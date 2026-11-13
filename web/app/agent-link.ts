// The page's end of the guest agent's connection (web/vsock-device.ts; docs/devices.md "The guest's agent"): frames to
// and from the agent (web/agent-frame.ts), whether it is connected, and how much the page has in flight. The device
// takes the page's bytes as the guest's credit and buffers allow; the link keeps at most `WINDOW` bytes the guest hasn't
// taken yet, so a guest that stops reading costs the page a queue of frames, not the device's memory.
//
// What it says: HELLO each time the agent connects (the agent answers with its own: `agent`), with the capabilities the
// page uses (`caps`: the clock's TIME always, the clipboard's frames only on a machine that shares it), TIME (`time`),
// TYPE (`type`), the toolbar's switch (`pause`, `resume`), which it says again (PAUSE or RESUME) each time the agent
// connects, and the clipboard's frames, which web/app/clipboard.ts speaks over it (`send`, `onFrame`). The toolbar's
// clipboard menu (web/app/ClipboardMenu.svelte) drives it through `ClipboardShare`; the tests through `window.__agent`
// and `window.__clipboard`.
//
// Each connection is a stream of its own, begun at a frame: a restore resets the guest's transport, so the agent
// connects again. A stream that goes out of step (`broken`) is reset by the page, and the agent connects again too.

import {
  CAP,
  decodeHello,
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

/** What the page says it does (web/agent-frame.ts `CAP`): the clock always, the clipboard's frames where it is shared. */
export const pageCaps = (clipboard: boolean) => CAP.TIME | (clipboard ? CAP.TYPE | CAP.TEXT | CAP.IMAGE : 0);

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
  private queue: Uint8Array[] = [];
  private inflight = 0;
  private port: MessagePort;
  /** What the page's HELLO says (`pageCaps`). */
  readonly caps: number;

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
   * Sets the guest's clock to the host's (`ms`, `Date.now()`'s scale): TIME, after the agent's HELLO said it can;
   * false (nothing sent) otherwise.
   */
  time(ms = Date.now()): boolean {
    if (!this.agent || !(this.agent.caps & CAP.TIME) || !(this.caps & CAP.TIME)) return false;
    return this.send(FRAME.TIME, encodeTime(ms));
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
    return this.inflight + this.queue.reduce((n, b) => n + b.length, 0);
  }

  close() {
    this.port.close();
  }

  private pump() {
    while (this.inflight < WINDOW) {
      const b = this.queue.shift();
      if (!b) break;
      this.inflight += b.length;
      this.port.postMessage({ type: 'data', bytes: b } satisfies AgentToDevice, [b.buffer]);
    }
  }

  /** A message from the device: the agent connected or its connection ended, the page's bytes taken, the agent's bytes. */
  private fromDevice(m: AgentFromDevice | undefined) {
    switch (m?.type) {
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
          for (const f of this.onHello) f(h);
        }
      }
      this.onFrame?.(f);
    }
    // Out of step (a frame's length that can't be): the connection reset, so the agent connects again.
    if (this.reader.broken) this.port.postMessage({ type: 'reset' } satisfies AgentToDevice);
  }
}
