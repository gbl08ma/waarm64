// virtio-net's backend (docs/devices.md "net"): the card between the guest's queues and its adapter (web/net.ts,
// web/gateway.ts), with the link's flaps.
import { echoBackend, echoLease, gateway, gatewayOf, portBackend } from './gateway.ts';
import { loopback, portAdapter, type NetAdapter } from './net.ts';
import {
  F_GUEST_CSUM,
  F_GUEST_TSO4,
  F_GUEST_TSO6,
  F_MRG_RXBUF,
  MAX_FRAME,
  MAX_GSO_FRAME,
  MAX_PORT_FRAME,
  NET_HDR,
  receive,
  transmit,
  type RxFrame,
} from './offload.ts';
import { gather, scatter, type Backend, type Ctx, type Request } from './virtio.ts';
import type { NetSpec } from './devices.ts';

/** The largest frame for the guest: a merged packet, IPv6's largest, behind Ethernet and a VLAN tag. */
const MAX_RX = NET_HDR + 18 + 40 + 65_535;

/**
 * How long a link flap keeps the link down: past what systemd-networkd waits out. It acts on a carrier loss at once,
 * except when the DHCP lease's MTU isn't the link's original one (a tailnet's 1280 against virtio's 1500): then it
 * ignores a loss shorter than 5 s (`link_carrier_lost`, systemd 257, against drivers that reset the link on an MTU
 * change, systemd#18738). A 1 s flap and a 5 s one were both ignored at boot's first lease; 7 s is past it.
 */
export const FLAP_MS = 7000;
/**
 * How long a restored machine's card holds the flaps its switches owe (`Backend.restored`) when the page never says it
 * settled its leases, from when the page says its network is connected (`{type: 'connected'}`): past what
 * web/app/areas/lease-actions.ts waits at most from then (its grace, the agent's HELLO and LEASED: 110 s). Not from the
 * restore: a connection can take minutes to come (the demo server full or crowded), and the flap its switch owes then is
 * the one the hold is for. Until it's connected the hold has no bound: the card has nothing to renew a lease from.
 */
export const HOLD_MS = 120_000;

const RX_QUEUE = 256; // frames held while the guest has posted no receive buffer

/**
 * virtio-net: each transmitted chain is a frame for the adapter (header
 * stripped, its checksum finished) or, a large TCP or UDP packet, its segments
 * (web/offload.ts); frames from the adapter wait for receive buffers, the
 * oldest dropped past RX_QUEUE, as a NIC drops. Those from a port arrive in
 * batches (the frames of one task, delivered at its end: a microtask, no
 * timer), and `receive` merges a batch's TCP segments and marks valid
 * checksums; the test adapters' frames go at once, so deterministic mode
 * stays exact. With MRG_RXBUF a frame fills as many buffers as it needs.
 * Guest bugs (short, oversized or malformed chains) drop the frame.
 */
export function net(ctx: Ctx, d: NetSpec): Backend {
  const io = ctx.io ?? new Float64Array(2); // bytes received (frames to the guest), sent
  const rx: Request[] = [];
  const frames: Uint8Array[] = []; // not yet through `receive`
  const ready: RxFrame[] = []; // waiting for buffers
  let scheduled = false;
  const room = (r: Request) => r.write.reduce((n, s) => n + s.len, 0);
  const deliver = () => {
    scheduled = false;
    const f = ctx.features();
    const mrg = (f & F_MRG_RXBUF) !== 0n;
    if (frames.length) {
      ready.push(
        ...receive(frames.splice(0), {
          csum: (f & F_GUEST_CSUM) !== 0n,
          merge4: mrg && (f & F_GUEST_TSO4) !== 0n,
          merge6: mrg && (f & F_GUEST_TSO6) !== 0n,
        }),
      );
      if (ready.length > RX_QUEUE) ready.splice(0, ready.length - RX_QUEUE);
    }
    while (rx.length && ready.length) {
      const { hdr, frame } = ready[0];
      const total = NET_HDR + frame.length;
      let n = 1;
      let have = room(rx[0]); // the room of buffers 0..n-1
      for (; have < total; n++) {
        if (!mrg || n === rx.length) break;
        have += room(rx[n]);
      }
      const fits = have >= total;
      if (!fits && mrg && n === rx.length && total <= MAX_RX) break; // more buffers to come
      ready.shift();
      if (!fits) continue; // larger than the guest's buffers can hold: dropped
      hdr[10] = n & 255; // num_buffers
      hdr[11] = n >> 8;
      io[0] += frame.length;
      const ram = ctx.ram();
      // Bytes [at, at + len) of the header and the frame after it, each scattered from where it is (no joined copy).
      for (let k = 0, at = 0; k < n; k++) {
        const r = rx.shift()!;
        const len = Math.min(room(r), total - at);
        const h = Math.max(0, Math.min(NET_HDR, at + len) - at);
        if (h) scatter(ram, r.write, hdr.subarray(at, at + h));
        const from = Math.max(0, at - NET_HDR);
        if (len > h) scatter(ram, r.write, frame.subarray(from, from + len - h), h);
        ctx.complete(r.w0, len);
        at += len;
      }
    }
  };
  const sync = d.adapter === 'loopback' || d.adapter === 'echo';
  const receiveFrame = (f: Uint8Array) => {
    frames.push(f);
    if (sync) deliver();
    else if (!scheduled) {
      scheduled = true;
      queueMicrotask(deliver);
    }
  };
  // The link flap (docs/devices.md "net"): the link goes down and, `FLAP_MS` later, up, so the guest's DHCP client asks
  // again at once (networkd does on a carrier). Only under a driver, and only when what the guest holds is stale.
  let flapping: ReturnType<typeof setTimeout> | undefined;
  // A restored machine's card holds the flaps its own switches owe (`restored`) until the page settled the restore's
  // leases (web/app/areas/lease-actions.ts: `{type: 'settled', renewed}` on the link): a flap then would take the link
  // down under the agent's LEASE, and the renewal it starts would go out on a dead link (udhcpc then waits for its next
  // try). Renewed, what was owed is dropped; not, it flaps then. `HOLD_MS` at most once the page's network is connected.
  let holding = false;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let owed = false;
  const settled = (renewed: boolean) => {
    clearTimeout(hold);
    [holding, hold] = [false, undefined];
    if (owed && !renewed) flap();
    owed = false;
  };
  const flap = () => {
    if (holding) {
      owed = true;
      return;
    }
    if (!ctx.features() || flapping) return;
    ctx.changeConfig((c) => {
      c[6] = 0;
    });
    flapping = setTimeout(() => {
      flapping = undefined;
      ctx.changeConfig((c) => {
        c[6] = 1;
      });
    }, FLAP_MS);
  };
  const a = d.adapter;
  /** Frames to a port of their own (the local helper's client), the page's gateway bypassed: larger frames pass. */
  let framesTo: NetAdapter | undefined;
  /** Frames mode with no port yet (the client went): the guest's frames are dropped, as a cable to nothing. */
  let framesMode = a instanceof MessagePort;
  const toFrames = (port: MessagePort | null) => {
    framesTo?.close?.();
    framesTo = port ? portAdapter(port, receiveFrame) : undefined;
    if (!framesMode) flap(); // the guest's lease was the gateway's
    framesMode = true;
  };
  const toGateway = () => {
    framesTo?.close?.();
    framesTo = undefined;
    if (framesMode) flap(); // the guest's lease was the helper's
    framesMode = false;
  };
  /** The page's gateway's frames: none while the card is on the helper's frames (it is bypassed; what it says is stale). */
  const fromGateway = (f: Uint8Array) => {
    if (!framesMode) receiveFrame(f);
  };
  const adapter: NetAdapter =
    a === 'loopback'
      ? loopback(receiveFrame)
      : a === 'echo'
        ? gateway(receiveFrame, echoBackend(echoLease(d.gateway ?? 0)), {
            ...gatewayOf(d.gateway ?? 0),
            leaseSeconds: d.leaseSeconds,
            renewSeconds: d.renewSeconds,
          })
        : a instanceof MessagePort
          ? portAdapter(a, receiveFrame)
          : gateway(fromGateway, portBackend(a.ip, { frames: toFrames, gateway: toGateway }), {
              advertiseMs: 60_000,
              ...gatewayOf(d.gateway ?? 0),
              leaseSeconds: d.leaseSeconds,
              renewSeconds: d.renewSeconds,
              stale: flap,
            });
  if (a instanceof MessagePort) framesTo = adapter; // a frame port from the start: its own, the card's frames go to it
  // The page's: a flap asked for (a restored guest whose agent couldn't renew its lease: web/app/areas/lease-actions.ts).
  const link = typeof a === 'object' && !(a instanceof MessagePort) ? a.link : undefined;
  if (link)
    link.onmessage = (e: MessageEvent<{ type?: string; renewed?: boolean } | undefined>) => {
      if (e.data?.type === 'flap') {
        settled(true); // asked for: the page's renewal, past anything held
        flap();
      } else if (e.data?.type === 'settled') settled(e.data.renewed === true);
      else if (e.data?.type === 'connected' && holding && !hold) hold = setTimeout(() => settled(false), HOLD_MS);
    };
  const out = (f: Uint8Array) => (framesMode ? framesTo?.send(f) : adapter.send(f));
  return {
    request(r) {
      if (r.queue === 0) {
        rx.push(r);
        deliver();
        return undefined;
      }
      const len = r.read.reduce((n, s) => n + s.len, 0);
      if (len > NET_HDR && len <= NET_HDR + MAX_GSO_FRAME) {
        io[1] += len - NET_HDR; // the guest's frame (a large one before its segmentation)
        for (const f of transmit(gather(ctx.ram(), r.read, len), framesMode ? MAX_PORT_FRAME : MAX_FRAME)) out(f);
      }
      return 0;
    },
    reset() {
      rx.length = 0;
      frames.length = 0;
      ready.length = 0;
      if (flapping) {
        clearTimeout(flapping);
        flapping = undefined;
        ctx.config()[6] = 1;
      }
    },
    // Only a card the page settles (its link): the gateway's, whose switches to the local helper's frames flap.
    restored() {
      if (link) holding = true; // bounded from the connection (`connected`): HOLD_MS
    },
    close: () => {
      clearTimeout(flapping);
      clearTimeout(hold);
      link?.close();
      if (framesTo !== adapter) framesTo?.close?.();
      adapter.close?.();
    },
  };
}
