// The virtio-snd backend without a guest (web/snd.ts): control requests and their errors on
// hand-built buffers, the streams' lifecycles, transmit messages held, played and returned, the
// deterministic sink's completions and hash, receive messages filled by the deterministic source and
// the realtime clock source, the format conversion, save and restore.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceEntry, type Ctx, type Request } from '../web/devices.ts';
import { CAPACITY, QUANTA, RATE, RUN, WRITE, ringViews } from '../web/audio-ring.ts';
import {
  CONTROLQ, EVENTQ, FMT_FLOAT, FMT_S16, FMT_S32, RATE_BITS, RXQ, R_CHMAP_INFO, R_JACK_INFO, R_JACK_REMAP, R_PCM_INFO, R_PCM_PREPARE, R_PCM_RELEASE,
  R_PCM_SET_PARAMS, R_PCM_START, R_PCM_STOP, S_BAD_MSG, S_NOT_SUPP, S_OK, TXQ, checksumSink, fnv1a, fromF32, micSource, pattern as wave, patternSource, sndBackend, toF32, type SndParams, type SndState,
} from '../web/snd.ts';

const RATE_48000 = 7;

/** Little-endian u32s (a bigint is a u64), then raw bytes. */
function bytes(...fields: (number | bigint | Uint8Array)[]) {
  const parts = fields.map((f) => {
    if (f instanceof Uint8Array) return f;
    const b = new Uint8Array(typeof f === 'bigint' ? 8 : 4);
    if (typeof f === 'bigint') new DataView(b.buffer).setBigUint64(0, f, true);
    else new DataView(b.buffer).setUint32(0, f, true);
    return b;
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), at += p.length;
  return out;
}

const setParams = ({ stream = 0, buffer = 16384, period = 4096, features = 0, channels = 2, format = FMT_S16, rate = RATE_48000 } = {}) =>
  bytes(R_PCM_SET_PARAMS, stream, buffer, period, features, new Uint8Array([channels, format, rate, 0]));
const pcm = (code: number, stream = 0) => bytes(code, stream);
const query = (code: number, start: number, count: number, size: number) => bytes(code, start, count, size);

/** A device on 1 MiB of RAM; requests are laid out in it one after the other, completions recorded. */
function rig(sink = checksumSink(1 << 20), source = patternSource()) {
  const ram = new Uint8Array(1 << 20);
  const done: { w0: number; len: number }[] = [];
  const ctx: Ctx = { ram: () => ram, ramSize: ram.length, complete: (w0, len) => done.push({ w0, len }), config: () => new Uint8Array(256), changeConfig: () => {}, untaken: () => 0 };
  const dev = sndBackend(ctx, sink, source);
  let free = 0;
  let head = 0;
  /** Posts a chain (readable `read`, then writable buffers of `write` bytes); returns it. */
  const post = (queue: number, read: Uint8Array[], write: number[]) => {
    const seg = (len: number) => {
      const s = { off: free, len };
      free += len;
      return s;
    };
    const r: Request = { w0: head++ | queue << 16, queue, read: read.map((b) => { const s = seg(b.length); ram.set(b, s.off); return s; }), write: write.map(seg) };
    const len = dev.request(r); // a number completes now, as Devices.poll does
    if (len !== undefined) done.push({ w0: r.w0, len });
    return r;
  };
  /** A DEVICE exit: its requests, then the end of the exit. */
  const exit = (...posts: (() => Request)[]) => {
    const rs = posts.map((p) => p());
    dev.polled();
    return rs;
  };
  const written = (r: Request) => {
    const out: number[] = [];
    for (const s of r.write) out.push(...ram.subarray(s.off, s.off + s.len));
    return new Uint8Array(out);
  };
  /** Sends a control request; returns its completion and its reply's status (and the reply). */
  const control = (cmd: Uint8Array, room = 4) => {
    const before = done.length;
    const [r] = exit(() => post(CONTROLQ, [cmd], [room]));
    const c = done.slice(before).find((d) => d.w0 === r.w0);
    assert.ok(c, 'a control request completes at once');
    const reply = written(r).subarray(0, c.len);
    return { status: new DataView(reply.buffer, reply.byteOffset).getUint32(0, true), reply, len: c.len };
  };
  const status = (cmd: Uint8Array, room = 4) => control(cmd, room).status;
  /** A transmit message of `frames` bytes (stream 0 unless given); its status is the last 8 writable bytes. */
  const tx = (frames: Uint8Array, stream = 0, room = 8) => post(TXQ, [bytes(stream), frames], [room]);
  const txStatus = (r: Request) => {
    const w = written(r);
    return w.length >= 8 ? [new DataView(w.buffer).getUint32(w.length - 8, true), new DataView(w.buffer).getUint32(w.length - 4, true)] : [];
  };
  const completed = (r: Request) => done.filter((d) => d.w0 === r.w0);
  /** A receive message with room for `bytes` of frames and the status (stream 1 unless given). */
  const rx = (bytes_: number, stream = 1, write = [bytes_, 8]) => post(RXQ, [bytes(stream)], write);
  return { ram, done, dev, sink, source, post, exit, control, status, tx, txStatus, completed, written, rx };
}

/** `n` bytes of a recognizable pattern, starting at `seed`. */
const pattern = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, k) => (k * 7 + seed) & 0xff);

test('snd: the device entry and config space (jacks 0, streams 2, chmaps 0)', () => {
  const { entry, config } = deviceEntry({ type: 'snd' });
  assert.deepEqual(entry, [25n, 0n, 4n, 64n, 12n]);
  assert.deepEqual([...config], [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
});

test('snd: PCM_INFO answers the output and the input stream; info queries out of range, too small or with no room are BAD_MSG', () => {
  const r = rig();
  const info = r.control(query(R_PCM_INFO, 0, 1, 32), 36);
  assert.equal(info.status, S_OK);
  assert.equal(info.len, 36);
  const v = new DataView(info.reply.buffer, info.reply.byteOffset + 4, 32);
  // hda_fn_nid 0, features 0, formats S16 | S32 | FLOAT, rates 8-192 kHz, output, 1-2 channels, padding.
  assert.deepEqual([v.getUint32(0, true), v.getUint32(4, true), v.getBigUint64(8, true), v.getBigUint64(16, true)], [0, 0, 1n << 5n | 1n << 17n | 1n << 19n, BigInt(RATE_BITS)]);
  assert.deepEqual([...info.reply.subarray(28, 36)], [0, 1, 2, 0, 0, 0, 0, 0]);
  // A larger item size (a newer driver's struct): ours, then zeros.
  const big = r.control(query(R_PCM_INFO, 0, 1, 40), 44);
  assert.equal(big.status, S_OK);
  assert.equal(big.len, 44);
  assert.deepEqual([...big.reply.subarray(4, 36)], [...info.reply.subarray(4, 36)]);
  // Both: the input stream is the same but for its direction.
  const both = r.control(query(R_PCM_INFO, 0, 2, 32), 68);
  assert.equal(both.status, S_OK);
  assert.deepEqual([...both.reply.subarray(4, 36)], [...info.reply.subarray(4, 36)]);
  assert.deepEqual([...both.reply.subarray(36, 68)], [...info.reply.subarray(4, 28), 1, 1, 2, 0, 0, 0, 0, 0]);
  assert.deepEqual([...r.control(query(R_PCM_INFO, 1, 1, 32), 36).reply.subarray(4)], [...both.reply.subarray(36, 68)]);
  assert.equal(r.status(query(R_PCM_INFO, 2, 0, 32)), S_OK); // nothing asked, nothing answered
  for (const [cmd, room] of [
    [query(R_PCM_INFO, 0, 3, 32), 100], // past the streams
    [query(R_PCM_INFO, 2, 1, 32), 36],
    [query(R_PCM_INFO, 3, 0, 32), 4],
    [query(R_PCM_INFO, 0, 2, 32), 67], // no room for the second
    [query(R_PCM_INFO, 0xffffffff, 2, 32), 68], // start + count wraps
    [query(R_PCM_INFO, 0, 1, 31), 36], // an item smaller than the struct
    [query(R_PCM_INFO, 0, 1, 32), 35], // no room for it
    [bytes(R_PCM_INFO, 0, 1), 36], // short
    [query(R_JACK_INFO, 0, 1, 24), 28], // no jacks
    [query(R_CHMAP_INFO, 0, 1, 24), 28], // no channel maps
    [bytes(R_JACK_REMAP, 0, 0, 0), 4],
    [new Uint8Array(3), 4],
  ] as const) assert.equal(r.status(cmd, room), S_BAD_MSG, `${[...cmd]}`);
  assert.equal(r.status(query(R_JACK_INFO, 0, 0, 24)), S_OK);
  assert.equal(r.status(query(R_CHMAP_INFO, 0, 0, 24)), S_OK);
  for (const code of [0, 3, 0x106, 0x201, 0x300, 0x1000, 0x8000]) assert.equal(r.status(bytes(code, 0, 0, 0)), S_NOT_SUPP, `code ${code}`);
  // No room for even a status: completed with nothing written.
  const before = r.done.length;
  const [c] = r.exit(() => r.post(CONTROLQ, [query(R_PCM_INFO, 0, 1, 32)], [3]));
  assert.deepEqual(r.done.slice(before), [{ w0: c.w0, len: 0 }]);
});

test('snd: SET_PARAMS takes the offered formats, rates and channels; NOT_SUPP for the rest, BAD_MSG for bad sizes', () => {
  const r = rig();
  for (const p of [{}, { format: FMT_S32, buffer: 32768, period: 8192 }, { format: FMT_FLOAT, channels: 1, buffer: 4096, period: 1024 }, { rate: 1 }, { rate: 12 }, { rate: 6, buffer: 17616, period: 4404 }]) {
    assert.equal(r.status(setParams(p)), S_OK, JSON.stringify(p));
  }
  for (const p of [{ format: 3 }, { format: 4 }, { format: 6 }, { format: 20 }, { format: 0 }, { rate: 0 }, { rate: 13 }, { rate: 14 }, { rate: 40 }, { rate: 255 }, { channels: 0 }, { channels: 3 }, { features: 1 << 4 }, { features: 1 }]) {
    assert.equal(r.status(setParams(p)), S_NOT_SUPP, JSON.stringify(p));
  }
  for (const p of [{ period: 0 }, { buffer: 0 }, { period: 4094 }, { buffer: 16000 }, { period: 6, buffer: 12 }, { stream: 2 }]) {
    assert.equal(r.status(setParams(p)), S_BAD_MSG, JSON.stringify(p));
  }
  assert.equal(r.status(setParams().subarray(0, 23)), S_BAD_MSG); // short
  assert.equal(r.status(setParams({ format: FMT_S32, channels: 1, period: 6, buffer: 12 })), S_BAD_MSG); // 6 bytes isn't a whole frame of S32
  assert.deepEqual(r.dev.snd.params, { bufferBytes: 17616, periodBytes: 4404, channels: 2, format: FMT_S16, rate: 44100 }, 'the last accepted');
});

test('snd: the stream lifecycle follows the spec; a request out of order is BAD_MSG', () => {
  const r = rig();
  for (const code of [R_PCM_PREPARE, R_PCM_START, R_PCM_STOP, R_PCM_RELEASE]) assert.equal(r.status(pcm(code)), S_BAD_MSG, `${code} before SET_PARAMS`);
  assert.equal(r.status(pcm(R_PCM_PREPARE, 2)), S_BAD_MSG, 'no stream 2');
  assert.equal(r.status(bytes(R_PCM_PREPARE)), S_BAD_MSG, 'short');
  assert.equal(r.status(setParams()), S_OK);
  for (const code of [R_PCM_START, R_PCM_STOP, R_PCM_RELEASE]) assert.equal(r.status(pcm(code)), S_BAD_MSG, `${code} before PREPARE`);
  assert.equal(r.status(pcm(R_PCM_PREPARE)), S_OK);
  assert.equal(r.status(pcm(R_PCM_PREPARE)), S_OK, 'again');
  assert.equal(r.status(pcm(R_PCM_STOP)), S_BAD_MSG);
  assert.equal(r.status(setParams()), S_OK, 'SET_PARAMS while prepared');
  assert.equal(r.status(pcm(R_PCM_PREPARE)), S_OK);
  assert.equal(r.status(pcm(R_PCM_START)), S_OK);
  for (const cmd of [setParams(), pcm(R_PCM_PREPARE), pcm(R_PCM_START), pcm(R_PCM_RELEASE)]) assert.equal(r.status(cmd), S_BAD_MSG, `${[...cmd.subarray(0, 4)]} while started`);
  assert.equal(r.status(pcm(R_PCM_STOP)), S_OK);
  assert.equal(r.status(pcm(R_PCM_STOP)), S_BAD_MSG);
  assert.equal(r.status(pcm(R_PCM_START)), S_OK, 'a pause released');
  assert.equal(r.status(pcm(R_PCM_STOP)), S_OK);
  assert.equal(r.status(pcm(R_PCM_RELEASE)), S_OK);
  assert.equal(r.status(pcm(R_PCM_RELEASE)), S_BAD_MSG);
  assert.equal(r.status(pcm(R_PCM_START)), S_BAD_MSG);
  assert.equal(r.status(pcm(R_PCM_PREPARE)), S_OK, 'PREPARE after RELEASE');
  assert.equal(r.status(pcm(R_PCM_RELEASE)), S_OK, 'RELEASE from PREPARE');
  assert.equal(r.status(setParams()), S_OK, 'SET_PARAMS after RELEASE');
  assert.deepEqual(r.dev.snd.log.slice(0, 3), ['PCM_PREPARE BAD_MSG', 'PCM_START BAD_MSG', 'PCM_STOP BAD_MSG']);
  assert.ok(r.dev.snd.log.includes('PCM_SET_PARAMS 2ch S16 48000 16384/4096 OK'));
});

test('snd: messages wait for START, play at the end of its exit in order, and the sink hashes their frames', () => {
  const r = rig();
  r.status(setParams());
  r.status(pcm(R_PCM_PREPARE));
  const frames = [0, 1].map((k) => pattern(4096, k));
  const held = r.exit(() => r.tx(frames[0]), () => r.tx(frames[1]));
  assert.deepEqual(held.map(r.completed), [[], []], 'held while prepared');
  r.status(pcm(R_PCM_START));
  for (const m of held) {
    assert.deepEqual(r.completed(m), [{ w0: m.w0, len: 8 }]);
    assert.deepEqual(r.txStatus(m), [S_OK, 0]);
  }
  // Started: a message completes at the end of the exit that posted it, not before.
  const now = r.post(TXQ, [bytes(0), pattern(4096, 2)], [8]);
  assert.deepEqual(r.completed(now), []);
  r.dev.polled();
  assert.deepEqual(r.completed(now), [{ w0: now.w0, len: 8 }]);
  // A status split over buffers: the last 8 writable bytes, nothing before them.
  const split = r.post(TXQ, [bytes(0), pattern(1024, 3)], [3, 2, 6]);
  r.dev.polled();
  assert.deepEqual(r.completed(split), [{ w0: split.w0, len: 8 }]);
  assert.deepEqual([...r.ram.subarray(split.write[0].off, split.write[0].off + 3)], [0, 0, 0]);
  assert.deepEqual(r.txStatus(split), [S_OK, 0]);
  const all = new Uint8Array([...frames[0], ...frames[1], ...pattern(4096, 2), ...pattern(1024, 3)]);
  assert.deepEqual(r.sink.played(), { frames: all.length / 4, bytes: all.length, messages: 4, fnv: fnv1a(all).toString(16).padStart(8, '0') });
  assert.equal(Buffer.compare(r.sink.kept(), all), 0, 'the frames as given');
});

test('snd: an exit completes at most a buffer less a period (Linux reads its position modulo the buffer)', () => {
  const r = rig();
  r.status(setParams()); // 4 periods of 4096
  r.status(pcm(R_PCM_PREPARE));
  const four = r.exit(...[0, 1, 2, 3].map((k) => () => r.tx(pattern(4096, k))));
  r.status(pcm(R_PCM_START));
  assert.deepEqual(four.map((m) => r.completed(m).length), [1, 1, 1, 0], 'three at START');
  const next = r.exit(() => r.tx(pattern(4096, 4)));
  assert.deepEqual([...four, ...next].map((m) => r.completed(m).length), [1, 1, 1, 1, 1], 'the fourth and the next at the next exit');
  // Short messages: as many as fit in three periods' bytes.
  const small = r.exit(...[0, 1, 2, 3, 4, 5, 6].map((k) => () => r.tx(pattern(2048, k))));
  assert.deepEqual(small.map((m) => r.completed(m).length), [1, 1, 1, 1, 1, 1, 0]);
  r.exit();
  assert.equal(r.completed(small[6]).length, 1, 'at any exit');
  assert.equal(r.sink.played().messages, 12);
});

test('snd: STOP pauses (messages wait), START resumes, RELEASE returns what is held without playing it', () => {
  const r = rig();
  r.status(setParams());
  r.status(pcm(R_PCM_PREPARE));
  r.status(pcm(R_PCM_START));
  r.exit(() => r.tx(pattern(4096)));
  r.status(pcm(R_PCM_STOP));
  const paused = r.exit(() => r.tx(pattern(4096, 1)));
  assert.deepEqual(r.completed(paused[0]), [], 'held while stopped');
  r.status(pcm(R_PCM_START));
  assert.equal(r.completed(paused[0]).length, 1, 'played after the pause');
  r.status(pcm(R_PCM_STOP));
  const back = r.exit(() => r.tx(pattern(4096, 2)), () => r.tx(pattern(4096, 3)));
  const played = r.sink.played();
  const before = r.done.length;
  const rel = r.control(pcm(R_PCM_RELEASE));
  assert.equal(rel.status, S_OK);
  // The RELEASE's reply, then the messages in order, each OK.
  assert.deepEqual(r.done.slice(before).map((d) => d.w0 & 0xffff0000), [CONTROLQ << 16, TXQ << 16, TXQ << 16]);
  for (const m of back) assert.deepEqual(r.txStatus(m), [S_OK, 0]);
  assert.deepEqual(r.sink.played(), played, 'returned, not played');
  // Given to the sink but not played yet (the burst limit) and released: returned once.
  r.status(pcm(R_PCM_PREPARE));
  const queued = r.exit(...[0, 1, 2, 3].map((k) => () => r.tx(pattern(4096, k))));
  r.status(pcm(R_PCM_START));
  r.status(pcm(R_PCM_STOP));
  r.status(pcm(R_PCM_RELEASE));
  r.exit();
  assert.deepEqual(queued.map((m) => r.completed(m).length), [1, 1, 1, 1]);
  assert.equal(r.sink.played().messages, played.messages + 3);
});

test('snd: transmit messages that are malformed or out of place are BAD_MSG at once; event buffers are held', () => {
  const r = rig();
  const early = r.tx(pattern(4096));
  assert.deepEqual(r.txStatus(early), [S_BAD_MSG, 0], 'before SET_PARAMS');
  r.status(setParams());
  const unprepared = r.tx(pattern(4096));
  assert.deepEqual(r.txStatus(unprepared), [S_BAD_MSG, 0]);
  r.status(pcm(R_PCM_PREPARE));
  for (const m of [r.tx(pattern(4096), 1), r.tx(pattern(4096), 2), r.tx(pattern(4095)), r.post(TXQ, [new Uint8Array(3)], [8])]) {
    assert.deepEqual(r.completed(m), [{ w0: m.w0, len: 8 }]);
    assert.deepEqual(r.txStatus(m), [S_BAD_MSG, 0]);
  }
  const noRoom = r.tx(pattern(4096), 0, 7);
  r.dev.polled();
  assert.deepEqual(r.completed(noRoom), [], 'held: valid, only its status has no room');
  r.status(pcm(R_PCM_START));
  assert.deepEqual(r.completed(noRoom), [{ w0: noRoom.w0, len: 0 }], 'completed with nothing written');
  const ev = r.exit(() => r.post(EVENTQ, [], [8]));
  assert.deepEqual(r.completed(ev[0]), []);
});

test('snd: a virtio reset drops what is held (nothing completes for it) and the stream state', () => {
  const r = rig();
  r.status(setParams());
  r.status(pcm(R_PCM_PREPARE));
  const held = r.exit(() => r.tx(pattern(4096)), () => r.post(EVENTQ, [], [8]));
  r.dev.reset();
  r.exit();
  assert.deepEqual(held.map(r.completed), [[], []]);
  assert.equal(r.dev.snd.state, 'none');
  assert.equal(r.status(pcm(R_PCM_START)), S_BAD_MSG);
});

test('snd: save and restore keep the stream, the log and the sink; held messages posted again play once', () => {
  const r = rig();
  r.status(setParams());
  r.status(pcm(R_PCM_PREPARE));
  const first = r.exit(...[0, 1, 2, 3].map((k) => () => r.tx(pattern(4096, k))));
  r.status(pcm(R_PCM_START)); // three played, the fourth held
  const state = JSON.parse(JSON.stringify(r.dev.save())) as SndState;
  assert.equal(state.streams[0].state, 'started');
  assert.equal((state.sink as { messages: number }).messages, 3);
  // A new VM: the core posts the held chain again (its bytes are in the restored RAM).
  const s = rig();
  s.ram.set(r.ram);
  s.dev.restore(state);
  const again = s.exit(() => s.post(TXQ, first[3].read.map((g) => r.ram.slice(g.off, g.off + g.len)), [8]));
  assert.equal(s.completed(again[0]).length, 1);
  const all = new Uint8Array([0, 1, 2, 3].flatMap((k) => [...pattern(4096, k)]));
  assert.deepEqual(s.sink.played(), { frames: 4096, bytes: 16384, messages: 4, fnv: fnv1a(all).toString(16).padStart(8, '0') });
  assert.deepEqual(s.dev.snd.log, r.dev.snd.log);
  assert.equal(s.status(pcm(R_PCM_STOP)), S_OK, 'still started');
  const started = state.streams[0];
  for (const bad of [null, {}, { ...state, streams: [{ ...started, state: 'playing' }] }, { ...state, log: 'x' }, { ...state, streams: [{ ...started, params: null }] }, { ...state, streams: [started, started, started] }, { ...state, sink: { frames: 1 } }, { ...state, source: { frames: 1 } }]) {
    assert.throws(() => rig().dev.restore(bad), /no state for the sound device/, JSON.stringify(bad));
  }
  // A state from before the input stream (the output's `state` and `params`) loads: the input is new.
  const old = rig();
  old.dev.restore({ state: 'started', params: started.params, log: state.log, sink: state.sink });
  assert.equal(old.dev.snd.streams[0].state, 'started');
  assert.equal(old.dev.snd.streams[1].state, 'none');
  assert.equal(old.status(pcm(R_PCM_STOP)), S_OK);
});

test('snd: toF32 converts S16, S32 and FLOAT', () => {
  const s16 = new Uint8Array(new Int16Array([-32768, -1, 0, 1, 16384, 32767]).buffer);
  assert.deepEqual([...toF32(s16, FMT_S16)], [-1, -1 / 32768, 0, 1 / 32768, 0.5, 32767 / 32768]);
  const s32 = new Uint8Array(new Int32Array([-2147483648, 0, 1073741824, 2147483647]).buffer);
  assert.deepEqual([...toF32(s32, FMT_S32)], [-1, 0, 0.5, Math.fround(2147483647 / 2147483648)]);
  const f = new Float32Array([-1, 0.25, 1, 1.5]);
  assert.deepEqual([...toF32(new Uint8Array(f.buffer), FMT_FLOAT)], [-1, 0.25, 1, 1.5]);
  // Unaligned, from the middle of a buffer (guest RAM is read in place).
  const odd = new Uint8Array(5);
  odd.set(s16.subarray(8, 12), 1);
  assert.deepEqual([...toF32(odd.subarray(1), FMT_S16)], [0.5, 32767 / 32768]);
  assert.throws(() => toF32(new Uint8Array(4), 3), /no conversion/);
});

/** The input stream set up (4 periods of 4096 bytes: S16 stereo 1024 frames) and prepared. */
function capture(r: ReturnType<typeof rig>) {
  assert.equal(r.status(setParams({ stream: 1 })), S_OK);
  assert.equal(r.status(pcm(R_PCM_PREPARE, 1)), S_OK);
}
const P_IN: SndParams = { bufferBytes: 16384, periodBytes: 4096, channels: 2, format: FMT_S16, rate: 48000 };

test('snd: the input stream has its own lifecycle; the log names it', () => {
  const r = rig();
  r.status(setParams());
  r.status(pcm(R_PCM_PREPARE));
  r.status(pcm(R_PCM_START));
  assert.equal(r.status(pcm(R_PCM_START, 1)), S_BAD_MSG, 'the input has no parameters');
  capture(r);
  assert.equal(r.status(pcm(R_PCM_START, 1)), S_OK);
  assert.equal(r.status(pcm(R_PCM_STOP)), S_OK);
  assert.deepEqual([r.dev.snd.streams[0].state, r.dev.snd.streams[1].state], ['stopped', 'started']);
  assert.deepEqual(r.dev.snd.log.slice(-4), ['PCM_SET_PARAMS#1 2ch S16 48000 16384/4096 OK', 'PCM_PREPARE#1 OK', 'PCM_START#1 OK', 'PCM_STOP OK']);
});

test('snd: receive messages wait for the input\'s START and are filled with the pattern at the end of their exit, a buffer less a period at most', () => {
  const r = rig();
  capture(r);
  const four = r.exit(...[0, 1, 2, 3].map(() => () => r.rx(4096)));
  assert.deepEqual(four.map(r.completed), [[], [], [], []], 'held while prepared');
  r.status(pcm(R_PCM_START)); // the output's START (no parameters: BAD_MSG) starts nothing
  assert.deepEqual(four.map(r.completed), [[], [], [], []]);
  r.status(pcm(R_PCM_START, 1));
  assert.deepEqual(four.map((m) => r.completed(m).length), [1, 1, 1, 0], 'three at START');
  r.exit();
  assert.deepEqual(four.map((m) => r.completed(m)), four.map((m) => [{ w0: m.w0, len: 4096 + 8 }]), 'the fourth at the next exit; frames and status written');
  // The frames, then OK and latency 0.
  const all = new Uint8Array(four.flatMap((m) => [...r.written(m).subarray(0, 4096)]));
  assert.equal(Buffer.compare(all, wave(P_IN, 0, 16384)), 0);
  for (const m of four) assert.deepEqual(r.txStatus(m), [S_OK, 0]);
  // A 1 kHz triangle left (48 frames), 1.5 kHz right (32): -12000 at frame 0, 0 a quarter in, 12000 half-way.
  const v = new Int16Array(all.buffer, 0, 128);
  assert.deepEqual([v[0], v[1], v[24], v[2 * 24], v[2 * 16 + 1], v[2 * 47], v[2 * 48]], [-12000, -12000, 0, 12000, 12000, -11000, -12000]);
  assert.deepEqual(r.source.recorded(), { frames: 4096, bytes: 16384, messages: 4, fnv: fnv1a(all).toString(16).padStart(8, '0') });
  // Frames split over buffers, the status in the last 8 bytes.
  const split = r.rx(1024, 1, [1000, 30, 2]);
  r.dev.polled();
  assert.deepEqual(r.completed(split), [{ w0: split.w0, len: 1032 }]);
  assert.equal(Buffer.compare(r.written(split).subarray(0, 1024), wave(P_IN, 4096, 1024)), 0, 'the pattern goes on');
  assert.deepEqual(r.txStatus(split), [S_OK, 0]);
});

test('snd: the pattern in each format; a mono stream gets the left', () => {
  const s32 = new Int32Array(wave({ ...P_IN, format: FMT_S32 }, 12, 16).buffer); // frames 12 and 13
  assert.deepEqual([...s32], [0, 6000 * 65536, 1000 * 65536, 7500 * 65536]);
  const f32 = new Float32Array(wave({ ...P_IN, format: FMT_FLOAT, channels: 1 }, 24, 8).buffer); // frames 24 and 25
  assert.deepEqual([...f32], [12000 / 32768, 11000 / 32768]);
  assert.deepEqual([...new Int16Array(wave({ ...P_IN, channels: 1 }, 0, 4).buffer)], [-12000, -11000]);
});

test('snd: receive messages malformed or out of place are BAD_MSG; STOP pauses; RELEASE returns them unfilled', () => {
  const r = rig();
  const early = r.rx(4096);
  assert.deepEqual(r.txStatus(early), [S_BAD_MSG, 0], 'before SET_PARAMS');
  capture(r);
  for (const m of [r.rx(4096, 0), r.rx(4096, 2), r.rx(4094), r.rx(0), r.post(RXQ, [new Uint8Array(3)], [4096, 8])]) {
    assert.deepEqual(r.completed(m), [{ w0: m.w0, len: 8 }]);
    assert.deepEqual(r.txStatus(m), [S_BAD_MSG, 0]);
  }
  r.status(pcm(R_PCM_START, 1));
  r.exit(() => r.rx(4096));
  r.status(pcm(R_PCM_STOP, 1));
  const paused = r.exit(() => r.rx(4096));
  assert.deepEqual(r.completed(paused[0]), [], 'held while stopped');
  const recorded = r.source.recorded();
  const before = r.done.length;
  r.status(pcm(R_PCM_RELEASE, 1));
  assert.deepEqual(r.done.slice(before).map((d) => [d.w0 & 0xffff0000, d.len]), [[CONTROLQ << 16, 4], [RXQ << 16, 8]], 'the reply, then the message with only its status');
  assert.deepEqual(r.source.recorded(), recorded, 'returned, not filled');
});

test('snd: save and restore keep the input stream and the source; a held receive message posted again is filled once, the pattern going on', () => {
  const r = rig();
  capture(r);
  const first = r.exit(...[0, 1, 2, 3].map(() => () => r.rx(4096)));
  r.status(pcm(R_PCM_START, 1)); // three filled, the fourth held
  const state = JSON.parse(JSON.stringify(r.dev.save())) as SndState;
  assert.equal(state.streams[1].state, 'started');
  const s = rig();
  s.ram.set(r.ram);
  s.dev.restore(state);
  const again = s.exit(() => s.post(RXQ, first[3].read.map((g) => r.ram.slice(g.off, g.off + g.len)), [4096, 8]));
  assert.equal(s.completed(again[0]).length, 1);
  assert.equal(Buffer.compare(s.written(again[0]).subarray(0, 4096), wave(P_IN, 3072, 4096)), 0);
  assert.equal(s.source.recorded().fnv, fnv1a(wave(P_IN, 0, 16384)).toString(16).padStart(8, '0'));
});

test('snd: with no microphone the source records silence at the stream\'s rate, a buffer less a period since the guest last posted, paused while stopped', () => {
  let t = 1000;
  let untaken = 0;
  const src = micSource({ now: () => t, schedule: false, untaken: () => untaken });
  const got: number[] = [];
  const ask = (k: number) => src.record(P_IN, 4096, (data) => { assert.ok(data.length === 4096 && data.every((b) => b === 0)); got.push(k); });
  for (const k of [0, 1, 2, 3]) ask(k);
  src.start(P_IN);
  const at = (ms: number) => { t = ms; src.pump(); };
  at(1021);
  assert.deepEqual(got, [], '1008 frames: not a period yet');
  at(1022);
  assert.deepEqual(got, [0]);
  untaken = 3;
  at(1090);
  assert.deepEqual(got, [0, 1, 2], 'a buffer less a period without a message');
  at(1200);
  assert.deepEqual(got, [0, 1, 2], 'and not by time while the core hasn\'t taken them');
  untaken = 0;
  at(1201);
  at(1273);
  assert.deepEqual(got, [0, 1, 2], 'half a buffer\'s time and 30 ms (72.7 ms) after they were taken: not yet');
  at(1274);
  assert.deepEqual(got, [0, 1, 2, 3]);
  ask(4); // 5 periods given at 1274 ms: 5120 frames of 13,152
  at(1275);
  assert.deepEqual(got, [0, 1, 2, 3, 4], 'a message: the guest ran');
  src.stop();
  ask(5);
  at(5000);
  assert.deepEqual(got.length, 5, 'stopped: the clock stands');
  src.start(P_IN); // counted afresh from here
  at(5021);
  assert.deepEqual(got.length, 5);
  at(5022);
  assert.deepEqual(got.length, 6);
});

test('snd: the microphone\'s ring: frames in order in the stream\'s format while its worklet fills it, at most a buffer behind; silence by the clock when it stops', () => {
  let t = 1000;
  const src = micSource({ now: () => t, schedule: false });
  const { h, data } = ringViews(src.ring);
  let written = 0;
  /** The worklet: `n` frames, left counting up from `written`, right its negative, and a heartbeat. */
  const quantum = (n: number) => {
    for (let k = 0; k < n; k++) {
      const i = 2 * ((written + k) % CAPACITY);
      data[i] = (written + k) / 65536;
      data[i + 1] = -(written + k) / 65536;
    }
    written += n;
    Atomics.store(h, WRITE, written);
    Atomics.add(h, QUANTA, 1);
  };
  const got: Uint8Array[] = [];
  const ask = () => src.record(P_IN, 4096, (d) => got.push(d));
  for (let k = 0; k < 4; k++) ask();
  src.start(P_IN);
  assert.deepEqual([Atomics.load(h, RUN), Atomics.load(h, RATE)], [1, 48000], 'the page is asked for the microphone at the stream\'s rate');
  const at = (ms: number) => { t = ms; src.pump(); };
  quantum(512); // from before: stale when the ring goes live
  at(1001);
  quantum(1000);
  at(1002);
  assert.equal(got.length, 0, 'not a period yet');
  quantum(100);
  at(1003);
  assert.equal(got.length, 1);
  const s16 = new Int16Array(got[0].buffer);
  assert.deepEqual([s16[0], s16[1], s16[2], s16[2 * 1023]], [Math.round((512 / 65536) * 32767), -Math.round((512 / 65536) * 32767), Math.round((513 / 65536) * 32767), Math.round((1535 / 65536) * 32767)], 'from the frames written once live');
  // Mono: the mean of the channels (here 0); FLOAT as it comes, clamped.
  assert.deepEqual([...new Int16Array(fromF32(new Float32Array([0.5, -0.5, 1, 1]), { ...P_IN, channels: 1 }).buffer)], [0, 32767]);
  assert.deepEqual([...new Float32Array(fromF32(new Float32Array([2, -0.25]), { ...P_IN, format: FMT_FLOAT }).buffer)], [1, -0.25]);
  // A stall: 10,000 frames come at once; the next message starts at most a buffer (4096 frames) behind the newest.
  quantum(10_000);
  at(1004);
  const first = Math.round(new Int16Array(got[1].buffer)[0] / 32767 * 65536);
  assert.ok(Math.abs(first - (written - 4096)) <= 1, `${first} vs ${written - 4096}`);
  // The worklet stops (no heartbeat for 50 ms): silence by the clock from then.
  const n = got.length;
  at(1060);
  ask();
  at(1060 + 22);
  assert.equal(got.length, n + 1);
  assert.ok(got[n].every((b) => b === 0));
});
