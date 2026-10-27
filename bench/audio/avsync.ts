// A/V sync and the decode's cost on the desktop guest (audio S3, docs/audio.md "Decisions"; dev-only, not in tests):
// images/arch/desktop.sh's image (sway, Firefox, PipeWire, the kernel's virtio_snd) on the page, 4 vCPUs, the screen at
// 1376×762 (bench/gpu/guest-session.ts). sway starts (on GLES with 3D, `WLR_RENDERER=pixman` with `2d`), then Firefox
// in kiosk mode plays each clip of /home/arch/media (images/arch/media.sh) through avsync.html, with a profile of
// its own (autoplay, `dump` on).
//   avsync         the sync clip: a white frame and a 1 kHz beep at every second. The page times the flash where the
//                  screen is drawn (`?avprobe`: the draw that turned its centre bright) and the beep where the sound
//                  leaves (bench/audio/onset-worklet.ts after the volume, its frame mapped to the page's clock by
//                  `getOutputTimestamp`, which includes the output latency): offset = sound - picture, per second.
//   sintel         a real video (VP9 480p, Opus), and sintel-silent, the same without its sound: the guest's CPU
//                  (every thread's, bench/gpu/guest-session.ts `load`) and Firefox's dropped frames, with and without.
//   mpv:<file>     mpv plays a clip of the media in sway with VA-API (`--hwdec=vaapi`): the guest's CPU, mpv's frames,
//                  its dropped frames (late at the output, and dropped by the decoder) over the phase.
//   mpv-sound      Sintel's sound alone (`mpv --no-video --ao=pipewire`), and mpv-null, the same decode paced in real
//                  time with no output (`--ao=null`): what the sound path itself costs (PipeWire, the driver, the device).
// Each phase also reads the guest's ALSA parameters while it plays (PipeWire's period and buffer), the ring's
// underruns and gap frames, and the latency reported to the guest.
//   node bench/audio/avsync.ts <virgl|2d> <image.qcow2> [outdir]       (default bench/results/local/avsync/<mode>/)
// CLIPS picks the clips (default avsync,sintel,sintel-silent; a name without an extension is a .webm); PHASE_S the
// seconds measured (default 20), from WARM_S (default 5) after the clip starts playing. MEDIA=disk plays them from
// bench/video/media-disk.sh's disk instead (the page's second disk: the sync clip in VP9 and H.264 too, the trailer's
// H.264 MP4), for the video track (docs/plans/video.md V2: VIRGL_GPU=virgl decodes VP9 and H.264 on the host, and
// virgl,novideo in the guest). Firefox's frames and dropped frames are counted over the phase. MPV_ARGS adds to mpv's
// options (VK2 L6: `--vo=gpu-next --gpu-api=vulkan` with VIRGL_GPU=virgl,vulkan); SHIM=1 (with MEDIA=disk) installs the media disk's VA driver.
// PROFILE=1 samples the guest's PCs over each clip's phase and symbolizes the kernel's (the clip's `profile`); SYSCALLS=1
// counts the guest's syscalls by thread over it (guest-session.ts `load`: a tracepoint on every syscall, so drops only
// from runs without it). FF_PREFS=<pref>=<value>;... adds prefs to Firefox's profile (docs/plans/video.md §8);
// VARIANTS=<label>:<prefs>|<label>:<prefs>... plays each Firefox clip under each set of prefs in turn (FF_PREFS's syntax,
// added to FF_PREFS; an empty set is Firefox's defaults), ROUNDS times (default 1), alternating, from a fresh prefs.js
// each launch; their records are <clip>@<label>-r<round>. NCPUS: the machine's vCPUs (default 4). TIMELINE=1 records
// the vCPU timeline over each phase (guest-session.ts `summarizeTimeline`; the rows in <outdir>/<clip>.timeline.json).
// Results: <outdir>/results.json, screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { GAP_FRAMES, LATENCY, UNDERRUNS } from '../../web/audio-ring.ts';
import { openSession } from '../gpu/guest-session.ts';

const mode = process.argv[2] ?? 'virgl';
const image = process.argv[3];
if (!image) throw new Error('usage: node bench/audio/avsync.ts <virgl|2d> <image.qcow2> [outdir]');
const out = process.argv[4] ?? new URL(`../results/local/avsync/${mode}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const CLIPS = (process.env.CLIPS ?? 'avsync,sintel,sintel-silent,mpv-sound,mpv-null').split(',');
const PHASE_S = Number(process.env.PHASE_S ?? 20);
const WARM_S = Number(process.env.WARM_S ?? 5);

const disk = process.env.MEDIA === 'disk';
// MPV_ARGS: more of mpv's options for the mpv:<file> phases (e.g. `--vo=gpu-next --gpu-api=vulkan`: VK2 L6).
const MPV_ARGS = process.env.MPV_ARGS ?? '';
const MEDIA = disk ? '/mnt/media' : '/home/arch/media';
const s = await openSession({ gpu: mode === 'virgl' ? process.env.VIRGL_GPU ?? 'virgl' : '2d', image, out, screen: process.env.SCREEN, ncpus: Number(process.env.NCPUS ?? 4), query: 'snd=&avprobe', disk2: disk ? '/target/video/media.ext4' : undefined });
const { page, log, pasteSerial, rootShell, load, run, runLines, asUser } = s;
const results: Record<string, unknown> = { mode, gl: s.gl, chromium: s.browser.version(), phaseS: PHASE_S };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, slow: s.slow }, null, 1));

await rootShell();
if (disk) await run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media; ls /mnt/media | tr "\\n" " "');
// SHIM=1: the VA driver on the media disk (bench/video/media-disk.sh's target/video/shim/) as the guest's (an image
// whose webpc-va is older: VK2 L6's webpc-va 3 sizes exported surfaces).
if (disk && process.env.SHIM) log('shim', await run('cp /mnt/media/webpc_drv_video.so /usr/lib/dri/ && echo shim installed'));
results.info = await run('uname -r; pacman -Q linux firefox pipewire wireplumber mesa webpc-va | tr "\\n" " "; echo; lsmod | grep -o "^virtio_snd"; head -2 /proc/asound/cards | tr -s " "');
log('info', results.info);
const userPrefs = (list: string) => list.split(';').filter(Boolean).map((kv) => {
  const [k, v] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)];
  return `user_pref("${k}", ${/^(true|false|-?\d+)$/.test(v) ? v : JSON.stringify(v)});\n`;
}).join('');
const prefs = userPrefs(process.env.FF_PREFS ?? '');
const variants = (process.env.VARIANTS ?? ':').split('|').map((v) => ({ label: v.slice(0, v.indexOf(':')), prefs: v.slice(v.indexOf(':') + 1) }));
const ROUNDS = Number(process.env.ROUNDS ?? 1);
results.prefs = process.env.FF_PREFS;
results.variants = variants;
// Firefox's profile (autoplay, dump, no first-run pages, FF_PREFS; a variant's prefs on top: `ffprefs <n>`) and its
// start (`ffrun <url> <tag>`, as the user, by sway).
await pasteSerial(String.raw`mkdir -p /home/arch/avprofile; cat > /home/arch/user-base.js <<'EOF'
user_pref("browser.dom.window.dump.enabled", true);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.shell.checkDefaultBrowser", false);
${prefs}EOF`);
for (const [i, v] of variants.entries()) await pasteSerial(`cat > /home/arch/user-v${i}.js <<'EOF'\n${userPrefs(v.prefs)}EOF`);
await pasteSerial(String.raw`cat > /root/ff.sh <<'EOF'
ffprefs() { cat /home/arch/user-base.js /home/arch/user-v$1.js > /home/arch/avprofile/user.js; rm -f /home/arch/avprofile/prefs.js; chown arch:arch /home/arch/avprofile/user.js; }
ffkill() { pkill -x firefox; for i in $(seq 60); do pgrep -x firefox >/dev/null || return 0; sleep 1; done; pkill -9 -x firefox; sleep 2; }
ffrun() { rm -f /tmp/ff-$2.log; su arch -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) exec 'firefox --profile /home/arch/avprofile --kiosk $1 > /tmp/ff-$2.log 2>&1'" >/dev/null; }
ffwait() { for i in $(seq 240); do grep -q "AVSYNC playing" /tmp/ff-$1.log 2>/dev/null && { echo playing; return; }; sleep 0.5; done; echo timeout; }
EOF
chown -R arch:arch /home/arch/avprofile`);
results.sway = await s.startSway(mode === 'virgl' ? 'gles2' : 'pixman');
log('sway', results.sway);
results.pipewire = await run(asUser('wpctl status 2>/dev/null | grep -A2 Sinks: | tr -s [:blank:]'));
log('pipewire', results.pipewire);
save();

type W = { __flashes?: number[]; __onsets?: number[]; __audio: { context(): AudioContext | undefined; output(): GainNode | undefined; header(): Int32Array | undefined } };
/** The onset node on the page's current context (once per context), its onsets in `__onsets` (ms, the page's clock). */
const listen = () => page.evaluate(async () => {
  const w = window as unknown as W & { __onsetCtx?: AudioContext };
  const ctx = w.__audio.context(), gain = w.__audio.output();
  if (!ctx || !gain || w.__onsetCtx === ctx) return !!ctx;
  await ctx.audioWorklet.addModule('/bench/audio/onset-worklet.ts');
  const node = new AudioWorkletNode(ctx, 'webpc-onset', { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<number>) => {
    const ts = ctx.getOutputTimestamp();
    (w.__onsets ??= []).push(ts.performanceTime! + (e.data / ctx.sampleRate - ts.contextTime!) * 1000);
  };
  gain.connect(node);
  w.__onsetCtx = ctx;
  return true;
});
const ring = () => page.evaluate(([u, g, l]) => { const h = (window as unknown as W).__audio.header(); return h ? { underruns: h[u], gapFrames: h[g], latencyFrames: h[l] } : undefined; }, [UNDERRUNS, GAP_FRAMES, LATENCY]);

/** Sound minus picture (ms) for each flash with a beep within 500 ms of it. */
function offsets(flashes: number[], onsets: number[]) {
  const d: number[] = [];
  for (const f of flashes) {
    let best: number | undefined;
    for (const o of onsets) if (Math.abs(o - f) < 500 && (best === undefined || Math.abs(o - f) < Math.abs(best))) best = o - f;
    if (best !== undefined) d.push(best);
  }
  return d;
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// mpv:<file>: the video too, in sway (`--hwdec=vaapi`, mpv's default output), its frames and drops from its status.
// MPV_VARIANTS=<label>:<options>|<label>:<options>...: each mpv:<file> clip under each set of mpv's options in turn
// (added to MPV_ARGS), ROUNDS times, alternating (MPV_ENV='VAR=x …': mpv's environment, e.g. VK3 L4e's VN_PERF); their records are mpv-<file>@<label>-r<round> (VK2 L6: mpv on virgl's
// GL against Vulkan in one boot).
const mpvVariants = process.env.MPV_VARIANTS ? process.env.MPV_VARIANTS.split('|').map((v) => ({ label: v.slice(0, v.indexOf(':')), args: v.slice(v.indexOf(':') + 1) })) : [{ label: '', args: '' }];
results.mpvVariants = process.env.MPV_VARIANTS;
for (const name of CLIPS.filter((c) => c.startsWith('mpv:'))) for (let round = 0; round < (process.env.MPV_VARIANTS ? ROUNDS : 1); round++) for (const v of mpvVariants) {
  const file = name.slice(4), clip = `mpv-${file.replace(/\W/g, '-')}${v.label ? `@${v.label}-r${round}` : ''}`;
  const args = [MPV_ARGS, v.args].filter(Boolean).join(' ');
  // Under `script` (mpv prints its status line only to a terminal), from a script (no quoting through su and script).
  await pasteSerial(`cat > /home/arch/mpv-run.sh <<'EOF'\n#!/bin/sh\nexec env ${process.env.MPV_ENV ?? ''} mpv --hwdec=vaapi ${args} --log-file=/tmp/mpv-full.log --fs --ao=pipewire --length=${PHASE_S + WARM_S + 20} --term-status-msg='MPV \${estimated-frame-number} \${frame-drop-count} \${decoder-frame-drop-count} \${hwdec-current}' ${MEDIA}/${file}\nEOF\nchmod 755 /home/arch/mpv-run.sh`);
  await run(asUser('script -qfc /home/arch/mpv-run.sh /tmp/mpv.log >/dev/null 2>&1 &'));
  await page.waitForTimeout(WARM_S * 1000);
  const status = async () => (await run(`grep -a -o 'MPV [0-9]* [0-9]* [0-9]* [a-z0-9-]*' /tmp/mpv.log | tail -1`)).trim().split(' ');
  const s0 = await status();
  let s1: string[] = [];
  const r = await load(clip, PHASE_S, process.env.TIMELINE ? s.timeline : undefined, async () => { s1 = await status(); });
  const timeline = process.env.TIMELINE ? await s.timelineSummary(clip) : undefined;
  const log1 = await run(`tr '\\r' '\\n' < /tmp/mpv.log | grep -a -v 'MPV [0-9]' | grep -a . | head -20`);
  // What mpv said of its output and decoder (its log: errors and warnings, the decoder it used, a failed import).
  const mpvLog = await runLines(`grep -a -E '\\]\\[[ew]\\]|Using hardware|Imported|interop' /tmp/mpv-full.log | grep -av 'Setting option' | grep -av 'libplacebo\\] \\[' | cut -c1-200 | uniq | head -${process.env.MPV_LOG_LINES ?? 20}`);
  // mpv on Vulkan may not exit (VK2 L6: its vo thread waits on a swapchain image the compositor still shows): killed.
  await run('pkill -x mpv; for i in $(seq 10); do pgrep -x mpv >/dev/null || break; sleep 0.5; done; pkill -9 -x mpv; sleep 1');
  const quality = s0.length >= 4 && s1.length >= 4 ? { frames: +s1[1] - +s0[1], dropped: +s1[2] - +s0[2], decoderDropped: +s1[3] - +s0[3], hwdec: s1[4] } : undefined;
  results[clip] = { quality, status: [s0.join(' '), s1.join(' ')], log: log1, mpvLog, mpvArgs: args, ...r, ...(timeline ? { timeline } : {}) };
  log(clip, 'phase', JSON.stringify(quality), 'busy', JSON.stringify(r.cpus?.find((c: { cpu: string }) => c.cpu === 'cpu')), 'video', JSON.stringify(r.display.renderer?.video), '\n' + log1, '\n' + mpvLog.join('\n'));
  save();
}

for (const clip of CLIPS.filter((c) => c.startsWith('mpv-'))) {
  // As the user in sway's session (PipeWire's socket), for longer than the phase; killed after it.
  const ao = clip === 'mpv-sound' ? 'pipewire' : 'null';
  await run(asUser(`mpv --no-video --no-terminal --ao=${ao} --length=${PHASE_S + WARM_S + 20} ${MEDIA}/sintel.webm >/dev/null 2>&1 &`));
  await page.waitForTimeout(WARM_S * 1000);
  const hw = await run('cat /proc/asound/card0/pcm0p/sub0/hw_params | tr "\\n" " "');
  const quantum = await run(asUser('pw-metadata -n settings 2>/dev/null | grep -o clock.[a-z-]*quantum.*value:.[0-9]*'));
  const r0 = await ring();
  const r = await load(clip, PHASE_S);
  const r1 = await ring();
  await run('pkill -x mpv; sleep 1');
  results[clip] = { hwParams: hw, quantum, ring: r1 && r0 ? { underruns: r1.underruns - r0.underruns, gapFrames: r1.gapFrames - r0.gapFrames } : undefined, ...r };
  log(clip, 'hw', hw, 'quantum', quantum, 'ring', JSON.stringify(results[clip] && (results[clip] as { ring: unknown }).ring));
  save();
}

/** Firefox's playback quality, its last report (avsync.html, once a second): frames presented and dropped so far. */
const quality = async (clip: string) => {
  const m = /frames=(\d+) dropped=(\d+)/.exec(await run(`grep -E "AVSYNC t=" /tmp/ff-${clip}.log | tail -1`));
  return m ? { frames: +m[1], dropped: +m[2] } : undefined;
};
const ffClips = CLIPS.filter((c) => !c.startsWith('mpv-') && !c.startsWith('mpv:'));
const one = variants.length === 1 && ROUNDS === 1;
for (const [round, vi, name] of Array.from({ length: ROUNDS }, (_, r) => variants.flatMap((_, i) => ffClips.map((c) => [r, i, c] as const))).flat()) {
  const file = name.includes('.') ? name : `${name}.webm`, clip = name.replace(/\W/g, '-') + (one ? '' : `@${variants[vi].label}-r${round}`);
  if (!/yes/.test(await run(`test -f ${MEDIA}/${file} && echo yes`))) { log(clip, 'not in the image'); continue; }
  await run(`. /root/ff.sh; ffkill; ffprefs ${vi}`, 120_000);
  await run(`. /root/ff.sh; ffrun file://${MEDIA}/avsync.html?v=${file} ${clip}`);
  const started = performance.now();
  const playing = await run(`. /root/ff.sh; ffwait ${clip}`, 330_000);
  log(clip, playing, `after ${((performance.now() - started) / 1000).toFixed(1)} s`);
  if (!/playing/.test(playing)) {
    // Never started (a variant Firefox can't play with): what its log ends with, and on to the next.
    results[clip] = { playing, log: await run(`grep -v -E "Tranche|Feedback|format 0x" /tmp/ff-${clip}.log | tail -8 | cut -c1-200`) };
    log(clip, results[clip]);
    save();
    continue;
  }
  if (!/silent/.test(clip)) await page.waitForFunction(() => (window as unknown as W).__audio.context()?.state === 'running', null, { timeout: 30_000 }).catch(() => log(clip, 'the sound never started on the page'));
  await listen();
  await page.waitForTimeout(WARM_S * 1000);
  const hw = await run('cat /proc/asound/card0/pcm0p/sub0/hw_params | tr "\\n" " "');
  const r0 = await ring();
  const q0 = await quality(clip);
  await page.evaluate(() => { const w = window as unknown as W; w.__flashes = []; w.__onsets = []; });
  let q1: Awaited<ReturnType<typeof quality>>;
  const r = await load(clip, PHASE_S, process.env.PROFILE ? s.sampler : process.env.TIMELINE ? s.timeline : undefined, async () => { q1 = await quality(clip); });
  const timeline = process.env.TIMELINE ? await s.timelineSummary(clip) : undefined;
  // Each report over the phase as frames and drops since the one before: when Firefox drops, in bursts or evenly.
  const series = q0 && q1 ? (await run(`grep -E "AVSYNC t=" /tmp/ff-${clip}.log | awk '{split($3,f,"="); split($4,d,"="); if (f[2]>=${q0.frames} && f[2]<=${q1.frames}) {if (n++) printf "%d:%d ", f[2]-pf, d[2]-pd; pf=f[2]; pd=d[2]}}'`))
    .split(/\s+/).filter(Boolean).map((x) => x.split(':').map(Number)) : [];
  const profile = process.env.PROFILE ? await s.symbolize(40) : undefined;
  const { flashes, onsets } = await page.evaluate(() => { const w = window as unknown as W; return { flashes: w.__flashes ?? [], onsets: w.__onsets ?? [] }; });
  const r1 = await ring();
  const ff = await run(`grep -E "AVSYNC t=" /tmp/ff-${clip}.log | tail -1; grep -c -E "AVSYNC (waiting|stalled)" /tmp/ff-${clip}.log`);
  const d = offsets(flashes, onsets);
  const rec = {
    hwParams: hw, ring: r1 && r0 ? { underruns: r1.underruns - r0.underruns, gapFrames: r1.gapFrames - r0.gapFrames, latencyFrames: r1.latencyFrames } : undefined, firefox: ff,
    // Over the phase: what Firefox presented and dropped.
    quality: q0 && q1 ? { frames: q1.frames - q0.frames, dropped: q1.dropped - q0.dropped, worstSecond: Math.max(0, ...series.map(([, x]) => x)) } : undefined,
    perSecond: series,
    flashes: flashes.length, onsets: onsets.length, offsetsMs: d.map((x) => +x.toFixed(1)),
    offset: d.length ? { median: +pct(d, 0.5).toFixed(1), p10: +pct(d, 0.1).toFixed(1), p90: +pct(d, 0.9).toFixed(1), min: +Math.min(...d).toFixed(1), max: +Math.max(...d).toFixed(1) } : undefined,
    ...r,
    ...(profile ? { profile } : {}),
    ...(timeline ? { timeline } : {}),
  };
  log(clip, 'offset', JSON.stringify(rec.offset), 'ring', JSON.stringify(rec.ring), 'firefox', ff, 'phase', JSON.stringify(rec.quality), 'video', JSON.stringify(r.display.renderer?.video), 'hw', hw);
  results[clip] = rec;
  save();
}
await run('. /root/ff.sh; ffkill', 120_000);
// `?gpu=virgl,debug`: the renderer's video lines (the first 200).
if (s.debugLines.length) results.debug = s.debugLines.filter((l) => l.includes('video')).slice(0, 200);
save();
await s.close();
log('done', out);
