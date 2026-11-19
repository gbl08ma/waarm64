# DEMO: handover

The kickoff is [DEMO-KICKOFF.md](DEMO-KICKOFF.md); the plan [docs/plans/first-demo.md](docs/plans/first-demo.md).

## Start here (for a new session; 2026-11-19 ~14:00)

You're picking up the DEMO track (the first demo: a store of demo machines resumed from template snapshots, and a
hosted demo network). Read, in order: CLAUDE.md, [DEMO-KICKOFF.md](DEMO-KICKOFF.md) (binding; the user's words, edited
with their OK on 2026-11-19 for the red lines and loop 11), this file, and the fork's `../waarm64-demonet/HANDOVER.md`.
docs/plans/first-demo.md is background only: what binds is now in docs/decisions.md ("Network", "Demos"). **Do not
deploy** vm.tny.im or vmdisks.tny.im (decision 11): ask first. **Loop 15** (below) is built; its CI and the
user's answer on room names are what's left of it.

### Where things stand

- **Loop 15 (a demo's room) is built** in the commit after efb166ef (see "What's left" 1 for its state and CI).
- **waarm64 `main`** (origin): loops 0–6, 10, 10b, 12, 13 are done; two out-of-context
  reviews of the page's demo code (branches `review/demo-page`, `review/demo-page-2`, kept on origin), every finding
  fixed or left by the user's decision ("Awaiting the user's review"). Three demos in deploy/disks/demos.json:
  `alpine-term` (Alpine at a root prompt; also New machine's template), `arch-desktop` and `arch-3d` (the Arch desktop,
  resumed with foot counting 10 s down to Firefox or the shader demo). Built locally: `target/demos/{alpine-term,
  arch-desktop,arch-3d,pieces}` (the desktops from bench/results/local/demo/site, made by the page copy in
  bench/results/local/demo/dist). **Nothing of the track is deployed.**
- **Numbers** (bench/demo/REPORT.md, local through a modelled 100 Mbit/s / 20 ms link): Alpine click → command
  2.9–3.0 s, 24.7 MB ("DEMO loop 3"); arch-desktop click → desktop 12.7 s, 140 MiB, arch-3d 13.2 s, 145 MiB
  ("DEMO loop 12"). comparison.md §3 has Alpine's, marked local.
- **Loop 12's CI:** ci.sh at `c2bacdcf` (green but page-open's "a machine running in another tab", 8.9 s against its
  10 s wait at load ~15: the known timing flake below, passed alone in 2.2 s); ci-machines.sh and ci-graphics.sh at
  `704702da` (the desktop step ran: desktop 2.5 s, Firefox's window 28.6 s); `704702da`'s own change by its unit test
  and tsc; the commits after it are this file's only.
- **The track's docs are in docs/ already** (this session moved them; an Explore agent checked the kickoff, the plan
  and this file against docs/): decisions.md "Network" and "Demos" (the kickoff's decisions, which docs and code now
  cite instead of the kickoff), remote-disks.md "Publishing", "Building" and **"Deploying the demos"** (the runbook),
  networking/demo-network.md (with "Not taken, and why": Wisp, Workers, a mode of the helper), frontend.md "The demo
  store", machines.md §6, clipboard.md, images.md, backlog.md (the demos' loose ends).
- **waarm64-demonet `main`** (origin, private): `77a669d`. Loops 7–9, 11, 14 (the slow lane, **off by default**) and
  their reviews done; `deploy/` (a distroless image, compose.yaml behind the host's Caddy; README "In a container");
  `forwarded-ignored` counts private peers too (77a669d). **Hosted by the user at `wss://demonet.tny.im/`**
  (2026-11-19), checked from here: hello, budget, and `forwarded-ignored 0` in its counters. Its HANDOVER.md has its
  state, backlog and the owner's open numbers.

### The user's decisions since the kickoff (2026-11-19), all binding

1. The kickoff's "Needs the user's OK" is **red lines** (stop and ask: deploys, allowlist rules past
   `dl-cdn.alpinelinux.org`, new dependencies, the slow lane's numbers or turning it on) and **engineering calls**
   (make them, list them under "Awaiting the user's review"). Definition-format changes may skip a migration if it
   costs too much (say so under "Before you load this build").
2. The `alpine-demo` image is **barebones like unkernel's** (nothing preinstalled beyond Alpine's base).
3. **Hosting the fork is the user's** (done: decision 10).
4. **CI is the coordinator's**: subagents don't run scripts/ci*.sh; one CI script at a time on the machine.
5. The demo server's URL is **`wss://demonet.tny.im/`**.
6. The Alpine agent's install command is in an **informational modal from a link under the clipboard-sharing
   setting**. **Copy rules (docs/copy.md) apply** to every word the page shows: no distributions named, colons only to
   announce (the user rejected a first wording for both).
7. **Clipboard sharing starts paused for every machine made from a demo** (each run; not remembered).
8. Disk cleanups done with the user's OK (old Podman images, old desktop qcow2s, `target/debug`, the gdb guest,
   `target/snapbench`, `target/vk2-nvidia-bundle.tar`); 32 GB free.
9. `?disk=<url>&clipboard=1` **stays as is** (the transient machine has no network unless the user attaches one):
   clipboard.md.
10. **The desktop demos resume with foot counting down to their app** (the user's idea), not with the app in the
    snapshot; `init_on_free` dropped (its cost on every free in the visitor's machine). The demo server is hosted.
11. **DO NOT DEPLOY** (the user allowed a deploy after loop 12, then withdrew it: "DO NOT DEPLOY"), so the demos
    don't have to be replaced on the live site when loop 15 changes them. Ask before any deploy.
12. **Loop 15** (below) is the user's: a second adapter on the global public room for every demo machine, a node key
    per machine (else they'd share an address), and **the agent configuring an unmanaged, connected card on
    Alpine**, for every Alpine user with the agent (OK'd).
13. **Images CI or the Desktop Demo use stay as they are** (`alpine-uefi`, `target/arch/desktop.qcow2`).
14. **Loop 15's answers** (the user, 2026-11-19): the room **only for demos that ask** (`demo.room: "global"`; all
    three ask); **direct when possible** (not relay only); **incoming connections on**; the start panel's words as
    proposed plus a sentence that only the relays see the IP address and another visitor learns it only by
    connecting, "which requires knowing your machine's name" (the user's wording). The agent configures a card only
    where no systemd runs (the user checked: networkd's units manage the cards there).

### What's left, in order

**1. Loop 15 and 15b: a second adapter on the global public room for every demo machine, and its names on Alpine —
built, not yet through CI.**
What it is (docs: rooms.md "A demo's room", devices.md "A card nothing else manages", adapters.md §1 rule 2,
decisions.md "Network"):
- `demo.room: "global"` (definitions.ts, definition-check.ts: needs two adapters; tools/demo-site.ts carries it);
  web/app/net-demo.ts `withDemoRoom` makes a room connection per machine (`forMachine`, named as the machine, its key at
  the first start), `deleteOwnConnections` on the machine's Delete (MachinePane).
- The agent's CARDS (frame 32, `CAP.CARDS` bit 18; agent/src/card.rs): the page names the connected cards at each HELLO
  and change (web/app/net-settled.ts `macs`/`listen`, agent-actions `cards`, agent-link `cards`); on a guest without
  systemd, networkd or NetworkManager, a down card no ifupdown file names and no DHCP client runs for gets
  `accept_ra_rt_info_max_plen` 128, `ip link set up`, `udhcpc6` with the agent's script (/run/waarm64-udhcpc6.script).
  LEASE renews udhcpc6 too. The agent image rebuilt (SHA256SUMS).
- deploy/disks/demos.json: all three demos `room: "global"`, a second MAC each; templates rebuilt in target/demos
  (alpine-term; the desktops: see below). The start panel's note `DemoStart.room`.
- Tests: agent/src/card.rs (5), tests/agent-link.test.ts CARDS, tests/agent.test.ts pins, tests/demo-store.test.ts
  (the room per machine, delete), tests/demo-site.test.ts (a room on one adapter refused), and
  **tests/page-demo-room.test.ts** (ci-net.sh's last step: two Alpine demo machines on the fork's server and a room
  through the rig; eth1's address, the /48 on eth1, defaults on eth0, pings both ways: **passed alone, 16 s**).
  tests/page-demos-guest.test.ts strips `room` (CI never joins the public global room).
- **Loop 15b, names on Alpine** (the user's choice of the agent as resolver, "only where the udhcpc logic is used"):
  agent/src/resolve.rs, a DNS forwarder process forked once the agent brought a card up, on 127.0.53.53:53 (UDP,
  TCP), holding `/etc/resolv.conf` while a card's lease gave resolvers (udhcpc6's script writes
  /run/waarm64-dns/<card>), the upstreams udhcpc wrote kept in its comments, given back when the leases go or the
  agent ends (its pipe closes). devices.md "Names through the agent". The room test pings by full name and by first
  label, and resolves a name upstream (passed alone, 26 s).
- **Left:** one CI round at 15b's commit (all three templates rebuilt once, with 15b's agent): ci.sh, ci-net, ci-machines,
  ci-graphics (link target/demos/{arch-desktop,arch-3d,alpine-term,pieces} into ../waarm64-ci first), then push.

**2. The track's end** (kickoff "The end"), after loop 15 (and a deploy only if the user asks for one):
- An **out-of-context review** of the page's demo code since review/demo-page-2 (the clipboard pause, loop 12's
  build and countdown, loop 15), its findings fixed (each with its failing test first) or filed.
- **The whole CI set** on the final head: ci.sh, ci-net, ci-debian `--platform`, ci-graphics, ci-machines, ci-audio,
  ci-jit, ci-fp, ci-deqp, ci-deqp-vk, ci-usb.
- **Docs:** check once more that docs/ says what DEMO-KICKOFF.md, plans/first-demo.md and this file say that's
  long-term (most moved on 2026-11-19); drop docs/README.md's row for plans/first-demo.md; PLAN.md's DEMO row set to
  done (one line); then delete DEMO-KICKOFF.md, this file and docs/plans/first-demo.md in that commit. "Awaiting the
  user's review" and "Before you load this build" go to the user first (or into the docs where they're facts).
- **The deployed numbers** only if a deploy happened (runbook step 7; bench/demo has no target for the deployed store
  yet), into bench/demo/REPORT.md and comparison.md §3.

**Deploy facts not in the runbook:** `target/dist` in the main checkout is an old copy (27eb7884): never deploy it.

### How to work here

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
- **Disk:** 150 GB, ~32 GB free. A desktop template build needs ~6 GB of scratch; clean `.work/` and plain
  snapshots as soon as they're done with.
- **The demos' builds** (remote-disks.md "Building the demos"): a desktop takes ~3 min; the CI worktree needs
  `target/demos/{arch-desktop,arch-3d,pieces}` linked in from main (`cp -al`, the old entries removed first) or
  ci-graphics' desktop step skips. A build's failure leaves a screenshot `<site>/<id>-failed.png`. Commands typed into
  the guest's shell from make-template.ts: in single quotes, write `"` bare (a `\"` makes GNU grep warn and the count
  unreadable: it cost one build).
- **Watch background logs with a Monitor whose filter covers failure too**, and stop it when its log is rewritten (a
  watch on a reused log path replays the old run's lines).
- The fork pushes only as `git -C /home/gabriel.guest/Development/waarm64-demonet push` (the user's allow rule).

## Before you load this build (for the user)

- **Loop 4 (definitions v2):** nothing to export first. Definitions of version 1 still import (the reader takes 1 and
  2), and machine records are unchanged but for an optional `fromDemo`. One thing to know: an exported definition is now
  version 2, which a page from before loop 4 refuses.

- **Loop 3 (snapshot codec 3):** nothing to export first. Kept snapshots stay LZ4 and load as before; only templates made
  with `--deflate` are the new container version 3, which a page from before loop 3 refuses as newer.

## Awaiting the user's review

- **Loop 15's engineering calls:** the room's connection is the machine's (`forMachine`), deleted with it unless
  another machine was attached to it since; a fresh copy of a demo gets its own. CARDS is a new frame (not LEASE at
  every connection, which would have nmcli reconnect cards a user disconnected). The agent's card: only down cards,
  only without systemd/networkd/NetworkManager, IPv6 only, resolvers left alone, never taken down. The udhcpc6 script
  lives at /run/waarm64-udhcpc6.script (outside the agent's tmpfs, so it outlives the service). Template recipes got a
  second random MAC each (a shape change: new snapshots under the same ids).
- **Loop 15b's engineering calls:** the forwarder listens on 127.0.53.53 (not 127.0.0.1: a user's resolver may be
  there); it runs only where the agent brought a card up, for any such card's lease with resolvers (a tailnet's
  MagicDNS on Alpine too, not only a room); non-room names go to every upstream at once, the first answer that isn't
  SERVFAIL/REFUSED relayed (musl's own behavior); TCP by a child per connection; the upstreams kept in resolv.conf's
  comments so a restarted forwarder recovers them. A forwarder killed alone (OOM) leaves resolv.conf naming it until
  udhcpc's next rewrite; the agent starts it again at its next CARDS.

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
