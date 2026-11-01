// The local network helper's client (docs/plans/networking-local.md; L0's spike: the page takes it from `?localnet=`
// or `#net=`, and L2 makes it a connection kind). The helper (net/webpc-net) runs on the user's computer and serves
// the guest DHCP, DNS and a gateway onto its own sockets, so this only moves Ethernet frames: between a card's frame
// port (web/net.ts `portAdapter`: one frame per message, no gateway in the page) and a WebSocket on loopback. On the
// socket each binary message is one or more whole frames, each after its 4-byte big-endian length (QEMU's stream
// framing, what the helper's switch speaks); the frames that come in one task go out as one message.

/** The framing's name and version, checked by both ends (net/webpc-net `Subprotocol`). */
export const LOCAL_SUBPROTOCOL = 'webpc-net.v1';

/** Why the helper closed the socket (net/webpc-net's close codes), as the page says it. */
export const LOCAL_CLOSE: Record<number, string> = {
  4001: 'the page and the helper are different versions',
  4003: "the helper doesn't accept this page's address (run it with --origin)",
  4004: "the link's token isn't this helper's: pair again with the link it prints",
};

/** Frames as one message: each after its length. */
export function frameMessage(frames: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(frames.reduce((n, f) => n + 4 + f.length, 0));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const f of frames) {
    v.setUint32(at, f.length);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return out;
}

/** A message's frames (copies), or undefined when it isn't whole frames. */
export function framesOf(msg: Uint8Array): Uint8Array[] | undefined {
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < msg.length) {
    if (at + 4 > msg.length) return undefined;
    const n = v.getUint32(at);
    if (n < 14 || at + 4 + n > msg.length) return undefined;
    out.push(msg.slice(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}

/** A `ws://127.0.0.1:<port>/<token>` (or `[::1]`, `localhost`) URL, or an error to show. */
export function parseLocalURL(s: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return { error: `“${s}” isn't the helper's link (ws://127.0.0.1:<port>/<token>)` };
  }
  if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.pathname.length < 2) return { error: `“${s}” isn't the helper's link (ws://127.0.0.1:<port>/<token>)` };
  return { url: u.href };
}

export type LocalState = 'connecting' | 'connected' | 'closed';

export type LocalNet = {
  state(): LocalState;
  /** Why it closed, as the page says it (undefined while open). */
  error(): string | undefined;
  /** Frames and bytes each way, for the spike's measurements. */
  stats(): { rxFrames: number; txFrames: number; rxBytes: number; txBytes: number; rxMessages: number; txMessages: number };
  close(): void;
};

/**
 * Connects the card behind `frames` (the page's end of its frame port) to the helper at `url`. `onChange` hears the
 * state change. It doesn't reconnect by itself (L2's question).
 */
export function startLocalNet(url: string, frames: MessagePort, onChange: () => void = () => {}): LocalNet {
  let state: LocalState = 'connecting';
  let error: string | undefined;
  const stats = { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, rxMessages: 0, txMessages: 0 };
  const ws = new WebSocket(url, LOCAL_SUBPROTOCOL);
  ws.binaryType = 'arraybuffer';
  let pending: Uint8Array[] = [];
  const flush = () => {
    const b = pending;
    pending = [];
    if (ws.readyState !== WebSocket.OPEN || !b.length) return;
    stats.txMessages++;
    ws.send(frameMessage(b));
  };
  frames.onmessage = (e: MessageEvent) => {
    const f = new Uint8Array(e.data as ArrayBuffer);
    stats.txFrames++;
    stats.txBytes += f.length;
    if (!pending.length) queueMicrotask(flush);
    pending.push(f);
  };
  ws.onopen = () => {
    if (ws.protocol !== LOCAL_SUBPROTOCOL) {
      error = LOCAL_CLOSE[4001];
      ws.close();
      return;
    }
    state = 'connected';
    onChange();
  };
  ws.onmessage = (e: MessageEvent) => {
    const got = framesOf(new Uint8Array(e.data as ArrayBuffer));
    if (!got) {
      error = "the helper sent a message that isn't whole frames";
      ws.close();
      return;
    }
    stats.rxMessages++;
    for (const f of got) {
      stats.rxFrames++;
      stats.rxBytes += f.length;
      frames.postMessage(f.buffer, [f.buffer]);
    }
  };
  ws.onclose = (e: CloseEvent) => {
    // A socket that never opened on loopback: the helper isn't running (or the browser's Local Network Access prompt was refused).
    error ??= LOCAL_CLOSE[e.code] ?? (state === 'connecting' ? "couldn't reach the helper: is it running? (or the browser's prompt for local network access was refused)" : `the helper closed the connection${e.reason ? `: ${e.reason}` : ''}`);
    state = 'closed';
    onChange();
  };
  return {
    state: () => state,
    error: () => (state === 'closed' ? error : undefined),
    stats: () => ({ ...stats }),
    close() {
      frames.onmessage = null;
      ws.close();
    },
  };
}
