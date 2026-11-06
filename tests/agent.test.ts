// Clipboard sharing's channel without a guest (docs/plans/clipboard.md §2): the agent's virtio-console
// (web/agent-device.ts) driven through hand-built queues as Linux's virtio_console drives it (the control handshake,
// the port's name, the guest's opens and closes, bytes both ways across buffers, a snapshot's state), the frames
// (web/agent-frame.ts) and their payloads (HELLO, TYPE: the same bytes as agent/src/frame.rs's tests), the page's end
// (web/app/agent-link.ts): its window of bytes in flight, HELLO, TYPE, the pause; the guest agent's unit and
// script (web/app/guest-agent.ts), the script under dash on directories of its own; and the page's clipboard sharing
// (web/app/clipboard.ts) on a faked link and browser: both ways, the paste chord, sync on focus with the read
// permission, the pending text's rules, the placeholders, the pause, the toolbar's state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AGENT_PORTS, agentDevice, agentEntry, CTL_RX, CTL_TX, DEVICE_READY, F_MULTIPORT, MAX_PENDING, PORT_ADD, PORT_NAME, PORT_OPEN, PORT_READY, type AgentFromDevice } from '../web/agent-device.ts';
import { ACK, CAP, CHUNK, CREDIT, DATA_END, DATA_FAIL, decodeAck, decodeData, decodeHello, decodeMore, decodeOffer, decodeRequest, encodeAck, encodeData, encodeFrame, encodeHello, encodeMore, encodeOffer, encodeRequest, FRAME, FrameReader, MAX_PAYLOAD, TYPE_CHUNK, typePayloads, UNKNOWN, VERSION, type Frame } from '../web/agent-frame.ts';
import { AgentLink, PAGE_CAPS, WINDOW } from '../web/app/agent-link.ts';
import { ACK_WAIT, ClipboardShare, EMPTY_RUN, INLINE, isPasteChord, PASTE_WAIT, TEXT, TEXT_CAP, textHash, watchReadPermission, type ClipLink, type ReadPermission } from '../web/app/clipboard.ts';
import { AGENT_FILE, AGENT_PORT, agentBinary, agentCredentials, agentScript } from '../web/app/guest-agent.ts';
import { oemStrings } from '../web/app/guest-unit.ts';
import { guestWords } from '../web/app/guest-words.ts';
import { words } from './words.ts';
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
  // The page's HELLO first, at each opening, and the switch: taken by the guest at once here.
  assert.deepEqual(sent.map((b) => b[4]), [FRAME.HELLO, FRAME.RESUME]);
  port2.postMessage({ type: 'taken', port: 0, n: dev.bytes });
  sent.length = 0;
  dev.bytes = 0;
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
  assert.equal(link.backlog, encodeFrame(FRAME.HELLO, encodeHello({ version: VERSION, caps: PAGE_CAPS })).length + encodeFrame(FRAME.RESUME).length, 'only the new opening\'s HELLO and RESUME');
  link.close();
  port2.close();
});

test("frames: HELLO's payload (version, capabilities: the bytes agent/src/frame.rs pins), longer ones from later versions", () => {
  assert.deepEqual([...encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TYPE }))], [7, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0]);
  assert.deepEqual([...encodeFrame(FRAME.PAUSE)], [1, 0, 0, 0, 6]);
  const h = { version: 3, caps: 0x80000101 };
  assert.deepEqual(decodeHello(encodeHello(h)), h);
  assert.deepEqual(decodeHello(new Uint8Array([...encodeHello(h), 9, 9, 9])), h, "a later version's fields are ignored");
  assert.equal(decodeHello(new Uint8Array([1, 0, 1, 0, 0])), undefined);
});

test("frames: TYPE's payloads, UTF-8 cut between characters and never inside a CRLF", () => {
  const dec = new TextDecoder('utf-8', { fatal: true });
  assert.deepEqual(typePayloads(''), []);
  assert.deepEqual(typePayloads('ls\n').map((p) => dec.decode(p)), ['ls\n']);
  const text = 'héllo ☃ 𝄞 wörld\r\nline two\r\n';
  for (const max of [4, 5, 6, 7, 8, 13]) {
    const parts = typePayloads(text, max);
    assert.ok(parts.every((p) => p.length <= max && p.length > 0), `frames of ${max}: ${parts.map((p) => p.length)}`);
    assert.equal(parts.map((p) => dec.decode(p)).join(''), text, `frames of ${max}: each is UTF-8 and they join up`);
    assert.ok(parts.every((p, i) => !(p[p.length - 1] === 0x0d && parts[i + 1]?.[0] === 0x0a)), `frames of ${max}: a CRLF split`);
  }
  const long = 'x'.repeat(TYPE_CHUNK * 2 + 10);
  assert.deepEqual(typePayloads(long).map((p) => p.length), [TYPE_CHUNK, TYPE_CHUNK, 10]);
  assert.ok(TYPE_CHUNK <= MAX_PAYLOAD);
  assert.throws(() => typePayloads('x', 3));
});

test("the link: HELLO and the switch at each opening, the agent's answer; TYPE once it can; PAUSE held over a reopening", async () => {
  const { port1, port2 } = channel();
  const link = new AgentLink(port1);
  const sent: { type: number; payload: Uint8Array }[] = [];
  const reader = new FrameReader();
  port2.onmessage = (e) => {
    sent.push(...reader.push(e.data.bytes));
    port2.postMessage({ type: 'taken', port: 0, n: e.data.bytes.length });
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  assert.equal(link.type('ls\n'), false, 'closed');
  port2.postMessage({ type: 'open', port: 0, open: true });
  await settle();
  // The switch said at once: an agent restored from a snapshot taken while paused would be paused still.
  assert.deepEqual(sent.map((f) => f.type), [FRAME.HELLO, FRAME.RESUME]);
  assert.deepEqual(decodeHello(sent[0].payload), { version: VERSION, caps: CAP.TYPE | CAP.TEXT });
  sent.splice(1, 1);
  assert.equal(link.type('ls\n'), false, "open, but the agent hasn't said it can");
  const hellos: unknown[] = [];
  link.onHello = (h) => hellos.push(h);
  port2.postMessage({ type: 'data', port: 0, bytes: encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TYPE | 0x100 })) });
  await settle();
  assert.deepEqual(hellos, [{ version: 1, caps: CAP.TYPE | 0x100 }]);
  assert.equal(link.canType, true);
  assert.equal(link.type('héllo\n'), true);
  await settle();
  assert.deepEqual(sent.slice(1).map((f) => [f.type, new TextDecoder().decode(f.payload)]), [[FRAME.TYPE, 'héllo\n']]);
  // Paused: nothing typed; the agent hears it, and again when it reopens its end (a restarted agent starts unpaused).
  link.pause();
  assert.equal(link.type('no'), false);
  await settle();
  assert.deepEqual(sent.slice(2).map((f) => f.type), [FRAME.PAUSE]);
  port2.postMessage({ type: 'open', port: 0, open: false });
  port2.postMessage({ type: 'open', port: 0, open: true });
  await settle();
  assert.equal(link.agent, undefined, "a new opening: the agent's HELLO is to come");
  assert.deepEqual(sent.slice(3).map((f) => f.type), [FRAME.HELLO, FRAME.PAUSE]);
  link.resume();
  await settle();
  assert.deepEqual(sent.slice(5).map((f) => f.type), [FRAME.RESUME]);
  link.close();
  port2.close();
});

test("the guest agent's unit: a long-running root service, wanted by multi-user.target, sandboxed but for what it needs", () => {
  const c = agentCredentials(guestWords().agent);
  assert.deepEqual(c.map((x) => x.name), ['webpc.agent.sh', 'systemd.extra-unit.webpc-agent.service', 'systemd.unit-dropin.multi-user.target~webpc-agent']);
  const unit = c[1].data;
  assert.match(unit, new RegExp(`^Description=${words('guest:guest-words.agent').source}$`, 'm'));
  for (const line of ['Type=simple', 'ImportCredential=webpc.agent.sh', 'ExecStart=/bin/sh %d/webpc.agent.sh', 'ExecStartPre=-+modprobe -q qemu_fw_cfg', 'TemporaryFileSystem=/run/webpc:mode=0700,exec,nosuid', 'Nice=10', 'MemoryMax=32M', 'OOMScoreAdjust=500', 'ProtectSystem=strict', 'Restart=on-failure']) {
    assert.match(unit, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), line);
  }
  assert.doesNotMatch(unit, /^Type=oneshot$/m);
  // TIOCSTI as root needs CAP_SYS_ADMIN; the session children (step 3) change uid: no NoNewPrivileges, no PrivateDevices.
  assert.match(unit, /^CapabilityBoundingSet=.*\bCAP_SYS_ADMIN\b.*$/m);
  assert.match(unit, /^CapabilityBoundingSet=.*\bCAP_SETUID\b.*\bCAP_SETGID\b/m);
  assert.match(unit, /^CapabilityBoundingSet=.*\bCAP_KILL\b/m, "the children are the user's: stopping one needs CAP_KILL");
  assert.doesNotMatch(unit, /^(NoNewPrivileges|PrivateDevices|PrivateUsers|DynamicUser)=/m);
  assert.equal(c[2].data, '[Unit]\nWants=webpc-agent.service\nAfter=webpc-agent.service\n');
  for (const [i, x] of oemStrings(c).entries()) assert.equal(Buffer.from(x.split('=').slice(1).join('='), 'base64').toString(), c[i].data);
});

const hasDash = process.env.PATH?.split(':').some((p) => existsSync(join(p, 'dash')));

test("the guest agent's script: the binary out of fw_cfg, gunzipped into /run/webpc, run in the script's place; without the file, nothing", { skip: !hasDash && 'no dash' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'webpc-agent-'));
  try {
    const at = (p: string) => join(root, p);
    // The script with its absolute paths moved under `root`, and udevadm a stub that says what it waited for.
    mkdirSync(at('bin'));
    writeFileSync(at('bin/udevadm'), `#!/bin/sh\necho "udevadm $*" >> ${at('log')}\n`);
    chmodSync(at('bin/udevadm'), 0o755);
    const script = join(root, 's.sh');
    writeFileSync(script, agentScript().replace(/(?<=[ =>])\/(sys|run)\//g, `${root}/$1/`));
    const run = () => execFileSync('dash', [script], { stdio: 'pipe', env: { PATH: `${at('bin')}:/usr/bin:/bin` } }).toString();
    // No fw_cfg file (no setting, or a kernel without qemu_fw_cfg): exits, nothing run.
    mkdirSync(at('run/webpc'), { recursive: true });
    assert.equal(run(), '');
    assert.equal(existsSync(at('run/webpc/agent')), false);
    // The file: copied, made executable for root only, run with the script's place (exec), after udev's link.
    const raw = at(`sys/firmware/qemu_fw_cfg/by_name/${AGENT_FILE}/raw`);
    mkdirSync(raw.replace(/\/raw$/, ''), { recursive: true });
    const program = `#!/bin/sh\necho "agent ran as $$ with $#"\n`;
    writeFileSync(raw, gzipSync(program));
    assert.match(run(), /^agent ran as \d+ with 0\n$/);
    assert.equal(readFileSync(at('run/webpc/agent'), 'utf8'), program, 'gunzipped');
    assert.equal(execFileSync('stat', ['-c', '%a', at('run/webpc/agent')]).toString().trim(), '500');
    assert.equal(readFileSync(at('log'), 'utf8'), `udevadm wait --timeout=60 ${AGENT_PORT}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guest agent's binary: fetched whole if it is an ELF file, gzipped; otherwise none (the machine starts without it)", async () => {
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  const at = (body: BodyInit | null, status = 200) => `data:application/octet-stream;base64,${status === 200 && body instanceof Uint8Array ? Buffer.from(body).toString('base64') : ''}`;
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    assert.deepEqual(new Uint8Array(gunzipSync((await agentBinary(at(elf)))!)), elf, 'gzipped for fw_cfg');
    assert.equal(await agentBinary(at(new TextEncoder().encode('<!doctype html>'))), undefined, "a server's page");
    assert.equal(await agentBinary('http://127.0.0.1:1/webpc-agent'), undefined, 'nothing there');
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 2);
});

test("frames: the clipboard's payloads (the bytes agent/src/frame.rs pins)", () => {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const o = encodeOffer({ serial: 0x01020304, types: [{ type: 'text/plain', size: 3 }], inline: new TextEncoder().encode('abc') });
  assert.deepEqual([...o], [4, 3, 2, 1, 1, 1, 10, ...ascii('text/plain'), 3, 0, 0, 0, ...ascii('abc')]);
  assert.deepEqual(decodeOffer(o), { serial: 0x01020304, types: [{ type: 'text/plain', size: 3 }], inline: new TextEncoder().encode('abc') });
  const lazy = { serial: 9, types: [{ type: TEXT, size: UNKNOWN }, { type: 'UTF8_STRING', size: UNKNOWN }] };
  assert.deepEqual(decodeOffer(encodeOffer(lazy)), lazy);
  assert.equal(decodeOffer(encodeOffer(lazy).subarray(0, 20)), undefined, 'cut short');
  const r = encodeRequest({ serial: 7, id: 2, type: 'text/plain' });
  assert.deepEqual([...r], [7, 0, 0, 0, 2, 0, 0, 0, 10, ...ascii('text/plain')]);
  assert.deepEqual(decodeRequest(r), { serial: 7, id: 2, type: 'text/plain' });
  const d = encodeData(5, DATA_END, new TextEncoder().encode('hi'));
  assert.deepEqual([...d], [5, 0, 0, 0, DATA_END, ...ascii('hi')]);
  assert.deepEqual({ ...decodeData(d)!, bytes: [...decodeData(d)!.bytes] }, { id: 5, flags: DATA_END, bytes: ascii('hi') });
  assert.deepEqual([...encodeAck(3, ACK.TOO_LARGE)], [3, 0, 0, 0, 3]);
  assert.deepEqual(decodeAck(encodeAck(3, ACK.TOO_LARGE)), { serial: 3, status: ACK.TOO_LARGE });
  assert.deepEqual([...encodeMore(6, 1)], [6, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(decodeMore(encodeMore(6, 1)), { id: 6, n: 1 });
  assert.equal(decodeMore(new Uint8Array(5)), undefined);
  assert.deepEqual([FRAME.ACK, FRAME.MORE, CAP.TEXT], [8, 9, 2]);
  assert.ok(5 + CHUNK <= MAX_PAYLOAD);
});

/** A link as the clipboard sees it, the agent's side driven by hand: `sent` holds the page's frames. */
function fakeLink(caps: number = CAP.TYPE | CAP.TEXT) {
  const sent: Frame[] = [];
  const link: ClipLink = {
    open: true,
    paused: false,
    agent: { version: 1, caps },
    send(type, payload = new Uint8Array(0)) {
      if (!this.open) return false;
      sent.push({ type, payload });
      return true;
    },
    pause() {
      this.paused = true;
      this.send(FRAME.PAUSE);
    },
    resume() {
      this.paused = false;
      this.send(FRAME.RESUME);
    },
    type(text) {
      if (this.paused || !this.agent || !(this.agent.caps & CAP.TYPE)) return false;
      return this.send(FRAME.TYPE, new TextEncoder().encode(text));
    },
  };
  const deliver = (type: number, payload: Uint8Array) => link.onFrame!({ type, payload });
  /** The page's frames of `type` sent since the last call, taken off `sent`. */
  const take = (type: number) => {
    const got = sent.filter((f) => f.type === type);
    sent.splice(0, sent.length, ...sent.filter((f) => f.type !== type));
    return got;
  };
  return { link, sent, deliver, take };
}

/**
 * The browser as the clipboard sees it: `text` is the host's clipboard (`types` what `read()` says it has: by default
 * text when there is some), `focus` the document's, `refuse` makes writes fail (no activation), `reads` counts reads.
 */
function fakeHost() {
  const written: string[] = [];
  const host = {
    focus: true,
    text: '',
    types: undefined as string[] | undefined,
    refuse: false,
    reads: 0,
    changeEvents: false,
    clipboard: {
      writeText: async (s: string) => {
        if (host.refuse) throw new DOMException('no activation', 'NotAllowedError');
        written.push(s);
        host.text = s;
      },
      readText: async () => {
        host.reads++;
        return host.text;
      },
      read: async () => [{ types: host.types ?? (host.text ? ['text/plain'] : []) }],
    },
    hasFocus: () => host.focus,
  };
  return { host, written };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const requests = (frames: Frame[]) => frames.map((f) => decodeRequest(f.payload)!);

test("the host's clipboard: the guest's offer written while focused (inline, or requested under MOREs), kept without focus, capped; dropped while paused", async () => {
  const { link, deliver, take } = fakeLink();
  const { host, written } = fakeHost();
  const share = new ClipboardShare(link, host);
  assert.equal(share.active, true);
  deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: TEXT, size: 5 }], inline: utf8('hello') }));
  await settle();
  assert.deepEqual(written, ['hello']);
  assert.deepEqual(take(FRAME.REQUEST), [], 'inline: nothing requested');
  // Lazy: requested; each DATA frame but the last answered with a MORE; the text written once whole.
  deliver(FRAME.OFFER, encodeOffer({ serial: 2, types: [{ type: TEXT, size: UNKNOWN }] }));
  const [req] = requests(take(FRAME.REQUEST));
  assert.deepEqual({ ...req, id: 0 }, { serial: 2, id: 0, type: TEXT });
  deliver(FRAME.DATA, encodeData(req.id, 0, utf8('wörld, ')));
  assert.deepEqual(take(FRAME.MORE).map((f) => decodeMore(f.payload)), [{ id: req.id, n: 1 }]);
  deliver(FRAME.DATA, encodeData(req.id, DATA_END, utf8('in two')));
  await settle();
  assert.deepEqual(take(FRAME.MORE), [], 'no MORE after the end');
  assert.deepEqual(written, ['hello', 'wörld, in two']);
  // A failed answer writes nothing; a newer offer stops the older request (MORE 0).
  deliver(FRAME.OFFER, encodeOffer({ serial: 3, types: [{ type: 'text/plain', size: 10 }] }));
  const [r3] = requests(take(FRAME.REQUEST));
  deliver(FRAME.DATA, encodeData(r3.id, DATA_FAIL));
  deliver(FRAME.OFFER, encodeOffer({ serial: 4, types: [{ type: TEXT, size: 10 }] }));
  const [r4] = requests(take(FRAME.REQUEST));
  deliver(FRAME.OFFER, encodeOffer({ serial: 5, types: [{ type: TEXT, size: 3 }], inline: utf8('new') }));
  assert.deepEqual(take(FRAME.MORE).map((f) => decodeMore(f.payload)), [{ id: r4.id, n: 0 }]);
  deliver(FRAME.DATA, encodeData(r4.id, DATA_END, utf8('too late')));
  await settle();
  assert.deepEqual(written, ['hello', 'wörld, in two', 'new']);
  // Past the cap, or no text: not requested.
  deliver(FRAME.OFFER, encodeOffer({ serial: 6, types: [{ type: TEXT, size: TEXT_CAP + 1 }] }));
  deliver(FRAME.OFFER, encodeOffer({ serial: 7, types: [{ type: 'image/png', size: 10 }] }));
  assert.deepEqual(take(FRAME.REQUEST), []);
  // An answer that runs past the cap stops (MORE 0) and writes nothing.
  deliver(FRAME.OFFER, encodeOffer({ serial: 8, types: [{ type: TEXT, size: UNKNOWN }] }));
  const [r8] = requests(take(FRAME.REQUEST));
  const chunk = new Uint8Array(CHUNK).fill(0x61);
  for (let k = 0; k <= TEXT_CAP / CHUNK; k++) deliver(FRAME.DATA, encodeData(r8.id, 0, chunk));
  assert.deepEqual(take(FRAME.MORE).map((f) => decodeMore(f.payload)!).at(-1), { id: r8.id, n: 0 });
  await settle();
  assert.equal(written.length, 3);
  // No focus: kept as pending, not written.
  host.focus = false;
  deliver(FRAME.OFFER, encodeOffer({ serial: 9, types: [{ type: TEXT, size: 5 }], inline: utf8('later') }));
  await settle();
  assert.equal(written.length, 3);
  assert.equal(share.pending, 'later');
  // Paused: the guest's offers are dropped, the agent's requests fail.
  host.focus = true;
  link.paused = true;
  assert.equal(share.active, false);
  deliver(FRAME.OFFER, encodeOffer({ serial: 10, types: [{ type: TEXT, size: 6 }], inline: utf8('paused') }));
  deliver(FRAME.REQUEST, encodeRequest({ serial: 1, id: 40, type: TEXT }));
  await settle();
  assert.equal(written.length, 3);
  assert.deepEqual(take(FRAME.DATA).map((f) => decodeData(f.payload)!.flags), [DATA_FAIL]);
});

test("the host's clipboard: the page's offer, inline or answered under the agent's MOREs; ACK; echoes not offered back", async () => {
  const { link, deliver, take } = fakeLink();
  const { host, written } = fakeHost();
  const share = new ClipboardShare(link, host);
  const offers = () => take(FRAME.OFFER).map((f) => decodeOffer(f.payload)!);
  // The guest's text, written to the host: pasting it back offers nothing.
  deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: TEXT, size: 4 }], inline: utf8('mine') }));
  await settle();
  assert.deepEqual(written, ['mine']);
  await share.paste('mine');
  await share.paste('');
  assert.deepEqual(offers(), [], "the guest's own text, and nothing: not offered");
  // Short: inline; the ACK lets the paste go at once.
  let t0 = performance.now();
  const p = share.paste('from the host ✓');
  const [o] = offers();
  assert.deepEqual(o.types, [{ type: TEXT, size: utf8('from the host ✓').length }]);
  assert.equal(new TextDecoder().decode(o.inline), 'from the host ✓');
  deliver(FRAME.ACK, encodeAck(o.serial, ACK.HELD));
  await p;
  assert.ok(performance.now() - t0 < ACK_WAIT / 2, 'the ACK, not the wait');
  await share.paste('from the host ✓');
  assert.deepEqual(offers(), [], 'the guest has it');
  // Long: offered with its size and no bytes; the agent's request gets CREDIT frames, then one more for each MORE.
  const long = 'x'.repeat(CHUNK * 6 + 100);
  void share.paste(long);
  const [ol] = offers();
  assert.equal(ol.inline, undefined);
  assert.deepEqual(ol.types, [{ type: TEXT, size: long.length }]);
  deliver(FRAME.REQUEST, encodeRequest({ serial: ol.serial, id: 77, type: TEXT }));
  const frames = take(FRAME.DATA).map((f) => decodeData(f.payload)!);
  assert.equal(frames.length, CREDIT);
  assert.ok(frames.every((f) => f.id === 77 && f.flags === 0 && f.bytes.length === CHUNK));
  deliver(FRAME.MORE, encodeMore(77, 2));
  frames.push(...take(FRAME.DATA).map((f) => decodeData(f.payload)!));
  assert.equal(frames.length, CREDIT + 2);
  deliver(FRAME.MORE, encodeMore(77, 5));
  frames.push(...take(FRAME.DATA).map((f) => decodeData(f.payload)!));
  assert.deepEqual(frames.map((f) => f.flags), [0, 0, 0, 0, 0, 0, DATA_END]);
  assert.equal(frames.reduce((n, f) => n + f.bytes.length, 0), long.length);
  deliver(FRAME.MORE, encodeMore(77, 5));
  assert.deepEqual(take(FRAME.DATA), [], 'answered whole: nothing more');
  // Another request, stopped by MORE 0; one for an older offer, or for another type, fails.
  deliver(FRAME.REQUEST, encodeRequest({ serial: ol.serial, id: 78, type: 'text/plain' }));
  assert.equal(take(FRAME.DATA).length, CREDIT);
  deliver(FRAME.MORE, encodeMore(78, 0));
  deliver(FRAME.MORE, encodeMore(78, 3));
  assert.deepEqual(take(FRAME.DATA), []);
  deliver(FRAME.REQUEST, encodeRequest({ serial: o.serial, id: 79, type: TEXT }));
  deliver(FRAME.REQUEST, encodeRequest({ serial: ol.serial, id: 80, type: 'image/png' }));
  assert.deepEqual(take(FRAME.DATA).map((f) => decodeData(f.payload)), [{ id: 79, flags: DATA_FAIL, bytes: new Uint8Array(0) }, { id: 80, flags: DATA_FAIL, bytes: new Uint8Array(0) }]);
  // No ACK: the paste goes after ACK_WAIT. An ACK that says the guest didn't take it: the next paste offers it again.
  t0 = performance.now();
  await share.paste('unanswered');
  assert.ok(performance.now() - t0 >= ACK_WAIT - 5);
  offers();
  const q = share.paste('refused');
  const [or] = offers();
  deliver(FRAME.ACK, encodeAck(or.serial, ACK.NO_SESSION));
  await q;
  void share.paste('refused');
  assert.equal(offers().length, 1, 'offered again');
  // Past the cap: not offered.
  await share.paste('y'.repeat(TEXT_CAP + 1));
  assert.deepEqual(offers(), []);
  assert.ok(INLINE < CHUNK);
});

test('the paste chord: which keys; held for the paste event and the ACK, or let go after PASTE_WAIT; not held while sharing is off', async () => {
  const k = (key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}, code = `Key${key.toUpperCase()}`) => ({ key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  assert.ok(isPasteChord(k('v', { ctrlKey: true })));
  assert.ok(isPasteChord(k('V', { ctrlKey: true, shiftKey: true })));
  assert.ok(isPasteChord(k('v', { metaKey: true })));
  assert.ok(isPasteChord(k('Insert', { shiftKey: true }, 'Insert')));
  assert.ok(!isPasteChord(k('v')));
  assert.ok(!isPasteChord(k('v', { ctrlKey: true, altKey: true })));
  assert.ok(!isPasteChord(k('c', { ctrlKey: true })));
  assert.ok(!isPasteChord(k('Insert', {}, 'Insert')));
  // On a Dvorak layout Ctrl+V is the key that says 'v' (code Period): the browser's shortcut goes by the key.
  assert.ok(isPasteChord(k('v', { ctrlKey: true }, 'Period')));

  const { link, deliver, take } = fakeLink();
  const share = new ClipboardShare(link, fakeHost().host);
  const ctrlV = k('v', { ctrlKey: true });
  assert.equal(share.chord(k('a')), undefined, 'not a paste chord');
  // Held until the paste event, then until the ACK.
  let done = false;
  const held = share.chord(ctrlV)!.then(() => { done = true; });
  assert.equal(share.held, true);
  await new Promise((r) => setTimeout(r, 20));
  share.pasted('chord text');
  assert.equal(share.held, false);
  const [o] = take(FRAME.OFFER).map((f) => decodeOffer(f.payload)!);
  assert.equal(new TextDecoder().decode(o.inline), 'chord text');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, 'waits for the ACK');
  deliver(FRAME.ACK, encodeAck(o.serial, ACK.HELD));
  await held;
  // No paste event: let go after PASTE_WAIT, nothing offered; a paste event after it is no chord's.
  const t0 = performance.now();
  await share.chord(ctrlV);
  assert.ok(performance.now() - t0 >= PASTE_WAIT - 5);
  share.pasted('stray');
  assert.deepEqual(take(FRAME.OFFER), []);
  // Off: paused, the port closed, an agent without text.
  link.paused = true;
  assert.equal(share.chord(ctrlV), undefined);
  link.paused = false;
  link.open = false;
  assert.equal(share.chord(ctrlV), undefined);
  assert.equal(new ClipboardShare(fakeLink(CAP.TYPE).link, fakeHost().host).chord(ctrlV), undefined);
  assert.notEqual(textHash('a'), textHash('b'));
  assert.equal(textHash('☃'), textHash('☃'));
});

/** The page's offers' texts, taken off the link. */
const offered = (take: (type: number) => Frame[]) => take(FRAME.OFFER).map((f) => new TextDecoder().decode(decodeOffer(f.payload)!.inline));
const guestOffers = (deliver: (type: number, p: Uint8Array) => void, serial: number, text: string) => deliver(FRAME.OFFER, encodeOffer({ serial, types: [{ type: TEXT, size: utf8(text).length }], inline: utf8(text) }));

test("sync on focus: only with the read permission granted and focus; the host's text offered when it changed, an unchanged one not; clipboardchange gates the reads", async () => {
  const { link, take } = fakeLink();
  const { host } = fakeHost();
  const share = new ClipboardShare(link, host);
  host.text = 'copied on the host';
  // Without the permission (prompt, denied, a browser without it): no read at all.
  for (const p of ['none', 'prompt', 'denied'] as ReadPermission[]) {
    share.setPermission(p);
    await share.focused();
  }
  assert.equal(host.reads, 0, 'never read without the permission');
  share.setPermission('granted');
  await settle();
  assert.equal(host.reads, 1, 'granted just now: read at once');
  assert.deepEqual(offered(take), ['copied on the host']);
  await share.focused();
  assert.deepEqual(offered(take), [], 'unchanged: not offered again');
  host.text = 'another copy';
  host.focus = false;
  await share.focused();
  assert.equal(host.reads, 2, 'no read without focus');
  host.focus = true;
  await share.focused();
  assert.deepEqual(offered(take), ['another copy']);
  // Paused, or the agent's end closed: no reads.
  link.paused = true;
  await share.focused();
  link.paused = false;
  link.open = false;
  await share.focused();
  link.open = true;
  assert.equal(host.reads, 3);
  // Where clipboardchange exists, a focus reads only after one.
  const b = fakeLink();
  const hb = fakeHost().host;
  hb.changeEvents = true;
  hb.text = 'first';
  const sb = new ClipboardShare(b.link, hb);
  sb.setPermission('granted');
  await settle();
  assert.equal(hb.reads, 1, 'the first read: the clipboard is unknown');
  hb.text = 'second';
  await sb.focused();
  assert.equal(hb.reads, 1, 'no clipboardchange: no read');
  sb.clipboardChanged();
  await settle();
  assert.equal(hb.reads, 2);
  assert.deepEqual(offered(b.take), ['first', 'second']);
});

test("the guest's pending text: the newest only; written on focus when the host's clipboard is unchanged, dropped when it changed; on a key or pointer without the permission; a paste chord drops it", async () => {
  const { link, deliver, take } = fakeLink();
  const { host, written } = fakeHost();
  const share = new ClipboardShare(link, host);
  host.text = 'host one';
  share.setPermission('granted');
  await settle();
  assert.deepEqual(offered(take), ['host one']);
  // Two copies in the guest while the page has no focus: the newest is kept.
  host.focus = false;
  guestOffers(deliver, 1, 'guest one');
  guestOffers(deliver, 2, 'guest two');
  await settle();
  assert.equal(share.pending, 'guest two');
  // Focus, the host's clipboard as the page knew it: the pending text is written; reading it back offers nothing.
  host.focus = true;
  await share.focused();
  await settle();
  assert.deepEqual(written, ['guest two']);
  assert.equal(share.pending, undefined);
  await share.focused();
  assert.deepEqual(offered(take), [], "the guest's own text isn't offered back");
  // The host copied since: its text wins, the pending text is dropped.
  host.focus = false;
  guestOffers(deliver, 3, 'guest three');
  await settle();
  host.text = 'host two';
  host.focus = true;
  await share.focused();
  await settle();
  assert.equal(share.pending, undefined);
  assert.deepEqual(written, ['guest two'], "not written over the host's newer copy");
  assert.deepEqual(offered(take), ['host two']);
  // Without the permission: focus writes nothing; a key or pointer on the screen does.
  share.setPermission('prompt');
  host.focus = false;
  guestOffers(deliver, 4, 'guest four');
  await settle();
  host.focus = true;
  await share.focused();
  await settle();
  assert.equal(share.pending, 'guest four', 'focus alone: kept');
  share.activated(false);
  await settle();
  assert.deepEqual(written, ['guest two', 'guest four']);
  // A refused write (no activation: Firefox) keeps it for the next key or pointer.
  host.refuse = true;
  guestOffers(deliver, 5, 'guest five');
  await settle();
  assert.equal(share.pending, 'guest five', 'refused: pending');
  share.activated(false);
  await settle();
  assert.equal(share.pending, 'guest five', 'refused again: still pending');
  host.refuse = false;
  share.activated(false);
  await settle();
  assert.deepEqual(written, ['guest two', 'guest four', 'guest five']);
  // A paste chord drops it: the host's copy goes to the guest instead.
  host.focus = false;
  guestOffers(deliver, 6, 'guest six');
  await settle();
  share.activated(true);
  assert.equal(share.pending, undefined);
  host.focus = true;
  share.activated(false);
  await settle();
  assert.equal(written.length, 3);
  // Paused: the pending text goes.
  host.focus = false;
  guestOffers(deliver, 7, 'guest seven');
  await settle();
  share.pause();
  assert.equal(share.pending, undefined);
});

test("placeholders: an empty read is never offered and doesn't count as the host's; hidden reads in a run stop focus reads; refusals are silent", async () => {
  const { link, deliver, take } = fakeLink();
  const { host, written } = fakeHost();
  const share = new ClipboardShare(link, host);
  let changes = 0;
  share.onChange = () => changes++;
  share.setPermission('granted');
  await settle();
  // Nothing on the clipboard: nothing offered.
  assert.deepEqual(offered(take), []);
  host.text = 'real';
  await share.focused();
  assert.deepEqual(offered(take), ['real']);
  // A guest copy kept pending; an empty read (an image: types without text) neither offers nor writes it, nor
  // stands for the host's clipboard: the same text read after it is the one the page knew.
  host.focus = false;
  guestOffers(deliver, 1, 'from the guest');
  await settle();
  host.focus = true;
  host.text = '';
  host.types = ['image/png'];
  await share.focused();
  await settle();
  assert.deepEqual(offered(take), []);
  assert.deepEqual(written, []);
  assert.equal(share.pending, 'from the guest', 'an empty read: the pending text waits for a key');
  host.text = 'real';
  host.types = undefined;
  await share.focused();
  await settle();
  assert.deepEqual(offered(take), [], 'the same text as before the empty read: not new');
  assert.deepEqual(written, ['from the guest']);
  // Hidden: types say text, the text is empty. EMPTY_RUN in a row stop the focus reads, and the toolbar hears it;
  // a read without text among its types breaks a run.
  host.text = '';
  host.types = ['text/plain'];
  for (let i = 0; i < EMPTY_RUN - 1; i++) await share.focused();
  host.types = ['image/png'];
  await share.focused();
  host.types = ['text/plain'];
  for (let i = 0; i < EMPTY_RUN - 1; i++) await share.focused();
  assert.equal(share.stopped, false, 'a run broken by an image');
  const before = changes;
  await share.focused();
  assert.equal(share.stopped, true);
  assert.ok(changes > before, 'the toolbar is told');
  const reads = host.reads;
  host.text = 'later';
  host.types = undefined;
  await share.focused();
  assert.equal(host.reads, reads, 'stopped for the run');
  assert.deepEqual(offered(take), []);
  // Refusals: no throw, nothing offered.
  const b = fakeLink();
  const hb = fakeHost().host;
  hb.clipboard.readText = async () => { throw new DOMException('not focused', 'NotAllowedError'); };
  const sb = new ClipboardShare(b.link, hb);
  sb.setPermission('granted');
  await sb.focused();
  await settle();
  assert.deepEqual(offered(b.take), []);
  assert.equal(await sb.send(), false);
});

test("the toolbar's state and actions: waiting, sharing, paused; pause stops both ways and says PAUSE, resume sends nothing else; Send and Type read on the click", async () => {
  const { link, deliver, take, sent } = fakeLink();
  const { host, written } = fakeHost();
  const agent = link.agent;
  link.agent = undefined;
  const share = new ClipboardShare(link, host);
  assert.equal(share.state, 'waiting', 'before HELLO');
  let changes = 0;
  share.onChange = () => changes++;
  link.agent = agent;
  deliver(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TYPE | CAP.TEXT }));
  assert.equal(share.state, 'sharing');
  assert.equal(changes, 1);
  assert.equal(share.canType, true);
  // Pause: PAUSE to the agent; nothing read, offered or written; the paste chord not held.
  share.setPermission('granted');
  host.text = 'host';
  await settle();
  take(FRAME.OFFER);
  share.pause();
  assert.equal(share.state, 'paused');
  assert.equal(share.canType, false);
  assert.equal(take(FRAME.PAUSE).length, 1);
  host.text = 'host, while paused';
  const reads = host.reads;
  await share.focused();
  assert.equal(host.reads, reads);
  guestOffers(deliver, 1, 'guest, while paused');
  await settle();
  assert.deepEqual(written, []);
  assert.equal(share.chord({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), undefined);
  assert.equal(await share.send(), false);
  // Resume: RESUME and nothing more until the next copy or focus.
  share.resume();
  assert.equal(share.state, 'sharing');
  assert.deepEqual(sent.map((f) => f.type), [FRAME.RESUME]);
  take(FRAME.RESUME);
  // Send: the host's text offered on the click even when the guest has it; empty: nothing.
  host.text = 'sent';
  assert.equal(await share.send(), true);
  assert.equal(await share.send(), true);
  assert.deepEqual(offered(take), ['sent', 'sent']);
  host.text = '';
  assert.equal(await share.send(), false);
  // Type: TYPE with the host's text.
  host.text = 'typed\n';
  assert.equal(await share.typeIt(), true);
  assert.deepEqual(take(FRAME.TYPE).map((f) => new TextDecoder().decode(f.payload)), ['typed\n']);
  // The agent's end closes: waiting again.
  link.open = false;
  link.onOpen!(false);
  assert.equal(share.state, 'waiting');
  assert.equal(share.canType, false);
});

test('the read permission, followed: its state at once and at each change; none where the browser has no such permission', async () => {
  const status = new EventTarget() as EventTarget & { state: PermissionState };
  status.state = 'prompt';
  const seen: ReadPermission[] = [];
  const first = await watchReadPermission({ query: async () => status as unknown as PermissionStatus }, true, (s) => seen.push(s));
  assert.equal(first, 'prompt');
  status.state = 'granted';
  status.dispatchEvent(new Event('change'));
  status.state = 'denied';
  status.dispatchEvent(new Event('change'));
  assert.deepEqual(seen, ['prompt', 'granted', 'denied']);
  // Firefox and Safari: the name isn't a permission (a TypeError); no clipboard (not a secure context).
  assert.equal(await watchReadPermission({ query: async () => { throw new TypeError('not a permission'); } }, true, () => {}), 'none');
  assert.equal(await watchReadPermission({ query: async () => status as unknown as PermissionStatus }, false, () => {}), 'none');
  assert.equal(await watchReadPermission(undefined, true, () => {}), 'none');
});

test("a paste chord right after a sync's offer of the same text waits for that offer's ACK, not offering it twice", async () => {
  const { link, deliver, take } = fakeLink();
  const { host } = fakeHost();
  const share = new ClipboardShare(link, host);
  host.text = 'just copied';
  share.setPermission('granted');
  await settle();
  const [o] = take(FRAME.OFFER).map((f) => decodeOffer(f.payload)!);
  let done = false;
  const held = share.chord({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })!.then(() => { done = true; });
  share.pasted('just copied');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(take(FRAME.OFFER), [], 'not offered again');
  assert.equal(done, false, "the key waits for the sync's ACK");
  deliver(FRAME.ACK, encodeAck(o.serial, ACK.HELD));
  await held;
  // Once acknowledged, the same text lets the key go at once.
  const t0 = performance.now();
  await share.paste('just copied');
  assert.ok(performance.now() - t0 < ACK_WAIT / 2);
});
