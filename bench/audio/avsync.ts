// A/V sync and the decode's cost on the desktop guest (audio S3, docs/plans/audio.md §10.9; dev-only, not in tests):
// images/archarm/desktop.sh's image (sway, Firefox, PipeWire, virtio-snd-dkms) on the page, 4 vCPUs, the screen at
// 1376×762 (bench/gpu/guest-session.ts). sway starts (on GLES with 3D, `WLR_RENDERER=pixman` with `2d`), then Firefox
// in kiosk mode plays each clip of /home/alarm/media (images/archarm/media.sh) through avsync.html, with a profile of
// its own (autoplay, `dump` on).
//   avsync         the sync clip: a white frame and a 1 kHz beep at every second. The page times the flash where the
//                  screen is drawn (`?avprobe`: the draw that turned its centre bright) and the beep where the sound
//                  leaves (bench/audio/onset-worklet.ts after the volume, its frame mapped to the page's clock by
//                  `getOutputTimestamp`, which includes the output latency): offset = sound - picture, per second.
//   sintel         a real video (VP9 480p, Opus), and sintel-silent, the same without its sound: the guest's CPU
//                  (every thread's, bench/gpu/guest-session.ts `load`) and Firefox's dropped frames, with and without.
//   mpv-sound      Sintel's sound alone (`mpv --no-video --ao=pipewire`), and mpv-null, the same decode paced in real
//                  time with no output (`--ao=null`): what the sound path itself costs (PipeWire, the driver, the device).
// Each phase also reads the guest's ALSA parameters while it plays (PipeWire's period and buffer), the ring's
// underruns and gap frames, and the latency reported to the guest.
//   node bench/audio/avsync.ts <virgl|2d> <image.qcow2> [outdir]       (default bench/results/local/avsync/<mode>/)
// CLIPS picks the clips (default avsync,sintel,sintel-silent); PHASE_S the seconds measured (default 20), from
// WARM_S (default 5) after the clip starts playing. Results: <outdir>/results.json, screenshots.
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

const s = await openSession({ gpu: mode === 'virgl' ? process.env.VIRGL_GPU ?? 'virgl' : '2d', image, out, screen: process.env.SCREEN, query: 'snd=&avprobe' });
const { page, log, pasteSerial, rootShell, load, run, asUser } = s;
const results: Record<string, unknown> = { mode, gl: s.gl, chromium: s.browser.version(), phaseS: PHASE_S };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));

await rootShell();
results.info = await run('uname -r; pacman -Q firefox pipewire wireplumber virtio-snd-dkms | tr "\\n" " "; echo; lsmod | grep -o "^virtio_snd"; head -2 /proc/asound/cards | tr -s " "');
log('info', results.info);
// Firefox's profile (autoplay, dump, no first-run pages) and its start (`ffrun <url> <tag>`, as the user, by sway).
await pasteSerial(String.raw`mkdir -p /home/alarm/avprofile; cat > /home/alarm/avprofile/user.js <<'EOF'
user_pref("browser.dom.window.dump.enabled", true);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.shell.checkDefaultBrowser", false);
EOF`);
await pasteSerial(String.raw`cat > /root/ff.sh <<'EOF'
ffkill() { pkill -x firefox; for i in $(seq 60); do pgrep -x firefox >/dev/null || return 0; sleep 1; done; pkill -9 -x firefox; sleep 2; }
ffrun() { rm -f /tmp/ff-$2.log; su alarm -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) exec 'firefox --profile /home/alarm/avprofile --kiosk $1 > /tmp/ff-$2.log 2>&1'" >/dev/null; }
ffwait() { for i in $(seq 600); do grep -q "AVSYNC playing" /tmp/ff-$1.log 2>/dev/null && { echo playing; return; }; sleep 0.5; done; echo timeout; }
EOF
chown -R alarm:alarm /home/alarm/avprofile`);
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

for (const clip of CLIPS.filter((c) => c.startsWith('mpv-'))) {
  // As the user in sway's session (PipeWire's socket), for longer than the phase; killed after it.
  const ao = clip === 'mpv-sound' ? 'pipewire' : 'null';
  await run(asUser(`mpv --no-video --no-terminal --ao=${ao} --length=${PHASE_S + WARM_S + 20} /home/alarm/media/sintel.webm >/dev/null 2>&1 &`));
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

for (const clip of CLIPS.filter((c) => !c.startsWith('mpv-'))) {
  if (!/yes/.test(await run(`test -f /home/alarm/media/${clip}.webm && echo yes`))) { log(clip, 'not in the image'); continue; }
  await run('. /root/ff.sh; ffkill', 120_000);
  await run(`. /root/ff.sh; ffrun file:///home/alarm/media/avsync.html?v=${clip}.webm ${clip}`);
  const started = performance.now();
  const playing = await run(`. /root/ff.sh; ffwait ${clip}`, 330_000);
  log(clip, playing, `after ${((performance.now() - started) / 1000).toFixed(1)} s`);
  if (clip !== 'sintel-silent') await page.waitForFunction(() => (window as unknown as W).__audio.context()?.state === 'running', null, { timeout: 30_000 }).catch(() => log(clip, 'the sound never started on the page'));
  await listen();
  await page.waitForTimeout(WARM_S * 1000);
  const hw = await run('cat /proc/asound/card0/pcm0p/sub0/hw_params | tr "\\n" " "');
  const r0 = await ring();
  await page.evaluate(() => { const w = window as unknown as W; w.__flashes = []; w.__onsets = []; });
  const r = await load(clip, PHASE_S);
  const { flashes, onsets } = await page.evaluate(() => { const w = window as unknown as W; return { flashes: w.__flashes ?? [], onsets: w.__onsets ?? [] }; });
  const r1 = await ring();
  const ff = await run(`grep -E "AVSYNC t=" /tmp/ff-${clip}.log | tail -1; grep -c -E "AVSYNC (waiting|stalled)" /tmp/ff-${clip}.log`);
  const d = offsets(flashes, onsets);
  const rec = {
    hwParams: hw, ring: r1 && r0 ? { underruns: r1.underruns - r0.underruns, gapFrames: r1.gapFrames - r0.gapFrames, latencyFrames: r1.latencyFrames } : undefined, firefox: ff,
    flashes: flashes.length, onsets: onsets.length, offsetsMs: d.map((x) => +x.toFixed(1)),
    offset: d.length ? { median: +pct(d, 0.5).toFixed(1), p10: +pct(d, 0.1).toFixed(1), p90: +pct(d, 0.9).toFixed(1), min: +Math.min(...d).toFixed(1), max: +Math.max(...d).toFixed(1) } : undefined,
    ...r,
  };
  log(clip, 'offset', JSON.stringify(rec.offset), 'ring', JSON.stringify(rec.ring), 'firefox', ff, 'hw', hw);
  results[clip] = rec;
  save();
}
await run('. /root/ff.sh; ffkill', 120_000);
await s.close();
log('done', out);
