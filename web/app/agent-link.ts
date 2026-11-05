// The page's end of the agent's port (web/agent-device.ts; docs/plans/clipboard.md §2): frames to and from the guest's
// agent (web/agent-frame.ts), whether the agent holds its end open, and how much the page has in flight. The device
// takes the page's bytes as the guest posts buffers; the link keeps at most `WINDOW` bytes the guest hasn't taken
// yet, so a guest that stops reading costs the page a queue of frames, not the device's memory.

import { encodeFrame, FrameReader, type Frame } from '../agent-frame.ts';
import type { AgentFromDevice, AgentToDevice } from '../agent-device.ts';

/** The most bytes in flight to the guest (sent to the device, not yet in the guest's buffers). */
export const WINDOW = 256 << 10;

export class AgentLink {
  /** The guest's agent holds its end of the port open. */
  open = false;
  /** Called with each frame from the guest's agent. */
  onFrame?: (f: Frame) => void;
  /** Called when the agent opens or closes its end. */
  onOpen?: (open: boolean) => void;
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
        this.reader.reset();
        this.queue = [];
        this.inflight = 0;
        this.onOpen?.(m.open);
        break;
      case 'taken':
        this.inflight = Math.max(0, this.inflight - m.n);
        this.pump();
        break;
      case 'data':
        for (const f of this.reader.push(m.bytes)) this.onFrame?.(f);
        break;
    }
  }
}
