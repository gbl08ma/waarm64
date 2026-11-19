# DEMO: the first demo — kickoff

**Status: confirmed by the user, 2026-11-18;** the track is open (PLAN.md). The plan and its reasoning are
[docs/plans/first-demo.md](docs/plans/first-demo.md); how we compare with the others is
[docs/comparison.md](docs/comparison.md).

The user's brief (2026-11-18), in their words:

> They have us beat in usability (their direct demo boots straight to a very light version of alpine, and they have a
> WISP connection set up by default, allowing alpine to install packages as the user types, `python`, `htop`, etc.).
> We might need to set up a WISP network adapter type after all, just so we can have a semi-working connection out of
> the box.

> downloadable machine templates and "demo store" (machine definitions would optionally include a link to a snapshot
> that the emulator knows to load when the demo starts). at least one of the demos has to be as plug-and-play as that
> of unkernel (probably a buildroot or alpine one, ideally with a network connection that "just works" out of the box

> they should survive a reload by default. [...] I vote for automatically creating a machine from the demo
> definition, when the user selects a demo. [...] The "demo store" should alert users when they're about to start a
> demo that they've already started before, and for which they already have a modified machine. [...] New and updated
> demo versions can just have new IDs, so users don't get stuck behind on a demo from years ago.

> I vote for forking the helper and making these changes on a separate project [...]. One of the goals of the helper
> is for it to be simple and auditable by users, and adding features to it that don't make sense for the local use
> case wouldn't help that aspect.

> A server of mine can host the helper, as long as the allowlist is sufficiently strict. It should be easy to
> configure by me (from e.g. a JSON or TOML file).

> the demo store should have its own URL (e.g. vm.tny.im/demos) and be a full-screen affair like the machines page
> (now known as Home). it should also be possible to open the demos page from yet another item, "Demos", in Home's
> sidebar, between Preferences and About.

> add a setting that allows for reaching arbitrary non-allowlisted destinations over a heavily throttled connection
> like JSLinux's VPN

On the plan's review (2026-11-18):

> I doubt that an alpine boot on a machine that had already been booted before will write that much to the disk.
> measure and only change anything in the implementation if it would allow for saving a significant portion of
> bandwidth.

> [the guest agent on Alpine is] something that's worth fixing anyway, even outside of a demo's context [...] we should
> probably stick to Alpine for the lighter demo, and Arch for the heavier desktop/graphics demos.

> [orphaned snapshots after a page update are] known, and accepted [...] it's probably worth spending the effort to
> automate the building of those snapshots such that, if we need to update the emulator's core, we can easily create
> and publish new snapshots under the demos' existing IDs

> maybe, at least for some demos, we should avoid trying to cache the whole disk (it'd go against the "30 MB budget"
> idea anyway), even with the knowledge that loading the disk remotely on every page open is much slower.

> that's why I asked for the demonet to be able to go entirely through a VPN or proxy, and for the throttling: so my
> IP addresses are not exposed directly to so much abuse. That proxying should therefore probably extend to
> allowlisted destinations too [...] even if not the throttling.

> I'm not sure logging will be of much use especially if a VPN is involved. [...] The logging then brings in the need
> for a privacy notice that I am not seeing in unkernel or v86, and could make it seem like we're going to be doing
> creepy things.

> I have no problems with the demo network being available to non-demo custom machines, and our demonet server will
> restrict requests to our sanctioned origins anyway.

> OK to have the first visit go straight to the store, and everything else except the logging/privacy notice. If
> Alpine can't meet that target we'll have to see what the numbers are, and probably go with Alpine anyway

## The goal

A visitor opens `vm.tny.im` (the first visit lands on the store) or `vm.tny.im/demos`, clicks **Alpine (terminal)**
once, and is at a logged-in `#` prompt within ~5 s of the click (cold cache, a good connection; ≤ 30 MB on the wire,
the page's own code included), where `apk add python3 htop` works and typing a missing command installs it. The demo
is an ordinary stored machine that survives a reload. Every other demo in the store works the same way. **The numbers
are a target, not a gate:** if Alpine misses them, the track measures by how much and ships Alpine anyway (we resume
kernel memory too, which unkernel's demo doesn't).

## Decisions taken (binding for the track; the user's, 2026-11-18)

**The network**
1. **The no-Wisp decision is reopened** (plans/networking.md §1, plans/networking-local.md §1): a hosted way out.
   Full speed only to an allowlist; anything else only through a throttled slow lane, off by default.
2. **The way out is a hosted helper:** Ethernet frames over a WebSocket to a server-side netstack, as with the local
   helper. No TCP stack in the page, no smoltcp, no Wisp for now (it stays a possible "bring your own server"
   connection later). **No Cloudflare Workers** for it.
3. **The hosted helper is a fork of waarm64-net in a new repository** (`github.com/gbl08ma/waarm64-demonet`, created
   empty by the user on 2026-11-18): Go, released and deployed on its own, its own README, THIRD_PARTY and tests.
   waarm64-net stays the small local helper. This repo's tests pin a commit of the fork, as they pin the local
   helper's. The fork's repository is private, so cloud sessions skip its tests and say so.
4. **It runs on the user's server,** configured from **one TOML file** (BurntSushi/toml) the user edits, reloaded on
   change, with a `--check` that prints what each rule opens. It accepts only our origins.
5. **The first allowlist is what the Alpine demo's `apk` needs:** `dl-cdn.alpinelinux.org`, port 443 only. A rule is
   a hostname (matching itself only) or a `*.` suffix (its subdomains), with explicit ports, never addresses. It's
   enforced at the resolver, the dial and the TLS SNI or HTTP Host. The SNI check is a filter, not a wall (domain
   fronting gets past it): what protects the user's addresses is decision 7. Every rule past the first is the
   user's call.
6. **The slow lane** (off by default): unlisted destinations on listed ports, throttled per source IP (IPv6 grouped
   by /64) and in total.
7. **Egress through a VPN or a proxy, for every lane, the allowlisted one included:** direct, SOCKS5
   (golang.org/x/net/proxy) or an in-process WireGuard tunnel (wireguard-go), chosen per lane (throttling stays the
   slow lane's alone). A lane whose egress is down refuses, never goes direct. At the dial, every lane refuses
   private, loopback, link-local, IPv4-mapped and NAT64 forms and the server's own addresses. **Both dependencies are
   OK'd for the fork.**
8. **No per-connection logs and no privacy notice** (the user, against the review's proposal): the helper keeps
   counters only (per destination, budget refusals), and nothing that names a visitor. Abuse lands on the VPN's
   addresses, not the user's.
9. **The protocol is `waarm64-demonet.v1`:** v1's frames as binary messages, control as JSON text messages (codes
   and numbers, never words), and close codes 4008–4011 (plans/first-demo.md §3.2).
10. **The demo network is a connection kind of its own, `demo`, open to any machine,** demo or not, and to many at
    once (a socket each, no Web Lock). This changes adapters.md §1's rules 2 ("no default connection") and 4 (one
    machine per connection) for that kind, and decisions.md's Network row, in the loop that builds it.

**The demos**
11. **A demo makes a stored machine** from its definition, with its remote disk's overlay in OPFS (it survives a
    reload) and `fromDemo: {store, id}` on the record. Its first start restores the demo's template snapshot (a fork
    onto the fresh overlay, which is what a restore onto another overlay is) and keeps it as the machine's first
    snapshot. Not the page's transient machine.
12. **A demo's base disk is read remotely, never copied whole** (at least for the light demos): the blocks it reads
    go into the expiring disk cache as any URL disk's do, and only the overlay is kept for good. So a demo machine
    needs vmdisks.tny.im to run, and shows "this demo's files are gone" (a manifest's 404) rather than I/O errors.
13. **"Started before":** the store asks **Open my machine** (the default) or **Start a fresh copy**. **New versions
    get new ids** (`replaces` names the old one), but **a rebuild for a new core keeps the id:** when only the
    emulator changed (the snapshot's format or shape), the demo's snapshot is re-made and re-published under its
    existing id, by an automated build.
14. **Alpine for the light demo, Arch for the desktop and graphics demos.** Alpine boots through UEFI (a stored
    machine has no direct kernel boot: decisions.md "Booting users' images"). **The guest agent comes to Alpine
    (OpenRC) for every Alpine user, not only the demo:** started by an OpenRC service, with udhcpc in its lease
    renewal.
15. **The store is one JSON file holding its definitions inline,** whose relative URLs resolve against it, in the
    real definition format (`web/app/definitions.ts`: `type`, `machine`, attachments with `identity` and `serial`) at
    a new version. Links `?id=<id>` and `?store=<url>[&id=<id>]` also take a single definition's URL. Other stores'
    definitions are as trusted as an imported definition is.
16. **The store is a full-screen page of its own** (like Home) at `vm.tny.im/demos` (`demos.html` beside
    `index.html`, served by the assets-only Worker's `auto-trailing-slash`) and at `#demos`. Home's sidebar gets
    **Demos** between Preferences and About, which opens it. **The first visit (no machines yet) opens the store.**
    A Worker script for path-style routes only later, if ever.
17. **Every demo is hosted on vmdisks.tny.im** (the assets-only Worker): 2 MiB pieces in one `pieces/` directory
    shared by every image and version, under ~15,000 distinct files in all.
18. **Only what measures as worth it:** the template's overlay blocks (what a boot of an already-booted Alpine writes)
    are measured first, and the snapshot's disk side is changed only if that would save a significant part of the
    download.

## Loops

One slice, one commit and a short report per loop (CLAUDE.md "How a track runs"). The page's demos (loops 1–6) and
the fork (loops 7–10) are independent; the fork's loops can run beside them.

0. **Measure the gap** (no code): unkernel's, v86's and our current page in headless Chromium (time to prompt, bytes
   on the wire, `apk add python3`, peak memory), into a `bench/demo/REPORT.md` with its JSON, and the numbers into
   comparison.md §3 where the rows allow.
1. **The spike: an Alpine template restored in a fresh profile, offline, timed.** An Alpine UEFI machine, a template
   snapshot, hosted locally under its final path layout, restored in a fresh Chromium profile with no network:
   click to prompt, bytes (the page, the snapshot, the disk's reads, the template's overlay blocks: decision 18), the
   JIT's cold start. Settles a chunked image's identity by its content `id` (machines.md §10), so a template's pins
   match wherever it's hosted, and the pins mapped by slot onto the new machine's overlays.
2. **The guest agent on Alpine** (decision 14): an OpenRC service started from fw_cfg (or the image), udhcpc in
   `agent/src/lease.rs`, the clock set at a restore, tested with a template restored with an old clock (`apk` over
   TLS works after it).
3. **The Alpine demo guest:** `images/build.sh alpine-demo` (Alpine 3.24, UEFI, `main` with `community` on demand,
   the command-not-found wrapper, the agent, root logged in on the serial console, a motd that says what the network
   reaches). Its template snapshot, chunked into the shared `pieces/`, traced from the resume. Numbers.
4. **Definitions and the store's data:** the definition format's new version (a reader of both) with `demo` (id,
   summary, thumbnail, download, view, snapshot, network) and `fromDemo` on the record; `store.json`; a publish tool
   (ids unique, sizes checked, distinct files counted against vmdisks.tny.im's budget, each snapshot's core version
   and shape hash checked against the build being deployed).
5. **The automated demo build:** one command that rebuilds each demo's template from a given core and re-publishes
   it under its id (decision 13); `scripts/ci-machines.sh` makes a template from the local build and restores it.
6. **The store's page:** `demos.html` and `#demos`, the first visit, the interstitial (what the project is, what it
   needs, the download, a browser check before any download: Chromium, SharedArrayBuffer, OPFS, WebGL2 or WebGPU for
   3D, memory), the cards (keyboard, alt text, their text as data), `?id=` and `?store=`, Home's Demos item, a
   machine made from the definition, the first start's restore, "started before", versions by id, and the failure
   paths (the files gone, vmdisks.tny.im down, the snapshot's download cut off, the storage full, another machine in
   the tab). `scripts/ci-machines.sh` and `scripts/ci-debian.sh`.
7. **The fork.** `github.com/gbl08ma/waarm64-demonet` exists and is **empty** (the user, 2026-11-18). The loop sets
   it up in the dev VM: clone waarm64-net's history into `../waarm64-demonet`, beside `../waarm64-net` (`git clone
   ../waarm64-net ../waarm64-demonet`, then point `origin` at the new repository and push `main`), so the fork keeps
   waarm64-net's history and authorship. Then rename the module and binary, write its own README, THIRD_PARTY.md and
   CLAUDE.md (what it is, that it is public-facing, its rules), and add `tests/waarm64-demonet.ts` here, pinning its
   commit as `tests/waarm64-net.ts` pins the helper's, with a `WAARM64_DEMONET_SRC=../waarm64-demonet` override
   (docs/devenv.md gets the checkout's line). From there: TLS behind a reverse proxy (the source address only from
   the trusted proxy's header), the origin, no token, a network per WebSocket (no guest sees another; a renewal from
   a MAC it never leased to is ACKed), per-IP budgets, the TOML file with reload and `--check`. Check early that
   wireguard-go's netstack and gvisor-tap-vsock's pinned gVisor agree on one version, and measure a network's cost
   per WebSocket (what 4009 "full" means).
8. **The allowlist and the egress:** the rules at the resolver (HTTPS/SVCB answered empty), the dial (the refused
   ranges of decision 7) and the first bytes, tested against fake upstreams (a listed name, an unlisted one, a
   listed CDN address with another SNI or Host, ECH, UDP 443, a literal address, a private answer); egress per lane
   (direct, SOCKS5, WireGuard), fail-closed.
9. **The control channel and close codes** (`waarm64-demonet.v1`), and `http://<gateway>/status`.
10. **The page's side of the demo network:** the `demo` connection kind (decision 10) with its rule changes in
    adapters.md and decisions.md, on a `wss://` URL with no pairing and no Local Network Access prompt; the control
    messages rendered from the catalog (the message bar for budgets, the Network status for the lane, refused
    destinations as a count); the helper unreachable or closing mid-run; `scripts/ci-net.sh` against a fork's build on
    loopback, pinned by commit.
11. **Review the fork:** an out-of-context review of the fork before it's public, and its fixes. **Hosting it** (the
    server: Caddy, the service, the TOML file's place, monitoring, how releases are built and installed) **is the
    user's own follow-up, outside the track** (the user, 2026-11-19): the fork's README says how to run it, nothing
    more.
12. **The desktop demo as a snapshot** (Arch, sway, Firefox, resumed at the desktop), and a 3D one (glmark2, vkcube or
    a small game on virgl or Venus). Its card says what its network reaches (one rule by default).
13. **Templates under New machine:** the same definitions without a snapshot.
14. **The slow lane** (decision 6), with throttling tests (the rate holds per IP and in total, under many
    connections). Off by default; after the store ships, since the goal doesn't need it.
15. **An out-of-context review of the page's demo code,** its fixes, the numbers, the comparison's numbers filled in,
    the docs.

## Needs the user's OK during the track

**The red lines** (the user, 2026-11-19: not expected to be crossed during the track; stop and ask):
- Each allowlist rule past `dl-cdn.alpinelinux.org`, and the slow lane's first numbers (rate, connections, total)
  before it's turned on.
- Every deploy: the fork on the user's server, vmdisks.tny.im, vm.tny.im.
- A new dependency beyond those decision 7 and decision 4 name.

**Engineering calls, made in the loops and listed in the handover** (the user, 2026-11-19):
- The definition format's new version and the machine record's `fromDemo` field: designed as a senior engineer
  would. No real users yet, so if a migration path from the old version would cost too much, skip it and say so at
  the top of the handover (the user exports their machines before loading that build).
- The `alpine-demo` image: **barebones, like unkernel's** (Alpine's base minimum, `apk`, the command-not-found
  wrapper, the agent, networking, the motd; no python, lua or nano preinstalled: they install on demand). Each demo
  added to the store is listed in the handover.
- The agent on Alpine and udhcpc in its lease renewal, as decision 14 directs.
- A change to the snapshot's disk side, if decision 18's measurement asks for one: make it.
- Any guest-visible change to an existing machine (none planned: demos are new machines).

## Validation

- `scripts/ci.sh` for every loop that touches this repo's code; `scripts/ci-net.sh` for the network's loops;
  `scripts/ci-machines.sh` and `scripts/ci-debian.sh` for the store, definitions and snapshots; `scripts/ci-graphics.sh`
  for the 3D demo.
- The fork's own tests (`go test`, the allowlist's fake upstreams, the throttle) in its repository's CI equivalent.
- The demo's numbers from `bench/` in Chromium (medians and IQR, docs/benchmarking.md "Rules"): click to prompt,
  bytes, `apk add python3`.
- A last check by hand on the deployed page, once the user has deployed it.

## The end

The Alpine demo meets the goal's numbers on the deployed page; the store lists it and at least the desktop demo;
every test layer is green; the numbers are in `bench/demo/REPORT.md` and comparison.md §3; the plan's outcome has
moved into docs/ (frontend.md for the store, machines.md for `fromDemo` and definitions, networking/ for the demo
network, remote-disks.md for hosting); loose ends are in backlog.md; PLAN.md's row is done; and this kickoff, its
handover and plans/first-demo.md are deleted.
