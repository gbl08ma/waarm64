// Clipboard sharing's channel without a guest (docs/plans/clipboard.md §2): the agent's virtio-console
// (web/agent-device.ts) driven through hand-built queues as Linux's virtio_console drives it (the control handshake,
// the port's name, the guest's opens and closes, bytes both ways across buffers, a snapshot's state), the frames
// (web/agent-frame.ts) and their payloads (HELLO, TYPE: the same bytes as agent/src/frame.rs's tests), the page's end
// (web/app/agent-link.ts): its window of bytes in flight, HELLO, TYPE, the pause; and the guest agent's unit and
// script (web/app/guest-agent.ts), the script under dash on directories of its own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AGENT_PORTS, agentDevice, agentEntry, CTL_RX, CTL_TX, DEVICE_READY, F_MULTIPORT, MAX_PENDING, PORT_ADD, PORT_NAME, PORT_OPEN, PORT_READY, type AgentFromDevice } from '../web/agent-device.ts';
import { CAP, decodeHello, encodeFrame, encodeHello, FRAME, FrameReader, MAX_PAYLOAD, TYPE_CHUNK, typePayloads, VERSION } from '../web/agent-frame.ts';
import { AgentLink, PAGE_CAPS, WINDOW } from '../web/app/agent-link.ts';
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
  // The page's HELLO first, at each opening: taken by the guest at once here.
  assert.deepEqual(sent.map((b) => b[4]), [FRAME.HELLO]);
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
  assert.equal(link.backlog, encodeFrame(FRAME.HELLO, encodeHello({ version: VERSION, caps: PAGE_CAPS })).length, 'only the new opening\'s HELLO');
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

test("the link: HELLO at each opening, the agent's answer; TYPE once it can; PAUSE held over a reopening", async () => {
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
  assert.deepEqual(sent.map((f) => f.type), [FRAME.HELLO]);
  assert.deepEqual(decodeHello(sent[0].payload), { version: VERSION, caps: CAP.TYPE });
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
