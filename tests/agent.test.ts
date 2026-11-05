// Clipboard sharing's channel without a guest (docs/plans/clipboard.md §2): the agent's virtio-console
// (web/agent-device.ts) driven through hand-built queues as Linux's virtio_console drives it (the control handshake,
// the port's name, the guest's opens and closes, bytes both ways across buffers, a snapshot's state), the frames
// (web/agent-frame.ts), and the page's end (web/app/agent-link.ts): its window of bytes in flight.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AGENT_PORTS, agentDevice, agentEntry, CTL_RX, CTL_TX, DEVICE_READY, F_MULTIPORT, MAX_PENDING, PORT_ADD, PORT_NAME, PORT_OPEN, PORT_READY, type AgentFromDevice } from '../web/agent-device.ts';
import { encodeFrame, FRAME, FrameReader, MAX_PAYLOAD } from '../web/agent-frame.ts';
import { AgentLink, WINDOW } from '../web/app/agent-link.ts';
import type { Ctx } from '../web/devices.ts';

/** A guest's RAM and the device's completions; `at` hands out buffers, one region per call. */
function guest() {
  const ram = new Uint8Array(1 << 20);
  const done: { w0: number; len: number }[] = [];
  let next = 0;
  let w0 = 0;
  const ctx = { ram: () => [ram], complete: (w: number, len: number) => done.push({ w0: w, len }) } as unknown as Ctx;
  const at = (len: number) => {
    const off = next;
    next += len;
    return { off, len, mem: 0 };
  };
  /** A driver-to-device buffer holding `bytes`. */
  const out = (queue: number, bytes: Uint8Array) => {
    const s = at(bytes.length);
    ram.set(bytes, s.off);
    return { w0: ++w0, queue, read: [s], write: [] };
  };
  /** A device-to-driver buffer of `len` bytes (in `pieces` segments). */
  const into = (queue: number, len: number, pieces = 1) => ({ w0: ++w0, queue, read: [], write: Array.from({ length: pieces }, () => at(len / pieces)) });
  /** What the device wrote into a buffer it completed. */
  const read = (r: ReturnType<typeof into>, len: number) => {
    const b = new Uint8Array(len);
    let k = 0;
    for (const s of r.write) {
      const n = Math.min(s.len, len - k);
      b.set(ram.subarray(s.off, s.off + n), k);
      k += n;
    }
    return b;
  };
  return { ram, ctx, done, out, into, read };
}

const control = (id: number, event: number, value: number) => {
  const m = new Uint8Array(8);
  const v = new DataView(m.buffer);
  v.setUint32(0, id, true);
  v.setUint16(4, event, true);
  v.setUint16(6, value, true);
  return m;
};
const parse = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { id: v.getUint32(0, true), event: v.getUint16(4, true), value: v.getUint16(6, true), extra: b.subarray(8) };
};

/** The messages a port receives, as they come. */
function listen(port: MessagePort) {
  const got: AgentFromDevice[] = [];
  const waiters: (() => void)[] = [];
  port.onmessage = (e) => {
    got.push(e.data);
    waiters.splice(0).forEach((w) => w());
  };
  /** Resolves with the first message (taken off the list) that `pred` accepts, waiting for it. */
  const next = async (pred: (m: AgentFromDevice) => boolean = () => true, ms = 2000): Promise<AgentFromDevice> => {
    const end = Date.now() + ms;
    for (;;) {
      const i = got.findIndex(pred);
      if (i >= 0) return got.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`no such message; got ${JSON.stringify(got)}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { got, next };
}

/** A device whose driver has done the handshake (as Linux's does: buffers on the control queue, DEVICE_READY, PORT_READY). */
const open: MessagePort[] = [];
after(() => open.forEach((p) => p.close()));
/** A MessageChannel whose ports are closed when the tests end, whatever happened. */
function channel() {
  const c = new MessageChannel();
  open.push(c.port1, c.port2);
  return c;
}

function handshake() {
  const g = guest();
  const { port1, port2 } = channel();
  const dev = agentDevice(g.ctx, { type: 'agent', port: port2 });
  const ctl = Array.from({ length: 4 }, () => g.into(CTL_RX, 64));
  for (const r of ctl) assert.equal(dev.request(r), undefined, 'control buffers are held');
  assert.equal(dev.request(g.out(CTL_TX, control(0xffffffff, DEVICE_READY, 1))), 0);
  const add = parse(g.read(ctl[0], 8));
  assert.deepEqual([add.id, add.event], [0, PORT_ADD], 'the port added on DEVICE_READY');
  assert.equal(g.done.find((d) => d.w0 === ctl[0].w0)?.len, 8);
  dev.request(g.out(CTL_TX, control(0, PORT_READY, 1)));
  const name = g.done.find((d) => d.w0 === ctl[1].w0)!;
  const n = parse(g.read(ctl[1], name.len));
  assert.deepEqual([n.id, n.event, new TextDecoder().decode(n.extra)], [0, PORT_NAME, AGENT_PORTS[0]], 'named on PORT_READY');
  const open = parse(g.read(ctl[2], 8));
  assert.deepEqual([open.id, open.event, open.value], [0, PORT_OPEN, 1], 'the host end is open');
  return { g, dev, page: port1, ctl };
}

test('the agent device: one port, MULTIPORT, four queues', () => {
  const { entry, config } = agentEntry();
  assert.deepEqual(entry, [3n, F_MULTIPORT, 4n, 64n, 12n]);
  assert.equal(new DataView(config.buffer).getUint32(4, true), 1, 'max_nr_ports');
});

test('the agent device: the handshake names the port; a second PORT_READY or a bad id changes nothing', () => {
  const { g, dev, page } = handshake();
  const before = g.done.length;
  dev.request(g.out(CTL_TX, control(0, PORT_READY, 1)));
  dev.request(g.out(CTL_TX, control(7, PORT_OPEN, 1)));
  dev.request(g.out(CTL_TX, new Uint8Array(4))); // short: dropped
  assert.equal(g.done.length, before, 'no control message, no completion for held buffers');
  page.close();
});

test('the agent device: the guest opens the port; bytes go both ways across buffers; a close drops what waits', async () => {
  const { g, dev, page } = handshake();
  const p = listen(page);
  // Bytes from the page before the guest opens the port: dropped, as Linux drops them.
  page.postMessage({ type: 'data', port: 0, bytes: new Uint8Array([1, 2, 3]) });
  await new Promise((r) => setTimeout(r, 50));
  dev.request(g.out(CTL_TX, control(0, PORT_OPEN, 1)));
  assert.deepEqual(await p.next((m) => m.type === 'open'), { type: 'open', port: 0, open: true });
  const rx = [g.into(0, 4), g.into(0, 6, 2)];
  for (const r of rx) assert.equal(dev.request(r), undefined);
  // 12 bytes for 10 bytes of buffers: 4, then 6 across two segments; 2 wait.
  const sent = Uint8Array.from({ length: 12 }, (_, i) => 10 + i);
  page.postMessage({ type: 'data', port: 0, bytes: sent });
  assert.deepEqual(await p.next((m) => m.type === 'taken'), { type: 'taken', port: 0, n: 10 });
  assert.deepEqual([...g.read(rx[0], 4)], [10, 11, 12, 13]);
  assert.deepEqual([...g.read(rx[1], 6)], [14, 15, 16, 17, 18, 19]);
  assert.deepEqual(g.done.slice(-2).map((d) => d.len), [4, 6]);
  const last = g.into(0, 64);
  dev.request(last);
  assert.deepEqual(await p.next((m) => m.type === 'taken'), { type: 'taken', port: 0, n: 2 });
  assert.deepEqual([...g.read(last, 2)], [20, 21]);
  // The guest writes: the page gets the bytes, in one message per buffer chain.
  assert.equal(dev.request(g.out(1, new TextEncoder().encode('hello'))), 0);
  const data = await p.next((m) => m.type === 'data');
  assert.equal(data.type === 'data' && new TextDecoder().decode(data.bytes), 'hello');
  // Closed: what waits is dropped, and so is what comes while it stays closed.
  page.postMessage({ type: 'data', port: 0, bytes: new Uint8Array(5) });
  await new Promise((r) => setTimeout(r, 50));
  dev.request(g.out(CTL_TX, control(0, PORT_OPEN, 0)));
  assert.deepEqual(await p.next((m) => m.type === 'open'), { type: 'open', port: 0, open: false });
  dev.request(g.out(CTL_TX, control(0, PORT_OPEN, 1)));
  await p.next((m) => m.type === 'open');
  const fresh = g.into(0, 64);
  const doneBefore = g.done.length;
  dev.request(fresh);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(g.done.length, doneBefore, 'the bytes from before the close are gone');
  page.close();
});

test('the agent device: past MAX_PENDING the page\'s bytes are dropped (the link never sends that much)', async () => {
  const { g, dev, page } = handshake();
  const p = listen(page);
  dev.request(g.out(CTL_TX, control(0, PORT_OPEN, 1)));
  await p.next((m) => m.type === 'open');
  page.postMessage({ type: 'data', port: 0, bytes: new Uint8Array(MAX_PENDING) });
  page.postMessage({ type: 'data', port: 0, bytes: new Uint8Array([9]) });
  await new Promise((r) => setTimeout(r, 50));
  const state = dev.save!() as { ports: { pending: Uint8Array }[] };
  assert.equal(state.ports[0].pending.length, MAX_PENDING);
  page.close();
});

test('the agent device: a snapshot keeps the port open and the bytes not yet taken; a reset closes it', async () => {
  const { g, dev, page } = handshake();
  const p = listen(page);
  dev.request(g.out(CTL_TX, control(0, PORT_OPEN, 1)));
  await p.next((m) => m.type === 'open');
  page.postMessage({ type: 'data', port: 0, bytes: new Uint8Array([7, 8, 9]) });
  await new Promise((r) => setTimeout(r, 50));
  const state = structuredClone(await dev.save!());
  page.close();

  // The restored device: the page hears that the port is open, and the guest's buffers (posted again) get the bytes.
  const { port1, port2 } = channel();
  const q = listen(port1);
  const again = agentDevice(g.ctx, { type: 'agent', port: port2 });
  again.restore!(state);
  assert.deepEqual(await q.next((m) => m.type === 'open'), { type: 'open', port: 0, open: true });
  const rx = g.into(0, 16);
  again.request(rx);
  assert.deepEqual(await q.next((m) => m.type === 'taken'), { type: 'taken', port: 0, n: 3 });
  assert.deepEqual([...g.read(rx, 3)], [7, 8, 9]);
  // A reset (the driver going away): the port is closed for the page.
  again.reset();
  assert.deepEqual(await q.next((m) => m.type === 'open'), { type: 'open', port: 0, open: false });
  port1.close();
});

test('frames: encoded, read back whatever pieces they come in; a bad length breaks the reader until reset', () => {
  const a = encodeFrame(FRAME.HELLO, new Uint8Array([1, 2]));
  assert.deepEqual([...a], [3, 0, 0, 0, FRAME.HELLO, 1, 2]);
  const big = encodeFrame(FRAME.DATA, Uint8Array.from({ length: MAX_PAYLOAD }, (_, i) => i & 0xff));
  const empty = encodeFrame(FRAME.PAUSE);
  const stream = new Uint8Array([...a, ...big, ...empty]);
  const r = new FrameReader();
  const frames = [];
  for (let k = 0; k < stream.length; k += 1000) frames.push(...r.push(stream.subarray(k, k + 1000)));
  assert.deepEqual(frames.map((f) => [f.type, f.payload.length]), [[FRAME.HELLO, 2], [FRAME.DATA, MAX_PAYLOAD], [FRAME.PAUSE, 0]]);
  assert.equal(Buffer.compare(frames[1].payload, big.subarray(5)), 0);
  assert.equal(r.pending, 0);
  // One byte at a time, too.
  const one = new FrameReader();
  const got = [...a].flatMap((b) => one.push(new Uint8Array([b])));
  assert.deepEqual(got.map((f) => [...f.payload]), [[1, 2]]);
  assert.throws(() => encodeFrame(FRAME.DATA, new Uint8Array(MAX_PAYLOAD + 1)));
  // A length of zero, or past the largest frame: broken, everything dropped until reset.
  const bad = new FrameReader();
  assert.deepEqual(bad.push(new Uint8Array([...a, 0, 0, 0, 0, 9])).length, 1);
  assert.equal(bad.broken, true);
  assert.deepEqual(bad.push(a), []);
  bad.reset();
  assert.equal(bad.push(a).length, 1);
  const huge = new Uint8Array(4);
  new DataView(huge.buffer).setUint32(0, MAX_PAYLOAD + 2, true);
  assert.deepEqual(bad.push(huge), []);
  assert.equal(bad.broken, true);
});

test('the link: frames out only while the agent\'s end is open, at most WINDOW bytes in flight; frames in; a reopening starts afresh', async () => {
  const { port1, port2 } = channel();
  const link = new AgentLink(port1);
  const sent: Uint8Array[] = [];
  const dev = { bytes: 0 };
  port2.onmessage = (e) => { sent.push(e.data.bytes); dev.bytes += e.data.bytes.length; };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  assert.equal(link.send(FRAME.HELLO), false, 'closed: nothing sent');
  const opens: boolean[] = [];
  link.onOpen = (o) => opens.push(o);
  port2.postMessage({ type: 'open', port: 0, open: true });
  await settle();
  assert.deepEqual(opens, [true]);
  // Six frames of 64 KiB (and 5 bytes of header each): sent until the bytes in flight reach WINDOW, the fourth past it.
  const payload = new Uint8Array(65536);
  for (let i = 0; i < 6; i++) assert.equal(link.send(FRAME.DATA, payload), true);
  await settle();
  assert.equal(sent.length, Math.ceil(WINDOW / (65536 + 5)));
  assert.ok(link.backlog >= 6 * (65536 + 5) - 1);
  // The guest takes them: the rest go.
  port2.postMessage({ type: 'taken', port: 0, n: dev.bytes });
  await settle();
  assert.equal(sent.length, 6);
  // Frames in, cut anywhere.
  const frames: number[] = [];
  link.onFrame = (f) => frames.push(f.type);
  const both = new Uint8Array([...encodeFrame(FRAME.OFFER, new Uint8Array(3)), ...encodeFrame(FRAME.REQUEST)]);
  port2.postMessage({ type: 'data', port: 0, bytes: both.subarray(0, 6) });
  port2.postMessage({ type: 'data', port: 0, bytes: both.subarray(6) });
  await settle();
  assert.deepEqual(frames, [FRAME.OFFER, FRAME.REQUEST]);
  // A half frame, then the agent closes and reopens: the half is forgotten, and so is the queue.
  port2.postMessage({ type: 'data', port: 0, bytes: both.subarray(0, 3) });
  link.send(FRAME.DATA, payload);
  port2.postMessage({ type: 'open', port: 0, open: false });
  port2.postMessage({ type: 'open', port: 0, open: true });
  port2.postMessage({ type: 'data', port: 0, bytes: encodeFrame(FRAME.HELLO) });
  await settle();
  assert.deepEqual(opens, [true, false, true]);
  assert.deepEqual(frames, [FRAME.OFFER, FRAME.REQUEST, FRAME.HELLO]);
  assert.equal(link.backlog, 0);
  link.close();
  port2.close();
});
