// The page's end of the guest agent's connection (web/vsock-device.ts; docs/devices.md "The guest's agent"): frames to
// and from the agent (web/agent-frame.ts), whether it is connected, and how much the page has in flight. The device
// takes the page's bytes as the guest's credit and buffers allow; the link keeps at most `WINDOW` bytes the guest hasn't
// taken yet, so a guest that stops reading costs the page a queue of frames, not the device's memory.
//
// What it says: HELLO each time the agent connects (the agent answers with its own: `agent`), with the capabilities the
// page uses (`caps`: the clock's TIME always, the clipboard's frames only on a machine that shares it, DISPLAY on one
// with a screen of virtio-gpu's; RENEW needs only the agent's), TIME (`time`), the screen's size (`display`, again at each agent's HELLO),
// RENEW once after a template's restore (`renew`), TYPE (`type`), the toolbar's switch (`pause`, `resume`), which it says again (PAUSE or RESUME) each time the agent
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
  decodeHello,
  decodeRenewed,
  encodeDisplay,
  encodeFrame,
  encodeHello,
  encodeTime,
  FRAME,
  FrameReader,
  typePayloads,
  VERSION,
  type Frame,
  type Hello,
} from '../agent-frame.ts';
import type { AgentFromDevice, AgentToDevice } from '../vsock-device.ts';

/** The most bytes in flight to the guest (sent to the device, not yet in the guest's buffers). */
export const WINDOW = 256 << 10;

/**
 * What the page says it does (web/agent-frame.ts `CAP`): the clock always, the clipboard's frames where it is shared,
 * the screen's size where the guest's screen follows the page's (`display`: virtio-gpu's).
 */
export const pageCaps = (clipboard: boolean, display = false) =>
  CAP.TIME | (clipboard ? CAP.TYPE | CAP.TEXT | CAP.IMAGE : 0) | (display ? CAP.DISPLAY : 0);

/** RENEW's random bytes. */
export const RENEW_BYTES = 64;

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
  /** Called with the agent's HELLO (each listener: the clipboard's, the clock's, the page's sign that the guest is up). */
  readonly onHello: ((h: Hello) => void)[] = [];
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
  /** `lease`'s answers awaited: LEASED's status, or undefined when the connection ends first. */
  private leasing: ((status?: number) => void)[] = [];

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
        resolve(h);
      };
      this.onHello.push(on);
    });
  }

  /**
   * The guest's leases renewed (LEASE: the machine was restored and its connections are up): LEASED's status, or
   * undefined if the agent can't (no `CAP.LEASE`), the connection ends first, or nothing comes within `ms`.
   */
  lease(ms: number): Promise<number | undefined> {
    if (!this.agent || !(this.agent.caps & CAP.LEASE) || !this.send(FRAME.LEASE)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), ms);
      const done = (status?: number) => {
        clearTimeout(timer);
        this.leasing = this.leasing.filter((f) => f !== done);
        resolve(status);
      };
      this.leasing.push(done);
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

  close() {
    this.port.close();
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
    for (const done of [...this.leasing]) done(undefined);
    if (!open) this.conn = 0;
    if (open) {
      this.send(FRAME.HELLO, encodeHello({ version: VERSION, caps: this.caps }));
      // The switch, said at each connection: an agent restored from a snapshot taken while paused is paused, and the
      // pause is the run's, not the snapshot's (plan §5).
      if (this.caps & CAP.TEXT) this.send(this.paused ? FRAME.PAUSE : FRAME.RESUME);
    }
    this.onOpen?.(open);
  }

  /** The agent's bytes: its frames, a HELLO taken as the agent's. */
  private received(bytes: Uint8Array) {
    for (const f of this.reader.push(bytes)) {
      if (f.type === FRAME.HELLO) {
        const h = decodeHello(f.payload);
        if (h) {
          this.agent = h;
          this.sendRenew();
          this.sendDisplay();
          for (const f of this.onHello) f(h);
        }
      }
      if (f.type === FRAME.LEASED) for (const done of [...this.leasing]) done(f.payload[0]);
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
