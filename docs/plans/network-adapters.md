# Several network adapters, and connections kept by the browser (proposed, 2026-10-18)

A machine today has one network card or none (`network: boolean` in its shape, web/app/shape.ts), and the page has one
connection: one set of settings per browser (`webpc.settings` `net`, web/app/network.ts), one kept Tailscale node per
control server (IndexedDB `webpc-tailscale`, profiles keyed by the control URL: web/tailscale-state.ts) and one tailcat
identity per origin (`webpc-tailcat` `served`, web/tailcat.ts). That single connection follows the user from machine
to machine, which is what makes the first boot easy. [machines.md](machines.md) left several adapters for "a later
milestone" (§1.1, §4.1, §10). This plan is that milestone, with the network's UX made the same as the disks' and USB's.

## 1. Decisions (the user, 2026-10-18)

1. **A machine has up to 4 network adapters**, in order, each with its own MAC. Adapters are part of the shape:
   virtio-mmio has no hotplug, so adding, removing or reordering one needs the machine off (as a disk does).
2. **Connections are the browser's, not the machine's:** a list kept in this browser (like the disks in this
   browser, [frontend.md](../frontend.md) "The Machines page"), each a tailnet, tailcat or, later, a p2p room
   ([networking-p2p.md](networking-p2p.md)). An adapter is **attached to a connection, or to none**. A connection
   carries its own state (a tailnet's node, tailcat's identity and address), so it keeps working as the user moves
   from one machine to the next, without any notion of a "default" connection.
3. **An adapter with no connection is allowed:** a card with no cable, as today's card is before Connect.
4. **One running machine holds a connection at a time**, through a Web Lock per connection (as overlays and USB
   devices have). A machine that wants a held connection says which machine holds it and offers to take it from there.
5. **Two adapters on the same tailnet are two connections:** two nodes, enrolled separately, with separate state.
   One machine can't attach one connection twice (the lock is the connection's).
6. **Ephemeral connections:** chosen when the connection is made, never written to the browser's storage, for every
   kind. A tailnet's ephemeral connection asks the control server for an ephemeral node (removed once it is gone); a
   tailcat one has a fresh identity, and its address is held in memory only. They are gone when the page that made
   them closes, and the adapters attached to them are found detached, saying so. A stored connection keeps
   everything, the tailcat address it goes online through included (today that address is never saved).
7. **Routing over several adapters:** each adapter's gateway has its own addresses, and **only adapters that reach the
   internet offer a default route**; among those, the first in order wins (§4).
8. **Managed on the Machines page's Network tab and from the toolbar's Network menu**, one section per adapter in the
   menu. **Attaching starts with "New connection…"**, which makes the connection in the same wizard and attaches it,
   because a new user with a new machine has no connection yet.

## 2. Connections

### 2.1 The record

IndexedDB `webpc`, a new object store `connections` (web/app/store.ts), keyed by id:

```ts
type Connection = {
  id: string;            // random; also the Web Lock's name, `webpc-net:<id>`
  name: string;          // the user's; default from the kind and the tailnet or address ("Tailscale", "tailcat 2")
  kind: 'tailnet' | 'tailcat';           // later 'room'
  ephemeral: boolean;    // never true in the store: an ephemeral connection lives only in the page's memory
  tailnet?: { controlURL: string; hostname: string; exitNode: string; stateKey: string };
  tailcat?: { exit?: string; serve: boolean; relay: string; identity?: TailcatIdentity };
  connectAtStart: boolean;               // off after Disconnect, as `autoconnect` is today
  lastUsed: number;                      // what the wizard preselects (§3.2)
};
```

- **A tailnet's node** stays in `webpc-tailscale` in the Go client's format (docs/tailnet.md "The kept node"), under
  the profile prefix `stateKey` instead of the control URL. `openState(profile)` already takes any prefix, so the
  change is which prefix the page passes (`persist` in web/tailscale.ts). The format stays the Go client's, so the
  hand-over test still holds.
- **tailcat's identity** moves from the single `served` key into the connection (or stays in `webpc-tailcat` keyed by
  the connection's id; L0 picks one by what the sweep needs). The address it goes online through (`exit`) is kept only
  in a stored connection.
- **An auth key** is still never kept. It enrolls the node once. On a stored connection the node is kept like a
  login's (the control server still makes it ephemeral when the key is an ephemeral one). On an ephemeral connection
  the node is ephemeral.
- **Ephemeral connections** live in a `Map` in the page that made them (they can't be shared with other tabs without
  storing them). Their kept state (the node's keys) goes to an in-memory store that the client is given in place of
  IndexedDB.

### 2.2 From today's single connection

On the first load with this code, today's settings and kept state become one stored connection, so nobody logs in
again:
- If `net.kind` is a tailnet with a kept node: a tailnet connection whose `stateKey` is the existing prefix (the
  control URL), so no bytes are moved.
- If tailcat serving was on: a tailcat connection holding the `served` identity, so the machine's tailcat address
  doesn't change.
- Every stored machine that has `network: true` gets one adapter attached to that connection.

The migration then drops `net` from `webpc.settings`. (machines.md §1.13 dropped compatibility because nobody used the
page; vm.tny.im is live now, and keeping a login costs one function.)

### 2.3 Locks between tabs

A Web Lock `webpc-net:<id>` is held while a running machine has the connection's client. This works as USB's does
([usb.md](../usb.md) "Device locks"), over the store's `BroadcastChannel`:
- `net-who` asks a tab to name the machine that holds the lock, and `net-held` answers.
- `net-release` asks the holder to disconnect the connection and detach it.

The page offers **Use it here instead**, which takes the connection over.

## 3. The page

### 3.1 The Machines page

- **The Network tab** (`Network.svelte` is split: the tab, the wizard, the menu) lists the machine's adapters in order.
  Each adapter shows its MAC, its connection (name, kind, ephemeral or not, state) and **Connect at start**. Its
  actions are **Attach…** or **Change connection…**, **Detach**, **Disconnect** and **Connect** while it runs, and,
  with the machine off, **Remove** and reorder. **Add an adapter** is there with the machine off, up to 4. What needs
  the machine off says so and offers to power it off, as Disks does.
- **Connections** sits beside **Storage** on the Machines page and lists every connection in this browser. For each
  one it shows the kind, whether it's ephemeral, the machines that have it and which one holds it. Its actions are
  **Rename**, **Edit** (only what the kind allows changing without a new node: hostname and exit node, or the relay),
  **Log out** (a tailnet: the node is removed and its keys deleted), **New address** (tailcat serving) and
  **Delete** (detaches it from its machines, after a confirmation that names them). **New connection…** opens the
  same wizard on its own.

### 3.2 The Attach wizard

1. **The choice:** **New connection…** first (preselected when the browser has none). After it come the connections
   in this browser, the most recently used free one preselected, and held ones marked with their holder.
2. **New connection…** goes on to today's Network wizard steps: the kind (a tailnet or tailcat, each explained), then
   its settings. One new setting closes them: **Keep this connection in this browser**, on by default; off makes it
   ephemeral, and the line explains what that means.
3. **Attach** saves the connection (unless it's ephemeral), attaches it and, on a running machine, connects it, which
   is today's Connect. The menu then opens on that adapter.

A new machine made from a disk image gets one adapter (as today's machines get the card). Its first Connect is this
wizard, from the toolbar.

### 3.3 The toolbar's Network menu

The menu has one section per adapter, headed by the adapter's number and connection name. Each section holds what the
menu holds today for its connection: the status, Log in…, Internet through, the tailcat address, Disconnect and Log
out. It also has **Change connection…**, the wizard above. A machine with a single adapter shows the menu as it is
today, with no heading.

### 3.4 web/app/network.ts

`createNetwork` becomes one `Network` per adapter. Each holds its own machine port, client and error, with the
`connect(c: Connection)` that picks the client and its state store. The worker gets one `ip` port per adapter. The
behaviour is the same as today's: a restart hands the new machine's port to the running client, and Disconnect takes
the port back.

## 4. The guest side

- **The shape:** `network: boolean` becomes `adapters: {mac: string}[]`. A machine with one adapter at
  `52:54:00:12:34:56` hashes the same as today's `network: true` (shape.ts keeps old hashes where nothing changed, as
  it does for USB), so existing snapshots stay valid. A new adapter gets a random locally administered MAC, kept in
  the record. `slots` gives net slots in adapter order (each is guest-visible: `enp0s…`/`eth<n>` by slot).
  `snapshotProblems` names the adapters that changed.
- **The device list:** one `{type: 'net', mac, adapter: {ip}}` per adapter (devices.md "net" already takes `mac`). With
  4 adapters, 16 disks and the other six transports, a machine uses 26 of the core's 32. No core change and no ABI
  change.
- **Each adapter's gateway has its own addresses:** MAC `02:77:65:62:70:6<n>`, IPv4 `169.254.0.<n+1>` and the IPv6
  link-local from that MAC (web/gateway.ts `GatewayOptions` already takes `mac` and `ip`). tailcat's IPv4 lease is
  `192.0.0.<n+2>`. It is local, because the client translates it to the tunnel's IPv6, and 192.0.0.2 through
  192.0.0.5 stay inside the /29 it comes from. A tailnet's addresses are distinct already.
- **Default routes:** the page knows every adapter's state and picks the **primary**: the first adapter, in order,
  whose connection reaches the internet (a tailnet with an exit node in use, or tailcat going online through a
  server). Only the primary's gateway sends the default route (option 121's `0.0.0.0/0`; a router advertisement
  lifetime above 0). The others send their network's routes only:
  - a tailnet: 100.64.0.0/10 and the peers' routes in option 121, and fd7a:115c:a1e0::/48 as a router
    advertisement's Route Information option, with router lifetime 0;
  - tailcat: only serving, today's lease without resolvers.

  When the primary loses the internet, the next one becomes primary. Its router advertisement goes out at once; the
  IPv4 route moves at the lease's renewal, so the gateway's lease time drops to what a takeover should cost (L2
  measures it against networkd). This works on any guest, with no guest configuration: Debian's
  `network.network.card` credential already matches `e*`.
- **DNS:** each lease carries its own connection's resolvers and domains. systemd-resolved keeps them per link, so
  MagicDNS names go to the tailnet's adapter and the rest go to the primary's resolvers. A guest without
  systemd-resolved gets every adapter's resolvers in one list (a loose end, not a goal).

## 5. Snapshots, definitions, duplication

- **Snapshots** pin the adapters, which are in the shape, and not the connections (like USB devices). A restore keeps
  the machine's current attachments, and the restored guest renews its leases.
- **A machine's definition** exports its adapters (MACs) and not its connections, which hold secrets. An imported
  machine's adapters come detached.
- **Duplicate** copies the adapters with new MACs and no connections: one connection can't be attached to two
  machines that run together.

## 6. What changes

- web/app/store.ts: `connections`, the migration (§2.2), the notes `net-who`, `net-held` and `net-release`.
- web/app/shape.ts: `adapters`, the hash kept for the old shape, and `slots`.
- web/app/network.ts: one `Network` per adapter, connections, and the in-memory state store for ephemeral ones.
- web/tailscale-state.ts and web/tailscale.ts: a prefix per connection, and a store that never touches IndexedDB.
- web/tailcat.ts: an identity per connection (`forgetTailcatIdentity` takes one), and a fresh one for an ephemeral
  connection.
- web/gateway.ts: route options (default or a list) and the router advertisement's Route Information option, chosen
  by the page while running.
- web/app/worker.ts and protocol.ts: a port per adapter, plus a message that changes an adapter's routes.
- The Svelte parts: the Network tab, Connections, the wizard's first step and "Keep this connection", and the menu's
  sections.
- net/ts: none expected. `persist` is already a prefix, and an ephemeral node is already a flag (`control.rs`
  `ephemeral`).
- docs: frontend.md "Network" and "The Machines page", devices.md "net" (the gateway's options), tailnet.md "The kept
  node", and machines.md §10's pointer.
- No step count moves (the tests' guests keep their devices).

## 7. Loops

One slice, one commit, a short report each. `scripts/ci.sh` runs at each loop, `scripts/ci-machines.sh` from L1, and
`scripts/ci-net.sh` at L2 and L4.

- **L0, the model:** connection records, the migration (planted: a kept node's prefix rewritten, so the node logs in
  again), locks and their notes between two tabs, and the in-memory store. DOM-free and unit-tested. No UI.
- **L1, several adapters:** the shape (old hashes unchanged; planted: a MAC left out of the hash), slots, a port per
  adapter, and the gateway's addresses per adapter. Test: Debian with three adapters on the echo backend, each
  pinging through its own gateway.
- **L2, routes:** the primary, the routes-only leases and the takeover. Tests:
  - two echo backends where only one reaches "the internet": the guest's default route goes through it;
  - the primary dropped: the default route moves, and the time that takes is measured;
  - with headscale: a tailnet without an exit node next to tailcat through a server, where the guest reaches the
    tailnet's peer and the internet at once.
- **L3, the page:** the Network tab, Connections, the wizard with New connection… and Keep, the menu's sections and
  the holder's offer. Page tests:
  - a new machine connected in one wizard;
  - a connection moved between two machines;
  - one held by another tab;
  - an ephemeral one detached after a reload;
  - tailcat's kept address over a reload.
- **L4, exit:** docs, the backlog and PLAN.md, plus `scripts/ci-debian.sh` and `scripts/ci-net.sh` in the dev VM
  (the headscale rig is Podman's).

A cloud session can do L0, L1 and L3 (its tests on the echo backend and tailcat's test relay). L2's headscale test and
the exit's network suite are the dev VM's (cloud.md).

## 8. Open points

- **Ephemeral connections are the page's that made them.** The user put it as "until the browser closes"; sharing one
  across tabs would mean storing it somewhere, which is what ephemeral rules out. If two tabs should share one, it has
  to be in `sessionStorage`, and that is per tab too.
- **The takeover's IPv4 delay** depends on the lease time and networkd's renewal. If L2 finds it too slow, the
  gateway can force a renew (DHCP FORCERENEW, which networkd ignores without authentication) or flap the link (the
  device's link is always up today: devices.md "net"). Measure first.
- **p2p rooms** join as a third kind. A room's node has one identity across rooms (networking-p2p.md §2), which
  becomes one identity per connection here, like tailcat's.
