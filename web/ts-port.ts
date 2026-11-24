// The gateway's IP port as a tailnet client's worker holds it (web/tailnet-worker.ts, web/tailcat-worker.ts,
// web/room-worker.ts): the port of the moment (a restarted machine attaches another), the guest's packets in, the
// client's out (batched, each after its headroom: web/net.ts `batchSender`, `IP_HEADROOM`), and the lease the guest's DHCP gets, told again only when it
// changed (each one the gateway hears makes a router advertisement: web/gateway.ts `leaseChanged`). Whether the
// adapter is the guest's default way out (`primary`, per family) and its rank come with the page's `primary` message;
// the worker's `offered` makes the lease of them. The worker keeps its client: a detach only hands the port back.
import type { Lease } from './gateway.ts';
import { batchSender, IP_HEADROOM, packetsOf } from './net.ts';

/** What the page said of the adapter's place (docs/networking/adapters.md §4; the `primary` message). */
export type Placement = {
  /** The guest's default way out: otherwise its lease carries only the network's routes. */
  primary: boolean;
  /** And IPv6's ("A primary per family"; default `primary`). */
  primary6: boolean;
  /** Its place among the machine's connected adapters: its IPv6 routes' preference (web/gateway.ts `ranked`). */
  rank: number;
};

export type IpPortHost = {
  /** Takes the gateway's port (the start's, or a restarted machine's), drops the last one, and tells it the lease. */
  attach(port: MessagePort): void;
  /** Whether a port is held: false once detached (a start that awaited something checks it). */
  attached(): boolean;
  /** The page's `primary` message: the lease again, if that changed it. */
  place(p: { primary: boolean; primary6?: boolean; rank?: number }): void;
  /** Tells the gateway the lease (`offered`'s), if it changed. */
  postLease(): void;
  /** A packet for the guest. */
  send(packet: Uint8Array): void;
  /** Withdraws the lease and gives up the port: the worker hands it back (`detached`). */
  detach(): MessagePort | undefined;
};

/** `offered`: the lease for the adapter's place (null: none); `guest`: the guest's packets, for the client. */
export function ipPortHost(
  offered: (p: Placement) => Lease | null,
  guest: (packets: Uint8Array[]) => void,
): IpPortHost {
  let ip: MessagePort | undefined;
  let send: ((packet: Uint8Array) => void) | undefined;
  const placement: Placement = { primary: true, primary6: true, rank: 0 };
  /** The lease last posted (JSON): a change that leaves it the same (a peer coming online) posts none. */
  let posted = '';
  const post = (lease: Lease | null, force: boolean) => {
    const json = JSON.stringify(lease);
    if (!force && json === posted) return;
    posted = json;
    ip?.postMessage({ type: 'lease', lease });
  };
  return {
    attach(port) {
      if (ip) {
        ip.onmessage = null;
        ip.close();
      }
      ip = port;
      send = batchSender(port, IP_HEADROOM);
      port.onmessage = (ev: MessageEvent) => {
        const packets = packetsOf(ev.data);
        if (packets) guest(packets);
      };
      post(offered(placement), true); // a new port hasn't heard it
    },
    attached: () => !!ip,
    place(p) {
      placement.primary = p.primary;
      placement.primary6 = p.primary6 ?? p.primary;
      placement.rank = p.rank ?? 0;
      post(offered(placement), false);
    },
    postLease: () => post(offered(placement), false),
    send: (p) => send?.(p),
    detach() {
      post(null, true);
      const port = ip;
      if (port) port.onmessage = null;
      ip = undefined;
      send = undefined;
      return port;
    },
  };
}
