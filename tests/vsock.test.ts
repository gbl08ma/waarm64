// systemd's notify socket without a guest (docs/devices.md "vsock"): the virtio-vsock (web/vsock-device.ts) driven
// through hand-built queues as Linux's virtio_transport drives it for sd_notify: a connection to the host's port, the
// message, the guest's half close (systemd 256 and later: `shutdown(SHUT_WR)`, then a `recv` that waits for EOF) or full
// close (254 and 255: `close`), each answered so the guest's PID 1 never waits; other ports and types refused; a message
// past the credit reset; a restore telling the guest its transport was reset. The guest agent's connection
// (`AGENT_PORT`): bytes both ways, the guest's credit honoured and the device's own given back, one connection at a
// time, the page's reset, refused without the page's end. And the page's end (`onReady`), and the credential
// (web/app/firmware-files.ts).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  AGENT_BUF,
  AGENT_PORT,
  BUF_ALLOC,
  decodeHeader,
  encodeHeader,
  EVENT,
  GUEST_CID,
  HDR,
  HOST_CID,
  NOTIFY_PORT,
  notifySocket,
  onReady,
  OP,
  RX,
  SHUTDOWN_RCV,
  SHUTDOWN_SEND,
  TX,
  TYPE_STREAM,
  vsockDevice,
  vsockEntry,
  type AgentFromDevice,
  type Header,
  type VsockFromDevice,
} from '../web/vsock-device.ts';
import { firmwareFiles } from '../web/app/firmware-files.ts';
import type { Ctx } from '../web/devices.ts';

/** A guest's RAM, the device's completions, and the guest's packets and buffers. */
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
  /** A packet from the guest's `port` to the host's `to`: its header and payload in two segments, as Linux posts them. */
  const packet = (port: number, op: number, o: Partial<Header> & { payload?: Uint8Array; to?: number } = {}) => {
    const payload = o.payload ?? new Uint8Array(0);
    const h = encodeHeader({
      srcCid: GUEST_CID,
      dstCid: HOST_CID,
      srcPort: port,
      dstPort: o.to ?? NOTIFY_PORT,
      len: payload.length,
      type: TYPE_STREAM,
      op,
      flags: 0,
      bufAlloc: 256 << 10,
      fwdCnt: 0,
      ...o,
    });
    const hs = at(HDR);
    ram.set(h, hs.off);
    const read = [hs];
    if (payload.length) {
      const ps = at(payload.length);
      ram.set(payload, ps.off);
      read.push(ps);
    }
    return { w0: ++w0, queue: TX, read, write: [] };
  };
  /** A receive buffer (Linux's: 4 KiB, one segment). */
  const rxBuffer = (queue = RX, len = 4096) => ({ w0: ++w0, queue, read: [], write: [at(len)] });
  /** The headers the device wrote into the receive buffers it completed. */
  const received = (buffers: ReturnType<typeof rxBuffer>[]) =>
    done.flatMap((d) => {
      const b = buffers.find((x) => x.w0 === d.w0 && x.queue === RX);
      return b ? [decodeHeader(ram.subarray(b.write[0].off, b.write[0].off + HDR))] : [];
    });
  return { ram, ctx, done, packet, rxBuffer, received };
}

/** Every channel the tests open, closed at the end even after a failure (an open port keeps Node's event loop alive). */
const channels: MessageChannel[] = [];
after(() => channels.forEach((c) => c.port1.close()));
function channel() {
  const ch = new MessageChannel();
  channels.push(ch);
  return ch;
}
/** Until `got` has `n` messages, for at most 5 s (a loaded host delivers late); then a moment more for any extra. */
async function settle(got: unknown[], n: number) {
  for (const t = performance.now(); got.length < n && performance.now() - t < 5000; ) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
}

/** The device on a channel of its own: the messages it posts, as they come. */
function device(g: ReturnType<typeof guest>) {
  const ch = channel();
  const got: VsockFromDevice[] = [];
  ch.port1.onmessage = (e: MessageEvent<VsockFromDevice>) => got.push(e.data);
  const dev = vsockDevice(g.ctx, { type: 'vsock', port: ch.port2 });
  const buffers = Array.from({ length: 16 }, () => g.rxBuffer());
  for (const b of buffers) assert.equal(dev.request(b), undefined, 'a receive buffer is held');
  return { dev, got, buffers, settle: (n: number) => settle(got, n) };
}

const text = (s: string) => new TextEncoder().encode(s);

test('vsock: the entry (ID 19, no features, three queues) and the guest CID in the config', () => {
  const { entry, config } = vsockEntry();
  assert.deepEqual(entry, [19n, 0n, 3n, 64n, 8n]);
  assert.equal(new DataView(config.buffer).getBigUint64(0, true), BigInt(GUEST_CID));
  assert.equal(notifySocket(), `vsock-stream:2:${NOTIFY_PORT}`);
});

test("vsock: systemd 256's message: connected, taken, posted at the half close, closed by the host, reset by the guest", async () => {
  const g = guest();
  const d = device(g);
  const port = 1023;
  d.dev.request(g.packet(port, OP.REQUEST));
  d.dev.request(g.packet(port, OP.RW, { payload: text('READY=1\nSTATUS=Ready.') }));
  d.dev.request(g.packet(port, OP.SHUTDOWN, { flags: SHUTDOWN_SEND }));
  await d.settle(1);
  assert.deepEqual(d.got, [{ type: 'notify', lines: ['READY=1', 'STATUS=Ready.'] }]);
  const answers = g.received(d.buffers);
  assert.deepEqual(answers.map((h) => [h.op, h.flags]), [[OP.RESPONSE, 0], [OP.SHUTDOWN, SHUTDOWN_RCV | SHUTDOWN_SEND]]);
  for (const h of answers) {
    assert.deepEqual([h.srcCid, h.dstCid, h.srcPort, h.dstPort, h.type, h.len], [HOST_CID, GUEST_CID, NOTIFY_PORT, port, TYPE_STREAM, 0]);
    assert.equal(h.bufAlloc, BUF_ALLOC);
  }
  assert.equal(answers[1].fwdCnt, 'READY=1\nSTATUS=Ready.'.length, 'the bytes taken');
  // The guest answers the host's close with RST: nothing more from the device, and the port is free again.
  d.dev.request(g.packet(port, OP.RST));
  d.dev.request(g.packet(port, OP.REQUEST));
  assert.deepEqual(g.received(d.buffers).map((h) => h.op), [OP.RESPONSE, OP.SHUTDOWN, OP.RESPONSE]);
});

test("vsock: systemd 254's message (a full close) answered by RST; a message across packets whole", async () => {
  const g = guest();
  const d = device(g);
  d.dev.request(g.packet(1022, OP.REQUEST));
  d.dev.request(g.packet(1022, OP.RW, { payload: text('X_SYSTEMD_UNIT_ACTIVE=multi-') }));
  d.dev.request(g.packet(1022, OP.RW, { payload: text('user.target\n') }));
  d.dev.request(g.packet(1022, OP.SHUTDOWN, { flags: SHUTDOWN_RCV | SHUTDOWN_SEND }));
  await d.settle(1);
  assert.deepEqual(d.got, [{ type: 'notify', lines: ['X_SYSTEMD_UNIT_ACTIVE=multi-user.target'] }]);
  assert.deepEqual(g.received(d.buffers).map((h) => h.op), [OP.RESPONSE, OP.RST]);
});

test('vsock: refused: another port, another type, another CID, a packet of no connection; CREDIT_REQUEST answered', async () => {
  const g = guest();
  const d = device(g);
  d.dev.request(g.packet(1000, OP.REQUEST, { to: 22 }));
  d.dev.request(g.packet(1001, OP.REQUEST, { type: 2 })); // SEQPACKET
  d.dev.request(g.packet(1002, OP.REQUEST, { dstCid: 5 }));
  d.dev.request(g.packet(1003, OP.RW, { payload: text('READY=1') }));
  d.dev.request(g.packet(1004, OP.RST)); // nothing answers a reset
  d.dev.request(g.packet(1005, OP.REQUEST));
  d.dev.request(g.packet(1005, OP.CREDIT_REQUEST));
  d.dev.request(g.packet(1005, OP.CREDIT_UPDATE)); // ignored
  await d.settle(0);
  assert.deepEqual(g.received(d.buffers).map((h) => [h.dstPort, h.op]), [
    [1000, OP.RST],
    [1001, OP.RST],
    [1002, OP.RST],
    [1003, OP.RST],
    [1005, OP.RESPONSE],
    [1005, OP.CREDIT_UPDATE],
  ]);
  assert.deepEqual(d.got, [], 'nothing posted');
});

test('vsock: a message past the credit reset, not posted; packets wait for receive buffers', async () => {
  const g = guest();
  const ch = channel();
  const got: unknown[] = [];
  ch.port1.onmessage = (e) => got.push(e.data);
  const dev = vsockDevice(g.ctx, { type: 'vsock', port: ch.port2 });
  dev.request(g.packet(1023, OP.REQUEST));
  dev.request(g.packet(1023, OP.RW, { payload: new Uint8Array(BUF_ALLOC) }));
  dev.request(g.packet(1023, OP.RW, { payload: new Uint8Array(1) }));
  assert.equal(g.done.length, 0, 'no receive buffer yet');
  const buffers = [g.rxBuffer(), g.rxBuffer(), g.rxBuffer()];
  for (const b of buffers) dev.request(b);
  assert.deepEqual(g.received(buffers).map((h) => h.op), [OP.RESPONSE, OP.RST]);
  dev.request(g.packet(1023, OP.SHUTDOWN, { flags: SHUTDOWN_SEND })); // gone: refused
  assert.deepEqual(g.received(buffers).map((h) => h.op), [OP.RESPONSE, OP.RST, OP.RST]);
  await settle(got, 0);
  assert.deepEqual(got, []);
});

test('vsock: a restored device resets the transport (once an event buffer is there); a reset drops the connections', () => {
  const g = guest();
  const dev = vsockDevice(g.ctx, { type: 'vsock' });
  const saved = dev.save!();
  const restored = vsockDevice(g.ctx, { type: 'vsock' });
  restored.restore!(saved);
  assert.equal(g.done.length, 0);
  const ev = g.rxBuffer(EVENT, 4);
  g.ram.fill(0xff, ev.write[0].off, ev.write[0].off + 4);
  restored.request(ev);
  assert.deepEqual(g.done, [{ w0: ev.w0, len: 4 }]);
  assert.equal(new DataView(g.ram.buffer).getUint32(ev.write[0].off, true), 0, 'TRANSPORT_RESET');
  restored.request(g.rxBuffer(EVENT, 4));
  assert.equal(g.done.length, 1, 'once');
  // A device reset forgets its connections: the guest's next packet on one is refused.
  const rx = g.rxBuffer();
  restored.request(g.packet(1023, OP.REQUEST));
  restored.reset();
  restored.request(rx);
  restored.request(g.packet(1023, OP.RW, { payload: text('READY=1') }));
  assert.deepEqual(g.received([rx]).map((h) => h.op), [OP.RST]);
});

/** The device with an agent end: what it posts to the page's agent end, and the guest's receive buffers (`n` of them). */
function agentDevice(g: ReturnType<typeof guest>, n = 16) {
  const ch = channel();
  const got: AgentFromDevice[] = [];
  ch.port1.onmessage = (e: MessageEvent<AgentFromDevice>) => got.push(e.data);
  const dev = vsockDevice(g.ctx, { type: 'vsock', agent: ch.port2 });
  const buffers = Array.from({ length: n }, () => g.rxBuffer());
  for (const b of buffers) dev.request(b);
  /** What the page sent, once the device has it (a port's messages come in a later task). */
  const page = async (m: unknown) => {
    ch.port1.postMessage(m);
    await new Promise((r) => setTimeout(r, 20));
  };
  return { dev, got, buffers, page, settle: (k: number) => settle(got, k) };
}

/** The packets the device completed in `buffers`, their headers and payloads. */
function packets(g: ReturnType<typeof guest>, buffers: { w0: number; write: { off: number }[] }[]) {
  return g.done.flatMap((d) => {
    const b = buffers.find((x) => x.w0 === d.w0);
    if (!b) return [];
    const h = decodeHeader(g.ram.subarray(b.write[0].off, b.write[0].off + HDR));
    return [{ h, payload: g.ram.slice(b.write[0].off + HDR, b.write[0].off + HDR + h.len) }];
  });
}

test("vsock: the agent's connection: opened, its bytes to the page, the page's to the guest; closed by the agent", async () => {
  const g = guest();
  const d = agentDevice(g);
  d.dev.request(g.packet(2000, OP.REQUEST, { to: AGENT_PORT }));
  await d.settle(1);
  assert.deepEqual(d.got, [{ type: 'open', open: true, conn: 1 }]);
  const [response] = packets(g, d.buffers);
  assert.deepEqual([response.h.op, response.h.srcPort, response.h.dstPort, response.h.bufAlloc], [OP.RESPONSE, AGENT_PORT, 2000, AGENT_BUF]);
  d.dev.request(g.packet(2000, OP.RW, { to: AGENT_PORT, payload: text('hello') }));
  await d.settle(2);
  assert.deepEqual(d.got[1], { type: 'data', bytes: text('hello'), conn: 1 });
  await d.page({ type: 'data', bytes: text('from the page'), conn: 1 });
  await d.settle(3);
  assert.deepEqual(d.got[2], { type: 'taken', n: 13, conn: 1 });
  const rw = packets(g, d.buffers).at(-1)!;
  assert.deepEqual([rw.h.op, rw.h.len, rw.h.fwdCnt, new TextDecoder().decode(rw.payload)], [OP.RW, 13, 5, 'from the page'], "the page's bytes, and the agent's taken");
  // The agent closes: RST back, the page hears it, and its bytes go nowhere.
  d.dev.request(g.packet(2000, OP.SHUTDOWN, { to: AGENT_PORT, flags: SHUTDOWN_RCV | SHUTDOWN_SEND }));
  await d.settle(4);
  assert.deepEqual(d.got[3], { type: 'open', open: false, conn: 1 });
  assert.equal(packets(g, d.buffers).at(-1)!.h.op, OP.RST);
  const before = g.done.length;
  await d.page({ type: 'data', bytes: text('lost'), conn: 1 });
  assert.equal(g.done.length, before);
});

test("vsock: the page's bytes into a receive buffer of several segments: the header and payload as one run across them", async () => {
  const g = guest();
  const d = agentDevice(g, 1);
  d.dev.request(g.packet(2002, OP.REQUEST, { to: AGENT_PORT }));
  await d.settle(1);
  // Three segments, out of RAM order: the header ends inside the second, the payload runs on into the third.
  const [a, b, c] = [{ off: 300_000, len: 20, mem: 0 }, { off: 200_000, len: 30, mem: 0 }, { off: 400_000, len: 4000, mem: 0 }];
  const rx = { w0: 9999, queue: RX, read: [], write: [b, a, c] };
  d.dev.request(rx);
  const payload = Uint8Array.from({ length: 100 }, (_, i) => i + 1);
  await d.page({ type: 'data', bytes: payload, conn: 1 });
  const done = g.done.find((x) => x.w0 === 9999);
  assert.equal(done?.len, HDR + 100);
  const run = new Uint8Array(HDR + 100);
  run.set(g.ram.subarray(b.off, b.off + 30), 0);
  run.set(g.ram.subarray(a.off, a.off + 20), 30);
  run.set(g.ram.subarray(c.off, c.off + HDR + 100 - 50), 50);
  const h = decodeHeader(run);
  assert.deepEqual([h.op, h.len, h.srcCid, h.dstCid], [OP.RW, 100, HOST_CID, GUEST_CID]);
  assert.equal(Buffer.compare(run.subarray(HDR), payload), 0);
});

test("vsock: the agent's connection: the page's bytes as the guest's credit and buffers allow (nothing asked when it runs out); the device's credit given back as it takes", async () => {
  const g = guest();
  const d = agentDevice(g, 4);
  d.dev.request(g.packet(2001, OP.REQUEST, { to: AGENT_PORT, bufAlloc: 6000, fwdCnt: 0 }));
  await d.settle(1);
  // 10,000 bytes; the guest has room for 6,000, and three buffers of 4 KiB (one took the RESPONSE).
  await d.page({ type: 'data', bytes: new Uint8Array(10_000).fill(7), conn: 1 });
  const sent = () => packets(g, d.buffers).filter((p) => p.h.op === OP.RW).reduce((n, p) => n + p.h.len, 0);
  assert.equal(sent(), 6000, 'the credit');
  // Out of credit: the device waits for the guest's own CREDIT_UPDATE (Linux sends one as its reader frees room); an
  // update that frees nothing gets no answer (asking again would bounce packets with the guest's kernel: review 1).
  const quiet = g.done.length;
  d.dev.request(g.packet(2001, OP.CREDIT_UPDATE, { to: AGENT_PORT, bufAlloc: 6000, fwdCnt: 0 }));
  assert.equal(g.done.length, quiet, 'nothing for an update that freed nothing');
  assert.ok(!packets(g, d.buffers).some((p) => p.h.op === OP.CREDIT_REQUEST), 'no CREDIT_REQUEST');
  // The guest read it all: its credit update lets the rest go into new buffers.
  const more = [g.rxBuffer(), g.rxBuffer(), g.rxBuffer()];
  for (const b of more) d.dev.request(b);
  d.dev.request(g.packet(2001, OP.CREDIT_UPDATE, { to: AGENT_PORT, bufAlloc: 6000, fwdCnt: 6000 }));
  const all = packets(g, [...d.buffers, ...more]).filter((p) => p.h.op === OP.RW);
  assert.equal(all.reduce((n, p) => n + p.h.len, 0), 10_000);
  assert.ok(all.every((p) => p.payload.every((b) => b === 7)));
  await d.settle(3);
  assert.equal(d.got.filter((m) => m.type === 'taken').reduce((n, m) => n + (m.type === 'taken' ? m.n : 0), 0), 10_000);
  // The agent's bytes: past a quarter of the device's buf_alloc unannounced, a CREDIT_UPDATE says what was taken.
  const rx = [g.rxBuffer(), g.rxBuffer()];
  for (const b of rx) d.dev.request(b);
  for (let k = 0; k < AGENT_BUF / 4 / 4096; k++) d.dev.request(g.packet(2001, OP.RW, { to: AGENT_PORT, payload: new Uint8Array(4096), fwdCnt: 10_000, bufAlloc: 6000 }));
  const update = packets(g, [...d.buffers, ...more, ...rx]).filter((p) => p.h.op === OP.CREDIT_UPDATE);
  assert.deepEqual(update.map((p) => p.h.fwdCnt), [AGENT_BUF / 4]);
});

test("vsock: the agent's connection: one at a time (a new one takes the old one's place), the page's reset, refused without the page's end; a restore drops it", async () => {
  const g = guest();
  const d = agentDevice(g);
  d.dev.request(g.packet(2002, OP.REQUEST, { to: AGENT_PORT }));
  d.dev.request(g.packet(2003, OP.REQUEST, { to: AGENT_PORT }));
  await d.settle(3);
  assert.deepEqual(d.got, [{ type: 'open', open: true, conn: 1 }, { type: 'open', open: false, conn: 1 }, { type: 'open', open: true, conn: 2 }]);
  assert.deepEqual(packets(g, d.buffers).map((p) => [p.h.dstPort, p.h.op]), [[2002, OP.RESPONSE], [2002, OP.RST], [2003, OP.RESPONSE]]);
  // The page's messages for the old connection are dropped (review 2): its bytes and its reset.
  const before = g.done.length;
  await d.page({ type: 'data', bytes: text('the rest of a paste'), conn: 1 });
  await d.page({ type: 'reset', conn: 1 });
  assert.equal(g.done.length, before, "the old connection's bytes and reset: nothing");
  // A REQUEST again from the same port (the agent's socket closed and the port reused) is a new connection, which
  // the page hears (review 3).
  d.dev.request(g.packet(2003, OP.REQUEST, { to: AGENT_PORT }));
  await d.settle(5);
  assert.deepEqual(d.got.slice(3), [{ type: 'open', open: false, conn: 2 }, { type: 'open', open: true, conn: 3 }]);
  // The page resets it (a stream out of step): RST, and the page hears it closed.
  await d.page({ type: 'reset', conn: 3 });
  await d.settle(6);
  assert.deepEqual(d.got[5], { type: 'open', open: false, conn: 3 });
  assert.deepEqual(packets(g, d.buffers).at(-1)!.h.op, OP.RST);
  d.dev.request(g.packet(2003, OP.RW, { to: AGENT_PORT, payload: text('x') }));
  assert.deepEqual(packets(g, d.buffers).at(-1)!.h.op, OP.RST, 'its packets refused');
  // No page end (a machine without the agent): refused.
  const g2 = guest();
  const bare = vsockDevice(g2.ctx, { type: 'vsock' });
  const rx = g2.rxBuffer();
  bare.request(rx);
  bare.request(g2.packet(2004, OP.REQUEST, { to: AGENT_PORT }));
  assert.deepEqual(g2.received([rx]).map((h) => h.op), [OP.RST]);
  // A device reset drops it: the page hears it closed.
  d.dev.request(g.packet(2005, OP.REQUEST, { to: AGENT_PORT }));
  d.dev.reset();
  await d.settle(8);
  assert.deepEqual(d.got.slice(6), [{ type: 'open', open: true, conn: 4 }, { type: 'open', open: false, conn: 4 }]);
});

test("vsock: the page's end hears READY=1, not the rest", async () => {
  const ch = channel();
  let up = 0;
  const seen: unknown[] = [];
  onReady(ch.port1, () => up++);
  ch.port1.addEventListener('message', (e) => seen.push(e.data));
  ch.port2.postMessage({ type: 'notify', lines: ['STATUS=Starting…'] } satisfies VsockFromDevice);
  ch.port2.postMessage({ type: 'notify', lines: ['X_SYSTEMD_UNIT_ACTIVE=multi-user.target'] } satisfies VsockFromDevice);
  ch.port2.postMessage({ type: 'notify', lines: ['READY=1', 'STATUS=Ready.'] } satisfies VsockFromDevice);
  await settle(seen, 3);
  assert.equal(up, 1);
});

test("vsock: a firmware machine's credential points systemd at the socket; a `?credential=` of the name replaces it", () => {
  const start = (credentials: { name: string; data: string }[]) =>
    ({
      config: { machine: 'uefi', devices: { nets: 0 }, guest: { credentials, netConfig: false } },
      words: {},
      disks: [],
    }) as unknown as Parameters<typeof firmwareFiles>[0];
  const files = (c: { name: string; data: string }[]) =>
    firmwareFiles(start(c))!.filter((f) => f.name === 'opt/io.systemd.credentials/vmm.notify_socket');
  assert.deepEqual(files([]), [{ name: 'opt/io.systemd.credentials/vmm.notify_socket', data: notifySocket() }]);
  assert.deepEqual(files([{ name: 'vmm.notify_socket', data: 'vsock-stream:2:1' }]), [
    { name: 'opt/io.systemd.credentials/vmm.notify_socket', data: 'vsock-stream:2:1' },
  ]);
  assert.equal(firmwareFiles({ ...start([]), config: { ...start([]).config, machine: 'buildroot' } }), undefined);
});
