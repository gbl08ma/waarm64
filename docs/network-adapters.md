# Network adapters and connections

A machine has up to four network adapters, and each is attached to one of the browser's **connections** (a tailnet or
tailcat), or to none. This page is the model and the guest side: what a connection is and where its state lives, the
locks between tabs, the guest's routes over several adapters and the numbers measured. The page's menus and wizard
are in [frontend.md](frontend.md) "Network" and "The Machines page", the gateway's DHCP and router advertisements in
[devices.md](devices.md) "net", and the clients in [tailnet.md](tailnet.md). Loose ends are in
[backlog.md](backlog.md) "Several adapters' loose ends". (Built 2026-10-18/19, from a plan whose section numbers the
code's comments still cite; [machines.md](plans/machines.md) had left several adapters for later.)

## 1. The rules (the user's, 2026-10-18)

1. **A machine has up to 4 network adapters** (`MAX_ADAPTERS`), in order, each with its own MAC. Adapters are part
   of the shape: virtio-mmio has no hotplug, so adding or removing one needs the machine off (as a disk does).
2. **Connections are the browser's, not the machine's:** a list kept in this browser, each a tailnet or tailcat
   (later, perhaps, a p2p room: [plans/networking-p2p.md](plans/networking-p2p.md), or a local helper:
   [plans/networking-local.md](plans/networking-local.md)). A connection carries its own state
   (a tailnet's node, tailcat's identity and address), so it keeps working as the user moves from one machine to the
   next. There is no "default" connection.
3. **An adapter with no connection is allowed:** a card with no cable.
4. **One running machine holds a connection at a time**, through a Web Lock per connection (§2.3). A machine that
   wants a held connection says which machine holds it and offers to take it.
5. **Two adapters on the same tailnet are two connections:** two nodes, enrolled separately, with separate state.
6. **Ephemeral connections** are chosen when the connection is made and are never written to the browser's storage.
   A tailnet's asks the control server for an ephemeral node; a tailcat one has a fresh identity, held in memory.
   They are the page's that made them: a reload or closing the tab ends them, and their adapters come back detached,
   saying so. (Sharing one across tabs would mean storing it somewhere, which is what ephemeral rules out.) A stored
   connection keeps everything, the address of the tailcat server it goes online through included.
7. **Routing over several adapters:** each adapter's gateway has its own addresses, and only the **primary** offers
   the default route (§4).
8. **Managed on the Machines page's Network tab and from the toolbar's Network menu.** Attaching starts with
   **New connection…**, which makes the connection in the same wizard, because a new machine's user has none yet.

## 2. Connections

### 2.1 The record

IndexedDB `webpc`, object store `connections` (web/app/store.ts), `Connection` in web/app/connections.ts: an id (also
the lock's name), the user's name, the kind, `ephemeral`, the kind's settings, `connectAtStart` (off after
Disconnect) and `lastUsed` (what the wizard preselects). The state stays where the clients keep it:
- **A tailnet's node** in `webpc-tailscale`, in the Go client's format ([tailnet.md](tailnet.md) "The kept node"),
  under the profile prefix `stateKey` (the connection's id; for a node kept before connections, its control URL). An
  auth key is never kept: it enrolls the node once, and the node is then kept like a login's (ephemeral only when the
  key or the connection is).
- **tailcat's served identity** in `webpc-tailcat` under `identityKey` (`served` for the one kept before
  connections). The server address it goes online through (`exit`) is a secret and is kept only in a stored
  connection.
- **An ephemeral connection** lives in a `Map` in the page, and its client's state goes to an in-memory store instead
  of IndexedDB.
- **A p2p room**, if it comes ([plans/networking-p2p.md](plans/networking-p2p.md)), joins as a third kind: its node's
  one identity across rooms becomes one per connection, like tailcat's.

### 2.2 From the single connection kept before

The page used to have one connection per browser (`webpc.settings` `net`, one kept node per control server, one
tailcat identity per origin). On the first load with connections, `migrateLegacy` makes them stored connections, so
nobody logs in again: a tailnet connection per kept node, whose `stateKey` is the profile it was kept under (no bytes
move), and a tailcat one for the `served` identity, so the machine's tailcat address stays. The transient machine's
adapter and every stored machine's first are attached to the one the settings were on, and `net` is dropped from the
settings. Idempotent.

### 2.3 Locks between tabs

A Web Lock `webpc-net:<id>` is held while a running machine has the connection's client (web/app/locks.ts, as USB's
devices: [usb.md](usb.md) "Device locks"), over the store's `BroadcastChannel`: `net-who` asks which machine holds it,
`net-held` answers, and `net-release` asks the holder to let go. The page offers **Use it here**, and the other tab
disconnects and says it was taken.

## 3. The page

The Machines page's **Network tab** (§3.1) lists a machine's adapters with their MACs and connections, and
**Connections** lists the browser's; the **Network wizard** (§3.2) attaches a connection, a new one or one of the
browser's; the toolbar's **Network menu** (§3.3) has a section per adapter of the page's machine. What each shows and
does: [frontend.md](frontend.md) "The Machines page" and "Network". The live side is web/app/net-live.ts
(`PageNetwork`): a `Network` (web/app/network.ts) per adapter, each with its machine port, client and error; a
restart hands the new machine's port to the running client, and Disconnect takes the port back.

## 4. The guest side

- **The shape:** `adapters: {id, mac, connection?}[]`. A machine with one adapter at `52:54:00:12:34:56` hashes the
  same as a machine made before adapters with its card (`network: true`, read through `adaptersOf`), so its
  snapshots stay valid. A new adapter gets a random MAC under `52:54:00`. Net slots come in adapter order (each is
  guest-visible: `eth<n>` by slot). With 4 adapters, 16 disks and the other transports, a machine uses 26 of the
  core's 32. A connection isn't in the shape: attaching is saved at once, running or not.
- **Each adapter's gateway has its own addresses:** MAC `02:77:65:62:70:63` plus `n`, IPv4 `169.254.0.<n+1>` and the
  IPv6 link-local from that MAC (web/gateway.ts `gatewayOf`; adapter 0's are the one card's). tailcat's IPv4 lease is
  192.0.0.2 on every adapter: it is local to its link (the client translates it to the tunnel's IPv6), and only the
  primary carries IPv4 routes, so two tailcat adapters with the same address don't meet. A tailnet's addresses are
  distinct already.
- **The primary** (`primaryOf`): the first adapter, in order, that is connected and reaches the internet (a tailnet
  with an exit node in use, tailcat going online through a server); without one, the first connected, so a machine
  with one adapter keeps its default route. The page picks it again on every change and tells each client
  (`setPrimary`). The primary's lease is as a single card's. The others' carry `routes` (`routedLease`), and their
  gateway is then the router for those prefixes only: option 121 without a default and no option 3, a router
  advertisement with lifetime 0 and a Route Information option per IPv6 prefix. A tailnet offers 100.64.0.0/10 and
  fd7a:115c:a1e0::/48 (`TAILNET_ROUTES`), tailcat the /48 (`TAILCAT_ROUTES`). systemd-networkd installs them all, so
  this works on any guest without configuration: Debian's `network.network.card` credential matches `e*`.
- **The takeover:** when the primary loses the internet, the next one becomes primary. Its router advertisement goes
  out at once, and IPv4's default moves at the guest's next DHCP renewal, so a machine with several adapters has its
  lease renewed every 10 s (DHCP's T1; the lease lasts two minutes, so a gateway that stops answering for a while
  costs no address: web/devices.ts `SEVERAL_ADAPTERS`). **Measured on the dev VM** (`tests/net-guest.test.ts`'s two
  adapters, Debian 13's networkd): IPv6 at once, IPv4 in 8, 9 and 9 s. With T1 at half a two-minute lease it took
  49 s (twice; 37 s in the cloud's first run). Faster would take forcing a renew (DHCP FORCERENEW, which networkd
  ignores without authentication) or flapping the link (a guest-visible device feature: the link is always up,
  devices.md "net"); not needed so far.
- **IPv6 out** (web/reach6.ts): an adapter whose far end may have no IPv6 route out probes it, and while it doesn't
  answer, its lease has no IPv6 default route and no IPv6 resolvers (`unreached6`: the address stays, routed through
  the network's own prefixes), so the guest's IPv6 to the internet fails at once ("network unreachable") and clients
  that try IPv6 first fall back to IPv4. The probe is a DNS query (the root's NS) to `2606:4700:4700::1111` from the
  lease's IPv6 address, sent through the backend by its worker, whose answer the worker takes out of the guest's
  packets: at the start, every minute, at once on the browser's `online` and the Network Information API's `change`
  events. Three lost in a row (3 s each) make IPv6 out, one answer brings it back; until the first answer it is out.
  The router advertisement moves the default at once both ways. tailcat going online through a server uses it (a
  tailcat exit node accepts IPv6 connections it can't dial out and closes them empty, so curl and browsers never fell
  back): on the dev VM, which has no IPv6, the guest has no IPv6 default and curl reaches the internet over IPv4 by
  itself. A Tailscale exit node can have the same problem (docs/backlog.md "Network"). The probe tells only whether
  the far end reaches the internet over IPv6; it isn't per-family primaries (IPv6's default from another adapter).
- **DNS:** each lease carries its own connection's resolvers and domains, and systemd-resolved keeps them per link:
  a tailnet's MagicDNS domain sends its names to the tailnet's adapter (checked against headscale beside tailcat), and
  the rest go to the primary's resolvers. A guest without systemd-resolved gets every adapter's resolvers in one list.

## 5. Snapshots, definitions, copies

- **Snapshots** pin the adapters, which are in the shape, and not the connections (like USB devices). A restore keeps
  the machine's current attachments, and the restored guest renews its leases.
- **A machine's definition** carries its adapters' MACs (`machine.macs`, left out for one at the default) and not its
  connections, which hold secrets and are this browser's: an imported machine's adapters come detached.
- **Duplicate** copies the adapters with their MACs and no connections.

## 6. Tests

[testing.md](testing.md) "Network adapters and connections" lists them. On Debian (`scripts/ci-net.sh`):
`tests/net-guest.test.ts` (three cards on the echo backend, each with its own lease, router and gateway MAC; two
whose default route goes through the primary only and moves when the primary does, IPv4's bounded at 45 s) and
`tests/net-tailnet.test.ts`'s two adapters (`tests/browser/adapters.html`: two `Network`s and `primaryOf` as the page
has them): a tailnet on the Podman headscale with no exit node, beside tailcat through `tests/net/tailcat.sh`'s
server; tailcat is the primary although second, and the guest reaches the tailnet's peer (by address over both
families, by name through MagicDNS) and the internet (this machine's LAN through the exit node) at once. Planted
bugs each caught: a MAC left out of the hash, every adapter's gateway at one address, a default route from every
gateway, `primaryOf` taking the first connected, the renewal time ignored, a kept node's profile rewritten, a
connect without its lock, every node kept, Keep ignored.
