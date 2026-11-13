// The guest agent's channel without a guest (docs/devices.md "The guest's agent"; the vsock device that carries it:
// tests/vsock.test.ts): the frames (web/agent-frame.ts) and their payloads (HELLO, TYPE, TIME: the same bytes as
// agent/src/frame.rs's tests), the page's end (web/app/agent-link.ts): its window of bytes in flight, HELLO, TIME,
// TYPE, the pause, a stream out of step reset; the guest agent's unit and
// script (web/app/guest-agent.ts), the script under dash on directories of its own; and the page's clipboard sharing
// (web/app/clipboard.ts) on a faked link and browser: both ways, the paste chord, sync on focus with the read
// permission, the pending text's rules, the placeholders, the pause, the toolbar's state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ACK, CAP, CHUNK, CREDIT, DATA_END, DATA_FAIL, decodeAck, decodeData, decodeHello, decodeMore, decodeOffer, decodeRequest, encodeAck, encodeData, encodeFrame, encodeHello, encodeMore, encodeOffer, encodeRequest, encodeTime, FRAME, FrameReader, MAX_PAYLOAD, TYPE_CHUNK, typePayloads, TYPED, UNKNOWN, VERSION, type Frame } from '../web/agent-frame.ts';
import { AgentLink, pageCaps, WINDOW } from '../web/app/agent-link.ts';
import { ACK_WAIT, ClipboardShare, EMPTY_RUN, INLINE, type ClipLink } from '../web/app/clipboard.ts';
import { PASTE_WAIT } from '../web/app/clipboard-chord.ts';
import { contentHash, HTML, IMAGE_CAP, imageHash, isPasteChord, onMac, PNG, TEXT, TEXT_CAP, textHash, watchReadPermission, type Host, type HostItem, type ReadPermission } from '../web/app/clipboard-host.ts';
import { REQUEST_WAIT } from '../web/app/clipboard-transfer.ts';
import { AGENT_FILE, agentBinary, agentCredentials, agentScript } from '../web/app/guest-agent.ts';
import { oemStrings } from '../web/app/guest-unit.ts';
import { guestWords } from '../web/app/guest-words.ts';
import { words } from './words.ts';

const open: MessagePort[] = [];
after(() => open.forEach((p) => p.close()));
/** A MessageChannel whose ports are closed when the tests end, whatever happened. */
function channel() {
  const c = new MessageChannel();
  open.push(c.port1, c.port2);
  return c;
}

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
  const link = new AgentLink(port1, pageCaps(true));
  const sent: Uint8Array[] = [];
  const dev = { bytes: 0 };
  const conns: number[] = [];
  port2.onmessage = (e) => { sent.push(e.data.bytes); dev.bytes += e.data.bytes.length; conns.push(e.data.conn); };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  assert.equal(link.send(FRAME.HELLO), false, 'closed: nothing sent');
  const opens: boolean[] = [];
  link.onOpen = (o) => opens.push(o);
  port2.postMessage({ type: 'open', open: true, conn: 1 });
  await settle();
  assert.deepEqual(opens, [true]);
  // The page's HELLO first, at each opening, and the switch: taken by the guest at once here.
  assert.deepEqual(sent.map((b) => b[4]), [FRAME.HELLO, FRAME.RESUME]);
  port2.postMessage({ type: 'taken', n: dev.bytes, conn: 1 });
  sent.length = 0;
  dev.bytes = 0;
  // Six frames of 64 KiB (and 5 bytes of header each): sent until the bytes in flight reach WINDOW, the fourth past it.
  const payload = new Uint8Array(65536);
  for (let i = 0; i < 6; i++) assert.equal(link.send(FRAME.DATA, payload), true);
  await settle();
  assert.equal(sent.length, Math.ceil(WINDOW / (65536 + 5)));
  assert.ok(link.backlog >= 6 * (65536 + 5) - 1);
  // The guest takes them: the rest go.
  port2.postMessage({ type: 'taken', n: dev.bytes, conn: 1 });
  await settle();
  assert.equal(sent.length, 6);
  // Frames in, cut anywhere.
  const frames: number[] = [];
  link.onFrame = (f) => frames.push(f.type);
  const both = new Uint8Array([...encodeFrame(FRAME.OFFER, new Uint8Array(3)), ...encodeFrame(FRAME.REQUEST)]);
  port2.postMessage({ type: 'data', conn: 1, bytes: both.subarray(0, 6) });
  port2.postMessage({ type: 'data', conn: 1, bytes: both.subarray(6) });
  await settle();
  assert.deepEqual(frames, [FRAME.OFFER, FRAME.REQUEST]);
  // A half frame, then the agent closes and reopens: the half is forgotten, and so is the queue.
  port2.postMessage({ type: 'data', conn: 1, bytes: both.subarray(0, 3) });
  link.send(FRAME.DATA, payload);
  port2.postMessage({ type: 'open', open: false, conn: 1 });
  port2.postMessage({ type: 'open', open: true, conn: 2 });
  port2.postMessage({ type: 'data', conn: 1, bytes: encodeFrame(FRAME.OFFER) });
  port2.postMessage({ type: 'data', conn: 2, bytes: encodeFrame(FRAME.HELLO) });
  await settle();
  assert.deepEqual(opens, [true, false, true]);
  assert.deepEqual(frames, [FRAME.OFFER, FRAME.REQUEST, FRAME.HELLO]); // the old connection's OFFER after the new one opened: dropped
  assert.equal(link.backlog, encodeFrame(FRAME.HELLO, encodeHello({ version: VERSION, caps: pageCaps(true) })).length + encodeFrame(FRAME.RESUME).length, 'only the new opening\'s HELLO and RESUME');
  assert.deepEqual([...new Set(conns)], [1, 2], 'each frame for its connection');
  link.close();
  port2.close();
});

test("the link: TIME goes ahead of the frames queued, and takes the time as it goes to the device (review 4)", async () => {
  const { port1, port2 } = channel();
  const link = new AgentLink(port1, pageCaps(true));
  const sent: Frame[] = [];
  const reader = new FrameReader();
  port2.onmessage = (e) => { if (e.data.type === 'data') sent.push(...reader.push(e.data.bytes)); };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  port2.postMessage({ type: 'open', open: true, conn: 1 });
  port2.postMessage({ type: 'data', conn: 1, bytes: encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TIME | CAP.TEXT })) });
  await settle();
  port2.postMessage({ type: 'taken', n: 1 << 20, conn: 1 });
  // A backlog past the window, then TIME: it goes before the queued frames, stamped when it goes.
  const payload = new Uint8Array(65536);
  for (let i = 0; i < 8; i++) link.send(FRAME.DATA, payload);
  const now = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    assert.equal(link.time(), true);
    clock = 2_000_000; // the backlog drains later
    port2.postMessage({ type: 'taken', n: WINDOW, conn: 1 });
    await settle();
  } finally {
    Date.now = now;
  }
  const after = sent.filter((f) => f.type !== FRAME.HELLO && f.type !== FRAME.RESUME);
  const t = after.findIndex((f) => f.type === FRAME.TIME);
  assert.ok(t >= 0 && after.slice(t + 1).filter((f) => f.type === FRAME.DATA).length >= 3, 'ahead of the queued frames');
  assert.equal(new DataView(after[t].payload.buffer, after[t].payload.byteOffset).getBigUint64(0, true), 2_000_000n * 1_000_000n);
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
  const link = new AgentLink(port1, pageCaps(true));
  const sent: { type: number; payload: Uint8Array }[] = [];
  const reader = new FrameReader();
  port2.onmessage = (e) => {
    sent.push(...reader.push(e.data.bytes));
    port2.postMessage({ type: 'taken', n: e.data.bytes.length, conn: e.data.conn });
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  assert.equal(link.type('ls\n'), false, 'closed');
  port2.postMessage({ type: 'open', open: true, conn: 1 });
  await settle();
  // The switch said at once: an agent restored from a snapshot taken while paused would be paused still.
  assert.deepEqual(sent.map((f) => f.type), [FRAME.HELLO, FRAME.RESUME]);
  assert.deepEqual(decodeHello(sent[0].payload), { version: VERSION, caps: CAP.TYPE | CAP.TEXT | CAP.IMAGE | CAP.TIME });
  sent.splice(1, 1);
  assert.equal(link.type('ls\n'), false, "open, but the agent hasn't said it can");
  const hellos: unknown[] = [];
  link.onHello.push((h) => hellos.push(h));
  port2.postMessage({ type: 'data', conn: 1, bytes: encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TYPE | 0x100 })) });
  await settle();
  assert.deepEqual(hellos, [{ version: 1, caps: CAP.TYPE | 0x100 }]);
  assert.equal(link.canType, true);
  assert.equal(link.type('héllo\n'), true);
  await settle();
  // Its frames, then an empty one: the paste's end (the agent drops the rest of a paste it had no room for).
  assert.deepEqual(sent.slice(1).map((f) => [f.type, new TextDecoder().decode(f.payload)]), [[FRAME.TYPE, 'héllo\n'], [FRAME.TYPE, '']]);
  sent.splice(2, 1);
  // Paused: nothing typed; the agent hears it, and again when it reopens its end (a restarted agent starts unpaused).
  link.pause();
  assert.equal(link.type('no'), false);
  await settle();
  assert.deepEqual(sent.slice(2).map((f) => f.type), [FRAME.PAUSE]);
  port2.postMessage({ type: 'open', open: false, conn: 1 });
  port2.postMessage({ type: 'open', open: true, conn: 2 });
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
  assert.deepEqual(c.map((x) => x.name), ['waarm64.agent.sh', 'systemd.extra-unit.waarm64-agent.service', 'systemd.unit-dropin.multi-user.target~waarm64-agent']);
  const unit = c[1].data;
  assert.match(unit, new RegExp(`^Description=${words('guest:guest-words.agent').source}$`, 'm'));
  for (const line of ['Type=simple', 'ImportCredential=waarm64.agent.sh', 'ExecStart=/bin/sh %d/waarm64.agent.sh', 'ExecStartPre=-+modprobe -q qemu_fw_cfg', 'TemporaryFileSystem=/run/waarm64:mode=0700,exec,nosuid', 'Nice=10', 'MemoryMax=32M', 'OOMScoreAdjust=500', 'ProtectSystem=strict', 'Restart=on-failure']) {
    assert.match(unit, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), line);
  }
  assert.doesNotMatch(unit, /^Type=oneshot$/m);
  // Restarts end: a failure that lasts (no port, the host's end closed) stops at systemd's start limit rather than
  // restarting every RestartSec for the boot, each start reading the binary out of fw_cfg again (~1.3 s of a vCPU).
  // The limit counts starts within its interval: they come RestartSec and a run (the read, at least 1.3 s) apart.
  const [unitPart, servicePart] = unit.split(/^\[Service\]$/m);
  const value = (part: string, key: string) => /^(\d+)(min|s)?$/.exec(new RegExp(`^${key}=(.*)$`, 'm').exec(part)?.[1] ?? '');
  const seconds = (m: RegExpExecArray | null) => (m ? Number(m[1]) * (m[2] === 'min' ? 60 : 1) : NaN);
  const interval = seconds(value(unitPart, 'StartLimitIntervalSec')), burst = Number(value(unitPart, 'StartLimitBurst')?.[1]);
  const restart = seconds(value(servicePart, 'RestartSec'));
  assert.ok(burst * (restart + 1.3) <= interval, `the start limit can't be reached: ${burst} starts in ${interval} s, ${restart} s apart`);
  // TIOCSTI as root needs CAP_SYS_ADMIN; the session children (step 3) change uid: no NoNewPrivileges, no PrivateDevices.
  assert.match(unit, /^CapabilityBoundingSet=.*\bCAP_SYS_ADMIN\b.*$/m);
  assert.match(unit, /^CapabilityBoundingSet=.*\bCAP_SETUID\b.*\bCAP_SETGID\b/m);
  assert.match(unit, /^CapabilityBoundingSet=.*\bCAP_KILL\b/m, "the children are the user's: stopping one needs CAP_KILL");
  assert.doesNotMatch(unit, /^(NoNewPrivileges|PrivateDevices|PrivateUsers|DynamicUser)=/m);
  // The clock (TIME): CAP_SYS_TIME, no ProtectClock; the page over vsock: AF_VSOCK, no private network namespace (a
  // kernel with vsock namespaces would keep the host's CID from it).
  assert.match(unit, /^CapabilityBoundingSet=.*\bCAP_SYS_TIME\b/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_VSOCK$/m);
  assert.doesNotMatch(unit, /^(ProtectClock|PrivateNetwork)=/m);
  // X11 (step 5): the private /tmp keeps the X server's sockets (read-only; none there is no failure).
  assert.match(unit, /^PrivateTmp=yes$/m);
  assert.match(unit, /^BindReadOnlyPaths=-\/tmp\/\.X11-unix$/m);
  assert.equal(c[2].data, '[Unit]\nWants=waarm64-agent.service\nAfter=waarm64-agent.service\n');
  for (const [i, x] of oemStrings(c).entries()) assert.equal(Buffer.from(x.split('=').slice(1).join('='), 'base64').toString(), c[i].data);
});

const hasDash = process.env.PATH?.split(':').some((p) => existsSync(join(p, 'dash')));

test("the guest agent's script: the binary out of fw_cfg, gunzipped into /run/waarm64, run in the script's place; without the file, nothing", { skip: !hasDash && 'no dash' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'waarm64-agent-'));
  try {
    const at = (p: string) => join(root, p);
    // The script with its absolute paths moved under `root`.
    mkdirSync(at('bin'));
    const script = join(root, 's.sh');
    writeFileSync(script, agentScript().replace(/(?<=[ =>])\/(sys|run)\//g, `${root}/$1/`));
    const run = () => execFileSync('dash', [script], { stdio: 'pipe', env: { PATH: `${at('bin')}:/usr/bin:/bin` } }).toString();
    // No fw_cfg file (no setting, or a kernel without qemu_fw_cfg): exits, nothing run.
    mkdirSync(at('run/waarm64'), { recursive: true });
    assert.equal(run(), '');
    assert.equal(existsSync(at('run/waarm64/agent')), false);
    // The file: copied, made executable for root only, run with the script's place (exec).
    const raw = at(`sys/firmware/qemu_fw_cfg/by_name/${AGENT_FILE}/raw`);
    mkdirSync(raw.replace(/\/raw$/, ''), { recursive: true });
    const program = `#!/bin/sh\necho "agent ran as $$ with $#"\n`;
    writeFileSync(raw, gzipSync(program));
    assert.match(run(), /^agent ran as \d+ with 0\n$/);
    assert.equal(readFileSync(at('run/waarm64/agent'), 'utf8'), program, 'gunzipped');
    assert.equal(execFileSync('stat', ['-c', '%a', at('run/waarm64/agent')]).toString().trim(), '500');
    assert.doesNotMatch(agentScript(), /udevadm/, 'no device to wait for: the agent connects by itself');
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
    assert.equal(await agentBinary('http://127.0.0.1:1/waarm64-agent'), undefined, 'nothing there');
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
  // TYPED and its statuses: the numbers agent/src/frame.rs pins.
  assert.deepEqual([FRAME.TYPED, TYPED.DONE, TYPED.NOT_TEXT, TYPED.REFUSED, TYPED.DROPPED], [12, 0, 1, 2, 3]);
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
  // What became of it, as the agent says (TYPED): kept for the menu until the next Type.
  assert.equal(share.typed, undefined);
  deliver(FRAME.TYPED, new Uint8Array([TYPED.NOT_TEXT]));
  assert.equal(share.typed, TYPED.NOT_TEXT);
  assert.equal(await share.typeIt(), true);
  assert.equal(share.typed, undefined, 'a new Type forgets the last one');
  deliver(FRAME.TYPED, new Uint8Array([TYPED.DONE]));
  assert.equal(share.typed, TYPED.DONE);
  take(FRAME.TYPE);
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

test("the paste chord by the host: Cmd+V on a Mac (Ctrl+V is the guest's there, held for nothing), Ctrl+V elsewhere (Meta+V no paste)", async () => {
  const k = (key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}, code = `Key${key.toUpperCase()}`) => ({ key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  assert.ok(!isPasteChord(k('v', { metaKey: true })), 'Meta+V off a Mac: no browser paste');
  assert.ok(isPasteChord(k('v', { metaKey: true }), true));
  assert.ok(isPasteChord(k('V', { metaKey: true, shiftKey: true }), true));
  assert.ok(!isPasteChord(k('v', { ctrlKey: true }), true), "Ctrl+V on a Mac: the guest's");
  assert.ok(!isPasteChord(k('Insert', { shiftKey: true }, 'Insert'), true));
  assert.equal(onMac({ platform: 'MacIntel' }), true);
  assert.equal(onMac({ platform: 'Linux aarch64', userAgentData: { platform: 'macOS' } }), true);
  assert.equal(onMac({ platform: 'Win32' }), false);
  assert.equal(onMac(undefined), false);
  const { link } = fakeLink();
  const share = new ClipboardShare(link, { ...fakeHost().host, mac: true });
  assert.equal(share.chord(k('v', { ctrlKey: true })), undefined, 'a Mac: Ctrl+V not held');
  assert.ok(share.chord(k('v', { metaKey: true })));
});

test("web/input.ts holds the paste chord's key: the keys after it wait behind it in order (Ctrl's release after V), a second press goes too, its repeats don't; a blur drops them", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  g.window = new EventTarget();
  g.document = Object.assign(new EventTarget(), { pointerLockElement: null, hidden: false });
  try {
    const { attachInput, codeOf } = await import('../web/input.ts');
    const el = new EventTarget() as unknown as HTMLElement;
    const got: [number, number][] = [];
    const keyboard = { postMessage: (m: number[][]) => got.push([m[0][1], m[0][2]]) } as unknown as MessagePort;
    let release = () => {};
    let holds = 0;
    const input = attachInput(el, {
      keyboard,
      hold: (e) => (e.code === 'KeyV' && e.ctrlKey ? (holds++, new Promise<void>((r) => (release = r))) : undefined),
    });
    const key = (type: 'keydown' | 'keyup', code: string, ctrlKey = false, repeat = false) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { code, key: code === 'KeyV' ? 'v' : code === 'KeyA' ? 'a' : code, ctrlKey, shiftKey: false, altKey: false, metaKey: false, repeat });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const [ctrl, v, a] = ['ControlLeft', 'KeyV', 'KeyA'].map((c) => codeOf(c)!);
    key('keydown', 'ControlLeft', true);
    assert.equal(key('keydown', 'KeyV', true), false, 'the held key: no preventDefault (its paste event comes)');
    key('keydown', 'KeyV', true, true);
    key('keyup', 'KeyV', true);
    key('keydown', 'KeyV', true);
    key('keyup', 'KeyV', true);
    key('keyup', 'ControlLeft');
    key('keydown', 'KeyA');
    key('keyup', 'KeyA');
    assert.deepEqual(got, [[ctrl, 1]], 'only Ctrl, while V is held');
    release();
    await settle();
    assert.deepEqual(got, [[ctrl, 1], [v, 1], [v, 0], [v, 1], [v, 0], [ctrl, 0], [a, 1], [a, 0]], 'V with Ctrl down, twice, then the rest in order');
    assert.equal(holds, 1, 'the second press: no second hold');
    // A blur while held: the held key and the ones after it never go down; what was down goes up.
    got.length = 0;
    key('keydown', 'ControlLeft', true);
    key('keydown', 'KeyV', true);
    key('keydown', 'KeyA', true);
    (g.window as EventTarget).dispatchEvent(new Event('blur'));
    release();
    await settle();
    assert.deepEqual(got, [[ctrl, 1], [ctrl, 0]]);
    input.detach();
  } finally {
    Object.assign(g, saved);
  }
});

test("web/input.ts's hold: what's held is released and the screen's keys, pointer and wheel go nowhere until it ends; the Sleep chord still goes", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  g.window = new EventTarget();
  g.document = Object.assign(new EventTarget(), { pointerLockElement: null, hidden: false });
  try {
    const { attachInput, codeOf } = await import('../web/input.ts');
    const el = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), setPointerCapture: () => {} }) as unknown as HTMLElement;
    const keys: number[][][] = [];
    const moves: number[][][] = [];
    const port = (to: unknown[]) => ({ postMessage: (m: unknown) => to.push(m) }) as unknown as MessagePort;
    const input = attachInput(el, { keyboard: port(keys), tablet: port(moves) });
    const key = (type: 'keydown' | 'keyup', code: string) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { code, key: code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const move = (x: number, buttons = 0, type = 'pointermove') =>
      el.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: 10, buttons, pointerType: 'mouse', pointerId: 1, movementX: 0, movementY: 0 }));
    const wheel = () => {
      const e = Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100, deltaX: 0, deltaMode: 0 });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const a = codeOf('KeyA')!;
    key('keydown', 'KeyA');
    move(10, 1, 'pointerdown');
    (keys.length = 0), (moves.length = 0);
    input.chord('Sleep');
    input.hold(true);
    assert.equal(input.held(), true);
    assert.deepEqual(keys.map((m) => m[0].slice(1)), [[codeOf('Sleep'), 1], [codeOf('Sleep'), 0], [a, 0]], 'the chord, then the held A released');
    assert.equal(moves.length, 1, "the held button released");
    (keys.length = 0), (moves.length = 0);
    move(50);
    move(60, 1, 'pointerdown');
    assert.equal(wheel(), true, "the wheel's scroll prevented");
    assert.equal(key('keydown', 'KeyB'), true, "a key's browser action prevented");
    key('keyup', 'KeyB');
    input.key('KeyC', true, { key: 'c', ctrlKey: false, altKey: false, metaKey: false });
    assert.deepEqual([keys, moves], [[], []], 'nothing reaches the guest');
    input.hold(false);
    move(70);
    key('keydown', 'KeyB');
    assert.equal(moves.length, 1);
    assert.deepEqual(keys.map((m) => m[0].slice(1)), [[codeOf('KeyB'), 1]]);
    input.detach();
  } finally {
    Object.assign(g, saved);
  }
});

test("echoes: the guest's text is offered back once the host's went to it since; an ACK refusing after ACK_WAIT is still taken", async () => {
  const { link, deliver, take } = fakeLink();
  const { host } = fakeHost();
  const share = new ClipboardShare(link, host);
  const offers = () => take(FRAME.OFFER).map((f) => decodeOffer(f.payload)!);
  // The guest copies X; the host's Y goes to the guest; the host copies X again: the guest has Y, so X is offered.
  guestOffers(deliver, 1, 'X');
  await settle();
  const p = share.paste('Y');
  deliver(FRAME.ACK, encodeAck(offers()[0].serial, ACK.HELD));
  await p;
  void share.paste('X');
  assert.deepEqual(offers().map((o) => new TextDecoder().decode(o.inline)), ['X'], 'the guest holds Y: X offered');
  // A refusal after the key went (the session not ready yet): the next paste offers it again.
  await new Promise((r) => setTimeout(r, ACK_WAIT + 20));
  await share.paste('late');
  const [o] = offers();
  deliver(FRAME.ACK, encodeAck(o.serial, ACK.NO_SESSION));
  void share.paste('late');
  assert.equal(offers().length, 1, 'refused late: offered again');
});

test("the guest's clipboard changed hands (the port reopened, HELLO, SESSION): the echo hashes forgotten, the transfers dropped, the host's text synced again", async () => {
  const { link, deliver, take } = fakeLink();
  const { host, written } = fakeHost();
  const share = new ClipboardShare(link, host);
  const offers = () => take(FRAME.OFFER).map((f) => decodeOffer(f.payload)!);
  const held = async (text: string) => {
    const p = share.paste(text);
    const os = offers();
    assert.equal(os.length, 1, `${text}: offered`);
    deliver(FRAME.ACK, encodeAck(os[0].serial, ACK.HELD));
    await p;
  };
  await held('A');
  // The agent restarts (its port closes and opens): the guest's clipboard lost A, so the same paste offers it again.
  link.open = false;
  link.onOpen!(false);
  link.open = true;
  link.onOpen!(true);
  await held('A');
  // SESSION (sway restarted, a VT switch): the same.
  deliver(FRAME.SESSION, new Uint8Array(0));
  await held('A');
  // ... and with the read permission, the host's text goes to the new session by itself.
  host.text = 'A';
  share.setPermission('granted');
  await settle();
  offers();
  deliver(FRAME.SESSION, new Uint8Array(0));
  await settle();
  assert.deepEqual(offers().map((o) => new TextDecoder().decode(o.inline)), ['A'], 'synced to the new session');
  // A dead child's transfers: an answer to its request stops (its MOREs find nothing), a request of ours too.
  const long = 'x'.repeat(CHUNK * 6);
  void share.paste(long);
  const [ol] = offers();
  deliver(FRAME.REQUEST, encodeRequest({ serial: ol.serial, id: 5, type: TEXT }));
  assert.equal(take(FRAME.DATA).length, CREDIT);
  deliver(FRAME.OFFER, encodeOffer({ serial: 9, types: [{ type: TEXT, size: UNKNOWN }] }));
  const [r] = requests(take(FRAME.REQUEST));
  deliver(FRAME.SESSION, new Uint8Array(0));
  deliver(FRAME.MORE, encodeMore(5, 4));
  assert.deepEqual(take(FRAME.DATA), [], "the dead child's request: nothing more");
  deliver(FRAME.DATA, encodeData(r.id, DATA_END, utf8('stale')));
  await settle();
  assert.ok(!written.includes('stale'), "the dead child's answer: not written");
});

test("the link: TIME once the agent said it can; a machine without the clipboard says only TIME, no switch; a stream out of step reset", async () => {
  const { port1, port2 } = channel();
  const link = new AgentLink(port1, pageCaps(false));
  const sent: Frame[] = [];
  const toDevice: { type: string }[] = [];
  const reader = new FrameReader();
  port2.onmessage = (e) => {
    toDevice.push(e.data);
    if (e.data.type !== 'data') return;
    sent.push(...reader.push(e.data.bytes));
    port2.postMessage({ type: 'taken', n: e.data.bytes.length, conn: e.data.conn });
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  port2.postMessage({ type: 'open', open: true, conn: 1 });
  await settle();
  assert.deepEqual(sent.map((f) => f.type), [FRAME.HELLO], 'no clipboard: no switch');
  assert.deepEqual(decodeHello(sent[0].payload), { version: VERSION, caps: CAP.TIME });
  assert.equal(link.time(1000), false, "before the agent's HELLO");
  port2.postMessage({ type: 'data', conn: 1, bytes: encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TYPE })) });
  await settle();
  assert.equal(link.time(1000), false, 'an agent without CAP.TIME');
  port2.postMessage({ type: 'open', open: false, conn: 1 });
  port2.postMessage({ type: 'open', open: true, conn: 2 });
  port2.postMessage({ type: 'data', conn: 2, bytes: encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TIME })) });
  await settle();
  assert.equal(link.time(1_763_000_000_123.5), true);
  await settle();
  const t = sent.filter((f) => f.type === FRAME.TIME);
  assert.equal(t.length, 1);
  assert.equal(new DataView(t[0].payload.buffer, t[0].payload.byteOffset).getBigUint64(0, true), 1_763_000_000_123_500_000n);
  // Out of step (a length that can't be): the page resets the connection; the agent connects again.
  port2.postMessage({ type: 'data', conn: 2, bytes: new Uint8Array([0, 0, 0, 0, 1, 2, 3]) });
  await settle();
  assert.deepEqual(toDevice.at(-1), { type: 'reset', conn: 2 });
  // Its reader stays broken until the connection ends: one reset, not one a message (a later one could end the next connection).
  port2.postMessage({ type: 'data', conn: 2, bytes: new Uint8Array([9, 9, 9, 9]) });
  await settle();
  assert.equal(toDevice.filter((m) => m.type === 'reset').length, 1);
  link.close();
  port2.close();
});

test('frames: TIME and SESSION (the bytes agent/src/frame.rs pins)', () => {
  assert.deepEqual([...encodeTime(1_763_000_000_123.5)], [...new Uint8Array(new BigUint64Array([1_763_000_000_123_500_000n]).buffer)]);
  assert.deepEqual([...encodeFrame(FRAME.TIME, encodeTime(0))], [9, 0, 0, 0, 13, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeHello({ version: 1, caps: CAP.TIME })], [1, 0, 16, 0, 0, 0]);
  assert.deepEqual([FRAME.SESSION, FRAME.TIME, CAP.TIME], [11, 13, 16]);
  assert.deepEqual(pageCaps(false), CAP.TIME);
});

// ---- Images (docs/plans/clipboard.md §4.4).

/** Small images' bytes, as their types begin (the page passes them on; the conversion is faked here, real in tests/page-clipboard-ui.test.ts). */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const BMP_BYTES = new Uint8Array([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36]);
/** `n` bytes of a picture (a pattern: compared with `Buffer.compare`, never deepEqual'd). */
const picture = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + (i >> 9)) & 0xff);
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
/** Waits (bounded) until `f` holds: the image paths await the browser's promises and hashes. */
async function until(f: () => boolean, what: string) {
  for (let i = 0; i < 500; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail(`never: ${what}`);
}
const quiet = () => new Promise((r) => setTimeout(r, 50));

/**
 * The browser with images: `clip` is the host's clipboard as one item (its types' Blobs), which `write` replaces after
 * awaiting its promises, re-encoding a PNG as the browser does (other bytes, the same picture: here a byte prepended);
 * `toPng` converts by prepending the PNG signature to the image (recorded in `converted`).
 */
function imageHost() {
  const writes: Record<string, Blob>[] = [];
  const converted: string[] = [];
  type ImageHost = Host & { focus: boolean; refuse: boolean; clip: Record<string, Blob>; clipboard: Required<Host["clipboard"]> };
  const h: ImageHost = {
    focus: true,
    refuse: false,
    clip: {} as Record<string, Blob>,
    changeEvents: false,
    hasFocus: () => h.focus,
    clipboard: {
      writeText: async (s: string) => {
        if (h.refuse) throw new DOMException('no activation', 'NotAllowedError');
        h.clip = { 'text/plain': new Blob([s], { type: 'text/plain' }) };
      },
      readText: async () => (await h.clip['text/plain']?.text()) ?? '',
      read: async (): Promise<HostItem[]> => [{ types: Object.keys(h.clip), getType: async (t: string) => h.clip[t] }],
      write: async (item: Record<string, Promise<Blob>>) => {
        if (h.refuse) throw new DOMException('no activation', 'NotAllowedError');
        const got: Record<string, Blob> = {};
        for (const [t, p] of Object.entries(item)) got[t] = await p;
        writes.push(got);
        const png = got[PNG] && new Blob([new Uint8Array([0]), await got[PNG].arrayBuffer()], { type: PNG });
        h.clip = { ...got, ...(png ? { [PNG]: png } : {}) };
      },
    },
    toPng: async (b: Blob) => {
      converted.push(b.type);
      return new Blob([PNG_BYTES.subarray(0, 8), await b.arrayBuffer()], { type: PNG });
    },
  };
  return { host: h, writes, converted };
}

/** The agent answers the page's request `id` with `bytes`, in chunks, as the page's MOREs allow. */
function answerAll(deliver: (type: number, p: Uint8Array) => void, take: (type: number) => Frame[], id: number, bytes: Uint8Array) {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length || chunks.length === 0; at += CHUNK) chunks.push(bytes.subarray(at, at + CHUNK));
  let credit = CREDIT;
  for (let k = 0; k < chunks.length; k++) {
    assert.ok(credit > 0, 'the page granted no more');
    deliver(FRAME.DATA, encodeData(id, k === chunks.length - 1 ? DATA_END : 0, chunks[k]));
    credit--;
    for (const m of take(FRAME.MORE).map((f) => decodeMore(f.payload)!)) if (m.id === id) credit += m.n;
  }
}

const IMAGES = CAP.TYPE | CAP.TEXT | CAP.IMAGE;

test("images, guest to host: requested at the write as a ClipboardItem's promise (PNG as it is, another type converted to PNG, the text in the same item); none without CAP.IMAGE; capped", async () => {
  const { link, deliver, take } = fakeLink(IMAGES);
  const { host, writes, converted } = imageHost();
  const share = new ClipboardShare(link, host);
  const images: Blob[] = [];
  share.onImage = (b) => images.push(b);
  assert.equal(share.images, true);
  // A PNG of 200 KiB, offered without its bytes: requested (as the guest's type) and streamed under the credit.
  const big = picture(200 << 10);
  deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: PNG, size: UNKNOWN }] }));
  const [r1] = requests(take(FRAME.REQUEST));
  assert.deepEqual({ serial: r1.serial, type: r1.type }, { serial: 1, type: PNG });
  answerAll(deliver, take, r1.id, big);
  await until(() => writes.length === 1, 'the PNG written');
  assert.deepEqual(Object.keys(writes[0]), [PNG]);
  assert.ok(same(await bytesOf(writes[0][PNG]), big), 'the PNG as it came');
  assert.deepEqual(converted, [], 'a PNG: not converted');
  await until(() => images.length === 1, 'onImage');
  // A JPEG with text inline: one item, the JPEG converted to PNG in the worker, the text beside it.
  deliver(FRAME.OFFER, encodeOffer({ serial: 2, types: [{ type: TEXT, size: 3 }, { type: 'image/jpeg', size: UNKNOWN }], inline: utf8('alt') }));
  const [r2] = requests(take(FRAME.REQUEST));
  assert.equal(r2.type, 'image/jpeg', 'the text inline: only the image requested');
  answerAll(deliver, take, r2.id, JPEG_BYTES);
  await until(() => writes.length === 2, 'the JPEG written');
  assert.deepEqual(Object.keys(writes[1]).sort(), [PNG, 'text/plain']);
  assert.equal(await writes[1]['text/plain'].text(), 'alt');
  assert.deepEqual(converted, ['image/jpeg']);
  const png = await bytesOf(writes[1][PNG]);
  assert.ok(same(png.subarray(0, 8), PNG_BYTES.subarray(0, 8)) && same(png.subarray(8), JPEG_BYTES), 'the converted PNG');
  // A BMP with long text: both requested, both in the item.
  deliver(FRAME.OFFER, encodeOffer({ serial: 3, types: [{ type: TEXT, size: UNKNOWN }, { type: 'image/bmp', size: UNKNOWN }] }));
  const rs = requests(take(FRAME.REQUEST));
  assert.deepEqual(rs.map((r) => r.type).sort(), ['image/bmp', TEXT]);
  const long = 'x'.repeat(5000);
  answerAll(deliver, take, rs.find((r) => r.type === TEXT)!.id, utf8(long));
  answerAll(deliver, take, rs.find((r) => r.type === 'image/bmp')!.id, BMP_BYTES);
  await until(() => writes.length === 3, 'the BMP written');
  assert.equal(await writes[2]['text/plain'].text(), long);
  assert.deepEqual(converted, ['image/jpeg', 'image/bmp']);
  // Past the cap by its size: not requested; an answer running past it stops (MORE 0), nothing written.
  deliver(FRAME.OFFER, encodeOffer({ serial: 4, types: [{ type: PNG, size: IMAGE_CAP + 1 }] }));
  assert.deepEqual(take(FRAME.REQUEST), []);
  deliver(FRAME.OFFER, encodeOffer({ serial: 5, types: [{ type: PNG, size: UNKNOWN }] }));
  const [r5] = requests(take(FRAME.REQUEST));
  const chunk = encodeData(r5.id, 0, new Uint8Array(CHUNK));
  for (let k = 0; k <= IMAGE_CAP / CHUNK; k++) deliver(FRAME.DATA, chunk);
  assert.deepEqual(take(FRAME.MORE).map((f) => decodeMore(f.payload)!).at(-1), { id: r5.id, n: 0 });
  await quiet();
  assert.equal(writes.length, 3, 'nothing past the cap written');
  // An agent without CAP.IMAGE (an older one): its image offers aren't taken; the text of one is.
  const old = fakeLink(CAP.TYPE | CAP.TEXT);
  const o = imageHost();
  const s2 = new ClipboardShare(old.link, o.host);
  assert.equal(s2.images, false);
  old.deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: PNG, size: 10 }] }));
  old.deliver(FRAME.OFFER, encodeOffer({ serial: 2, types: [{ type: TEXT, size: 2 }, { type: PNG, size: 10 }], inline: utf8('hi') }));
  await quiet();
  assert.deepEqual(old.take(FRAME.REQUEST), []);
  assert.equal(await o.host.clipboard.readText(), 'hi');
});

test("images, guest to host: kept pending without focus (the newest only, a newer text replaces it), written on a key; a refused write stays pending; read back once after the write, so its re-encoding isn't sent back", async () => {
  const { link, deliver, take } = fakeLink(IMAGES);
  const { host, writes } = imageHost();
  const share = new ClipboardShare(link, host);
  // Through functions: an assertion would narrow the fields for good.
  const [pendingSerial, pendingText] = [() => share.pendingItem?.serial, () => share.pending];
  host.focus = false;
  deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: PNG, size: UNKNOWN }] }));
  assert.deepEqual(take(FRAME.REQUEST), [], 'no focus: nothing requested (the bytes cross at the write)');
  assert.equal(pendingSerial(), 1);
  deliver(FRAME.OFFER, encodeOffer({ serial: 2, types: [{ type: TEXT, size: 4 }], inline: utf8('text') }));
  assert.equal(pendingSerial(), undefined, 'a newer text replaces it');
  assert.equal(pendingText(), 'text');
  deliver(FRAME.OFFER, encodeOffer({ serial: 3, types: [{ type: PNG, size: UNKNOWN }] }));
  assert.equal(pendingText(), undefined);
  assert.equal(pendingSerial(), 3);
  // A key on the screen (activation), the write refused: requested, stopped (MORE 0), pending again.
  host.refuse = true;
  share.activated(false);
  const [r] = requests(take(FRAME.REQUEST));
  assert.equal(r.serial, 3);
  await until(() => pendingSerial() !== undefined, 'pending again after the refusal');
  assert.deepEqual(take(FRAME.MORE).map((f) => decodeMore(f.payload)), [{ id: r.id, n: 0 }]);
  // Allowed, with the permission and focus: written on the next key, then read back: what the browser made of it is
  // the guest's.
  host.refuse = false;
  host.focus = true;
  share.setPermission('granted');
  await quiet();
  assert.deepEqual(take(FRAME.OFFER), [], 'the empty host clipboard: nothing offered');
  share.activated(false);
  const [r3] = requests(take(FRAME.REQUEST));
  assert.equal(r3.serial, 3);
  const pic = picture(70000, 3);
  answerAll(deliver, take, r3.id, pic);
  await until(() => writes.length === 1, 'written');
  assert.equal((await bytesOf(host.clip[PNG])).length, pic.length + 1, 'the host re-encoded it');
  await quiet();
  // Focus reads of what the host has now (the guest's own image, re-encoded): not offered back.
  for (let i = 0; i < 3; i++) await share.focused();
  await quiet();
  assert.deepEqual(take(FRAME.OFFER), [], "the guest's image, re-encoded by the browser, offered back");
  // The host's own copy after it: offered.
  host.clip = { [PNG]: new Blob([PNG_BYTES], { type: PNG }) };
  await share.focused();
  await until(() => take(FRAME.OFFER).length === 1, "the host's image offered");
});

test("images, host to guest: a sync's PNG and text offered together (the text inline), the PNG answered under the agent's MOREs; unchanged: not again; the paste chord's File; one image held; capped; text only for an agent without CAP.IMAGE", async () => {
  const { link, sent, deliver, take } = fakeLink(IMAGES);
  const { host } = imageHost();
  host.changeEvents = true;
  const share = new ClipboardShare(link, host);
  const pic = picture(300 << 10, 5);
  host.clip = { [PNG]: new Blob([pic], { type: PNG }), 'text/plain': new Blob(['a picture'], { type: 'text/plain' }) };
  share.setPermission('granted');
  await until(() => sent.some((f) => f.type === FRAME.OFFER), "the sync's offer");
  const [f] = take(FRAME.OFFER);
  const o = decodeOffer(f.payload)!;
  assert.deepEqual(o.types, [{ type: TEXT, size: 9 }, { type: PNG, size: pic.length }]);
  assert.equal(new TextDecoder().decode(o.inline), 'a picture', 'the text inline, the first type');
  // A change event with the same clipboard: read, not offered again.
  share.clipboardChanged();
  await quiet();
  assert.deepEqual(take(FRAME.OFFER), [], 'unchanged: not offered again');
  // The agent requests the PNG: 4 frames, then one for each MORE.
  deliver(FRAME.REQUEST, encodeRequest({ serial: o.serial, id: 70, type: PNG }));
  let got = take(FRAME.DATA).map((d) => decodeData(d.payload)!);
  assert.equal(got.length, CREDIT);
  deliver(FRAME.MORE, encodeMore(70, 10));
  got = got.concat(take(FRAME.DATA).map((d) => decodeData(d.payload)!));
  assert.equal(got.at(-1)!.flags, DATA_END);
  const all = new Uint8Array(got.reduce((n, d) => n + d.bytes.length, 0));
  got.reduce((at, d) => (all.set(d.bytes, at), at + d.bytes.length), 0);
  assert.ok(same(all, pic), 'the PNG answered whole');
  // A type it hasn't: FAIL.
  deliver(FRAME.REQUEST, encodeRequest({ serial: o.serial, id: 71, type: 'image/jpeg' }));
  assert.deepEqual(take(FRAME.DATA).map((d) => decodeData(d.payload)!.flags), [DATA_FAIL]);
  // An answer in progress when a newer image is offered (the paste chord's File): it fails, the page holding one image
  // of its own.
  deliver(FRAME.REQUEST, encodeRequest({ serial: o.serial, id: 72, type: PNG }));
  take(FRAME.DATA);
  const file = new Blob([PNG_BYTES], { type: PNG });
  const held = share.chord({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })!;
  share.pasted('', file);
  await until(() => sent.some((x) => x.type === FRAME.OFFER), "the paste chord's image offered");
  assert.deepEqual(take(FRAME.OFFER).map((x) => decodeOffer(x.payload)!.types), [[{ type: PNG, size: PNG_BYTES.length }]]);
  assert.deepEqual(take(FRAME.DATA).map((d) => decodeData(d.payload)!.flags), [DATA_FAIL]);
  deliver(FRAME.MORE, encodeMore(72, 5));
  assert.deepEqual(take(FRAME.DATA), [], 'the older answer ended');
  await held;
  // Past the cap: not offered (by its size, before any bytes are read).
  const huge = { size: IMAGE_CAP + 1, arrayBuffer: () => assert.fail('read past the cap') } as unknown as Blob;
  await share.paste({ image: huge }, true);
  assert.deepEqual(take(FRAME.OFFER), []);
  await share.paste({ text: 'beside', image: huge }, true);
  assert.deepEqual(take(FRAME.OFFER).map((x) => decodeOffer(x.payload)!.types.map((t) => t.type)), [[TEXT]], 'the text alone');
  // An agent without CAP.IMAGE: the text alone; an image alone: nothing.
  const old = fakeLink(CAP.TYPE | CAP.TEXT);
  const s2 = new ClipboardShare(old.link, imageHost().host);
  await s2.paste({ text: 'words', image: file }, true);
  assert.deepEqual(old.take(FRAME.OFFER).map((x) => decodeOffer(x.payload)!.types.map((t) => t.type)), [[TEXT]]);
  await s2.paste({ image: file }, true);
  assert.deepEqual(old.take(FRAME.OFFER), []);
});

test('images: the hashes the page remembers (text, image, both)', async () => {
  const a = await imageHash(new Uint8Array(PNG_BYTES));
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, await imageHash(new Uint8Array(JPEG_BYTES)));
  assert.equal(contentHash('hi'), `${textHash('hi')}/`);
  assert.equal(contentHash(undefined, a), `/${a}`);
  assert.notEqual(contentHash('hi', a), contentHash('hi'));
  assert.equal(contentHash(''), contentHash(undefined), 'empty text is none');
});

// ---- HTML (docs/plans/clipboard.md §3.2, §4.3).

test("HTML, guest to host: written with its text as one ClipboardItem, the HTML requested at the write; its text's hash stands for it (not offered back); without ClipboardItem writes, the text alone; HTML that doesn't come is the text's, escaped", async () => {
  const { link, deliver, take } = fakeLink(IMAGES);
  const { host, writes } = imageHost();
  const share = new ClipboardShare(link, host);
  const written: string[] = [];
  share.onWritten = (s) => written.push(s);
  deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: TEXT, size: 4 }, { type: HTML, size: UNKNOWN }], inline: utf8('bold') }));
  const [r] = requests(take(FRAME.REQUEST));
  assert.deepEqual({ serial: r.serial, type: r.type }, { serial: 1, type: HTML }, 'the text inline: only the HTML requested');
  answerAll(deliver, take, r.id, utf8('<b>bold</b>'));
  await until(() => writes.length === 1, 'the item written');
  assert.deepEqual(Object.keys(writes[0]).sort(), ['text/html', 'text/plain']);
  assert.equal(await writes[0]['text/html'].text(), '<b>bold</b>');
  assert.equal(await writes[0]['text/plain'].text(), 'bold');
  await until(() => written.length === 1, 'onWritten');
  assert.deepEqual(written, ['bold']);
  // A focus read of it (with the permission): the guest's own, not offered back.
  share.setPermission('granted');
  await share.focused();
  await quiet();
  assert.deepEqual(take(FRAME.OFFER), [], "the guest's HTML offered back");
  // Long text and HTML: both requested; HTML that fails is the text's, escaped.
  deliver(FRAME.OFFER, encodeOffer({ serial: 2, types: [{ type: TEXT, size: UNKNOWN }, { type: HTML, size: UNKNOWN }] }));
  const rs = requests(take(FRAME.REQUEST));
  assert.deepEqual(rs.map((x) => x.type).sort(), [HTML, TEXT].sort());
  answerAll(deliver, take, rs.find((x) => x.type === TEXT)!.id, utf8('a < b'));
  deliver(FRAME.DATA, encodeData(rs.find((x) => x.type === HTML)!.id, DATA_FAIL));
  await until(() => writes.length === 2, 'the item written without the HTML');
  assert.equal(await writes[1]['text/html'].text(), 'a &lt; b', 'the text, escaped');
  // HTML past the cap by its size: the text alone (writeText).
  deliver(FRAME.OFFER, encodeOffer({ serial: 3, types: [{ type: TEXT, size: 2 }, { type: HTML, size: TEXT_CAP + 1 }], inline: utf8('hi') }));
  await until(() => Object.keys(host.clip).join() === 'text/plain', 'the text alone');
  assert.equal(await host.clip['text/plain'].text(), 'hi');
  assert.deepEqual(take(FRAME.REQUEST), []);
  // A browser without ClipboardItem writes: the text alone.
  const plain = fakeLink(IMAGES);
  const f = fakeHost();
  new ClipboardShare(plain.link, f.host);
  plain.deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: TEXT, size: 2 }, { type: HTML, size: UNKNOWN }], inline: utf8('ok') }));
  await quiet();
  assert.deepEqual(f.written, ['ok']);
  assert.deepEqual(plain.take(FRAME.REQUEST), []);
});

test("HTML, host to guest: offered after the text (and the image), answered when the agent requests it; the paste chord's HTML too; never alone, nor past the cap; the same text with other HTML is the same content", async () => {
  const { link, sent, deliver, take } = fakeLink(IMAGES);
  const { host } = imageHost();
  host.changeEvents = true;
  const share = new ClipboardShare(link, host);
  host.clip = { 'text/plain': new Blob(['hello'], { type: 'text/plain' }), 'text/html': new Blob(['<i>hello</i>'], { type: HTML }) };
  share.setPermission('granted');
  await until(() => sent.some((f) => f.type === FRAME.OFFER), "the sync's offer");
  const o = decodeOffer(take(FRAME.OFFER)[0].payload)!;
  assert.deepEqual(o.types, [{ type: TEXT, size: 5 }, { type: HTML, size: 12 }]);
  deliver(FRAME.REQUEST, encodeRequest({ serial: o.serial, id: 40, type: HTML }));
  const [d] = take(FRAME.DATA).map((x) => decodeData(x.payload)!);
  assert.equal(d.flags, DATA_END);
  assert.equal(new TextDecoder().decode(d.bytes), '<i>hello</i>');
  // Other HTML for the same text: the same content, not offered again.
  host.clip = { 'text/plain': new Blob(['hello'], { type: 'text/plain' }), 'text/html': new Blob(['<b>hello</b>'], { type: HTML }) };
  share.clipboardChanged();
  await quiet();
  assert.deepEqual(take(FRAME.OFFER), []);
  // The paste chord's HTML, beside its text; with an image, after it.
  const chord = { key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
  let held = share.chord(chord)!;
  share.pasted('pasted', undefined, '<p>pasted</p>');
  await held;
  assert.deepEqual(take(FRAME.OFFER).map((x) => decodeOffer(x.payload)!.types), [[{ type: TEXT, size: 6 }, { type: HTML, size: 13 }]]);
  held = share.chord(chord)!;
  share.pasted('', new Blob([PNG_BYTES], { type: PNG }), '<img>');
  await held;
  assert.deepEqual(take(FRAME.OFFER).map((x) => decodeOffer(x.payload)!.types.map((t) => t.type)), [[PNG, HTML]]);
  // Never alone; past the cap, the text without it.
  await share.paste({ html: '<p>alone</p>' }, true);
  assert.deepEqual(take(FRAME.OFFER), []);
  await share.paste({ text: 'small', html: 'x'.repeat(TEXT_CAP + 1) }, true);
  assert.deepEqual(take(FRAME.OFFER).map((x) => decodeOffer(x.payload)!.types.map((t) => t.type)), [[TEXT]]);
});

test("a guest image whose bytes never come: its request stops after REQUEST_WAIT (MORE 0), and the focus syncs held behind its write go on", async () => {
  assert.ok(REQUEST_WAIT >= 10_000, 'long enough for a guest program to encode a large image');
  const { link, deliver, take } = fakeLink(IMAGES);
  const { host, writes } = imageHost();
  const share = new ClipboardShare(link, host);
  share.requestWait = 100;
  share.setPermission('granted');
  await quiet();
  take(FRAME.OFFER);
  // A guest program offers an image and never serves it (frozen, or an X11 owner that never answers).
  deliver(FRAME.OFFER, encodeOffer({ serial: 1, types: [{ type: PNG, size: UNKNOWN }] }));
  const [r] = requests(take(FRAME.REQUEST));
  assert.equal(r.type, PNG);
  // A DATA before the wait ends keeps it going.
  await new Promise((done) => setTimeout(done, 60));
  deliver(FRAME.DATA, encodeData(r.id, 0, picture(1000)));
  await new Promise((done) => setTimeout(done, 60));
  assert.deepEqual(take(FRAME.MORE).map((f) => decodeMore(f.payload)), [{ id: r.id, n: 1 }], 'a DATA restarts the wait');
  await new Promise((done) => setTimeout(done, 150));
  assert.deepEqual(take(FRAME.MORE).map((f) => decodeMore(f.payload)), [{ id: r.id, n: 0 }], 'stopped once nothing came');
  assert.equal(writes.length, 0);
  // The host's own copy: the next focus offers it.
  host.clip = { 'text/plain': new Blob(["the host's"], { type: 'text/plain' }) };
  await share.focused();
  await until(() => take(FRAME.OFFER).length === 1, "the host's text offered after the stuck write");
});

test("a focus read still reading its image when a paste chord's text comes: the chord's offer goes last", async () => {
  const { link, take } = fakeLink(IMAGES);
  let release!: () => void;
  const late = new Promise<void>((r) => (release = r));
  const pic = picture(1000, 9);
  // The host's clipboard has an image whose bytes come late (a large one, read for its hash).
  const slow = { size: pic.length, type: PNG, arrayBuffer: async () => (await late, pic.buffer) } as unknown as Blob;
  const host: Host = {
    hasFocus: () => true,
    clipboard: { writeText: async () => {}, readText: async () => '', read: async () => [{ types: [PNG], getType: async () => slow }], write: async () => {} },
  };
  const share = new ClipboardShare(link, host);
  // Becoming granted reads at once: that read is hashing the image when the chord's paste comes with new text.
  share.setPermission('granted');
  await settle();
  const held = share.chord({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  assert.ok(held);
  share.pasted('new text');
  release();
  await quiet();
  const offers = take(FRAME.OFFER).map((f) => decodeOffer(f.payload)!);
  assert.ok(offers.length > 0);
  assert.equal(new TextDecoder().decode(offers.at(-1)!.inline), 'new text', `the offers: ${offers.map((o) => o.types.map((t) => t.type))}`);
  // Two offers: an image read late, then text: the text's goes, not the image's after it.
  let release2!: () => void;
  const late2 = new Promise<void>((r) => (release2 = r));
  const pic2 = picture(1000, 10);
  const slow2 = { size: pic2.length, type: PNG, arrayBuffer: async () => (await late2, pic2.buffer) } as unknown as Blob;
  const first = share.paste({ image: slow2 }, true);
  const second = share.paste('later', true);
  release2();
  await Promise.all([first, second]);
  const after = take(FRAME.OFFER).map((f) => decodeOffer(f.payload)!);
  assert.deepEqual(after.map((o) => new TextDecoder().decode(o.inline)), ['later'], "the older image's offer sent after the text's");
});

test("the guest's clock (web/app/areas/agent-actions.ts): TIME at the agent's HELLO and on `syncClock`, under Preferences' switch; again when the wall clock moves away from performance.now() (the host slept)", async (t) => {
  const { AgentActions, SLEEP_CHECK_MS, SLEEP_GAP_MS } = await import('../web/app/areas/agent-actions.ts');
  const g = globalThis as unknown as { location?: unknown; localStorage?: unknown; window?: unknown };
  const saved = { location: g.location, localStorage: g.localStorage, window: g.window };
  let search = '';
  g.location = { get search() { return search; } };
  g.localStorage = { getItem: () => null, setItem: () => undefined };
  g.window = {};
  t.after(() => Object.assign(g, saved));
  const { port1, port2 } = channel();
  const times: Frame[] = [];
  const reader = new FrameReader();
  port2.onmessage = (e) => {
    if (e.data.type !== 'data') return;
    times.push(...reader.push(e.data.bytes).filter((f) => f.type === FRAME.TIME));
    port2.postMessage({ type: 'taken', n: e.data.bytes.length, conn: e.data.conn });
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  let ups = 0;
  // The wall clock as the actions read it: the real one, moved on by `jump` (a host's sleep performance.now() missed).
  let jump = 0;
  const now = Date.now;
  Date.now = () => now() + jump;
  t.after(() => { Date.now = now; });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const actions = new AgentActions();
  const link = actions.begin({ agent: { port1, port2: undefined as unknown as MessagePort } as MessageChannel, clipboard: false, agentStub: false }, () => ups++)!;
  assert.equal(link.caps, CAP.TIME);
  assert.equal(actions.syncClock(), false, 'no agent yet');
  port2.postMessage({ type: 'open', open: true, conn: 1 });
  port2.postMessage({ type: 'data', conn: 1, bytes: encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TIME })) });
  await settle();
  assert.equal(ups, 1, 'the HELLO: the guest is up');
  assert.equal(times.length, 1, 'TIME at the HELLO');
  assert.equal(actions.syncClock(), true);
  await settle();
  assert.equal(times.length, 2, 'TIME after a pause');
  // The wall clock steady: nothing; then it jumps past the gap between two checks: TIME.
  t.mock.timers.tick(SLEEP_CHECK_MS);
  await settle();
  assert.equal(times.length, 2);
  jump = SLEEP_GAP_MS + 1000;
  t.mock.timers.tick(SLEEP_CHECK_MS);
  await settle();
  assert.equal(times.length, 3, "the host's sleep");
  // Off (`?clocksync=0`): nothing sent.
  search = '?clocksync=0';
  assert.equal(actions.syncClock(), false);
  jump += SLEEP_GAP_MS + 1000;
  t.mock.timers.tick(SLEEP_CHECK_MS);
  await settle();
  assert.equal(times.length, 3);
  // The run ends (review 5): its link closed, the sleep check stopped, nothing to set.
  search = '';
  actions.end();
  assert.equal(actions.syncClock(), false, 'after the run');
  assert.equal((g.window as { __agent?: unknown }).__agent, undefined);
  jump += SLEEP_GAP_MS + 1000;
  t.mock.timers.tick(SLEEP_CHECK_MS);
  await settle();
  assert.equal(times.length, 3);
  port2.close();
});
