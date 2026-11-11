// The video track's V0 guest gate (docs/graphics.md "Video"; dev-only, not in tests): the desktop guest
// (images/arch/desktop.sh) on the page with video advertised (`?gpu=virgl,video`) and the renderer's null decoder.
// What VA-API the guest's Mesa offers (`vainfo`), whether FFmpeg decodes through it (`-hwaccel vaapi`, the Sintel
// trailer's H.264 and VP9), and whether Firefox does (its log: `MOZ_LOG=PlatformDecoderModule:5,FFmpegVideo:5`) with
// the guest's CPU over the playback. The clips are bench/video/media-disk.sh's, on the second disk.
//   node bench/video/v0.ts <image.qcow2> [outdir]      (default bench/results/local/video/v0/)
// CAPTURE=1 also saves the session's virgl capture (web/virgl-trace.ts) as <outdir>/capture.vglt: V1's fixtures.
// FIREFOX=0 skips Firefox, FFMPEG=0 FFmpeg; PREFS adds Firefox prefs (`name=value,…`, e.g.
// media.hardware-video-decoding.force-enabled=true); about:support's graphics section goes to the results (G4's
// autoconfig, bench/gpu/firefox/webpc.cfg); PHASE_S is the seconds measured while each clip plays (default 15).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeTrace } from '../../web/virgl-trace.ts';
import { openSession } from '../gpu/guest-session.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/video/v0.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/video/v0/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PHASE_S = Number(process.env.PHASE_S ?? 15);
const capture = !!process.env.CAPTURE;

const s = await openSession({ gpu: `virgl,video${capture ? ',capture' : ''}`, image, out, disk2: '/target/video/media.ext4' });
const { page, log, pasteSerial, rootShell, load, run, asUser } = s;
const results: Record<string, unknown> = { gl: s.gl, chromium: s.browser.version() };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
type RS = { video?: { frames: number; bitstreamBytes: number; errors: number } };
/** The renderer's video totals (the GPU worker's last render-stats). */
const video = async () => {
  const v = await page.evaluate(() => ((window as unknown as { __renderStats?: RS[] }).__renderStats ?? []).at(-1)?.video);
  return { frames: v?.frames ?? 0, bytes: v?.bitstreamBytes ?? 0, errors: v?.errors ?? 0 };
};

await rootShell();
await run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media; ls /mnt/media | tr "\\n" " "');
results.info = await run('uname -r; pacman -Q mesa libva ffmpeg firefox | tr "\\n" " "');
// SHIM=1: the VA driver on the media disk (bench/video/media-disk.sh) as the guest's, for every process.
const shim = !!process.env.SHIM;
if (shim) await run('cp /mnt/media/webpc_drv_video.so /usr/lib/dri/ && echo LIBVA_DRIVER_NAME=webpc >> /etc/environment');
const vaEnv = shim ? 'LIBVA_DRIVER_NAME=webpc ' : '';
log('info', results.info);
results.vainfo = await run(vaEnv + 'vainfo --display drm --device /dev/dri/renderD128 2>&1 | tail -20', 120_000);
log('vainfo\n' + results.vainfo);
save();

// FFmpeg on VA-API, no display: 120 frames of each, the pictures left on the device (`-hwaccel_output_format vaapi`).
for (const clip of process.env.FFMPEG === '0' ? [] : ['sintel_trailer-480p.mp4', 'sintel.webm']) {
  const before = await video();
  const t0 = Date.now();
  const r = await run(`cd /tmp; (TIMEFORMAT='time %R s user %U s sys %S s'; time ${vaEnv}ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -i /mnt/media/${clip} -frames:v 120 -an -f null -) 2>&1 | tail -8`, 300_000);
  const after = await video();
  results[`ffmpeg ${clip}`] = { out: r, ms: Date.now() - t0, frames: after.frames - before.frames, bytes: after.bytes - before.bytes, errors: after.errors };
  log(`ffmpeg ${clip}`, results[`ffmpeg ${clip}`]);
  // The same decode in software, for the CPU it costs the guest.
  const sw = await run(`cd /tmp; (TIMEFORMAT='time %R s user %U s sys %S s'; time ffmpeg -hide_banner -loglevel warning -i /mnt/media/${clip} -frames:v 120 -an -f null -) 2>&1 | tail -3`, 300_000);
  results[`ffmpeg-sw ${clip}`] = sw;
  log(`ffmpeg-sw ${clip}`, sw);
  save();
}

if (process.env.FIREFOX !== '0') {
  await pasteSerial(String.raw`mkdir -p /home/arch/vprofile; cat > /home/arch/vprofile/user.js <<'EOF'
user_pref("browser.dom.window.dump.enabled", true);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.shell.checkDefaultBrowser", false);
${(process.env.PREFS ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return `user_pref("${k}", ${v});`; }).join('\n')}
EOF
chown -R arch:arch /home/arch/vprofile
cat > /root/ff.sh <<'EOF'
ffkill() { pkill -x firefox; for i in $(seq 60); do pgrep -x firefox >/dev/null || return 0; sleep 1; done; pkill -9 -x firefox; sleep 2; }
ffrun() { rm -f /tmp/ff-$2.log; su arch -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) exec '/home/arch/ff-launch.sh $1 $2'" >/dev/null; }
ffwait() { for i in $(seq 560); do grep -q "AVSYNC playing" /tmp/ff-$1.log 2>/dev/null && { echo playing; return; }; sleep 0.5; done; echo timeout; tail -15 /tmp/ff-$1.log; }
EOF
# sway's exec splits commands at commas: MOZ_LOG's list goes through a script.
printf '#!/bin/sh\n${vaEnv}FFBENCH_SUPPORT=/tmp/ff-$2.support MOZ_LOG=PlatformDecoderModule:5,FFmpegVideo:5,Dmabuf:5 exec firefox --profile /home/arch/vprofile --kiosk "$1" > /tmp/ff-$2.log 2>&1\n' > /home/arch/ff-launch.sh
chmod 755 /home/arch/ff-launch.sh`);
  for (const [from, to] of [['autoconfig.js', '/usr/lib/firefox/defaults/pref/autoconfig.js'], ['webpc.cfg', '/usr/lib/firefox/webpc.cfg']]) {
    await pasteSerial(`cat > ${to} <<'EOF'\n${readFileSync(new URL(`../gpu/firefox/${from}`, import.meta.url), 'utf8')}EOF`);
  }
  results.sway = await s.startSway('gles2');
  log('sway', results.sway);
  for (const clip of (process.env.CLIPS ?? 'sintel.webm,sintel_trailer-480p.mp4').split(',')) {
    const tag = clip.replace(/\W.*/, '') + (clip.endsWith('mp4') ? '-h264' : '-vp9');
    await run(`. /root/ff.sh; ffrun file:///mnt/media/avsync.html?v=${clip} ${tag}`);
    const playing = await run(`. /root/ff.sh; ffwait ${tag}`, 330_000);
    log(tag, playing);
    const r = await load(tag, PHASE_S);
    // The first lines about VA-API and dmabufs, in order (each kind once).
    const ff = await run(`grep -i -E "vaapi|va-api|hw ?dec|hardware|dmabuf|v4l2|egl|failed|error" /tmp/ff-${tag}.log | grep -v -E "Tranche|Feedback|format 0x" | sed -e 's/^.*\\]: //' | awk '!seen[$0]++' | head -60`);
    const support = await run(`for i in $(seq 40); do [ -s /tmp/ff-${tag}.support ] && break; sleep 1; done; grep -i -E "video|vaapi|dmabuf|decod|webrender " /tmp/ff-${tag}.support`, 90_000);
    const quality = await run(`grep "AVSYNC t=" /tmp/ff-${tag}.log | tail -1`);
    results[`firefox ${tag}`] = { playing, load: r, quality, log: ff, support };
    log(tag, quality, JSON.stringify(r.display.renderer?.video), '\n' + ff, '\n' + support);
    await page.locator('#screen').screenshot({ path: `${out}/${tag}.png` });
    await run('. /root/ff.sh; ffkill');
    save();
  }
}

if (capture) {
  // The records concatenated, as base64 (a page hands strings back quickly, arrays of numbers slowly).
  const [n, b64] = await page.evaluate(() => {
    const rs = (window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ?? [];
    let s = '';
    for (const r of rs) for (let k = 0; k < r.length; k += 8192) s += String.fromCharCode(...r.subarray(k, k + 8192));
    return [rs.length, btoa(s)] as const;
  });
  writeFileSync(`${out}/capture.vglt`, encodeTrace([new Uint8Array(Buffer.from(b64, 'base64'))]));
  log('capture', n, 'records');
}
results.warnings = Object.fromEntries(s.warnings);
save();
await s.close();
void asUser;
