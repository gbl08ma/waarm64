// The microphone on the desktop guest (audio S4, docs/audio.md "Decisions"; dev-only, not in tests): images/arch/
// desktop.sh's image on the page with Chromium's fake capture device playing a tone (`MIC_HZ`, default 500), sway
// started (so PipeWire and WirePlumber run in arch's session), then: the sources WirePlumber lists (the virtio card's
// capture must be one), a recording with `pw-record` (PipeWire's own client, at 48 kHz stereo S16), and each channel's
// frequency by its rising zero crossings (od and awk in the guest), with the page's microphone state and ring.
//   node bench/audio/mic-desktop.ts <image.qcow2> [outdir]       (default bench/results/local/mic-desktop/)
// SECONDS the recording's length (default 4). Results: <outdir>/results.json.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_FRAMES, WRITE } from '../../web/audio-ring.ts';
import { openSession } from '../gpu/guest-session.ts';
import { toneWav } from '../../tests/snd-disk.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/audio/mic-desktop.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/mic-desktop/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const MIC_HZ = Number(process.env.MIC_HZ ?? 500);
const SECONDS = Number(process.env.SECONDS ?? 4);
const wav = join(mkdtempSync(join(tmpdir(), 'webpc-mic-')), 'mic.wav');
writeFileSync(wav, toneWav(20, 48000, [MIC_HZ, MIC_HZ]));
process.env.CHROMIUM_ARGS = `${process.env.CHROMIUM_ARGS ?? ''} --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=${wav}`;

const s = await openSession({ gpu: '2d', image, out, screen: process.env.SCREEN, query: 'snd=' });
const { page, log, rootShell, run, asUser } = s;
const results: Record<string, unknown> = { chromium: s.browser.version(), micHz: MIC_HZ, seconds: SECONDS };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
try {
  await rootShell();
  results.info = await run('uname -r; pacman -Q linux pipewire wireplumber | tr "\\n" " "; echo; head -2 /proc/asound/cards | tr -s " "; ls /dev/snd | tr "\\n" " "');
  log('info', results.info);
  results.sway = await s.startSway('pixman');
  // The default source WirePlumber picked: the virtio card's capture.
  const sources = () => run(asUser('pw-cli ls Node 2>/dev/null | grep -o alsa_input.*'));
  results.sources = await sources();
  log('sources', results.sources);
  // The recording, then each channel's rising zero crossings a second (the samples after the 44-byte header).
  const rec = await run(`${asUser(`rm -f /tmp/mic.wav; timeout ${SECONDS} pw-record --rate 48000 --channels 2 --format s16 /tmp/mic.wav`)}; stat -c %s /tmp/mic.wav`, (SECONDS + 60) * 1000);
  const page_ = await page.evaluate(() => { const a = (window as unknown as { __audio: { micState: string; micHeader(): Int32Array | undefined; micSettings(): MediaTrackSettings | undefined } }).__audio; return { state: a.micState, header: a.micHeader() && [...a.micHeader()!] }; });
  const hz = await run(`od -An -t d2 -v -j 44 /tmp/mic.wav | awk '{for(i=1;i<=NF;i++){c=n%2; if(p[c]<0&&$i>=0)r[c]++; p[c]=$i; if($i>m||-$i>m)m=($i<0?-$i:$i); n++}} END{f=n/2; printf "frames %d left %d right %d peak %d\\n", f, r[0]*48000/f, r[1]*48000/f, m}'`);
  results.recording = { bytes: rec.trim(), analysis: hz.trim(), page: { state: page_.state, written: page_.header?.[WRITE], dropped: page_.header?.[GAP_FRAMES] } };
  log('recording', JSON.stringify(results.recording));
  results.sourcesAfter = await sources();
  log('sources after', results.sourcesAfter);
  results.hw = await run('cat /proc/asound/card0/pcm0c/sub0/hw_params 2>/dev/null | tr "\\n" " "');
  save();
} finally {
  save();
  await s.close();
}
