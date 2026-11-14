// The page's end of the guest agent's connection (web/vsock-device.ts; docs/devices.md "The guest's agent"): frames to
// and from the agent (web/agent-frame.ts), whether it is connected, and how much the page has in flight. The device
// takes the page's bytes as the guest's credit and buffers allow; the link keeps at most `WINDOW` bytes the guest hasn't
// taken yet, so a guest that stops reading costs the page a queue of frames, not the device's memory.
//
// What it says: HELLO each time the agent connects (the agent answers with its own: `agent`), with the capabilities the
// page uses (`caps`: the clock's TIME always, the clipboard's frames only on a machine that shares it, DISPLAY on one
// with a screen of virtio-gpu's; RENEW needs only the agent's), TIME (`time`), the screen's size (`display`, again at each agent's HELLO),
// RENEW once after a template's restore (`renew`), LEASE after a restore (`lease`), TRIM (`trim`), DROP (`dropCaches`), COPY (`copy`), POWER (`power`), TYPE (`type`), the guest's desktop as the agent says it (`desktop`), the guest's OS as it names it (`os`), the toolbar's switch (`pause`, `resume`), which it says again (PAUSE or RESUME) each time the agent
// connects, and the clipboard's frames, which web/app/clipboard.ts speaks over it (`send`, `onFrame`). The toolbar's
// clipboard menu (web/app/ClipboardMenu.svelte) drives it through `ClipboardShare`; the tests through `window.__agent`
// and `window.__clipboard`.
//
// Each connection is a stream of its own, begun at a frame: a restore resets the guest's transport, so the agent
// connects again. A stream that goes out of step (`broken`) is reset by the page, and the agent connects again too.
// The device numbers the connections (`conn`): the link drops what comes of an earlier one and names its own in what
// it sends, so nothing of one connection (the rest of a paste, a `taken` count, a reset) reaches the next.

import {
  CAP,
  DESKTOP,
  decodeCopied,
  decodeHello,
  decodeOs,
  decodeRenewed,
  encodeDisplay,
  encodeFrame,
  encodeHello,
  encodeKeymap,
  encodeLease,
  encodeTime,
  FRAME,
  FrameReader,
  POWER,
  typePayloads,
  VERSION,
  type Frame,
  type GuestOs,
  type Hello,
} from '../agent-frame.ts';
import type { AgentFromDevice, AgentToDevice } from '../vsock-device.ts';
import type { KeyboardLayout } from './keyboard.ts';

/** The most bytes in flight to the guest (sent to the device, not yet in the guest's buffers). */
export const WINDOW = 256 << 10;

/**
 * What the page says it does (web/agent-frame.ts `CAP`): the clock, the desktop's state, the layout and the OS's name
 * always (every machine has a screen and a status bar), the clipboard's frames where it is shared, the screen's size
 * where the guest's screen follows the page's (`display`: virtio-gpu's).
 */
export const pageCaps = (clipboard: boolean, display = false) =>
  CAP.TIME |
  CAP.DESKTOP |
  CAP.KEYMAP |
  CAP.OS |
  (clipboard ? CAP.TYPE | CAP.TEXT | CAP.IMAGE | CAP.COPY : 0) |
  (display ? CAP.DISPLAY : 0);

/** RENEW's random bytes. */
export const RENEW_BYTES = 64;

/** An answer's status: its first byte. */
const first = (p: Uint8Array | 'gone' | undefined) => (p instanceof Uint8Array ? p[0] : undefined);

export class AgentLink {
  /** The guest's agent is connected. */
  open = false;
  /** The agent's HELLO, since it last connected. */
  agent?: Hello;
  /** The toolbar's switch: sharing paused for the run (the agent hears it whenever it opens its end). */
  paused = false;
  /** Called with each frame from the guest's agent. */
  onFrame?: (f: Frame) => void;
  /** Called when the agent connects or its connection ends. */
  onOpen?: (open: boolean) => void;
  /** The guest's graphical session as the agent last said it (DESKTOP; none while it isn't connected): the tests' waits. */
  desktop: number = DESKTOP.NONE;
  /** Called when `desktop` changes. */
  onDesktop?: (d: number) => void;
  /** The guest's OS as the agent last named it (OS; kept over its connections: the run's). */
  os?: GuestOs;
  /** Called with each OS. */
  onOs?: (os: GuestOs) => void;
  /** Called with the agent's HELLO (each listener: the clipboard's, the clock's, the page's sign that the guest is up). */
  readonly onHello: ((h: Hello) => void)[] = [];
  /** Called when the agent's connection ends (what the page shows of what it can goes). */
  readonly onClose: (() => void)[] = [];
  private reader = new FrameReader();
  /** Frames to send, and TIME's, made as it goes (its time then, not when queued). */
  private queue: (Uint8Array | (() => Uint8Array))[] = [];
  private inflight = 0;
  /** The device's number for the connection (0: none). */
  private conn = 0;
  /** The connection's reset is asked for: not again. */
  private resetting = false;
  private port: MessagePort;
  /** What the page's HELLO says (`pageCaps`). */
  readonly caps: number;
  /** The screen's size last given (`display`): said again at each agent's HELLO. */
  private size?: { width: number; height: number };
  /**
   * RENEW is owed (`renew`) until the agent's RENEWED: sent at the HELLO of an agent that renews, once a connection (one
   * that ends before RENEWED, a reset or the agent's restart, sends it again at the next).
   */
  private renewing = false;
  private renewSent = false;
  /** What the agent's RENEWED said (the tests read it). */
  renewed?: { done: number; failed: number };
  /** The answers awaited (`lease`'s LEASED, `trim`'s TRIMMED, `dropCaches`'s DROPPED, `copy`'s COPIED, `power`'s POWERED): their payload, or `gone` when the connection ends first. */
  private waiting: { type: number; done: (payload?: Uint8Array | 'gone') => void }[] = [];
  /** `hello`'s waiters, which the run's end (`close`) settles. */
  private helloWaits: ((h: Hello | undefined) => void)[] = [];
  /**
   * The answers still owed to asks that gave up (by type): the agent sends them all the same, and the next ask of their
   * type mustn't take one for its own (a COPY's stale screen). A new connection owes none.
   */
  private stale = new Map<number, number>();

  constructor(port: MessagePort, caps: number) {
    [this.port, this.caps] = [port, caps];
    port.onmessage = (e: MessageEvent<AgentFromDevice | undefined>) => this.fromDevice(e.data);
  }

  /** Sends a frame; false (nothing sent) while the agent isn't connected. */
  send(type: number, payload?: Uint8Array): boolean {
    if (!this.open) return false;
    this.queue.push(encodeFrame(type, payload));
    this.pump();
    return true;
  }

  /** Whether the agent said it pastes on the console (its HELLO has TYPE). */
  get canType() {
    return !!this.agent && (this.agent.caps & CAP.TYPE) !== 0;
  }

  /**
   * Sets the guest's clock to the host's (`ms`, `Date.now()`'s scale; by default the time as the frame goes to the
   * device): TIME, ahead of the frames queued, after the agent's HELLO said it can; false (nothing sent) otherwise.
   */
  time(ms?: number): boolean {
    if (!this.open || !this.agent || !(this.agent.caps & CAP.TIME) || !(this.caps & CAP.TIME)) return false;
    this.queue.unshift(() => encodeFrame(FRAME.TIME, encodeTime(ms ?? Date.now())));
    this.pump();
    return true;
  }

  /**
   * Pastes `text` on the guest's foreground text console (TYPE, in frames of `TYPE_CHUNK` bytes, then an empty one:
   * the paste's end, so that the agent drops the rest of a paste whose frame it had no room for, not a hole in it);
   * false (nothing sent) while paused, or before the agent said it can.
   */
  type(text: string): boolean {
    if (this.paused || !this.canType) return false;
    for (const p of typePayloads(text)) this.send(FRAME.TYPE, p);
    this.send(FRAME.TYPE);
    return true;
  }

  /**
   * The page's screen size, which the agent sets the guest's session to (DISPLAY): now, if the agent said it can, and
   * at each agent's HELLO (a restored guest's session has the size it was saved with). False: not sent now.
   */
  display(size: { width: number; height: number }): boolean {
    this.size = { ...size };
    return this.sendDisplay();
  }

  /**
   * The guest was restored from a template (web/app/worker.ts says so): its agent makes the guest's identity its own
   * (RENEW, with the host's random bytes), once: now if the agent can, else at its next HELLO that says it can.
   */
  renew() {
    this.renewing = true;
    this.renewSent = false;
    this.sendRenew();
  }

  private sendRenew() {
    if (!this.renewing || this.renewSent || !this.agent || !(this.agent.caps & CAP.RENEW)) return;
    this.renewSent = this.send(FRAME.RENEW, crypto.getRandomValues(new Uint8Array(RENEW_BYTES)));
  }

  /** The agent's HELLO: now if it said it, else when it does, within `ms` (undefined past it). */
  hello(ms: number): Promise<Hello | undefined> {
    if (this.agent) return Promise.resolve(this.agent);
    return new Promise((resolve) => {
      const on = (h: Hello) => done(h);
      const timer = setTimeout(() => done(undefined), ms);
      const done = (h: Hello | undefined) => {
        clearTimeout(timer);
        const i = this.onHello.indexOf(on);
        if (i >= 0) this.onHello.splice(i, 1);
        this.helloWaits = this.helloWaits.filter((w) => w !== done);
        resolve(h);
      };
      this.onHello.push(on);
      this.helloWaits.push(done);
    });
  }

  /**
   * The guest's leases renewed (LEASE: the machine was restored and its connections are up): LEASED's status, or
   * undefined if the agent can't (no `CAP.LEASE`), the connection ends first, or nothing comes within `ms`.
   */
  lease(ms: number, macs: string[] = []): Promise<number | undefined> {
    return this.ask(FRAME.LEASE, CAP.LEASE, FRAME.LEASED, ms, encodeLease(macs)).then(first);
  }

  /**
   * The guest's filesystems trimmed (TRIM: what they no longer use handed back to their disks): TRIMMED's status, or
   * undefined if the agent can't (no `CAP.TRIM`), the connection ends first, or nothing comes within `ms`. A trim
   * asked while one runs is answered with it.
   */
  trim(ms: number): Promise<number | undefined> {
    return this.ask(FRAME.TRIM, CAP.TRIM, FRAME.TRIMMED, ms).then(first);
  }

  /**
   * The guest's clean caches dropped (DROP: right before a snapshot, so the memory they held is free for the balloon's
   * hints): DROPPED's status, or undefined if the agent can't (no `CAP.DROP`), the connection ends first, or nothing
   * comes within `ms`.
   */
  dropCaches(ms: number): Promise<number | undefined> {
    return this.ask(FRAME.DROP, CAP.DROP, FRAME.DROPPED, ms).then(first);
  }

  /** Whether the agent said it reads the text console's screen (its HELLO has COPY). */
  get canCopy() {
    return !!this.agent && (this.agent.caps & CAP.COPY) !== 0;
  }

  /**
   * The guest's foreground text console's screen (COPY): COPIED's status and text, or undefined if the agent can't (no
   * `CAP.COPY`), the connection ends first, or nothing comes within `ms`.
   */
  copy(ms: number): Promise<{ status: number; text: string } | undefined> {
    return this.ask(FRAME.COPY, CAP.COPY, FRAME.COPIED, ms).then((p) =>
      p instanceof Uint8Array ? decodeCopied(p) : undefined,
    );
  }

  /** Whether the agent said it powers the guest off (its HELLO has POWER). */
  get canPower() {
    return !!this.agent && (this.agent.caps & CAP.POWER) !== 0;
  }

  /**
   * The guest powers off or reboots itself (POWER: a clean shutdown): POWERED's status; `gone` if the connection ended
   * first (the guest's shutdown stops its agent, which may be before its answer leaves); undefined if the agent can't
   * (no `CAP.POWER`) or nothing came within `ms`.
   */
  power(reboot: boolean, ms: number): Promise<number | 'gone' | undefined> {
    const what = new Uint8Array([reboot ? POWER.REBOOT : POWER.OFF]);
    return this.ask(FRAME.POWER, CAP.POWER, FRAME.POWERED, ms, what).then((p) => (p === 'gone' ? p : first(p)));
  }

  /**
   * The machine's keyboard layout, which the agent gives the running session where it hasn't it (KEYMAP); false (not
   * sent) before the agent said it can. The run's actions say it at each agent's HELLO (web/app/areas/agent-actions.ts).
   */
  keymap(k: KeyboardLayout): boolean {
    return !!this.agent && (this.agent.caps & CAP.KEYMAP) !== 0 && this.send(FRAME.KEYMAP, encodeKeymap(k));
  }

  /** Sends `type` (with `payload`) to an agent with `cap`, and waits up to `ms` for its answer (`answer`'s payload; `gone`: the connection ended first). */
  private ask(
    type: number,
    cap: number,
    answer: number,
    ms: number,
    payload?: Uint8Array,
  ): Promise<Uint8Array | 'gone' | undefined> {
    if (!this.agent || !(this.agent.caps & cap) || !this.send(type, payload)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.stale.set(answer, (this.stale.get(answer) ?? 0) + 1);
        done(undefined);
      }, ms);
      const done = (payload?: Uint8Array | 'gone') => {
        clearTimeout(timer);
        this.waiting = this.waiting.filter((w) => w.done !== done);
        resolve(payload);
      };
      this.waiting.push({ type: answer, done });
    });
  }

  private sendDisplay() {
    if (!this.size || !this.agent || !(this.agent.caps & CAP.DISPLAY) || !(this.caps & CAP.DISPLAY)) return false;
    return this.send(FRAME.DISPLAY, encodeDisplay(this.size.width, this.size.height));
  }

  /** The toolbar's switch (plan §5): the agent stops until `resume`. */
  pause() {
    this.paused = true;
    this.send(FRAME.PAUSE);
  }

  resume() {
    this.paused = false;
    this.send(FRAME.RESUME);
  }

  /** Bytes the page holds or has in flight, not yet in the guest. */
  get backlog() {
    return this.inflight + this.queue.reduce((n, b) => n + (typeof b === 'function' ? 13 : b.length), 0);
  }

  /** The run ended: the port closed, and what waits on the link settled (as at a connection's end). */
  close() {
    this.port.close();
    for (const w of [...this.waiting]) w.done('gone');
    for (const w of [...this.helloWaits]) w(undefined);
  }

  private pump() {
    while (this.inflight < WINDOW) {
      const next = this.queue.shift();
      if (!next) break;
      const b = typeof next === 'function' ? next() : next;
      this.inflight += b.length;
      this.port.postMessage({ type: 'data', bytes: b, conn: this.conn } satisfies AgentToDevice, [b.buffer]);
    }
  }

  /** A message from the device: the agent connected or its connection ended, the page's bytes taken, the agent's bytes. */
  private fromDevice(m: AgentFromDevice | undefined) {
    if (!m) return;
    // A connection's opening makes it the link's; anything else of another one is an earlier connection's.
    if (m.type === 'open' && m.open) this.conn = m.conn;
    else if (m.conn !== this.conn) return;
    switch (m.type) {
      case 'open':
        return this.opened(m.open);
      case 'taken':
        this.inflight = Math.max(0, this.inflight - m.n);
        this.pump();
        return;
      case 'data':
        return this.received(m.bytes);
    }
  }

  /** The agent connected, or its connection ended. */
  private opened(open: boolean) {
    // Each connection is a new stream both ways: what was half read or queued belonged to the last one.
    this.open = open;
    this.agent = undefined;
    this.reader.reset();
    this.queue = [];
    this.inflight = 0;
    this.resetting = false;
    this.renewSent = false;
    this.stale.clear();
    for (const w of [...this.waiting]) w.done('gone');
    this.setDesktop(DESKTOP.NONE);
    if (!open) {
      this.conn = 0;
      for (const f of [...this.onClose]) f();
    }
    if (open) {
      this.send(FRAME.HELLO, encodeHello({ version: VERSION, caps: this.caps }));
      // The switch, said at each connection: an agent restored from a snapshot taken while paused is paused, and the
      // pause is the run's, not the snapshot's (plan §5).
      if (this.caps & CAP.TEXT) this.send(this.paused ? FRAME.PAUSE : FRAME.RESUME);
    }
    this.onOpen?.(open);
  }

  private setDesktop(d: number) {
    if (d === this.desktop) return;
    this.desktop = d;
    this.onDesktop?.(d);
  }

  /** The agent's HELLO: what is owed to it said, its listeners told. */
  private agentHello(payload: Uint8Array) {
    const h = decodeHello(payload);
    if (!h) return;
    this.agent = h;
    this.sendRenew();
    this.sendDisplay();
    // A copy: a waiter (`hello`) leaves the list as it hears it.
    for (const f of [...this.onHello]) f(h);
  }

  /** An answer to the asks of its type, unless it is the one owed to an ask that gave up. */
  private answered(f: Frame) {
    const owed = this.stale.get(f.type) ?? 0;
    if (owed) this.stale.set(f.type, owed - 1);
    else for (const w of this.waiting.filter((w) => w.type === f.type)) w.done(f.payload);
  }

  /** The agent's bytes: its frames, a HELLO taken as the agent's. */
  private received(bytes: Uint8Array) {
    for (const f of this.reader.push(bytes)) {
      if (f.type === FRAME.HELLO) this.agentHello(f.payload);
      this.answered(f);
      if (f.type === FRAME.DESKTOP && f.payload.length === 1) this.setDesktop(f.payload[0]);
      const os = f.type === FRAME.OS ? decodeOs(f.payload) : undefined;
      if (os) this.onOs?.((this.os = os));
      if (f.type === FRAME.RENEWED) {
        this.renewed = decodeRenewed(f.payload);
        this.renewing = false;
      }
      this.onFrame?.(f);
    }
    // Out of step (a frame's length that can't be): the connection reset, once, so the agent connects again.
    if (this.reader.broken && !this.resetting) {
      this.resetting = true;
      this.port.postMessage({ type: 'reset', conn: this.conn } satisfies AgentToDevice);
    }
  }
}
