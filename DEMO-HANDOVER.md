# DEMO: handover

The kickoff is [DEMO-KICKOFF.md](DEMO-KICKOFF.md); the plan [docs/plans/first-demo.md](docs/plans/first-demo.md).

## Start here (for a new session; the coordinator, 2026-11-19 ~12:00)

You're picking up the DEMO track from a session that ran it overnight as a coordinator of subagents. Read, in order:
CLAUDE.md, [DEMO-KICKOFF.md](DEMO-KICKOFF.md) (binding; the user's words, edited with their OK on 2026-11-19 for the
red lines and loop 11), this file, [docs/plans/first-demo.md](docs/plans/first-demo.md), and the fork's own
`../waarm64-demonet/HANDOVER.md`. The user wants the track carried on from here; **don't deploy anything until the user
says so again** (they allowed it, then withdrew it: "changed my mind, don't deploy just yet", 2026-11-19).

### Where things stand

- **waarm64 `main`** (origin): everything through `f18c51a0` is pushed; each commit passed `scripts/ci.sh` plus the
  topic scripts its area needs (ci-machines, ci-net, ci-debian), run one at a time in the CI worktree (below). Loops 0,
  1, 2, 3, 4, 5, 6, 10, 10b, 13 are done; two out-of-context reviews of the page's demo code (branches
  `review/demo-page`, `review/demo-page-2`, kept on origin) and every finding fixed except those the user's decisions
  cover. After them: the OpenRC install dialog (006d8068, its words fixed in 16990a3e after the user's review:
  docs/copy.md, no distributions named) and **a demo's machine starts each run with clipboard sharing paused**
  (1bad1ddf + its test fix f18c51a0).
- **waarm64-demonet `main`** (origin, private repo): `9061197`. Loops 7, 8, 9, 11 (review: 10 findings fixed), 14 (the
  slow lane, **off by default**) and the slow lane's own review (8 findings fixed); `go test -race ./...` clean on a
  quiet machine (241 s); the release workflow's YAML fixed (9061197: a `: ` in a plain scalar made the file unparsable,
  so every push showed a 0 s failure). Its HANDOVER.md has its state, backlog and the owner's open numbers.
- **The Alpine demo meets the goal's numbers locally:** click → command answered 2.9–3.0 s, 24.7 MB on the wire, at a
  modelled 100 Mbit/s / 20 ms (bench/demo/REPORT.md "DEMO loop 3"; comparison.md §3 has them, marked local). Not
  deployed, so the kickoff's "on the deployed page" isn't met yet.
- **Loop 12 (the desktop and 3D demos): built, measured, docs moved; CI on `c2bacdcf` running** (branch
  `wip/demo-loop12`, rebased on main). Both demos resume with foot counting down to their app; click → desktop 12.7 s
  (arch-desktop) and 13.2 s (arch-3d) at 100/20, 140 and 145 MiB (bench/demo/REPORT.md "DEMO loop 12"). Merges to
  main once ci.sh, ci-machines.sh and ci-graphics.sh pass.

### The user's decisions since the kickoff (2026-11-19), all binding

1. The kickoff's "Needs the user's OK" is **red lines** (stop and ask: deploys, allowlist rules past
   `dl-cdn.alpinelinux.org`, new dependencies, the slow lane's numbers or turning it on) and **engineering calls**
   (make them, list them under "Awaiting the user's review"). Definition-format changes may skip a migration if it
   costs too much (say so under "Before you load this build").
2. The `alpine-demo` image is **barebones like unkernel's** (nothing preinstalled beyond Alpine's base; everything else
   installs on demand).
3. **Hosting the fork is the user's own follow-up**, outside the track (loop 11 is its review only).
4. **CI is the coordinator's**: subagents don't run scripts/ci*.sh; one CI script at a time on the machine.
5. The demo server's URL **`wss://demonet.tny.im/`** is confirmed (the user adds the DNS record when hosting).
6. The Alpine agent's install command is shown in an **informational modal from a link under the clipboard-sharing
   setting** (done: 006d8068, 16990a3e). **Copy rules (docs/copy.md) apply**: the user rejected the first wording for
   naming Alpine and the demo, and for colons that don't announce.
7. **Clipboard sharing starts paused for every machine made from a demo, ours included** (done: 1bad1ddf, f18c51a0):
   each run paused (not remembered), no clipboard read while paused, so no permission prompt until the visitor turns it
   on in the toolbar's Clipboard menu; a copy of a demo machine drops `fromDemo` and isn't paused.
9. **(2026-11-19, new session)** Loop 12's build with `cmdline: init_on_free=1` is **approved** (the exact command
   under "What's left" 1). `?disk=<url>&clipboard=1` **stays as is** (security question closed: the transient machine
   has no network unless the user attaches one). **No deploy yet**: ask again later. `target/snapbench` and
   `target/vk2-nvidia-bundle.tar` deleted with the user's OK (32 GB free after).
10. **(2026-11-19) The desktop demos resume with foot counting down to their app** (the user's idea: Firefox, the
   shader demo), not with the app in the snapshot; `init_on_free` dropped (its cost on every free in the visitor's
   machine, the user's concern). **The demo server is hosted** (`wss://demonet.tny.im/`, Docker Compose behind the
   user's Caddy; `trusted_proxies` checked: `forwarded-ignored` 0 with the fork's 77a669d). **DO NOT DEPLOY** vm.tny.im
   or vmdisks.tny.im: the user allowed it after loop 12, then withdrew it ("DO NOT DEPLOY", 2026-11-19), so the
   deployed site's demos don't need replacing when loop 15 changes them. Ask before any deploy.
8. The old Podman images (`webpc-*`, dangling) and `target/arch/desktop-kde.qcow2`, `desktop-pre-g7.qcow2` were
   deleted with the user's OK; earlier the gdb debug guest and cargo's `target/debug` caches (disk had filled to 100 %).

### What's left, in order

**1. Loop 12's end:** CI in `../waarm64-ci` at the branch head (its `target/demos/{arch-desktop,arch-3d,pieces}`
linked from main's, which hold the builds from bench/results/local/demo/site): ci.sh, then ci-machines.sh, then
ci-graphics.sh; on green, fast-forward main and push. The builds' commands (the user approved the first; the others
ran): `node tools/build-demos.ts --only arch-desktop,arch-3d --core bench/results/local/demo/dist --no-images
--no-publish --out bench/results/local/demo/site`.

**2. (closed: decision 9, kept as is.)**

**2b. Loop 15 (new, after loop 12; the user's, 2026-11-19): a second adapter on the global public room for every demo
machine**, so visitors' demo machines can reach one another. Not started. What it takes (worked out with the user):
- **A key per machine** (the user: else they'd all get the same address; the rooms' one-running-per-key lock,
  rooms.md "Decisions", forbids sharing anyway): `machineFromDemo` makes the machine's own room connection on
  `waarm64-room:global` with a fresh node key, made in the visitor's browser at the machine's first start, never in
  the definition or the snapshot; attached to adapter 1 as `attachDemoNetwork` attaches adapter 0.
- **The definition:** an optional field beside `demo.network` (e.g. `demo.room: "global"` for adapter 1, or a list of
  `{adapter, kind}`), additive within version 2 (pages ignore unknown fields); the publish tool and
  `web/app/definition-check.ts` learn it.
- **The rules:** adapters.md §1 rule 2 ("no default connection") gets a second exception, a room made by the page
  for a demo, in decisions.md's Network row (the user's call: ask). Rule 4 holds: one machine per key.
- **The snapshot carries no room address:** the template is built with adapter 1 present and unconnected; after the
  restore the page connects it and the guest asks for its address then (the room's gateway gives a /128 by DHCPv6 and
  the RA: tailnet.md). The restore's hold (devices.md "The network after a restore") and the agent's LEASE must cover
  the second card and DHCPv6.
- **The guests, without changing their images** (checked with the user, 2026-11-19): Arch's systemd-networkd already
  takes any `eth*`/`en*` card with `DHCP=yes`, v4 and v6 (images/arch/build.sh), so its second card configures
  itself. Alpine's ifupdown-ng configures only what `/etc/network/interfaces` lists (`lo`, `eth0`), so `eth1` stays
  down, and the room's address is a /128 by DHCPv6 (no SLAAC). Rather than an image change (a new content id, so new
  demo ids), **the agent does it**: its binary comes from fw_cfg at each start (web/app/guest-agent.ts), so it ships
  with the page; told a card is connected, it brings up a card nothing else manages (no ifupdown stanza, no
  dhcpcd/networkd/NetworkManager on it) and runs busybox's `udhcpc6` there, and its LEASE after a restore renews
  `udhcpc6` as it does `udhcpc` (`agent/src/lease.rs`). Only the primary (the demo network, eth0) offers default
  routes, so the room adds its /48 and nothing else. With no image changed, the demos keep their ids (no `replaces`):
  only their snapshots are made again.
- **Images CI and others already use stay as they are** (the user, 2026-11-19): `alpine-uefi` is ci.sh's and
  ci-net.sh's (`alpine-demo` is cut from it), and `target/arch/desktop.qcow2` is the deployed Desktop Demo's and
  bench/gpu's guest: never edited. If an image must change after all, `alpine-demo`'s own files only (its hash moves
  in SHA256SUMS, a new demo id), and an Arch change is a new image under a new name.
- **Every template made again** (a second card is another shape: the shape hash moves), by tools/build-demos.ts.
- **Costs and words:** the room client (`ts.wasm`, 3.8 MB) after the prompt, not before it (click → command stays);
  the visitor's browser then talks to six public Nostr relays and Tailscale's DERP servers: the interstitial says so
  (docs/copy.md). Proposed: the demos' room connection **relay only** (peers never learn the visitor's IP);
  incoming connections on as rooms default (a demo listens on nothing): both the user's to confirm.
- **A reason to use it:** a node's name is its key and nothing lists it, so the guest shows its own name (the motd or
  a login line, from the agent or the page) for the visitor to give out.
- **Tests:** the definition's field and the connection's making (Node, Chromium with a stand-in); a guest test of two
  demo machines reaching each other through the rig's derper and Nostr relay (bench/net's rig), skipped without it.
- **Then a deploy, when the user says so** (remote-disks.md "Deploying the demos").

**3. The deploy: NOT NOW** (decision 10: "DO NOT DEPLOY"; ask first). The runbook is docs/remote-disks.md "Deploying
the demos". Not in it: `target/dist` in the main checkout is an old copy (27eb7884), never to deploy; bench/demo
has no target for the deployed store yet (add one for the deployed numbers).

**4. After a deploy:** the deployed page's numbers (click → command, bytes, `apk add python3` once the fork is
hosted, PSS) into bench/demo/REPORT.md and comparison.md §3 (replacing the "local, not deployed" note), and the check by
hand the kickoff asks for.

**5. The track's end** (kickoff "The end"): the whole CI set on the final head (ci.sh, ci-net, ci-debian
`--platform`, ci-graphics, ci-machines, ci-audio, ci-jit, ci-fp, ci-deqp, ci-deqp-vk, ci-usb), the plan's outcome
moved into docs/ (frontend.md for the store, machines.md for `fromDemo` and definitions, networking/ for the demo
network, remote-disks.md for hosting: most is there already, check what plans/first-demo.md says that docs don't),
loose ends into docs/backlog.md, PLAN.md's row set to done, and DEMO-KICKOFF.md, this file and plans/first-demo.md
deleted in that commit. An out-of-context review of the page's demo code since review/demo-page-2 (the clipboard
pause, loop 12) before the end.

**6. Smaller loose ends** (in docs/backlog.md or worth adding there): an automated test of command-not-found (a page
test serving the virt ISO's signed `apks/`); udhcpc's address timing on `alpine-demo` after a restore not measured
(10b measured dhcpcd's); pieces now fetched whole even where ranges work (an A/B of the Desktop Demo's boot); the
page's slow-lane additions are done but the guest's motd line for the slow lane (fork HANDOVER "For waarm64's page"
item 7) isn't; `page-modal`'s bucket test now fails with a cause instead of hanging (it hung once under load, never
reproduced).

### How to work here (learned overnight)

- **CI in a worktree:** `../waarm64-ci` is a detached worktree; `git -C ../waarm64-ci checkout --detach <commit>`,
  then run the scripts there under `systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- timeout 1500
  scripts/<s>.sh`, one at a time, backgrounded, waiting on the notification. It keeps the next loop's uncommitted edits
  out of the test. Its `target/images` are hard links from main (`cp -al`); a new or rebuilt image must be linked in
  (`rm -rf` the old entry first). `target/vk/venus.wasm`, `LICENSES.txt` and **`venus.wasm.inputs`** are copied there:
  without the stamp, `tests/start.test.ts` builds Vulkan's renderer in its clone and can't delete it afterwards
  (rootless Podman owns the files: remove such a leftover with `podman unshare rm -rf /tmp/waarm64-clone-*`). It has its
  own cargo `target/` (rebuilt by ci.sh).
- **An image goes stale when `images/build.sh` changes** (its inputs include the script): `alpine-uefi` had to be
  rebuilt for ci-net.sh after loop 3; the rebuild reproduced its pinned hashes. A change to an image's sources moves
  its hash in images/SHA256SUMS (the build prints "differs"): commit the new line (c426eecf did, for alpine-demo).
- **Load makes timing tests fail:** with `go test -race ./...` (the fork) or Podman builds beside CI, load reached
  13–31 and tailnet leases, page-open's "at once" and page-ram failed; each passed alone. Keep heavy runs off while a
  CI script runs, and rerun a timing failure alone before chasing it. The tailnet ones had a real harness bug too
  (tests/serial-console.ts `run` returned the end marker's echo for empty output: fixed).
- **Auto mode refuses some subagent commands with no or a generic reason** (loop 12's builds, a plain unit test): don't
  retry or rephrase around it; report the exact command to the user, who can approve that exact call.
- **Disk:** 150 GB, 26 GB free at the end. A desktop template build needs ~6 GB of scratch; clean `.work/` and plain
  snapshots as soon as they're done with. Still there, not asked about: `target/snapbench` 3.9 GB,
  `target/vk2-nvidia-bundle.tar` 2.6 GB.
- The fork pushes only as `git -C /home/gabriel.guest/Development/waarm64-demonet push` (the user's allow rule).

## Before you load this build (for the user)

- **Loop 4 (definitions v2):** nothing to export first. Definitions of version 1 still import (the reader takes 1 and
  2), and machine records are unchanged but for an optional `fromDemo`. One thing to know: an exported definition is now
  version 2, which a page from before loop 4 refuses.

- **Loop 3 (snapshot codec 3):** nothing to export first. Kept snapshots stay LZ4 and load as before; only templates made
  with `--deflate` are the new container version 3, which a page from before loop 3 refuses as newer.

## Current state (per loop: the record of what each did)


- **The fork, loop 7 done** (waarm64-demonet `6de5a2b`, pushed): a network per WebSocket, per-IP budgets, the TOML
  file with reload and `--check`, close codes 4001/4003/4008–4010; fails closed until loop 8 (running beside).
- **Loop 0** (pushed): `bench/demo/` and the gap, [bench/demo/REPORT.md](bench/demo/REPORT.md) "DEMO loop 0".
- **Loop 1, the spike, done** (2026-11-19, pushed f29b3dd5): an Alpine template restored in a fresh profile,
  offline, through a modelled 100 Mbit/s / 20 ms link: **click → a command answered in ~3.4 s, ~32 MB on the wire**
  (page 2.5 MiB brotli'd, snapshot 24.0 MiB, disk 4.0 MiB), with the image booted with `init_on_free=1` and the
  guest's caches dropped before the snapshot (REPORT.md "DEMO loop 1"). Code: a chunked image's identity is its
  content (`{kind:'url', chunked, bytes}`, machines.md §3.1), a machine from a template (`web/app/template.ts`,
  `restoreFirst` on the record, machines.md §6.1), a machine's first restore fills its fresh overlays, one shared
  `pieces/` (`tools/chunk-image.ts --pieces`, `_headers`). The harness: target `waarm64-template` (`DEMO_LINK`,
  `DEMO_TEMPLATE`), `bench/demo/make-template.ts`, `spike-image.sh`, `site.ts`, `snapinfo.ts`, `ramcodec.ts`.
- **Loop 2, the agent on Alpine, done** (2026-11-19, pushed): an OpenRC service for the agent
  (`web/app/guest-agent.ts` `agentOpenrc`), reaching a user's own Alpine through a one-command installer the machine
  gives over fw_cfg (`opt/waarm64/openrc`: `modprobe qemu_fw_cfg; sh /sys/firmware/qemu_fw_cfg/by_name/opt/waarm64/openrc/raw`),
  since nothing stock on Alpine reads fw_cfg/SMBIOS/credentials at boot (devices.md "On OpenRC"); LEASE renews udhcpc
  (SIGUSR1) and dhcpcd (`dhcpcd -n`) found among the processes (`agent/src/lease.rs`); POWER falls back to busybox's
  `poweroff`/`reboot`; `body[data-lease]` says what a restore's lease renewal did. The clock and "ready" needed no new
  code: the agent's HELLO sets the clock and marks the machine up. Test: `tests/page-alpine-agent.test.ts` (ci-net.sh,
  ~2 min).

- **Loop 10, the page's side of the demo network, done** (2026-11-19, pushed;
  [docs/networking/demo-network.md](docs/networking/demo-network.md)): the connection kind `demo` (no lock: any machines
  and adapters at once, a socket each; rules 2 and 4 of adapters.md and decisions.md's Network row changed), its client
  (web/demo-net.ts in web/demo-net-worker.ts: `waarm64-demonet.v1`'s control messages kept as the status and notices,
  reconnects by close code), its words (web/app/demo-view.ts; the Network menu's status, the message bar, the
  details), the wizard's step (NetDemoStep.svelte), and **for loop 4: `attachDemoNetwork(store, machine, adapter = 0,
  url?)` in web/app/net-demo.ts** (what `demo.network: "demo"` calls; `demoConnection` finds or makes the browser's one
  record). Tests: `tests/demo-net.test.ts` (fake server), `tests/net-live.test.ts`'s demo case, and
  `tests/page-demonet.test.ts` in `scripts/ci-net.sh` (Alpine against the fork built at the commit
  `tests/waarm64-demonet.ts` pins, `73d9a2d`; `WAARM64_DEMONET_SRC` overrides; cloud sessions SKIP).

- **Loop 4, definitions and the store's data, done** (2026-11-19, pushed; machines.md §6.2,
  remote-disks.md "Publishing the demos"): definition version 2 (`demo`: id, summary, thumbnail, download, view,
  snapshot `{manifest, id}`, network `"demo"`, replaces as a list), with a reader of both versions, checks in
  `web/app/definition-check.ts` (a damaged one's error names the field); `fromDemo: {store, id}` on the record; the
  store (`web/app/demo-store.ts`: `parseStore`/`fetchStore`, a single definition's URL as a store of one, unreadable
  demos `skipped` and the rest shown, `demoMachines` for "started before" and older versions); `machineFromDemo`
  (web/app/template.ts: the snapshot fetched and checked by content id first, then the machine, `fromDemo`,
  `attachDemoNetwork`); the publish tool (`tools/publish-demos.ts`, `tools/demo-site.ts`, source
  `deploy/disks/demos.json`, ledger `target/disks/.publish.json`). Checked on the spike's real template
  (bench/results/local/demo/site/alpine-spike): its shape hash matches what the tool computes, and a dry run plus
  `--apply` on a hard-linked copy of target/disks keeps the desktop's files (1009 files).

- **Loop 3, the alpine-demo image, done** (2026-11-19, pushed; docs/images.md `alpine-demo`,
  [bench/demo/REPORT.md](bench/demo/REPORT.md) "DEMO loop 3"): `images/build.sh alpine-demo` (alpine-uefi's image cut to
  Alpine's base, `images/alpine-demo/`; 73.0 MB, bit for bit, in SHA256SUMS); `bench/demo/make-template.ts` waits for
  the agent and deflates the template; **snapshot frame codec 3, raw deflate** (the core's miniz_oxide, no new export:
  `repackFrames` in web/snapshot-file.ts, `deflateCodec` in web/lz.ts, `tools/snapshot-template.ts --deflate`; the reader
  and the load pool's workers read 2 and 3; a file with deflate frames is container version 3). **Numbers at 100/20:
  click → command 2.9–3.0 s, 24.7 MB on the wire** (LZ4: 3.6–3.7 s, 33.5 MB): the goal's numbers met. Checked by hand
  through the local helper: python3, community's fastfetch and lua installed on first use.

- **Loop 6, the store's page, done** (2026-11-19, pushed; docs/frontend.md "The demo store"): `/demos`
  (`demos.html` beside `index.html` in the copy; the dev server redirects `/demos` to `/web/app/demos`) and `#demos`,
  `?id=`, `?store=` (`web/app/demos-route.ts`); `DemosPage.svelte` in the machine's place with Back, Home's **Demos**
  between Preferences and About, the first visit (no machines, a bare address) opening it; cards (`DemoCard.svelte`),
  the interstitial with the browser's checks (`DemoStart.svelte`, `DemoChecks.svelte`, `demo-check.ts`), Start →
  `machineFromDemo` → `page.openDemo` (the demo's view, `switchMachine` asked once up front), started before (Open my
  machine, the default, its disks' manifests checked; Start a fresh copy), and the failures (`template.cutOff`,
  `template.full` new; the machine deleted when its snapshot can't be kept). Tests: tests/demos-route.test.ts (Node),
  tests/page-demos.test.ts (Chromium, stand-in worker), tests/page-demos-guest.test.ts (ci-machines.sh; **needs loop
  5's `target/demos/alpine-term/`**, `WAARM64_DEMO_SITE`/`WAARM64_DEMO_NAME` override, skipped without it).
  **For loop 5:** the guest test is its ci-machines check once the build writes `target/demos`; it wraps the site's
  `definition.json` into a store itself (the `demo` taken from it if it has one, its network dropped: offline).

- **Review fixes (review/demo-page, 2026-11-19, pushed):** R1 a chunked image's bytes checked against its
  content id (manifest id = its hashes', = the disk record's; each piece hashed before use, so pieces are always fetched
  whole; `web/sha256.ts` for the synchronous reads) and a definition's URL disk reused only at the same URL; R2 a
  definition's blank/ramdisk disk always a new record, identities checked by kind; R3 the template snapshot's manifest
  fetched once and its id checked against its hashes, hashes hex; R4 `importDefinition(store, def, finish)`: the
  snapshot kept and the demo network set before the record is stored once (any failure leaves nothing); #5
  `applyPlan` pieces first, the rest staged and renamed, store then ledger last; #6 LEASE's `dhcpcd -n` only for cards
  dhcpcd manages (`dhcpcd_manages`: its title names the card, or the manager and `/etc/dhcpcd.conf` doesn't deny it);
  #7 the demo client's backoff resets only after a socket lived 30 s past `hello` (`HEALTHY_MS`), "lost" once per
  outage, `open()` reports; #9 a copy drops `fromDemo`. `knownDisk` (a URL the user adds) still finds a record of the
  same image from another host: user-initiated and now content-checked, so kept (loop 1's call).

- **Loop 13, templates under New machine, done** (2026-11-19, pushed; machines.md §6.3): New machine opens a
  dialog (`web/app/NewMachine.svelte`): Empty machine (what it made before) and our store's demos marked
  `demo.template: true` (`templatesOf`), each made by `machineFromStoreTemplate` (the definition without `demo`: no
  snapshot, no demo network, no `fromDemo`; a cold boot). The store unreachable: said, Try again, Empty machine works.
  `deploy/disks/demos.json`'s alpine-term is marked. Tests that clicked New machine use `tests/page-home.ts`
  `newEmptyMachine` (answers our store empty: no request leaves the machine). Tests: tests/demo-store.test.ts,
  demo-site.test.ts (Node); tests/page-demos.test.ts's New machine case (Chromium).

- **Loop 5, the automated demo build, done** (2026-11-19, pushed; remote-disks.md "Building the demos"):
  `node tools/build-demos.ts [--core <wasm | target/dist>] [--apply]` remakes every demo with a `recipe` in
  deploy/disks/demos.json (the image name, the machine with a fixed MAC, the disk's serial) under its id into
  `target/demos/<id>/` (the image rebuilt if stale; make-template.ts with `--definition`, `--core` routed into the page,
  `--thumbnail`: thumb.webp), prunes the build's unnamed pieces, and plans the publish (dry run; `--apply` writes
  target/disks). ~32 s for alpine-term; the shape hash the same across builds (aa731d0b…, checked on two builds; the
  snapshot ids differ: RAM isn't reproducible). `target/demos/alpine-term` is built (from d686e684's core).
  scripts/ci-machines.sh builds it into target/ci-demos and runs tests/page-demos-guest.test.ts on it (passed: 21 s).

- **Loop 10b, the page's slow lane and the late address, done** (2026-11-19, pushed): the demo client and
  its words take the fork's slow lane (off on the server by default: forward-compatible; demo-network.md): the lane
  `slow`, the slow budget and `slow-threshold`, `hello.limits.slow` in the status's details, every refusal's reason in
  words (`slow-connections`, `slow-spent` among them; an unknown one: the name alone), 4010's `closing.lane`. **The
  late address after a restore** (devices.md "The network after a restore"): a restored card holds the flap its switch
  onto the helper's or the demo network's frames owes until `LeaseActions` settles (`{type: 'settled', renewed}`;
  `HOLD_MS` 120 s at most), so the agent's LEASE no longer runs under a link that's down. page-alpine-agent (passed
  under load ~13) asserts `carrier_changes` unchanged across the restore; there the address came 5.6 s after the page's
  load (agent 1.4 s; dhcpcd). Not measured on alpine-demo's udhcpc template yet (loop 5's build, ci-machines).

- **Review fixes (review/demo-page-2, 2026-11-19, pushed):** #1 a demo's start is its interstitial's (one
  at a time, `demos.starting`; aborted with its download when the interstitial goes; the switch asked again if another
  machine runs by then); #2 Open my machine for the machine running here goes to it; #3 the command-not-found hook runs
  the line again only when it's the command alone with plain-word arguments, else "run it again" (**images/alpine-demo
  changed: the image and the demo's template need a rebuild**; docs/images.md's sentence "runs the line typed again" is
  loop 12's file: add "when it is the command alone"); #4 a snapshot past the card's `download` or `MAX_TEMPLATE` (1 GiB)
  refused before a piece, pieces kept as Blobs as they come; #6 `importDefinition` writes disks, overlays and the machine
  after `finish` (a residual window of a few record writes, ms); #7 a stale store read dropped; #8 history entries for
  the store's steps, `popstate` followed; #9 a demo's view not saved (kept for the tab's reloads in sessionStorage: ci-machines' guest test reloads into it); #10 the hold's 120 s from `{type: 'connected'}`
  (when `NetSettled.when` resolves), unbounded before: the flap it's for comes with the connection, and with no
  connection there's nothing to renew; #11 a template's adapters get fresh MACs; #13 snapshot failures as MsgErrors
  (`template.download` + `chunked.malformed`/`pieceStatus`/`pieceWrong`, a piece's 404 `template.gone`), siblings
  aborted; #14 demo-net waits in steps of a day; #15 focus on choose/All demos, `alt=""`, the progress bar named.

## Before a deploy of vm.tny.im (the user)

The demos' templates must be made by the core that's deployed (the publish refuses another core format or shape hash):

1. `npm run dist` (the page into `target/dist/`, from the checkout you deploy);
2. `node tools/build-demos.ts --core target/dist` (each demo with a recipe made again under its id into
   `target/demos/<id>/`, the image rebuilt first if stale; a dry run of the publish: read the plan), then the same with
   `--apply` (writes `target/disks/`: store.json, `<id>/`, the shared `pieces/`). Or `node tools/publish-demos.ts
   --apply` alone once the builds are there;
3. deploy both: the page (`npm run dist`'s copy, docs/devenv.md "Deploying") and vmdisks.tny.im
   (`deploy/disks/deploy.sh`).

~30 s per template (plus ~40 s when `alpine-demo`'s image is rebuilt). When the image itself changed (its content id),
the publish refuses: that's a new demo id with `replaces` (decision 13).

## Next

See "Start here" › "What's left, in order" above.

## Awaiting the user's review

- **Loop 12's engineering calls:** two new demos, neither a template for New machine: **`arch-desktop`** (4 vCPUs,
  2 GiB, 3D, sway at 1280×800, Firefox) and **`arch-3d`** (the same image, the shader demo on virgl; virgl, not Venus,
  since a snapshot is refused while a Venus context exists), both on the demo network (their cards say it reaches
  only dl-cdn.alpinelinux.org: no websites, no pacman). They resume with foot open and a 10 s countdown to the app
  (`~/open-firefox.sh`, `~/open-shader-demo.sh`, Ctrl+C stops it), the user's idea; the card's thumbnail is taken after
  the build's own countdown, with the app open, and the screen at the snapshot is kept as `resume.webp` for the
  checks. The shader demo runs with `GDK_DISABLE=offload`. `init_on_free=1` dropped (the session's `cmdline` field
  stays, unused). screen-like.ts's threshold 12 kept (measured). The desktop image's 944 pieces are in the site twice
  until `desktop/` is published from the shared `pieces/` (backlog). Builds go only under `target/<dir>/<name>`
  (review demo-page-2 #12). Measured cost: the app's files (~125 MiB) come from the disk after the desktop shows, and a
  command typed meanwhile waits behind them (backlog: a trace of the app's start).

- **Loop 5's engineering calls:** the demo's machine is fixed in `deploy/disks/demos.json` (`recipe`: the image's name,
  the definition's `machine` with its MAC, and the disk's serial; the MAC and serial are loop 3's template's), so a
  rebuild's shape hash is the same; the publish tool takes `recipe` as a known field and leaves it to the build. The
  template is made by the checkout's page (the dev server) around the given core, not by the copy's bundle (the copy's
  `assets/waarm64_core-*.wasm` is routed in; its stamp is printed beside the checkout's commit): make a copy's demos
  from the checkout it was built from. The thumbnail is generated: the console's top at the prompt, 480×300 WebP.
  The image is rebuilt when `images/build.sh --check` calls it stale (Podman), unless `--no-images`.

- **The alpine-demo image's contents** (loop 3; the user's barebones brief): Alpine 3.24.2 from alpine-uefi's pinned
  cloud image, cut to alpine-base, e2fsprogs, linux-virt and Limine (45 packages; removed: tiny-cloud, chrony, dhcpcd,
  doas, dosfstools, mount, nvme-cli, openssh, sgdisk, tzdata); hostname `alpine`; root logged in on the serial console
  (`login -f root`), a getty on tty1; `eth0` by udhcpc (retrying every ~3 s); `/etc/apk/repositories` = main, with
  community commented out; no apk cache; `/etc/profile.d/command-not-found.sh` (a missing command → `apk search -x
  cmd:<name>` in main, then community, which it enables; installs; runs the typed line again); the motd (what to try,
  the network reaches dl-cdn only, `curl http://192.168.127.1/status`); the agent's OpenRC service in the default
  runlevel; Limine `timeout: 0`; the kernel's command line `… console=tty0 console=ttyAMA0 init_on_free=1`. 1 GiB disk.
- **Loop 3's engineering calls:** the image is built from the pinned cloud image (nothing from the live repositories
  goes in, so it's reproducible) rather than from the minirootfs; the template's frames are deflated (codec 3), the
  page's own saves stay LZ4; a deflated file is container version 3, which a page from before loop 3 refuses as newer
  (no existing snapshot changes: nothing to export first).

- **Review #8 left as is (the user's decision):** a store's definition can turn on clipboard sharing (and shares);
  other stores' definitions get no extra restrictions.
- **review/demo-page-2 #5, left as is (the same decision):** another store's demo can turn on clipboard sharing and the
  demo network together; with the server's slow lane on, a guest given the host's clipboard could send it out.
- **A demo's machine starts each run with clipboard sharing paused** (the user, 2026-11-19; docs/clipboard.md, frontend.md
  "The toolbar"): a record with `fromDemo` and the setting on starts with the toolbar's switch off (PAUSE at the agent's
  opening), the page makes no clipboard read (focus, HELLO, the paste chord, Send/Type all respect the pause) and
  Allow… is hidden, so Chromium asks nothing until the user ticks Share the clipboard; that one click resumes and, while
  the permission is `prompt`, reads on the click so Chromium asks (any machine's switch now does). **Choice:** not
  remembered: every run starts paused (one line to change: web/app/demo-store.ts `startsPaused`, or record a
  per-machine flag at the resume). A copy of a demo's machine drops `fromDemo` (review #9), so it shares from the start.

- **Loop 13's engineering calls:** templates are opt-in per demo (`demo.template: true`; a game or 3D test demo, or a
  second demo of one image, isn't a starting point), carried and type-checked by the publish tool. A template's machine
  takes nothing of the demo: no snapshot (cold boot), no demo network (its adapter unconnected, as any new machine's: the
  user attaches a connection), no `fromDemo`. Only our store's templates are offered (`?store=` is the store page's).
  New machine is now a dialog (one click more for an empty machine); the store is fetched each time it opens. The
  choices show name and summary, no thumbnail or download size (a template's download is the disk's reads, not a
  number the card has).

- **Loop 6's engineering calls:** the first visit opens the store only on a bare address with no machines, and never
  under automation unless `?firstvisit=1` (the tests open the page bare in fresh profiles; `leavewarning`'s precedent).
  The interstitial and "started before" are one panel (a card → its details: checks, then Open my machine / Start a
  fresh copy, or Start). Stops: no isolation, no OPFS, no WebGL2 (3D), no WebGPU (Vulkan), storage below the download
  ×1.25 (+64 MiB at least); warnings: not Chromium, mobile, `deviceMemory` below RAM + 1.5 GiB. "Last used" is the
  last write to the machine's overlays (no new record field). Another store: its JSON is fetched, then the warning
  (with its host and its own name), nothing more until accepted. The store's URL is configurable by `?store=` only.
  The message bar is hidden on the store's page, as on Home (whose banner shows it; the store's page shows its own
  errors). A new icon (`apps`, Tabler) for Demos.

- **Loop 4's engineering calls:** version 2 is version 1 plus `demo`, so there's no migration; exports write 2. No
  `needs` field: 3D, Vulkan and RAM come from the machine's own fields, so they can't disagree. `replaces` is a list,
  so v3 can name v1 and v2 both. The page ignores fields it doesn't know, while the publish tool refuses them. A
  store's unreadable demo is skipped and said, not fatal. `fromDemo.store` is the store's absolute URL (another host's
  store with the same id is another demo). A copy drops `fromDemo` (review #9: its card would open a copy that starts cold) and `restoreFirst`. Publishing is a dry run unless `--apply`. Retired demos keep their files until the 15,000-file budget,
  then the oldest retired go first. The ledger lives in the site, excluded by `.assetsignore`.

- **Loop 10:** the default server URL **`wss://demonet.tny.im/`** (web/demo-net.ts `DEMO_URL`) is **confirmed by the
  user (2026-11-19)**, who adds its DNS record when hosting the fork (a connection keeps its URL: changing the default later needs a new
  record or an edit). Engineering calls: a demo connection is made by the page itself (one stored record per URL, named
  "Demo network"); a restarted machine keeps its socket; `budget?` asked each minute only while traffic moves; 4010
  waits until the budget's reset; frames held (≤ 256 KiB) only while a socket opens; the message bar says 80 %, spent,
  back, a restart announced and a lost connection, nothing for 4008/4009/4013 (the menu's status says those).

- **Loop 1's engineering calls:** a chunked image's disk identity is now `{kind: 'url', chunked: <manifest id>, bytes}`
  (no path), for disks added from now on; disks added before keep their old identity (path + `etag`), so their
  overlays and snapshots stay valid, and adding the same URL again finds them: no migration, nothing to export first.
  A machine record may carry `restoreFirst` (a kept snapshot its first start restores without asking). A machine's
  first restore writes into its never-written overlays rather than forking beside them (only then: a restore the
  user asks for leaves their overlays alone).
- **Loop 2's engineering calls:** the agent reaches a stock Alpine by a one-command install (the fw_cfg file
  `opt/waarm64/openrc`, given beside the binary on every machine with the agent: ~3 KB more fw_cfg, a guest-visible
  change) rather than zero-touch, which no stock Alpine mechanism allows (tiny-cloud's NoCloud seed runs at a first
  boot only, cloud images only); our images bake the service. Not sandboxed on OpenRC (no namespaces there); capped by
  OpenRC's cgroups v2 where it has them. dhcpcd is renewed with `-n` (rebind), not `-N`, so a template's IPv4LL
  fallback is left too. The page shows the install command in an informational modal from a link under the machine's
  clipboard-sharing setting (the user's choice, 2026-11-19; commit 006d8068).
