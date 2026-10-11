// The sound ring without a browser (docs/plans/audio.md §4, §6): the realtime sink (web/snd.ts `ringSink`) on a
// fake clock, with the worklet's side played by hand or by the worklet itself (web/audio-worklet.ts, loaded with the
// AudioWorkletGlobalScope's names stubbed): frames converted into the ring in order and across its wrap, messages
// completed when the read index passes them (the worklet's, or the sink's own clock's), at most a buffer less a
// period at once, with the page's output latency; pause, release, mono; the worklet's gaps counted as underruns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPACITY, GAP_FRAMES, LATENCY, QUANTA, RATE, READ, RUN, UNDERRUNS, WRITE, newRing, ringViews } from '../web/audio-ring.ts';
import { FMT_FLOAT, FMT_S16, ringSink, type SndParams } from '../web/snd.ts';
import { flashProbe } from '../web/virgl-screen.ts';

const P: SndParams = { bufferBytes: 4 * 4096, periodBytes: 4096, channels: 2, format: FMT_S16, rate: 48000 };

/** A sink on a fake clock (ms) that the test pumps itself, and the ring's header and frames. */
function rig(params = P, untaken?: () => number) {
  let t = 1000;
  const sink = ringSink({ now: () => t, schedule: false, untaken });
  const { h, data } = ringViews(sink.ring);
  const done: { n: number; latency: number }[] = [];
  let n = 0;
  /** A period of S16 stereo frames whose left samples count up from `from` (so the ring's order shows). */
  const period = (from: number, frames = params.periodBytes / (2 * params.channels)) => {
    const s = new Int16Array(frames * params.channels);
    for (let f = 0; f < frames; f++) for (let c = 0; c < params.channels; c++) s[f * params.channels + c] = c === 0 ? from + f : -1;
    return new Uint8Array(s.buffer);
  };
  const play = (frames: Uint8Array) => {
    const id = n++;
    sink.play(params, frames, (latency) => done.push({ n: id, latency }));
  };
  const at = (ms: number) => {
    t = ms;
    sink.pump();
  };
  return { sink, h, data, done, play, period, at, ids: () => done.map((d) => d.n) };
}

test('ring sink: frames go into the ring as f32 stereo in order; on its own clock they complete at the stream rate', () => {
  const r = rig();
  r.sink.start(P);
  assert.equal(Atomics.load(r.h, RUN), 1);
  assert.equal(Atomics.load(r.h, RATE), 48000);
  for (let k = 0; k < 4; k++) r.play(r.period(k * 1024));
  assert.equal(Atomics.load(r.h, WRITE), 4096);
  assert.equal(r.data[2 * 5], 5 / 32768);
  assert.equal(r.data[2 * 5 + 1], -1 / 32768);
  assert.equal(r.data[2 * 3000], 3000 / 32768);
  r.at(1000); // the clock starts here
  r.at(1000 + 21); // 1008 frames: not a period yet
  assert.deepEqual(r.ids(), []);
  r.at(1000 + 22); // 1056
  assert.deepEqual(r.ids(), [0]);
  assert.equal(r.done[0].latency, 0); // nothing after the ring on its own clock
  r.at(1000 + 86); // 4128 > 4096: all four played, the ring dry; three complete (a buffer less a period without a message)
  assert.deepEqual(r.ids(), [0, 1, 2]);
  r.at(1000 + 86 + 72); // not yet: the wait is half a buffer's time and 30 ms (72.7 ms) from when the core had taken the batch
  assert.deepEqual(r.ids(), [0, 1, 2]);
  r.at(1000 + 86 + 73); // the stream's end
  assert.deepEqual(r.ids(), [0, 1, 2, 3]);
  assert.equal(Atomics.load(r.h, READ), 4096);
  // Dry, the clock waits for the guest: frames that come later aren't consumed for the time it waited, and the wait
  // (from when the ring ran out, at 4096 frames: 1085.3 ms) is an underrun once sound comes again.
  r.at(2000);
  r.play(r.period(0));
  assert.equal(Atomics.load(r.h, UNDERRUNS), 0);
  r.at(2010);
  assert.equal(Atomics.load(r.h, READ), 4096 + 480);
  assert.deepEqual([Atomics.load(r.h, UNDERRUNS), Atomics.load(r.h, GAP_FRAMES)], [1, Math.round((2000 - 1000 - 4096 / 48) * 48)]);
  // Frames that come before the clock catches the ring's end are no gap.
  r.play(r.period(0));
  r.at(2040);
  r.play(r.period(0));
  r.at(2070);
  assert.equal(Atomics.load(r.h, UNDERRUNS), 1);
});

test('ring sink: while the worklet plays (its heartbeat moves), its read index completes messages, with the page latency', () => {
  const r = rig();
  r.sink.start(P);
  for (let k = 0; k < 4; k++) r.play(r.period(k * 1024));
  Atomics.store(r.h, LATENCY, 960); // 20 ms at 48 kHz
  // Its heartbeat moves every 40 ms for 2 s and its read index stays: the sink's clock would have played all of it.
  for (let t = 1000; t <= 3000; t += 40) {
    Atomics.add(r.h, QUANTA, 1);
    r.at(t);
  }
  assert.deepEqual([r.ids(), Atomics.load(r.h, READ)], [[], 0]);
  Atomics.store(r.h, READ, 1024);
  Atomics.add(r.h, QUANTA, 1);
  r.at(3002);
  assert.deepEqual(r.done, [{ n: 0, latency: 960 * 4 }]);
  // The worklet stops playing (no heartbeat for LIVE_MS): the sink's clock takes over from its last quantum, so the
  // 58 ms since are played at once, not lost.
  r.at(3060);
  assert.equal(Atomics.load(r.h, READ), 1024 + 58 * 48);
  assert.deepEqual(r.ids(), [0, 1, 2]);
  r.at(3100);
  assert.equal(Atomics.load(r.h, READ), 4096);
  assert.deepEqual(r.ids(), [0, 1, 2]);
  r.at(3133);
  assert.deepEqual(r.ids(), [0, 1, 2, 3]);
  assert.equal(Atomics.load(r.h, UNDERRUNS), 0);
});

test('ring sink: at most a buffer less a period completes since the guest last posted; the rest after it posts again, or after a wait', () => {
  const r = rig();
  r.sink.start(P);
  for (let k = 0; k < 4; k++) r.play(r.period(k * 1024));
  Atomics.store(r.h, READ, 4096); // the worklet played the whole buffer between pumps (the device worker stalled)
  Atomics.add(r.h, QUANTA, 1);
  r.at(1000);
  assert.deepEqual(r.ids(), [0, 1, 2]);
  Atomics.add(r.h, QUANTA, 1);
  r.at(1005);
  assert.deepEqual(r.ids(), [0, 1, 2]);
  r.play(r.period(0)); // the guest ran
  Atomics.add(r.h, QUANTA, 1);
  r.at(1006);
  assert.deepEqual(r.ids(), [0, 1, 2, 3]);
  // And by time alone.
  const s = rig();
  s.sink.start(P);
  for (let k = 0; k < 4; k++) s.play(s.period(k * 1024));
  Atomics.store(s.h, READ, 4096);
  Atomics.add(s.h, QUANTA, 1);
  s.at(1000);
  Atomics.add(s.h, QUANTA, 1);
  s.at(1085); // the first pump after the batch's first completion: the core has taken it (no untaken here)
  assert.deepEqual(s.ids(), [0, 1, 2]);
  Atomics.add(s.h, QUANTA, 1);
  s.at(1157);
  assert.deepEqual(s.ids(), [0, 1, 2]);
  Atomics.add(s.h, QUANTA, 1);
  s.at(1158); // 72.7 ms after that
  assert.deepEqual(s.ids(), [0, 1, 2, 3]);
  // Counted across pumps, not per pump: Linux reports progress from a work item that one run serves for any number of
  // completions, so a whole buffer completed before it runs reads as none (audio.md §15).
  const c = rig();
  c.sink.start(P);
  for (let k = 0; k < 4; k++) c.play(c.period(k * 1024));
  for (const [read, at, ids] of [[1024, 1000, [0]], [3072, 1001, [0, 1, 2]], [4096, 1002, [0, 1, 2]]] as const) {
    Atomics.store(c.h, READ, read);
    Atomics.add(c.h, QUANTA, 1);
    c.at(at);
    assert.deepEqual(c.ids(), ids);
  }
  // While the core hasn't taken the completions (no vCPU runs: a restored machine starting, a paused one), the wait
  // doesn't start; it does once they're taken.
  let untaken = 3;
  const u = rig(P, () => untaken);
  u.sink.start(P);
  for (let k = 0; k < 4; k++) u.play(u.period(k * 1024));
  Atomics.store(u.h, READ, 4096);
  for (let t = 1000; t <= 1200; t += 20) {
    Atomics.add(u.h, QUANTA, 1);
    u.at(t);
  }
  assert.deepEqual(u.ids(), [0, 1, 2]);
  untaken = 0;
  Atomics.add(u.h, QUANTA, 1);
  u.at(1205);
  assert.deepEqual(u.ids(), [0, 1, 2]);
  Atomics.add(u.h, QUANTA, 1);
  u.at(1277);
  assert.deepEqual(u.ids(), [0, 1, 2]);
  Atomics.add(u.h, QUANTA, 1);
  u.at(1278);
  assert.deepEqual(u.ids(), [0, 1, 2, 3]);
  // A restored machine: three held messages posted again, and the restored RAM may hold a completion the guest hasn't
  // seen (audio.md §16): counted as a whole buffer in flight, two complete, the third after the guest posts.
  const z = rig();
  z.sink.start(P);
  for (let k = 0; k < 3; k++) z.play(z.period(k * 1024));
  z.sink.restored(P, 3 * 4096);
  Atomics.store(z.h, READ, 3072);
  Atomics.add(z.h, QUANTA, 1);
  z.at(1000);
  assert.deepEqual(z.ids(), [0, 1]);
  z.play(z.period(0));
  Atomics.add(z.h, QUANTA, 1);
  z.at(1001);
  assert.deepEqual(z.ids(), [0, 1, 2]);
});

test('ring sink: messages wait for room; the ring wraps', () => {
  const big: SndParams = { ...P, periodBytes: 16384 * 4, bufferBytes: 16384 * 4 * 8 }; // periods of 16384 frames
  const r = rig(big);
  r.sink.start(big);
  for (let k = 0; k < 6; k++) r.play(r.period(k)); // 98,304 frames for a ring of 65,536
  assert.equal(Atomics.load(r.h, WRITE), CAPACITY);
  Atomics.store(r.h, READ, 16384 * 2);
  Atomics.add(r.h, QUANTA, 1);
  r.at(1000);
  assert.deepEqual(r.ids(), [0, 1]);
  assert.equal(Atomics.load(r.h, WRITE), CAPACITY + 16384 * 2);
  assert.equal(r.data[0], 4 / 32768); // message 4's first frame, at the ring's start again
  assert.equal(r.data[2 * 16384], 5 / 32768);
});

test('ring sink: STOP pauses its clock and the worklet, START resumes; RELEASE drops the ring and completes nothing', () => {
  const r = rig();
  r.sink.start(P);
  for (let k = 0; k < 4; k++) r.play(r.period(k * 1024));
  r.at(1000);
  r.at(1022);
  assert.deepEqual(r.ids(), [0]);
  r.sink.stop();
  assert.equal(Atomics.load(r.h, RUN), 0);
  r.at(5000);
  assert.deepEqual(r.ids(), [0]);
  r.sink.start(P);
  r.at(5001);
  r.at(5023);
  assert.deepEqual(r.ids(), [0, 1]);
  r.sink.release();
  assert.equal(Atomics.load(r.h, READ), Atomics.load(r.h, WRITE));
  r.at(9000);
  assert.deepEqual(r.ids(), [0, 1]);
});

test('ring sink: a mono stream is written to both channels; FLOAT as it comes', () => {
  const mono: SndParams = { ...P, channels: 1, format: FMT_FLOAT, periodBytes: 512, bufferBytes: 2048 };
  const sink = ringSink({ schedule: false });
  const { h, data } = ringViews(sink.ring);
  sink.start(mono);
  sink.play(mono, new Uint8Array(new Float32Array([0.5, -0.25]).buffer), () => {});
  assert.equal(Atomics.load(h, WRITE), 2);
  assert.deepEqual([...data.subarray(0, 4)], [0.5, 0.5, -0.25, -0.25]);
});

/** web/audio-worklet.ts's processor class, under stubs of the AudioWorkletGlobalScope's names. */
async function processor() {
  const g = globalThis as unknown as Record<string, unknown>;
  let ctor: (new (o: unknown) => { process(i: unknown, o: Float32Array[][]): boolean }) | undefined;
  g.sampleRate = 48000;
  g.AudioWorkletProcessor = class {};
  g.registerProcessor = (_name: string, c: typeof ctor) => { ctor = c; };
  await import('../web/audio-worklet.ts');
  return ctor!;
}

test('worklet: plays the ring a quantum at a time while started at its rate; a gap in the sound is an underrun when it ends', async () => {
  const Proc = await processor();
  const ring = newRing();
  const { h, data } = ringViews(ring);
  const w = new Proc({ processorOptions: { ring } });
  const out = [new Float32Array(128), new Float32Array(128)];
  const quantum = () => w.process([], [out]);
  for (let k = 0; k < 300; k++) data[2 * k] = data[2 * k + 1] = k;
  Atomics.store(h, WRITE, 300);
  quantum(); // not started: silence, the ring untouched, no heartbeat
  assert.deepEqual([Atomics.load(h, READ), Atomics.load(h, QUANTA), out[0][5]], [0, 0, 0]);
  Atomics.store(h, RUN, 1);
  Atomics.store(h, RATE, 44100);
  quantum(); // another rate: not played
  assert.equal(Atomics.load(h, READ), 0);
  Atomics.store(h, RATE, 48000);
  quantum();
  assert.deepEqual([Atomics.load(h, READ), Atomics.load(h, QUANTA), out[0][5], out[1][127]], [128, 1, 5, 127]);
  quantum();
  quantum(); // 44 frames left, then dry
  assert.deepEqual([Atomics.load(h, READ), out[0][43], out[0][44]], [300, 299, 0]);
  quantum();
  assert.equal(Atomics.load(h, UNDERRUNS), 0); // not until the sound comes back
  Atomics.store(h, WRITE, 400);
  quantum();
  assert.deepEqual([Atomics.load(h, UNDERRUNS), Atomics.load(h, GAP_FRAMES)], [1, 84 + 128]);
  // The device worker's clock moved the read index under it: that quantum is silence, nothing is played twice.
  Atomics.store(h, WRITE, 1000);
  const r = Atomics.load(h, READ);
  const cas = Atomics.compareExchange;
  Atomics.compareExchange = ((a: Int32Array, i: number, e: number, v: number) => (Atomics.store(a, READ, r + 10), cas(a, i, e, v))) as typeof cas;
  try { quantum(); } finally { Atomics.compareExchange = cas; }
  assert.deepEqual([Atomics.load(h, READ), out[0][0]], [r + 10, 0]);
});

test("A/V sync's picture end (?avprobe): a flash is a draw that turns the screen's centre bright, once until it's dark again", () => {
  const t: number[] = [];
  const probe = flashProbe((at) => t.push(at));
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [250, 250, 250], [128, 128, 128], [255, 255, 255], [10, 10, 10], [200, 200, 200], [255, 0, 0], [240, 240, 240]]) probe(r, g, b);
  assert.equal(t.length, 2); // the white after black, and the light grey after the dark; mid grey and red neither end nor start one
  assert.ok(t.every((x) => Math.abs(x - (performance.timeOrigin + performance.now())) < 1000));
});
