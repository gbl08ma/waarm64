# Network adapters and connections

A machine has up to four network adapters, and each is attached to one of the browser's **connections** (a tailnet,
tailcat, the local helper, the demo network or a peer-to-peer room), or to none. This page is the model and the guest side: what a connection is and where its state lives, the
locks between tabs, the guest's routes over several adapters and the numbers measured. The page's menus and wizard
are in [frontend.md](../frontend.md) "Network" and "The Home page", the gateway's DHCP and router advertisements in
[devices.md](../devices.md) "net", and the clients in [tailnet.md](tailnet.md). Loose ends are in
[backlog.md](../backlog.md) "Several adapters' loose ends". (Built 2026-10-18/19, from a plan whose section numbers the
code's comments still cite; machines had first left several adapters for later: [machines.md](../machines.md).)

## 1. The rules (the user's, 2026-10-18)

1. **A machine has up to 4 network adapters** (`MAX_ADAPTERS`), in order, each with its own MAC. Adapters are part
   of the shape, their order too: virtio-mmio has no hotplug, so adding, removing or moving one needs the machine off
   (as a disk does).
2. **Connections are the browser's, not the machine's:** a list kept in this browser, each a tailnet, tailcat, the
   local helper on this computer (`local`: [local-helper.md](local-helper.md)), the demo network (`demo`:
   [demo-network.md](demo-network.md)) or a peer-to-peer room (`room`: [rooms.md](rooms.md)). A connection carries its
   own state (a tailnet's node, tailcat's identity and address, a room's node key), so it keeps working as the user
   moves from one machine to the next. There is no "default" connection, **except two the page makes for a demo**
   (decisions.md "Network"): the demo network's (the user, 2026-11-18), made when a demo's definition asks for it
   (web/app/net-demo.ts `attachDemoNetwork`, `withDemoNetwork`), which holds no secret; and **a demo's room** (the user,
   2026-11-19), a room connection of the demo machine's own on the global public room, on its second adapter, made
   with the machine (`withDemoRoom`, its record's `forMachine`) and deleted with it (`deleteOwnConnections`), its key
   made at the machine's first start ([rooms.md](rooms.md) "A demo's room").
3. **An adapter with no connection is allowed:** a card with no cable.
4. **One running machine holds a connection at a time**, through a Web Lock per connection (§2.3), **except the demo
   network's** (decision 10; `exclusive` in web/app/connections.ts): any number of machines and adapters run it at once,
   a socket each, and its server gives each socket a network of its own. A machine that
   wants a held connection says which machine holds it and offers to take it. A machine that stops (powered off,
   suspended, crashed, or stopped for one that can't start) lets its connections go and connects them again at its next start; a restart keeps them. The
   exception is an ephemeral tailnet's: its node is in the client, so the client stays, and no other tab can want it.
5. **Two adapters on the same tailnet are two connections:** two nodes, enrolled separately, with separate state.
6. **Ephemeral connections** are chosen when the connection is made and are never written to the browser's storage.
   A tailnet's asks the control server for an ephemeral node; a tailcat one has a fresh identity, held in memory.
   They are the page's that made them: a reload or closing the tab ends them, and their adapters come back detached,
   saying so. (Sharing one across tabs would mean storing it somewhere, which is what ephemeral rules out.) A stored
   connection keeps everything, the address of the tailcat server it goes online through included.
7. **Routing over several adapters:** each adapter's gateway has its own addresses, and only the **primary** offers
   the default route (§4).
8. **Managed on the Home page's Network tab and from the toolbar's Network menu.** Attaching starts with
   [New connection…](ui:network:NetPickStep.pick.new), which makes the connection in the same wizard, because a new machine's user has none yet.

## 2. Connections

### 2.1 The record

IndexedDB `waarm64`, object store `connections` (web/app/store.ts), `Connection` in web/app/connections.ts: an id (also
the lock's name), the user's name, the kind, `ephemeral`, the kind's settings, `connectAtStart` (off after
Disconnect) and `lastUsed` (what the wizard preselects). The state stays where the clients keep it:
- **A tailnet's node** in `waarm64-tailscale`, in the Go client's format ([tailnet.md](tailnet.md) "The kept node"),
  under the profile prefix `stateKey` (the connection's id; for a node kept before connections, its control URL). An
  auth key is never kept: it enrolls the node once, and the node is then kept like a login's (ephemeral only when the
  key or the connection is).
  Logging a node out needs the control server: with no machine running it, a client of its own on a port no guest has
  comes up with the node's keys, waits for the control server to answer (15 s) and logs out (`logOutNode`), so Log out
  works from Connections for any kept node, and Delete logs the node out first. A client that runs the node stops
  first and this is the path then too: the module, not connected, would only forget the keys here and strand the
  node, and only this knows the server has answered. If it doesn't answer, Log out keeps the node and says so (a client
  that ran stays stopped); Delete deletes all the same and says the node stays on the tailnet until it expires or an
  admin removes it. While it goes on the connection's lock is held, nothing connects it and no other tab can take it;
  one another tab's machine has is taken from it first, after asking.
- **The local helper's link** (`local.url`, `ws://127.0.0.1:<port>/<token>`) in the record: a secret, like tailcat's
  `exit`; the helper keeps its token, so the link stays good across its restarts. Nothing else to forget.
- **tailcat's identity** in `waarm64-tailcat` under `identityKey` (`served` for the one kept before
  connections): the node key, the same whether the connection serves or only goes online through a server (which can
  then `--allow` it), and the served address's pre-shared key. The server address it goes online through (`exit`) is a secret and is kept only in a stored
  connection.
- **An ephemeral connection** lives in a `Map` in the page, and its client's state goes to an in-memory store instead
  of IndexedDB.
- **A room's link and key**: the link (`room.link`, `waarm64-room:<id>?nostr=…&derp=…`, web/room.ts `roomLink`; a
  private room's is a secret) and the switches (`incoming`, `relayOnly`) in the record; the node key in
  `waarm64-room`, object store `identity`, under `room.identityKey` (64 hex digits, made at the first connect), so the
  machine's address and name in the room stay the same. The same database's `names` store (version 2) keeps a stored
  connection's room-names records, by room (a hash of its ID) and name id (web/room.ts `roomNamesStore`,
  [names.md](names.md) "Servers"); its `owner` and `titles` stores (version 3) keep the names agent's owners' secret and
titles under the connection's `identityKey`, so names go with the key: the connection's export is the key and, after a
dot, its names (`Connections.exportKey`, web/app/room-export.ts), and a connection made from it takes them. A connection made with another's key ([The connection's key](ui:network:NetRoomStep.room.key) under Advanced: the stored room connections) takes that one's `identityKey`:
  the same key in two rooms, one at a time: a running room connection holds its key's lock (`roomKeyLock`, beside its
  own; named by a hash of the key, a stored connection's read from its entry and made there at its first claim, so
  every kind of connection that has a key, in any tab, names one lock), so another connection on that key, on another
  adapter or in another tab, doesn't connect while it runs and says which has it (two DERP connections under one key
  break each other on a shared region: a derper delivers the key's packets to one of them). A page notes a key it is
  taking before it waits for the lock, so two connects on one key at once there don't both pass. A stored connection
  made with an ephemeral one's key (pasted, or chosen) keeps a copy in its own entry, never the key in its record. Delete forgets the key only when no other connection uses it, and New name gives the
  connection a key of its own (a new `identityKey` when it was shared). An ephemeral connection that uses a stored
  one's entry holds a shared Web Lock named by it (`waarm64-room-entry:<identityKey>`, web/app/connections.ts) while it
  lives, so another tab's Delete and New name see it (`sharesKey`: more holders than that page's own) and keep the
  entry; the last one using it forgets it, whichever tab. Each room has its own /48, so rooms on several
  adapters route apart.

### 2.2 From the single connection kept before

The page used to have one connection per browser (`waarm64.settings` `net`, one kept node per control server, one
tailcat identity per origin). On the first load with connections, `migrateLegacy` makes them stored connections, so
nobody logs in again: a tailnet connection per kept node, whose `stateKey` is the profile it was kept under (no bytes
move), and a tailcat one for the `served` identity, so the machine's tailcat address stays. The transient machine's
adapter and every stored machine's first are attached to the one the settings were on, and `net` is dropped from the
settings. Idempotent.

### 2.3 Locks between tabs

A Web Lock `waarm64-net:<id>` is held while a running machine has the connection's client (web/app/locks.ts, as USB's
devices: [usb.md](../usb.md) "Device locks"), over the store's `BroadcastChannel`: `net-who` asks which machine holds it,
`net-held` answers, and `net-release` asks the holder to let go. The page offers [Use it here](ui:network:network-actions.useHere), and the other tab
disconnects and says it was taken.

## 3. The page

The Home page's **Network tab** (§3.1) lists a machine's adapters with their MACs and connections, and
**[Connections](ui:machines:ConnectionsPane.connections.heading)** lists the browser's; the **Network wizard** (§3.2) attaches a connection, a new one or one of the
browser's; the toolbar's **Network menu** (§3.3) has a section per adapter of the page's machine (a button per adapter where the toolbar has room). What each shows and
does: [frontend.md](../frontend.md) "The Home page" and "Network". The live side is web/app/net-live.ts
(`PageNetwork`): a `Network` (web/app/network.ts) per adapter, each with its machine port, client and error; a
restart hands the new machine's port to the running client, matched by the adapter's id (so a client follows its
adapter when they move), and Disconnect takes the port back. A connection attached to or detached from a machine
running in another tab takes effect there at once: that tab hears the record change on the store's channel
(`follow`), and an adapter whose connection is in use says so.

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
- **The primary** (`primaryOf`): a connected local helper's adapter first (its DHCP is the helper's, which always
  gives a default route, so the page can't make it route only its own prefixes), else the first adapter, in order,
  that is connected and reaches the internet (a tailnet
  with an exit node in use, tailcat going online through a server); without one, the first connected, so a machine
  with one adapter keeps its default route. The page picks it again on every change and tells each client
  (`setPrimary`). The primary's lease is as a single card's. The others' carry `routes` (`routedLease`), and their
  gateway is then the router for those prefixes only: option 121 without a default and no option 3, a router
  advertisement with lifetime 0 and a Route Information option per IPv6 prefix. A tailnet offers 100.64.0.0/10 and
  fd7a:115c:a1e0::/48 (`TAILNET_ROUTES`). tailcat offers no prefix: its tunnel addresses, its clients' too, are in that
  same /48, so each client it lets in is a /128 route of its own, on the primary too (`peers6`, up to 40 options an
  advertisement, as many as 64 clients take): the longest match sends the guest's answers to tailcat's adapter
  whatever the order, and a tailcat adapter hides no tailnet peer. A room offers its own /48 (`prefix6`, web/room-worker.ts) and never
  reaches the internet, so it is the primary only when nothing else is connected. (With a /48 of its own, the guest answered tailcat
  clients through the tailnet's adapter and they timed out, tests/net-tailnet.test.ts's two adapters.) Two tailnets do
  share the /48, so an adapter's IPv6 routes carry a preference from its rank among the connected adapters (`ranksOf`,
  web/gateway.ts `ranked`: high, medium, then low; RFC 4191's three levels, so a third and fourth tie): the guest's
  kernel takes the more preferred of equal routes, and the earlier adapter's wins.
  systemd-networkd installs them all, so
  this works on any guest without configuration: Debian's `network.network.card` credential matches `e*`.
- **A connection that changes under a running guest** (another on the adapter, or the local helper's path in or out):
  the guest's IPv4 lease would stay until its renewal (half an hour on one adapter), so the card's link flaps
  ([devices.md](../devices.md) "net") and the guest asks for a lease at once; a reconnect to the same address doesn't
  flap. **Measured** in `tests/net-local.test.ts` (Debian 13's networkd, the page's gateway's lease to the helper's).
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
  the network's own prefixes and clients), so the guest's IPv6 to the internet fails at once ("network unreachable") and clients
  that try IPv6 first fall back to IPv4. A probe is a DNS query (the root's NS) to three operators' resolvers at once
  (`PROBE_TARGETS`: Cloudflare's, Google's, Quad9's; one blocked, as Cloudflare is in some countries at times, mustn't
  make IPv6 out), from the lease's IPv6 address, sent through the backend by its worker, lost when none answers, whose answer the worker takes out of the guest's
  packets: at the start, every minute, at once on the browser's `online` and the Network Information API's `change`
  events. Three lost in a row (3 s each) make IPv6 out, one answer brings it back; until the first answer it is out.
  The router advertisement moves the default at once both ways. tailcat going online through a server uses it (a
  tailcat exit node accepts IPv6 connections it can't dial out and closes them empty, so curl and browsers never fell
  back): on the dev VM, which has no IPv6, the guest has no IPv6 default and curl reaches the internet over IPv4 by
  itself; through an exit node on the Mac, which has IPv6, the default came within a second of networkd starting and
  curl used IPv6 (by hand, 2026-10-23). A tailnet runs it while an exit node is in use, from scratch for each exit node
  (out until it answers; none in use, no probe): the Podman peer has no IPv6 out, so the guest's IPv6 default goes
  when it becomes the exit node and comes back when it stops. The worker tells the page what the probe found (the
  netmap's `reached6`, the view's `internet6`), for the next point.
- **A primary per family** (`primary6Of`): IPv6's default way out is the primary when the primary's IPv6 reaches the
  internet or it is a local helper's (whose router advertisements are the helper's, not the page's); else the first
  adapter, in order, whose probe answers (tailcat through a server with no IPv6 first, a tailnet's exit node with IPv6
  second); without one, the primary, whose lease then has no IPv6 default. Each client is told both (`setPrimary`'s
  `primary6`), and `routedLease` gives each family's default or routes apart: IPv4's primary keeps its DHCP default and
  offers only its IPv6 routes, IPv6's advertises itself as the default router and its resolvers and offers only its
  IPv4 routes. The menu's adapter headings and the Network tab then say which family's default each carries.
  **Measured** in `tests/net-tailcat.test.ts`'s primary per family (two tailcat adapters, the first's probe unanswered,
  the second's answered by the stand-in; skipped without a non-link-local IPv6 address here: on the dev VM by hand,
  with a ULA added to `eth0` for the run): IPv4's default through the first, IPv6's through the second, the guest
  reaching this machine over both, and IPv6's default gone once the second's probe stops answering.
- **DNS:** each lease carries its own connection's resolvers and domains, and systemd-resolved keeps them per link:
  a tailnet's MagicDNS domain sends its names to the tailnet's adapter (checked against headscale beside tailcat), and
  the rest go to the primary's resolvers. A guest without systemd-resolved gets every adapter's resolvers in one list.

## 5. Snapshots, definitions, copies

- **Snapshots** pin the adapters, which are in the shape, and not the connections (like USB devices). A restore keeps
  the machine's current attachments, and the restored guest renews its leases once the page's connections are up:
  through the guest agent at once, else by a link flap (devices.md "The network after a restore").
- **A machine's definition** carries its adapters' MACs (`machine.macs`, left out for one at the default) and not its
  connections, which hold secrets and are this browser's: an imported machine's adapters come detached.
- **[Duplicate](ui:machines:MachinePane.duplicate)** copies the adapters with their MACs and no connections.

## 6. Tests

[testing.md](../testing.md) "Network adapters and connections" lists them. On Debian (`scripts/ci-net.sh`):
`tests/net-guest.test.ts` (three cards on the echo backend, each with its own lease, router and gateway MAC; two
whose default route goes through the primary only and moves when the primary does, IPv4's bounded at 45 s) and
`tests/net-tailnet.test.ts`'s two adapters (`tests/browser/adapters.html`: two `Network`s and `primaryOf` as the page
has them): a tailnet on the Podman headscale with no exit node, beside tailcat through `tests/net/tailcat.sh`'s
server; tailcat is the primary although second, and the guest reaches the tailnet's peer (by address over both
families, by name through MagicDNS) and the internet (this machine's LAN through the exit node) at once. Planted
bugs each caught: a MAC left out of the hash, every adapter's gateway at one address, a default route from every
gateway, `primaryOf` taking the first connected, the renewal time ignored, a kept node's profile rewritten, a
connect without its lock, every node kept, Keep ignored, the page not telling the network its machine stopped, the
page not following another tab's attachment. That test also lets a tailcat client in beside the tailnet, over
IPv6: it timed out with tailcat's /48, before its per-client routes.
