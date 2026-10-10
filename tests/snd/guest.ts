// What the snd test kernel (images/snd/init.c) must show in every runner: its console lines, and the
// device's state at the end (web/snd.ts `SndState`): the control requests of log.txt (one per line, the
// native twin reads the same file: core/tests/snd_guest.rs) and a sink that was given exactly what the
// guest says it wrote, which is init.c's waveform made again here (so the hash isn't merely the guest's word).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fnv1a, type Played, type SndState } from '../../web/snd.ts';

export const SND_LOG = readFileSync(new URL('log.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));

/** images/snd/init.c's waveform: 48 periods of 1024 frames, S16 stereo at 48 kHz, 440 Hz left and 660 Hz right at 12000. */
export function sndWaveform() {
  const s = new Int16Array(48 * 1024 * 2);
  for (let f = 0; f < s.length / 2; f++) {
    s[2 * f] = Math.round(12000 * Math.sin(2 * Math.PI * 440 * f / 48000));
    s[2 * f + 1] = Math.round(12000 * Math.sin(2 * Math.PI * 660 * f / 48000));
  }
  return new Uint8Array(s.buffer);
}

export function checkSndGuest(console: string, snd: SndState | undefined) {
  const text = console.replaceAll('\r\n', '\n');
  for (const want of ['snd: card VirtIO SoundCard, driver virtio-snd\n', 'snd: hw params 48000 Hz, 2 channels, period 1024 frames, buffer 4096 frames\n', 'snd: 0 frames queued at the end, drop ok', 'webpc: snd test ok\n']) {
    assert.ok(text.includes(want), `missing ${JSON.stringify(want)} in\n${text}\n${JSON.stringify(snd)}`);
  }
  const [, frames, fnv] = text.match(/^snd: wrote (\d+) frames fnv1a ([0-9a-f]{8})$/m) ?? [];
  assert.ok(snd, 'no sound device state');
  assert.deepEqual(snd.log, SND_LOG);
  const played = snd.sink as Played;
  assert.deepEqual([played.frames, played.bytes, played.fnv], [Number(frames), Number(frames) * 4, fnv]);
  const wave = sndWaveform();
  assert.deepEqual([wave.length, fnv1a(wave).toString(16).padStart(8, '0')], [played.bytes, played.fnv], 'the waveform init.c writes');
}
