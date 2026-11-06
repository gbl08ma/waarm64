// The page's end of the agent's port (web/agent-device.ts; docs/plans/clipboard.md §2): frames to and from the guest's
// agent (web/agent-frame.ts), whether the agent holds its end open, and how much the page has in flight. The device
// takes the page's bytes as the guest posts buffers; the link keeps at most `WINDOW` bytes the guest hasn't taken
// yet, so a guest that stops reading costs the page a queue of frames, not the device's memory.
//
// What it says (step 2): HELLO each time the agent opens its end (the agent answers with its own: `agent`), TYPE
// (`type`), and the toolbar's switch (`pause`, `resume`), which it says again to an agent that reopens its end (a
// restarted agent starts unpaused). No UI yet (step 4): the tests drive it through `window.__agent`.

import { CAP, decodeHello, encodeFrame, encodeHello, FRAME, FrameReader, typePayloads, VERSION, type Frame, type Hello } from '../agent-frame.ts';
import type { AgentFromDevice, AgentToDevice } from '../agent-device.ts';

/** The most bytes in flight to the guest (sent to the device, not yet in the guest's buffers). */
export const WINDOW = 256 << 10;

/** What the page says it can do (web/agent-frame.ts `CAP`). */
export const PAGE_CAPS = CAP.TYPE;

export class AgentLink {
  /** The guest's agent holds its end of the port open. */
  open = false;
  /** The agent's HELLO, since its end last opened. */
  agent?: Hello;
  /** The toolbar's switch: sharing paused for the run (the agent hears it whenever it opens its end). */
  paused = false;
  /** Called with each frame from the guest's agent. */
  onFrame?: (f: Frame) => void;
  /** Called when the agent opens or closes its end. */
  onOpen?: (open: boolean) => void;
  /** Called with the agent's HELLO. */
  onHello?: (h: Hello) => void;
  private reader = new FrameReader();
  private queue: Uint8Array[] = [];
  private inflight = 0;
  private port: MessagePort;
  /** The device's port this link is (web/agent-device.ts `AGENT_PORTS`). */
  private id: number;

  constructor(port: MessagePort, id = 0) {
    [this.port, this.id] = [port, id];
    port.onmessage = (e: MessageEvent<AgentFromDevice>) => this.fromDevice(e.data);
  }

  /** Sends a frame; false (nothing sent) while the agent's end is closed. */
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
   * Pastes `text` on the guest's foreground text console (TYPE, in frames of `TYPE_CHUNK` bytes); false (nothing
   * sent) while paused, or before the agent said it can.
   */
  type(text: string): boolean {
    if (this.paused || !this.canType) return false;
    for (const p of typePayloads(text)) this.send(FRAME.TYPE, p);
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

  /** Whether the stream from the guest went out of step (a frame's length that can't be): until the agent reopens its end. */
  get broken() {
    return this.reader.broken;
  }

  close() {
    this.port.close();
  }

  private pump() {
    while (this.queue.length && this.inflight < WINDOW) {
      const b = this.queue.shift()!;
      this.inflight += b.length;
      this.port.postMessage({ type: 'data', port: this.id, bytes: b } satisfies AgentToDevice, [b.buffer]);
    }
  }

  private fromDevice(m: AgentFromDevice) {
    if (m?.port !== this.id) return;
    switch (m.type) {
      case 'open':
        if (m.open === this.open) return;
        // A new opening is a new stream both ways: what was half read or queued belonged to the last one.
        this.open = m.open;
        this.agent = undefined;
        this.reader.reset();
        this.queue = [];
        this.inflight = 0;
        if (m.open) {
          this.send(FRAME.HELLO, encodeHello({ version: VERSION, caps: PAGE_CAPS }));
          if (this.paused) this.send(FRAME.PAUSE);
        }
        this.onOpen?.(m.open);
        break;
      case 'taken':
        this.inflight = Math.max(0, this.inflight - m.n);
        this.pump();
        break;
      case 'data':
        for (const f of this.reader.push(m.bytes)) {
          if (f.type === FRAME.HELLO) {
            const h = decodeHello(f.payload);
            if (h) {
              this.agent = h;
              this.onHello?.(h);
            }
          }
          this.onFrame?.(f);
        }
        break;
    }
  }
}
