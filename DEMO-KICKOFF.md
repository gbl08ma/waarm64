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

## The goal

A visitor opens `vm.tny.im/demos`, clicks **Alpine (terminal)** once, and is at a logged-in `#` prompt within ~5 s of
the click (cold cache, a good connection; ≤ 30 MB on the wire), where `apk add python3 htop` works and typing a
missing command installs it. The demo is an ordinary stored machine that survives a reload. Every other demo in the
store works the same way.

## Decisions taken (binding for the track; the user's, 2026-11-18)

1. **The no-Wisp decision is reopened** (plans/networking.md §1, plans/networking-local.md §1): a hosted way out for
   demos. Full speed only to an allowlist; anything else only through a throttled slow lane, off by default.
2. **The way out is a hosted helper:** Ethernet frames over a WebSocket to a server-side netstack, as with the local
   helper. No TCP stack in the page, no smoltcp, no Wisp for now (it stays a possible "bring your own server"
   connection later). **No Cloudflare Workers** for it.
3. **The hosted helper is a fork of waarm64-net in a new repository** (`github.com/gbl08ma/waarm64-demonet`, created empty by the user on 2026-11-18): Go,
   released and deployed on its own, its own README, THIRD_PARTY and tests. waarm64-net stays the small local helper.
   This repo's tests pin a commit of the fork, as they pin the local helper's.
4. **It runs on the user's server,** configured from **one TOML file** (BurntSushi/toml) the user edits, reloaded on
   change, with a `--check` that prints what each rule opens.
5. **The first allowlist is what the Alpine demo's `apk` needs:** `dl-cdn.alpinelinux.org`, port 443. Rules are a
   hostname or a `*.` suffix with explicit ports, never addresses. It's enforced at three points: the resolver, the
   dial, and the TLS SNI or HTTP Host. Every rule past the first is the user's call.
6. **The slow lane** (off by default): unlisted destinations on listed ports, throttled per source IP and in total,
   with short-lived hashed records for abuse reports.
7. **Egress per lane:** direct, SOCKS5 (golang.org/x/net/proxy) or an in-process WireGuard tunnel (wireguard-go); a
   lane whose egress is down refuses, never goes direct. **Both dependencies are OK'd for the fork.**
8. **The protocol is `waarm64-demonet.v1`:** v1's frames as binary messages, control as JSON text messages (codes
   and numbers, never words), and close codes 4008–4011 (plans/first-demo.md §3.2).
9. **A demo makes a stored machine** from its definition, with its remote disk's overlay in OPFS (it survives a
   reload) and `fromDemo: {store, id}` on the record. Its first start restores the demo's template snapshot onto the
   fresh overlay and keeps it as the machine's first snapshot. Not the page's transient machine.
10. **"Started before":** the store asks **Open my machine** (the default) or **Start a fresh copy**. **New versions
    get new ids** (`replaces` names the old one).
11. **The store is one JSON file holding its definitions inline,** whose relative URLs resolve against it. Links
    `?id=<id>` and `?store=<url>[&id=<id>]` also take a single definition's URL.
12. **The store is a full-screen page of its own** (like Home) at `vm.tny.im/demos` (`demos.html` beside
    `index.html`, served by the assets-only Worker's `auto-trailing-slash`) and at `#demos`. Home's sidebar gets
    **Demos** between Preferences and About, which opens it. A Worker script for path-style routes only later, if
    ever.
13. **Every demo is hosted on vmdisks.tny.im** (the assets-only Worker): chunked 2 MiB pieces, under ~15,000 files
    in all.

## Loops

One slice, one commit and a short report per loop (CLAUDE.md "How a track runs").

0. **Measure the gap** (no code): unkernel's, v86's and our current page in headless Chromium (time to prompt, bytes
   on the wire, `apk add python3`, peak memory), into a `bench/demo/REPORT.md` with its JSON, and the numbers into
   comparison.md §3 where the rows allow.
1. **The fork.** `github.com/gbl08ma/waarm64-demonet` exists and is **empty** (the user, 2026-11-18). The loop
   sets it up in the dev VM: clone waarm64-net's history into `../waarm64-demonet`, beside `../waarm64-net`
   (`git clone ../waarm64-net ../waarm64-demonet`, then point `origin` at the new repository and push `main`), so
   the fork keeps waarm64-net's history and authorship. Then rename the module and binary, write its own README,
   THIRD_PARTY.md and CLAUDE.md (what it is, that it is public-facing, its rules), and add
   `tests/waarm64-demonet.ts` here, pinning its commit as `tests/waarm64-net.ts` pins the helper's, with a
   `WAARM64_DEMONET_SRC=../waarm64-demonet` override (docs/devenv.md gets the checkout's line). From there:
   waarm64-net's code taken over, `--public`'s
   behavior as the only behavior: TLS behind a reverse proxy, the origin, no token, a network per WebSocket (no guest
   sees another), per-IP budgets, the TOML file with reload and `--check`.
2. **The allowlist** at the resolver, the dial and the first bytes, tested against fake upstreams: a listed name, an
   unlisted one, a listed CDN address reached with another SNI or Host, ECH, UDP 443, a literal address, a private
   answer.
3. **The control channel and close codes** (`waarm64-demonet.v1`), and `http://<gateway>/status`.
4. **The slow lane and egress per lane** (direct, SOCKS5, WireGuard), with throttling tests (the rate holds per IP
   and in total, under many connections) and the fail-closed egress.
5. **The page's side of the demo network:** the built-in "Demo network" connection (`waarm64-demonet.v1` on a
   `wss://` URL, no pairing, no Local Network Access prompt); the control messages rendered from the catalog (the
   message bar for budgets, the Network status for the lane, refused destinations as a count); `scripts/ci-net.sh`
   against a fork's build on loopback, pinned by commit.
6. **The Alpine demo guest:** `images/build.sh alpine-demo` (Alpine 3.24 from release media as `images/alpine` is,
   `main` with `community` on demand, the command-not-found wrapper, the guest agent, root logged in on the serial
   console, a motd that says what the network reaches). Its template snapshot, chunked and traced from the resume.
   Numbers: the snapshot's bytes, click to prompt, `apk add python3`.
7. **Definitions and the store's data:** the definition format's new version with `demo` (id, summary, thumbnail,
   download, view, snapshot, network) and `fromDemo` on the record; `store.json`; a publish tool (ids unique, sizes
   checked, the file budget for vmdisks.tny.im checked).
8. **The store's page:** `demos.html` and `#demos`, the interstitial (what the project is, what it needs, the
   download), the cards, `?id=` and `?store=`, the warning for other stores, Home's Demos item, a machine made from
   the definition, the first start's restore, "started before", versions by id. `scripts/ci-machines.sh` and
   `scripts/ci-debian.sh`.
9. **The desktop demo as a snapshot** (Arch, sway, Firefox, resumed at the desktop), and a 3D one (glmark2, vkcube or
   a small game on virgl or Venus).
10. **Templates under New machine:** the same definitions without a snapshot.
11. **An out-of-context review** (the page's demo code, and the fork's allowlist separately), its fixes, the
    numbers, the comparison's numbers filled in, the docs.

## Needs the user's OK during the track

- Each allowlist rule past `dl-cdn.alpinelinux.org`, and the slow lane's first numbers (rate, connections, total)
  before it's turned on.
- The definition format's new version (a format others may hold) and the machine record's `fromDemo` field.
- The `alpine-demo` image's contents, and each demo added to the store.
- Every deploy: the fork on the user's server, vmdisks.tny.im, vm.tny.im.
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
