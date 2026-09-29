// The page's network (docs/frontend.md "Network"): a machine with a network card (always there)
// (virtio-net on the Ethernet gateway, web/gateway.ts) whose IP packets go to a Tailscale
// client (web/tailscale.ts), which the user connects and logs in from the header's Network
// menu. DOM-free, so it's tested in Node (tests/network.test.ts).
//
// The machine holds one end of an IP port for as long as it runs; this keeps the other. The
// client, when there is one, has it (`attach`); a restarted machine brings a new port, and
// a disconnected client hands it back (`detach`), so a machine can be connected, disconnected and
// connected again without a restart.
import { startTailscale, tailscaleBuilt, type FromTailscale, type NetMap, type Tailscale, type TailscaleConfig } from '../tailscale.ts';

export { tailscaleBuilt };

export const DEFAULT_CONTROL = 'https://controlplane.tailscale.com';

/** What the user chooses (remembered per browser, except the auth key, which is never kept). */
export type NetworkSettings = {
  /** Empty: Tailscale's. */
  controlURL: string;
  hostname: string;
  /** Connect when the machine starts (off after Disconnect, and for an auth key, which isn't kept). */
  autoconnect: boolean;
  /** The last connection used an auth key: an ephemeral node, not kept, so it can't reconnect by itself or log out. */
  keyed: boolean;
};

export const DEFAULT_SETTINGS: NetworkSettings = { controlURL: '', hostname: '', autoconnect: false, keyed: false };

/** A control server's URL as the client takes it: https (http only for this computer), or an error to show. */
export function parseControlURL(input: string): { url: string } | { error: string } {
  const s = input.trim();
  if (!s) return { url: DEFAULT_CONTROL };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { error: `“${s}” isn't a URL (for example https://headscale.example.com).` };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'The control server must be an https:// URL (http:// works for this computer only).' };
  return { url: u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')) };
}

/** A node's hostname: one DNS label. Empty: `webpc`. */
export function parseHostname(input: string): { hostname: string } | { error: string } {
  const s = input.trim().toLowerCase();
  if (!s) return { hostname: 'webpc' };
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return { error: 'The hostname is letters, digits and hyphens (63 at most), not starting or ending with a hyphen.' };
  return { hostname: s };
}

export type Phase =
  /** No client. */
  | 'off'
  /** Loading the client, or waiting for the control server. */
  | 'connecting'
  /** The user has something to do: open the login link, or an admin has to approve the machine. */
  | 'login'
  | 'connected'
  | 'error';

export type NetworkView = {
  phase: Phase;
  /** One line for the menu. */
  text: string;
  /** Where to log in (only http(s) URLs). */
  loginURL?: string;
  /** The guest's IPv4 address, when connected. */
  address?: string;
};

/** What a `Tailscale` client reports, as far as the view needs it. */
export type ClientReport = { state: string; netmap?: NetMap; loginURL?: string; error?: string };

const web = (s: string | undefined) => {
  try {
    const u = new URL(s ?? '');
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** The menu's view of a client's report (`undefined`: there's no client). */
export function viewOf(c: ClientReport | undefined): NetworkView {
  if (!c) return { phase: 'off', text: 'Not connected' };
  if (c.error) return { phase: 'error', text: `Couldn't connect: ${c.error.split('\n')[0]}` };
  const loginURL = web(c.loginURL);
  switch (c.state) {
    case 'Running': {
      const address = c.netmap?.addresses.find((a) => !a.includes(':'))?.replace(/\/\d+$/, '');
      const peers = c.netmap?.peers.length ?? 0;
      return { phase: 'connected', address, text: `Connected${c.netmap?.name ? ` as ${c.netmap.name.replace(/\.$/, '')}` : ''}${address ? ` (${address})` : ''}, ${peers} peer${peers === 1 ? '' : 's'}` };
    }
    case 'NeedsLogin':
      return loginURL ? { phase: 'login', text: 'Log in to connect', loginURL } : { phase: 'connecting', text: 'Contacting the control server…' };
    case 'NeedsMachineAuth':
      return { phase: 'login', text: 'Waiting for an administrator to approve this machine', loginURL };
    case 'Stopped':
      return { phase: 'off', text: 'Stopped' };
    default:
      return { phase: 'connecting', text: c.state === '' ? 'Loading the client…' : 'Connecting…' };
  }
}

export type Connect = { controlURL: string; hostname: string; authKey?: string };

export type Network = {
  /** A new machine's end of the IP port (its device's `{ip: port}`; transfer it). Any client gets the other end. */
  port(): MessagePort;
  /** Starts the client on the machine's port (a machine with a card must have started). Throws if there's none. */
  connect(c: Connect): void;
  /** Stops the client and takes the port back; the machine keeps its card (and the address it was given). */
  disconnect(): Promise<void>;
  /** Logs the node out of its tailnet and forgets it, then disconnects. */
  logout(): Promise<void>;
  view(): NetworkView;
  /** Whether a client runs. */
  active(): boolean;
};

export function createNetwork(onChange: () => void, start: (config: TailscaleConfig, onEvent: (m: FromTailscale) => void) => Tailscale = startTailscale): Network {
  /** The page's end of the machine's port, while no client has it. */
  let free: MessagePort | undefined;
  let client: Tailscale | undefined;
  let error: string | undefined;

  const report = (): ClientReport | undefined => (client ? { state: client.state(), netmap: client.netmap(), loginURL: client.loginURL(), error } : undefined);

  async function disconnect() {
    const t = client;
    if (!t) return;
    client = undefined;
    error = undefined;
    free = await t.detach();
    t.close();
    onChange();
  }

  return {
    port() {
      const { port1, port2 } = new MessageChannel();
      if (client) client.attach(port1);
      else {
        free?.close();
        free = port1;
      }
      return port2;
    },
    connect(c) {
      if (client) return;
      if (!free) throw new Error('the machine hasn\'t started, so its network card isn\'t there yet: start it first');
      error = undefined;
      const ip = free;
      free = undefined;
      // An auth key's node is ephemeral and not kept; the login's node is (under its control server's name).
      const t = start({ controlURL: c.controlURL, authKey: c.authKey || undefined, hostname: c.hostname, ip, persist: c.authKey ? undefined : c.controlURL }, (m) => {
        if (m.type === 'error') error = m.error;
        else if (m.type === 'state' && m.state === 'Running') error = undefined;
        onChange();
      });
      client = t;
      t.running.catch((e) => { error = String(e?.message ?? e); onChange(); });
      onChange();
    },
    disconnect,
    async logout() {
      await client?.logout();
      await disconnect();
    },
    view: () => viewOf(report()),
    active: () => !!client,
  };
}
