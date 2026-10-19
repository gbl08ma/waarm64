// Spill memories on the desktop guest with its active set past memory 0 (docs/spill-memories.md; dev-only, not in
// tests): images/arch/desktop.sh's Arch with RAM past memory 0 (`?ram=`, default 6144 MiB: memory 0's 3071 MiB and a
// 3073 MiB node), 4 vCPUs, 3D, sway, Firefox (windows sway tiles, all visible, so none is throttled). First a WebGL 2
// window (bench/gpu/firefox/webgl.html: its frames a second and longest frame gap) and a video window (the media
// disk's clip in a loop, decoded by the host through VA-API: its frames a second and drops). Then memory-load windows
// (tools/mem.html: MB each, every 64-byte line read every PERIOD ms in a worker, each sweep's ms logged) are opened
// one at a time until the guest's memory is well past memory 0; after each, a sample: each node's meminfo, Firefox's
// anonymous pages by node (numa_maps of its processes), every tab's last sweep, the WebGL and video rates, the guest's
// MIPS, the core heap's high-water mark (web/vm.ts `heapUse`). Then the WebGL and video windows are closed and
// opened again (their new memory can only come from node 1) and sampled once more.
//   node bench/boot/results/m8-spill/tools/numa-desktop.ts <image.qcow2> [outdir]
// RAM (MiB), TABS (default 8), MB (per tab, default 384), PERIOD (ms, default 5000), SAMPLE_S (default 20),
// RECLAIM=1 sets vm.zone_reclaim_mode=1 first.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { GUEST_USER, openSession } from '../../../../gpu/guest-session.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/boot/results/m8-spill/tools/numa-desktop.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../../../../results/local/spill/desktop/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const RAM = Number(process.env.RAM ?? 6144), TABS = Number(process.env.TABS ?? 8), MB = Number(process.env.MB ?? 384);
const PERIOD = Number(process.env.PERIOD ?? 5000), SAMPLE_S = Number(process.env.SAMPLE_S ?? 20), CLIP = process.env.CLIP ?? 'sintel.webm';
const HOME = `/home/${GUEST_USER}`;
const D = `${HOME}/spill`;

const s = await openSession({ gpu: 'virgl', image, out, disk2: '/target/video/media.ext4', ramMiB: RAM });
const { page, log, pasteSerial, rootShell, run } = s;
const results: Record<string, unknown> = { ram: RAM, tabs: TABS, mb: MB, period: PERIOD, sampleS: SAMPLE_S, reclaim: !!process.env.RECLAIM, gl: s.gl, chromium: s.browser.version(), date: new Date().toISOString() };
const samples: Record<string, unknown>[] = [];
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, samples, warnings: Object.fromEntries(s.warnings), slow: s.slow }, null, 1));
const N = '/sys/devices/system/node';
const fields = (text: string, scale = 1) => Object.fromEntries(text.split(/\s+/).filter(Boolean).map((f) => { const [k, v] = f.split(':'); return [k, Math.round(Number(v) / scale)]; }));
/** Each node's meminfo (MiB). */
const meminfo = async () => fields(await run(`for n in 0 1; do grep -E 'MemFree|MemUsed|FilePages|AnonPages|Shmem:|Slab:' ${N}/node$n/meminfo | awk -v n=$n '{printf "n%s.%s%s ", n, $3, $4}'; done`), 1024);
/** Firefox's pages by node (MiB): anonymous (`anon=` lines) and all, every firefox process (shared pages in each). */
const firefox = async () => fields(await run(`for p in $(pgrep -f /usr/lib/firefox/firefox); do cat /proc/$p/numa_maps 2>/dev/null; done | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^N[0-9]=/) { split($i, a, "="); all[a[1]] += a[2]; if ($0 ~ / anon=/) anon[a[1]] += a[2] } } END {for (k in all) printf "all%s:%d anon%s:%d ", k, all[k] / 256, k, anon[k] / 256}'`));
/** Every memory tab's last sweep (ms). */
const sweeps = async () => fields(await run(`grep -a '^MEMSWEEP' /tmp/ff.log | awk '{l["tab" $2] = $3} END {for (k in l) printf "%s:%s ", k, l[k]}'`));
/** The WebGL window's frames a second and longest gap over the last `n` seconds; the video's frames and drops a second. */
const rates = async (n: number) => {
  const gl = (await run(`grep -a 'FFBENCH webgl t=' /tmp/ff.log | tail -${n} | sed 's/.*frames=\\([0-9]*\\) maxms=\\([0-9.]*\\)/\\1 \\2/' | awk '{f += $1; if ($2 > m) m = $2; k++} END {printf "%.1f %.0f", f / (k ? k : 1), m}'`)).split(' ').map(Number);
  const vq = (await run(`grep -a '^VQ' /tmp/ff.log | tail -1`)).split(' ').map(Number);
  return { webglFps: gl[0], webglMaxMs: gl[1], video: { frames: vq[1], dropped: vq[2], t: vq[3] } };
};
/** What the core's heap touched (MiB; the page's `__webpcHeap`). */
const heap = async () => {
  await page.evaluate(() => { (window as unknown as { __heap?: unknown }).__heap = undefined; (window as unknown as { __webpcHeap(): void }).__webpcHeap(); });
  await page.waitForFunction(() => (window as unknown as { __heap?: unknown }).__heap, undefined, { timeout: 30_000 });
  const { buckets, ...h } = await page.evaluate(() => (window as unknown as { __heap: Record<string, number> & { buckets?: number[] } }).__heap);
  return { ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k.replace('Bytes', 'MiB'), +(v / 2 ** 20).toFixed(1)])), buckets };
};
/** A sample over SAMPLE_S seconds. */
const sample = async (stage: string) => {
  const r0 = await rates(1), v0 = await s.vmStats();
  await page.waitForTimeout(SAMPLE_S * 1000);
  const r1 = await rates(SAMPLE_S), v1 = await s.vmStats();
  const vd = s.vmDelta(v0, v1);
  const secs = (r1.video.t - r0.video.t) / 1000;
  const row = {
    stage, nodes: await meminfo(), firefox: await firefox(), sweeps: await sweeps(),
    webglFps: r1.webglFps, webglMaxMs: r1.webglMaxMs, videoFps: secs > 0 ? +((r1.video.frames - r0.video.frames) / secs).toFixed(1) : null, videoDroppedPerS: secs > 0 ? +((r1.video.dropped - r0.video.dropped) / secs).toFixed(2) : null,
    mips: vd ? +vd.Msteps.toFixed(1) : null, tlbMissesPerS: vd?.tlbMisses, heap: await heap(),
  };
  samples.push(row);
  log(JSON.stringify(row));
  save();
};

const VIDEO_HTML = String.raw`<!doctype html>
<meta charset="utf-8">
<title>video</title>
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden } video { width: 100%; height: 100% }</style>
<video id="v" muted loop autoplay playsinline></video>
<script>
const v = document.getElementById('v');
v.src = decodeURIComponent(location.search.slice(1));
v.addEventListener('playing', () => { try { dump('VQPLAYING\n'); } catch (e) {} }, { once: true });
for (const ev of ['error', 'stalled', 'waiting', 'emptied', 'ended']) v.addEventListener(ev, () => { try { dump('VQEVENT ' + ev + ' ' + v.currentTime.toFixed(2) + ' ' + (v.error ? v.error.message : '') + '\n'); } catch (e) {} });
setInterval(() => { const q = v.getVideoPlaybackQuality(); try { dump('VQ ' + q.totalVideoFrames + ' ' + q.droppedVideoFrames + ' ' + Math.round(performance.timeOrigin + performance.now()) + '\n'); } catch (e) {} }, 1000);
</script>`;

try {
  await rootShell();
  results.boot = await meminfo();
  log('after boot (MiB)', results.boot);
  results.nodes = await run(`echo online $(cat ${N}/online) distance $(cat ${N}/node0/distance) / $(cat ${N}/node1/distance) balancing $(cat /proc/sys/kernel/numa_balancing) creds $(systemd-creds --system list 2>/dev/null | grep -c sysctl.extra)`);
  log(results.nodes);
  if (process.env.RECLAIM) results.reclaimSet = await run('sysctl -w vm.zone_reclaim_mode=1');
  await run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media; ls /mnt/media | tr "\\n" " "');
  const firefoxDir = new URL('../../../../gpu/firefox/', import.meta.url);
  await run(`mkdir -p ${D}/profile`);
  for (const [text, to] of [[readFileSync(new URL('bench.js', firefoxDir), 'utf8'), 'bench.js'], [readFileSync(new URL('webgl.html', firefoxDir), 'utf8'), 'webgl.html'], [readFileSync(new URL('user.js', firefoxDir), 'utf8') + 'user_pref("media.autoplay.default", 0);\nuser_pref("media.autoplay.blocking_policy", 0);\nuser_pref("browser.tabs.unloadOnLowMemory", false);\n', 'profile/user.js'], [readFileSync(new URL('mem.html', import.meta.url), 'utf8'), 'mem.html'], [VIDEO_HTML, 'video.html']] as const) {
    await pasteSerial(`cat > ${D}/${to} <<'EOF'\n${text}\nEOF`);
  }
  // Firefox in sway's session as the user: `ffopen <url>` starts it (its stdout and the content processes' dumps in
  // /tmp/ff.log) or, once it runs, opens the URL in a new window of it.
  await pasteSerial(String.raw`chown -R ${GUEST_USER}:${GUEST_USER} ${D}
cat > /root/ff.sh <<'EOF'
sw() { su ${GUEST_USER} -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) $1" > /dev/null; }
ffopen() { if pgrep -x firefox > /dev/null; then sw "exec 'firefox --profile ${D}/profile --new-window $1'"; else rm -f /tmp/ff.log; sw "exec 'firefox --profile ${D}/profile $1 > /tmp/ff.log 2>&1'"; fi; }
ffwait() { for i in $(seq 360); do [ "$(grep -a -c "$1" /tmp/ff.log 2> /dev/null)" -ge "${'$'}{2:-1}" ] && { echo ok; return; }; sleep 0.5; done; echo timeout; }
EOF`);
  results.sway = await s.startSway('gles2');
  log('sway', results.sway);
  const real = async (n: number) => {
    await run(`. /root/ff.sh; ffopen "file://${D}/webgl.html"`);
    log('webgl', await run(`. /root/ff.sh; ffwait "FFBENCH webgl ready" ${n}`, 200_000));
    await run(`. /root/ff.sh; ffopen "file://${D}/video.html?/mnt/media/${CLIP}"`);
    log('video', await run(`. /root/ff.sh; ffwait "^VQPLAYING" ${n}`, 200_000));
    await page.waitForTimeout(15_000);
  };
  await real(1);
  await sample('base');
  for (let k = 1; k <= TABS; k++) {
    await run(`. /root/ff.sh; ffopen "file://${D}/mem.html?${MB}:${k}:${PERIOD}"`);
    log(`tab ${k}`, await run(`. /root/ff.sh; ffwait "MEMSWEEP ${k} "`, 300_000));
    await sample(`tabs${k}`);
  }
  // The real workloads again, their new memory from what is left.
  await run(`. /root/ff.sh; sw '[title="^webgl"] kill'; sw '[title="^video"] kill'`);
  await page.waitForTimeout(5000);
  await real(2);
  for (let k = 1; k <= Number(process.env.REOPENED ?? 2); k++) await sample(`reopened${k}`);
  results.videoEvents = await run(`grep -a '^VQEVENT' /tmp/ff.log | tail -20 | tr '\\n' '|'`);
  results.firefoxErrors = await run(`grep -a -i -E 'error|crash' /tmp/ff.log | grep -v -E 'Tranche|Feedback' | tail -15 | cut -c1-200 | tr '\\n' '|'`);
  await page.locator('#screen').screenshot({ path: `${out}/end.png` });
} finally {
  save();
  await s.close?.();
}
