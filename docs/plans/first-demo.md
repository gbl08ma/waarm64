# The first demo: a machine that works with one click

**Status:** proposed 2026-11-18, not started (no kickoff yet). It brings together three items that were already
proposed: the preloaded image and snapshot (PLAN.md "Proposed"), a catalog of hosted images (machines.md §10), and the
public demo that resumes instead of booting (backlog.md "Remote disks"). It adds a fourth, a network that works out of
the box, which means **reopening a decision** (§3). How we compare with the other in-browser machines is
[../comparison.md](../comparison.md).

## 1. Why

Measured against the other systems, waarm64 is ahead on the CPU (about twice unkernel's speed in the user's
2026-11-18 test, with a stock kernel), on devices and graphics, and on what you can bring in and take out. It is behind
on the first minute. Today the deployed page opens on an idle machine that asks for a disk image. The Desktop Demo
exists, but it's a ~600 MB first boot of about 65 s, and its guest can't reach the internet unless you bring a
tailnet, a local helper or a room. unkernel's demo boots a small Alpine to a shell prompt on its own and already has a
connection (Wisp), so `apk add python3 htop` works from the first prompt. v86's demos have worked this way for years.

The bar for this track: **a visitor clicks once and gets a shell within seconds, and `apk add` (or the demo's
equivalent) works with nothing configured.** At least one demo in the store must meet it.

## 2. What the visitor sees (target)

1. `vm.tny.im` (or `vm.tny.im/#demo/<id>`) opens on the **demo store**. Per the decision of 2026-10-23
   (backlog.md), the page first says what the project is, that it needs a capable computer, and how many MB the
   download is. Nothing is fetched before the click.
2. One click on **Alpine (terminal)** downloads a small snapshot (budget: ≤ 30 MB on the wire) and the first pieces of
   a chunked disk, resumes, and shows a `#` prompt already logged in. The budget is ≤ 5 s from the click to the prompt
   on a good connection with a cold cache. Nothing boots: it's a resume.
3. The machine has a network adapter on the **demo's connection** (a Wisp server, §3). `apk add python3` works,
   `pip install` works, `curl https://…` works.
4. The visitor can **keep** the machine (it becomes an ordinary stored machine on the Home page, with its overlay and a
   snapshot), or close the tab and lose nothing they cared about. Until they keep it, the demo machine is the tab's
   and is ephemeral.
5. Every other demo in the store works the same way, with its own size shown on its card: the desktop (Arch, sway,
   Firefox), a 3D one (glmark2/vkcube/a game on virgl or Venus), Debian, and later others.

## 3. A network that works out of the box (the decision to reopen)

**What binds today:** plans/networking.md §1, "No v86 compatibility": v86's relay, Wisp and `fetch` adapters were
dropped because the `fetch` adapter breaks on CORS and because "the relay and Wisp adapters need someone to run a
server". plans/networking-local.md §1 repeats "Not WebSocket relays or Wisp" and "the user won't operate an open
proxy". Changing either is the user's call. The user's message of 2026-11-18 is the reason to reopen them: a first demo
whose network works out of the box needs a server somebody runs.

**Wisp** (Mercury Workshop's protocol, also used by v86 and unkernel) multiplexes TCP and UDP *streams* over one
WebSocket. It doesn't carry packets. So our guest's packets need a **TCP/IP endpoint in the page**: something that
terminates the guest's TCP connections, its UDP and its DNS at the gateway, and opens one Wisp stream for each. Our
gateway (`web/gateway.ts`) today does ARP, DHCP, DHCPv6 and NDP and forwards IP packets to a backend that has its own
IP. Nothing in it terminates TCP.

The options, with a recommendation for each:

- **What the others do** (2026-11-18, [../comparison.md](../comparison.md) §6): both v86 and unkernel terminate the
  guest's TCP in a hand-written JS stack. unkernel's `js/core/net.ts` is ~530 lines (MIT): ARP, DHCP, DNS for A
  records, and TCP with MSS and window scaling, a 1–8 s RTO, go-back-N and zero-window probes. Its Wisp client
  (`net-wisp.ts`) speaks Wisp v1, TCP only, with CONTINUE credits. v86's `fake_network.js` (BSD-2) sends one chunk at
  a time, and we saw no retransmission or window there. Neither forwards the guest's UDP, and neither has IPv6.
- **The stack.** (a) **smoltcp** in Rust wasm (0BSD, mature, no_std, used by many userspace VPNs), a new
  dependency, which needs the user's OK; (b) port unkernel's `net.ts` or v86's stack (MIT and BSD-2: porting is
  allowed with an attribution row): small, but a minimal TCP; (c) write our own (no). **Recommended: (a).** It's
  the sans-I/O shape `net/ts` already has, and it fits in the same worker. Its TCP is fuller (SACK-less, but
  correct), and it does IPv6 for later.
- **DNS: unkernel's trick, taken.** Wisp has no DNS of its own, and its CONNECT takes a *hostname*. So the gateway
  answers the guest's A queries with fake addresses from a reserved range (unkernel uses 198.18.0.0/15; our echo
  backend already leases from 198.18.0.x, so pick a range that doesn't collide). A TCP connect to one of those
  addresses becomes a Wisp CONNECT to the name, and the server resolves it. That also fits a Worker (`connect()`
  takes a hostname) and an allowlist by name. Literal addresses pass through when the server allows them. Other
  record types (AAAA, TXT, MX) get an empty answer, or DoH if something needs them. `net/ts`'s `dns.rs` already
  parses and builds messages.
- **The server, and who runs it.** This is the user's decision. (a) **Our own Wisp server on a Cloudflare Worker**
  (the user already deploys two Workers; `cloudflare:sockets` `connect()` opens outbound TCP), **restricted to a
  destination allowlist** (the demos' package mirrors, PyPI, npm, crates.io, GitHub's release hosts, a few test hosts)
  and to ports 80 and 443, with a per-IP rate and byte budget. That makes it a package proxy for the demos, not an open
  proxy. Workers have limits: no UDP (so DNS goes over DoH), and outbound sockets can't reach some destinations,
  Cloudflare's own addresses among them (to verify: §6). A `wisp-server-workers` exists (its license is
  unverified), but the server side is small enough to write: a WebSocket, the framing, CONNECT, DATA, CONTINUE and
  CLOSE. (b) A Wisp server on a VPS, with the same allowlist. The reference servers are copyleft: wisp-js is LGPL-3.0
  or AGPL-3.0 (its README and org listing disagree), wisp-server-python AGPL-3.0, epoxy-server reported AGPL. Running
  one unmodified as a service is fine, copying from it is not (CLAUDE.md "Licensing"), and it's one more thing to
  operate. (c) A third party's public endpoint (`wisp.mercurywork.shop`, which v86 presets; `anura.pro`), or
  unkernel's `wisp.pi0.io`, which only accepts known origins: no. That means their terms (none published), their
  logs and their uptime. **Recommended: (a), with the
  adapter speaking plain Wisp to any URL**, so a user can point it at their own server (wisp-server-python,
  epoxy-server, a `wisp-js` server) for unrestricted access.
- **Where it sits in our model.** A new connection kind, `wisp` (adapters.md §1 rule 2), with a URL. The demo's
  definition attaches its adapter to a built-in "Demo network" connection. A stored machine can use either the demo
  connection or one the user makes. It's the primary adapter like any other. IPv6: none at first. The gateway then
  offers no default IPv6 route on it, as with any backend that can't route IPv6 (adapters.md §4).
- **Inbound traffic:** none. Wisp has no listening sockets, so for that you use rooms, tailnets and the local helper,
  which stay what they are.

## 4. Demo store, templates and the definition format

The building block is the **machine definition** (machines.md §6). A demo is a definition with a few more fields,
published next to its disk and snapshot:

```jsonc
{
  "format": "waarm64-machine", "version": N,
  "name": "Alpine (terminal)",
  "demo": {
    "id": "alpine-term",                    // #demo/alpine-term
    "summary": "...", "thumbnail": "thumb.webp",
    "download": 24000000,                   // what the card shows, checked at publish time
    "view": "serial",                       // or "screen": the view it opens on
    "snapshot": { "manifest": "snap/manifest.json", "id": "<content id>" },
    "network": "demo"                       // attach adapter 0 to the built-in Wisp connection
  },
  "disks": [ { "kind": "url", "url": "https://vmdisks.tny.im/alpine-term/manifest.json", "id": "<chunked id>", "readOnly": false } ]
}
```

- **The store** is one JSON file (`vmdisks.tny.im/store.json`) that holds its definitions inline: one request, and
  every card (name, summary, thumbnail, download size, what it needs: 3D, Vulkan, RAM) renders at once. A definition
  is a KB or two, so dozens of demos still make a small file. Its relative URLs (disks, snapshot, thumbnail) resolve
  against the store's URL, so a demo's files sit beside it. A standalone definition file is the same object on its
  own. Anyone can host either kind.
- **Links:** `#demo=<url>` (the URL percent-encoded) takes either kind of file. The file's `format` says which:
  `waarm64-store` or `waarm64-machine`. A store link can name one of its demos: `#demo=<url>&id=<id>` opens that
  demo's interstitial. Without an `id` it shows that store's cards. `#demo/<id>` is short for our own store's
  `<id>`. A demo's `id` is unique within its store (the publish step checks), and a link to an `id` the store no
  longer has opens the store's cards and says so. Anything not from our store gets a warning that it isn't ours
  before anything is fetched past the JSON.
- **The snapshot** is fetched whole, chunked like a disk image, into the same expiring Storage Bucket as the disk's
  blocks (backlog.md "A public demo…"). It must be a **template** (`tools/snapshot-template.ts`: the guest agent
  renews entropy, the machine id and the SSH keys at the restore), and it pins its disk by the chunked image's `id`,
  never by its URL.
- **Ephemeral until kept:** the demo runs as the page's transient machine (no record), with an overlay in memory or in
  the expiring bucket. **Keep this machine** writes a record, moves the overlay into OPFS and keeps a snapshot.
- **Templates for new machines** (the user's own backlog item): the same definitions, minus `demo.snapshot`, offered
  under **New machine** as starting points ("Alpine", "Debian", "Arch desktop"), so a new machine needs no disk image
  of the user's own.

## 5. The guests

- **Alpine (terminal), the one that must match unkernel.** Alpine 3.24 aarch64 from release media, as `images/alpine`
  is, but made to be used: `apk` repositories set to the CDN, `openrc` with networking (udhcpc on `eth0`), the guest
  agent, a motd that says what to try, root logged in on the serial console, `apk` cache off. Kernel: Alpine's
  `linux-virt` (already booted by the tests) direct, or through UEFI from a published `alpine-uefi` image. Direct is
  smaller and faster, and a snapshot hides the boot anyway. 256–512 MiB of RAM, so the snapshot's RAM is small (SNAPZ
  compresses zero and free pages away). The disk is a chunked image of ~100–200 MB, of which the resume touches little.
  Measure: the snapshot's size on the wire, click to prompt, `apk add python3` time.
  What unkernel's demo does that this one should match: a shell's command-not-found hook that installs the package
  for a missing command and runs it (BusyBox ash has no hook, so use a small wrapper; only `main` enabled at first and
  `community` on demand, which unkernel says makes `apk` ~4× faster), and changes that survive a reload. For us
  that's "Keep this machine", or keeping a demo's overlay until the visitor resets it: a choice for the kickoff.
- **Buildroot**, as a fallback if Alpine's snapshot can't meet the budget: tiny, but no package manager. That makes it
  a worse match for "install as you type". Kept as a "boots in under a second" demo, not as the networked one.
- **The desktop (Arch, sway, Firefox), resumed at the desktop.** The existing Desktop Demo, as a snapshot rather than a
  65 s boot, with Firefox browsing over the demo network (HTTP and HTTPS are all it needs).
- **3D:** the desktop with glmark2 / vkcube / a small game preinstalled, so that "fully compliant OpenGL ES 3.0" is
  something a visitor sees, not something they read.

## 6. Loops (draft, for a kickoff)

0. **Measure the gap.** unkernel's and v86's demos against ours, by hand and in headless Chromium: time to prompt,
   bytes on the wire, `apk add python3` time, peak memory. These numbers feed [../comparison.md](../comparison.md) §3.
   No code.
1. **Wisp adapter, Node first.** smoltcp in a wasm module beside the gateway; TCP, UDP and DNS to Wisp streams; a
   local Wisp server in tests (a fixture we write in Node, to spec); `tests/` at the gateway level (a guest's TCP
   connect, a transfer, a close, a reset, a DNS lookup) and an Alpine boot that runs `apk add` against a local
   mirror.
2. **The Worker.** The Wisp server on Cloudflare with the allowlist, the budgets and logs that keep no addresses.
   Check which destinations `connect()` refuses (the mirrors' CDNs). Deploy only on the user's word.
3. **The connection kind on the page.** `wisp` in the Network tab and the menu, the built-in "Demo network", words
   in the catalog, the Debian network tests (`scripts/ci-net.sh`) extended to it.
4. **The demo guest.** `images/build.sh alpine-demo`, its template snapshot, chunked and traced from the resume,
   with numbers.
5. **The store and the definition's `demo` fields.** The interstitial, the cards, `#demo/<id>`, ephemeral until kept,
   Keep this machine. `scripts/ci-machines.sh` and `ci-debian.sh`.
6. **The desktop demo as a snapshot**, and the 3D one.
7. **Templates under New machine.**
8. **Review, numbers, the comparison's numbers filled in, the docs.**

**Needs the user's OK:** reopening plans/networking.md §1 and plans/networking-local.md §1 (Wisp; who runs the
server; the allowlist's policy); smoltcp as a dependency; the definition format's new version; a new guest image and
its hosting on vmdisks.tny.im; any deploy.

## 7. Open questions

- Does the demo's Wisp server keep an allowlist for good, or open up for kept machines (no, by default: an open proxy
  is what was ruled out)?
- Should the demo network also be offered to the user's own machines by default (a new machine's first adapter), or
  only to demos?
- An `ip`-level alternative to Wisp: a WebSocket that carries packets to a server-side NAT (what the local helper is,
  but hosted). It would be simpler for us (no stack in the page), but it's an open proxy by construction. Ruled out
  unless the user wants it.
- The snapshot of a template that has a live Wisp connection: the guest's TCP connections don't survive a resume (the
  page's stack is new). That's fine for a demo snapshotted at an idle prompt. A kept machine's snapshot behaves like
  one on any other backend.
