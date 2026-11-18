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
3. The machine has a network adapter on the **demo network** (a hosted helper with an allowlist, §3). `apk add python3` works,
   `pip install` works, `curl https://…` works.
4. **The demo is an ordinary stored machine from the click on** (the user, 2026-11-18): choosing a demo makes a
   machine from its definition, which is listed on the Home page with every setting where it always is. Its remote
   disk's overlay lives in this browser (OPFS), so **changes survive a reload by default**. The visitor deletes the
   machine like any other. Not the page's transient machine: its settings aren't all shown the same way, which would
   make the emulator look more limited than it is.
5. Every other demo in the store works the same way, with its own size shown on its card: the desktop (Arch, sway,
   Firefox), a 3D one (glmark2/vkcube/a game on virgl or Venus), Debian, and later others.

## 3. A network that works out of the box

**Reopened (the user, 2026-11-18).** plans/networking.md §1 ("No v86 compatibility") and plans/networking-local.md
§1 ("Not WebSocket relays or Wisp") no longer rule out a hosted way out. The user's caveat: if we run our own
server anyway, Wisp has no claim on us. Our own protocol, or **the local helper deployed on a server with a
destination allowlist**, may be simpler. The other rule stands: no open proxy, so whatever we host is restricted to a
list of destinations.

### 3.1 The two shapes

| | **A. A hosted helper** (frames) | **B. A stream proxy** (Wisp or our own, e.g. on a Worker) |
|---|---|---|
| What crosses the WebSocket | the guest's Ethernet frames, as with the local helper today | TCP (and maybe UDP) streams opened by name |
| Who runs TCP/IP | the server (gvisor-tap-vsock's netstack, in waarm64-net) | **the page**: a new TCP/IP endpoint at the gateway (smoltcp, or a port of unkernel's ~530-line `net.ts`) |
| New page code | almost none: a `local` connection whose URL is `wss://` on a host of ours instead of loopback (no Local Network Access prompt) | the stack, DNS with fake addresses, the stream client, a new connection kind |
| What the guest gets | everything the local helper gives: TCP, UDP (DNS, NTP, QUIC), ICMP, IPv6 where the server has it, a 1500 MTU | TCP only (UDP only with Wisp v2's extension where the server allows it), IPv4, DNS answered with fake addresses |
| The allowlist | at the server's dial (below, §3.2): addresses from its own DNS, checked again against the TLS SNI or HTTP Host | by name in each CONNECT: trivial |
| Hosting | a server we run (any small VPS, or the host behind static.gbl08ma.com), behind TLS | a Cloudflare Worker (or Durable Object), or the same server |
| Interop | ours only | Wisp framing lets users point it at any Wisp server for unrestricted access |

**Recommended: A.** It reuses what exists, gives the guest a real network (UDP and IPv6 too), and needs neither a
TCP stack in the page nor smoltcp as a dependency. What it costs is a server to run, and the allowlist's work in the
helper. B stays possible later as a "bring your own Wisp server" connection, for users who want their own unrestricted
way out without installing the local helper.

### 3.2 A: the helper on a server

**A fork, not a mode** (the user, 2026-11-18). waarm64-net stays the small local helper that a user can read and
trust on their own computer. The public helper is a **fork in a project of its own**, which takes the parts it shares
(the WebSocket framing and protocol, the gvisor-tap-vsock glue) and adds what only a server needs. Where it lives: a
new repository (`waarm64-demonet`, say) is **recommended** over a directory in this one. It's Go, released and
deployed on its own schedule to a server, with its own README, THIRD_PARTY and tests, like waarm64-net. This repo's
tests pin a commit of it the way they pin the local helper's. The user's call.

What it has that the local helper hasn't:
- **TLS and the origin:** behind a reverse proxy (Caddy) on `wss://`. Origin `https://vm.tny.im` only. No pairing
  token: the demo's link is public, so the token proves nothing. Instead each source IP gets a budget (connections,
  bytes a day, concurrent guests).
- **One network per WebSocket, not one per helper.** The local helper puts every page on one switch. Strangers' guests
  must not see each other, so each connection gets its own gateway and its own DHCP pool, or guest-to-guest frames are
  dropped. The library supports several virtual networks (*to check* at what cost each).
- **The allowlist, done at three points:**
  1. **DNS:** the helper's resolver answers only names on the list (and their CNAME chains), and remembers, per
     connection, each address it gave out with its name and TTL.
  2. **The dial:** gvisor-tap-vsock's TCP and UDP forwarders dial through Go's `net.Dialer`. Ours refuses an address
     this connection didn't get from (1), or a port not on the list (80 and 443, 53 to the helper itself, 123).
  3. **The first bytes:** an allowed address is often a CDN's (Fastly serves both PyPI and Alpine's CDN, and thousands
     of other sites), so the dial alone would let a guest reach every site on that CDN. The forwarder reads the TLS
     ClientHello's SNI, or the HTTP request's Host, before it dials, and checks it against the list. ECH hides the
     real name behind a public one, which isn't on the list, so it's refused. QUIC: refuse UDP 443, so clients fall
     back to TCP.
  
  This is the "challenge" the user expected. It's about two hundred lines of Go around the library's forwarders, with
  tests against a fake upstream.
- **The configuration is one file the owner edits** (the user, 2026-11-18: "easy to configure by me"), reloaded on
  change or `SIGHUP`, and checked at load (a bad file keeps the old one and says why). **TOML recommended** over JSON
  because it allows comments, which a list like this needs ("why is this host here"), with one small Go library
  (BurntSushi/toml, MIT). A sketch:

  ```toml
  [server]
  origins = ["https://vm.tny.im"]

  [budget]                       # per source IP
  guests = 2                     # at once
  bytes_per_day = "500MB"
  connections_per_minute = 120

  [[allow]]                      # a name and everything under it
  name = "dl-cdn.alpinelinux.org"
  ports = [443, 80]
  note = "Alpine packages (the Alpine demo)"

  [[allow]]
  name = "*.pythonhosted.org"    # a wildcard matches one or more labels, never the bare suffix
  ports = [443]
  note = "pip downloads"
  ```

  **Strict by construction:** nothing is allowed unless a rule names it. A rule is a hostname or a `*.` suffix (no
  regex) with explicit ports. No rule takes an address or a CIDR, so a guest can't reach a literal IP, a private
  range or the server's own services. Answers that resolve to private, loopback or link-local addresses are dropped
  whatever the name. UDP goes only to the helper's own DNS and NTP. `helper --check config.toml` prints what each
  rule allows, and resolves each name once, so the owner sees what a change opens before it's live.
- **What the first list holds:** the demos' package hosts (Alpine's CDN, PyPI and files.pythonhosted.org, Debian's,
  Arch's mirror, GitHub's release hosts, crates.io's), a time host, and one or two test sites so `curl` has something
  to show. The owner edits it.
- **Logs:** counts per destination and budget refusals, no addresses kept past the budget's day.
- **Cost:** bandwidth. A demo visitor's `apk add python3` is about 20 MB. One small VPS with a few TB a month covers a
  launch.

### 3.3 B on Cloudflare's free tier, for the record

The user asked whether a Wisp proxy (or our own) fits the Workers free tier. From Cloudflare's docs (2026-11-18):
- **A plain Worker:** 100,000 requests a day, but **10 ms of CPU per request** on the free plan. Cloudflare's post on
  WebSockets in Workers ([2021, updated 2022](https://blog.cloudflare.com/introducing-websockets-in-workers/#pricing-considerations))
  says a WebSocket "incur[s] a request charge when the connection is first established", then the Worker's duration
  while it's active, and "there is no per-message fee". So **a whole connection is one request**: the 100,000 a day
  is no constraint. By the same reading, though, the 10 ms of CPU is the whole connection's, since there's no
  per-message reset outside Durable Objects. A proxy copies every message in JS, so 10 ms runs out after a few MB at
  best, mid-download. (The post predates today's Standard pricing; the docs don't contradict this reading, but a
  `wrangler tail` test would settle it.) On the paid plan a request gets up to 5 minutes of CPU, billed per ms, which
  is plenty. **On the free plan, a plain Worker doesn't fit a proxy.**
- **A Durable Object** (on the free plan since the SQLite backend): each incoming WebSocket message resets the CPU
  budget to 30 s, and incoming messages bill at 20:1 (outgoing ones are free, so downloads cost no requests). But an
  open TCP socket keeps the object awake, and the free plan's **13,000 GB-s a day at 128 MB is ~29 object-hours a day**.
  That's one object serving everyone around the clock (one location, one thread), or ~29 visitor-hours of
  per-visitor objects. A launch day could pass that. On the $5 paid plan it doesn't matter.
- **What blocks it regardless of the plan:** `connect()` **refuses Cloudflare's own address ranges**, so any
  destination behind Cloudflare is unreachable (npm's registry among them). The docs also say "to connect to port 80
  or 443 to make HTTP requests, use `fetch`". Whether raw TCP to 443 with the guest's own TLS works isn't stated
  (`wisp-server-workers` existing suggests it does: *to test*). No UDP at all.
- **And the terms:** proxying arbitrary visitors' traffic through an account is the kind of use that gets an account
  looked at. With an allowlist it's narrower, but it should be read against Cloudflare's current terms before relying
  on it.

So B on a free Worker might work for a demo's `apk add`, with unknowns and a hard hole (Cloudflare-hosted
destinations). A on a small server has no unknowns, only work.

### 3.4 If B is built: what the others do, and the DNS

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

### 3.5 Either way

- **Where it sits in our model:** A is a `local` connection with a hosted URL. The demo's definition attaches adapter 0 to a
  built-in "Demo network" connection. B would be a new connection kind, `wisp`, with a URL.
- **Inbound traffic:** none. A public helper forwards no ports, and Wisp has no listening sockets. Rooms, tailnets and
  the local helper stay the way in.
- **Snapshots:** the guest's connections don't survive a resume (the server's side is gone), which is fine for a demo
  snapshotted at an idle prompt. A DHCP lease taken before the snapshot must still be valid, or renewed at the
  resume: with A, each connection's network should hand out the same address to the same MAC (the demo's template
  MAC), so the snapshot's lease stays right.

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
    "network": "demo"                       // attach adapter 0 to the built-in demo network
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
- **The snapshot** is fetched whole, chunked like a disk image, and becomes the new machine's first kept snapshot
  (below). It must be a **template** (`tools/snapshot-template.ts`: the guest agent
  renews entropy, the machine id and the SSH keys at the restore), and it pins its disk by the chunked image's `id`,
  never by its URL.
- **A demo makes a machine** (the user, 2026-11-18): choosing one writes a machine record from its definition, as
  Import a definition does (machines.md §6), with an overlay for the remote disk in OPFS, and **the demo's `id` stored
  on the record** (`fromDemo: {store, id}`). Its first start restores the demo's snapshot onto that fresh overlay
  (generation 0, so the pins match and nothing forks), and the snapshot is kept on the machine as its first snapshot.
  "Back to the demo's start" is then an ordinary Restore. Later starts are the machine's own: its overlay, its
  Suspend, its snapshots.
- **Started before:** the store looks for machines whose `fromDemo` matches the card. If one exists, the click asks:
  **Open my machine** (the default) or **Start a fresh copy** (another machine, named with a suffix), and says when the
  existing one was last used and that it has changes. The card also marks demos the visitor already has.
- **Versions are ids:** a demo that changes (a new image, a new snapshot) is published under a new `id`, and the old
  one leaves the store, or stays marked as old. A machine made from an old demo keeps working, because its disk's
  pieces and its snapshot are addressed by content. Nobody is held on an old version by the "started before" check,
  because the new id doesn't match. The store can name an id's successor (`replaces: "<old id>"`), so the card says
  "you have an older version of this demo".
- **Storage:** a demo machine's disk blocks go to the OPFS store of a URL disk, as any machine's do, not the
  expiring bucket. The bucket is right for a one-off visit, but a demo is now a machine the visitor keeps until they
  delete it.
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
  `community` on demand, which unkernel says makes `apk` ~4× faster), and changes that survive a reload, which a stored machine gives us for free (§4).
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
1. **The public helper**, a fork of waarm64-net in a project of its own (§3.2): a network per WebSocket, the
   budgets, the TOML configuration with `--check`, and the allowlist at the resolver, the dial and the first bytes, tested against fake upstreams (an allowed name,
   a name off the list, an allowed CDN address reached with another SNI or Host, ECH, UDP 443, a literal address).
2. **Hosting it:** on the user's server, behind TLS, with the list the user approves; logs without addresses. Deploy only on the user's word.
3. **The page:** a built-in "Demo network" (a `local` connection with that URL, no pairing, no Local Network Access
   prompt), its words in the catalog, and `scripts/ci-net.sh` against a public-mode helper on loopback.
4. **The demo guest.** `images/build.sh alpine-demo`, its template snapshot, chunked and traced from the resume,
   with numbers.
5. **The store and the definition's `demo` fields.** The interstitial, the cards, `#demo/<id>`, a machine made from
   the definition with `fromDemo`, the first start's restore, "started before" and versions by id.
   `scripts/ci-machines.sh` and `ci-debian.sh`.
6. **The desktop demo as a snapshot**, and the 3D one.
7. **Templates under New machine.**
8. **Review, numbers, the comparison's numbers filled in, the docs.**

**Settled (the user, 2026-11-18):** the no-Wisp decision reopened; a demo makes a stored machine, with `fromDemo`
and versions by id; the public helper is a fork of its own, hosted on the user's server, configured from a file.
**Needs the user's OK:** A or B (§3.1, A recommended); the fork's repository (§3.2); TOML and its library; the
allowlist's contents; smoltcp as a
dependency, only if B is built; the decisions' text in plans/networking.md §1 and plans/networking-local.md §1; the definition format's new version; a new guest image and
its hosting on vmdisks.tny.im; any deploy.

## 7. Open questions

- Does the hosted helper keep an allowlist for good, or open up for kept machines? No, by default: an open proxy is
  what was ruled out.
- Should the demo network also be offered to the user's own machines by default (a new machine's first adapter), or
  only to demos?
- B's unknowns, if it's ever wanted: a test confirming that a plain Worker's 10 ms covers a WebSocket's whole life,
  and whether `connect()` to 443 passes the guest's own TLS (§3.3).
