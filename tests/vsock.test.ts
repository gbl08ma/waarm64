// systemd's notify socket without a guest (docs/devices.md "vsock"): the virtio-vsock (web/vsock-device.ts) driven
// through hand-built queues as Linux's virtio_transport drives it for sd_notify: a connection to the host's port, the
// message, the guest's half close (systemd 256 and later: `shutdown(SHUT_WR)`, then a `recv` that waits for EOF) or full
// close (254 and 255: `close`), each answered so the guest's PID 1 never waits; other ports and types refused; a message
// past the credit reset; a restore telling the guest its transport was reset. And the page's end (`onReady`), and the
// credential (web/app/firmware-files.ts).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
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
