# DEMO: handover

The kickoff is [DEMO-KICKOFF.md](DEMO-KICKOFF.md); the plan [docs/plans/first-demo.md](docs/plans/first-demo.md).

## Start here (for a new session; 2026-11-19 ~20:30)

You're picking up the DEMO track (the first demo: a store of demo machines resumed from template snapshots, and a
hosted demo network). Read, in order: CLAUDE.md, [DEMO-KICKOFF.md](DEMO-KICKOFF.md) (binding; the user's words, edited
with their OK on 2026-11-19 for the red lines and loop 11), this file, and the fork's `../waarm64-demonet/HANDOVER.md`.
docs/plans/first-demo.md is background only: what binds is now in docs/decisions.md ("Network", "Demos"). **Do not
deploy** vm.tny.im or vmdisks.tny.im (decision 11) without the user asking. Every loop is done, and so are four out-of-context reviews and their fixes (review 4: f6252749). **The demos are
deployed** (4e81858b) and **the user validated them by hand** (2026-11-19: all three on their desktop's Nvidia GPU).
**Next: the user's items** ("What's left" 2), then the whole CI set, the deployed numbers and the track's end (a
CI set at f6252749 ran meanwhile: its results below). Review 4's fixes are page-side only (no agent or template rebuild); they reach vm.tny.im only with a
redeploy of the page (ask the user).

### Where things stand

- **waarm64 `main`** (origin): pushed through this file's commit. Loops 0–6, 10, 10b, 12, 13, 15 and 15b are done;
  three out-of-context reviews of the page's demo code (branches `review/demo-page`, `review/demo-page-2`,
  `review/demo-page-3`, kept on origin), every finding fixed or left by the user's decision ("Awaiting the user's
  review"). **Review 3** (9 findings) fixed in cbe02be1 but #7, filed (docs/backlog.md "The store's sweep never runs":
  the page never calls `Store.sweep`, which machines.md said it did; a template import's window before the record).
  The agent and alpine-demo images and the three templates were rebuilt after it. Three demos in
  deploy/disks/demos.json, each with the global room on its second adapter (`room: "global"`): `alpine-term` (Alpine
  at a root prompt; also New machine's template), `arch-desktop` and `arch-3d` (the Arch desktop, resumed with foot
  counting 10 s down to Firefox or the shader demo). Built locally, all three with review 3's agent (cbe02be1):
  `target/demos/{alpine-term,arch-desktop,arch-3d,pieces}`, made by tools/build-demos.ts from the checkout's core.
  **Deployed 2026-11-19 from 4e81858b** (the page, and the demos built by the checkout: the publish checks only the
  snapshot's format and shape): vmdisks.tny.im version af485190 (2047 files; the first deploy's templates' pieces
  removed, the user's go-ahead), vm.tny.im version dc7c6b87. Since the first deploy (c6a947e5): the desktops' templates
  are made before any GL client (d9fa199c: the first ones restored black on the Mac, its WebGL2's point size below
  SwiftShader's, so 3D was off), and the serial terminal fits its view with the agent's CONSOLE (ac51d59f, 4e81858b).
  Checked on the deployed page: the VM (SwiftShader) all three, the Mac's Chrome for Testing (Apple M4, Metal) both
  desktops with 3D on and no virtio-gpu error (bench/results/local/deployed-check.ts).
- **Loop 15 (a demo's room) and 15b (its names on Alpine):** docs rooms.md "A demo's room", devices.md "A card nothing
  else manages" and "Names through the agent", adapters.md §1 rule 2, decisions.md "Network". A room connection per
  demo machine (web/app/net-demo.ts `withDemoRoom`, `forMachine`, deleted with it); the agent's CARDS (frame 32,
  agent/src/card.rs) brings up a connected card nothing manages with udhcpc6 on guests without systemd, networkd or
  NetworkManager; its DNS forwarder (agent/src/resolve.rs, 127.0.53.53) holds `/etc/resolv.conf` there while such a
  card has resolvers, so room names resolve on musl. tests/page-demo-room.test.ts (ci-net.sh's last step): two
  Alpine demo machines on the fork's server and a room through the rig, pinging by address and by name.
- **Numbers** (bench/demo/REPORT.md, local through a modelled 100 Mbit/s / 20 ms link): Alpine click → command
  2.9–3.0 s, 24.7 MB ("DEMO loop 3"); arch-desktop click → desktop 12.7 s, 140 MiB, arch-3d 13.2 s, 145 MiB
  ("DEMO loop 12"). comparison.md §3 has Alpine's, marked local. CI's own runs after loop 15 (local, no link model):
  Alpine click → command 3.1 s; the desktop shown 2.5 s, Firefox's window 30.0 s.
- **CI at `cbe02be1`** (review 3's fixes), the whole set: ci.sh green but page-layout's "a notice's countdown goes
  on…" (two rings 400 ms after the move under load; passed alone; the test now waits for the move: next commit,
  ci-fast OK), ci-net OK (435 s; the room test now also kills the forwarder and restarts the service), ci-debian
  `--platform` OK (467 s), ci-graphics OK (198 s, the desktop step ran: click → desktop 2.5 s), ci-machines OK (342 s),
  ci-audio, ci-jit, ci-fp, ci-deqp OK, ci-deqp-vk OK (1079 s; the CI worktree needed `target/vkframes` linked in),
  ci-usb OK.
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
11. **Deploy only when the user asks** (the first deploy was done on their go-ahead, 2026-11-19, after review 3). Earlier: **DO NOT DEPLOY** (the user allowed a deploy after loop 12, then withdrew it: "DO NOT DEPLOY"), so the demos
    don't have to be replaced on the live site when loop 15 changes them. Ask before any deploy. **The user's plan
    (2026-11-19, after loop 15b): the first deploy of the demos system to vm.tny.im and vmdisks.tny.im comes after the
    out-of-context review and its fixes** (still asked for at the time).
12. **Loop 15** (done) is the user's: a second adapter on the global public room for every demo machine, a node key
    per machine (else they'd share an address), and **the agent configuring an unmanaged, connected card on
    Alpine**, for every Alpine user with the agent (OK'd).
13. **Images CI or the Desktop Demo use stay as they are** (`alpine-uefi`, `target/arch/desktop.qcow2`).
14. **Loop 15's answers** (the user, 2026-11-19): the room **only for demos that ask** (`demo.room: "global"`; all
    three ask); **direct when possible** (not relay only); **incoming connections on**; the start panel's words as
    proposed plus a sentence that only the relays see the IP address and another visitor learns it only by
    connecting, "which requires knowing your machine's name" (the user's wording). The agent configures a card only
    where no systemd runs (the user checked: networkd's units manage the cards there).
15. **Names on Alpine through the agent** (the user's choice of the options, 2026-11-19): the agent as a resolver,
    "only on distros like alpine; basically, whenever the udhcpc logic is used" (loop 15b). Coordinated with loop 15
    so the templates were rebuilt once and CI ran once, at 15b's commit.

### What's left, in order

**1. Done: the fourth out-of-context review** (`review/demo-page-4`, on origin; fixes f6252749, ci-fast OK): #1 the
serial terminal now keeps the size last told when the agent's connection ends (the guest's tty keeps it; 80×25 again
only at a new run), #2 a guest's reset after a restore gives back this browser's caps and 3D, #6 a Venus capset read
doesn't save the virgl caps, #7 docs; #3 not a defect (the fit's 2 px come out of the bottom padding: a per-height
check added, green before the change), #4 the re-login checks (Alpine, and now Debian) pass with the agent's tty hold
planted out (docs say so; the hold kept), #5 filed (backlog "A desktop demo's machine can wait for good").

**2. The user's items before the track closes** (2026-11-19, after review 4; each its own loop, then one template
rebuild and one whole CI set for all of them):
- **The divider in Both**: backlog "A divider to drag between the screen and the terminal in Both" (its whole design is
  there); the item leaves the backlog when done.
- **No padding around the serial terminal in its own view** (Terminal), as the screen has none in its own.
- **Colors in the serial terminal** (the user's approach, 2026-11-19: no agent change): a systemd drop-in in the
  page's SMBIOS strings (`SERIAL_TERM`, web/app/firmware-files.ts: `serial-getty@ttyAMA0.service`'s
  `TERM=xterm-256color`) for every firmware machine with systemd, and alpine-demo's `inittab` (`env
  TERM=xterm-256color login -f root`); alpine-uefi stays the stock cloud image. Written (local commit); checked by
  page-debian's `==term` line and, after the rebuild, by hand on the demos. A guest-visible change, the user's.
- **The desktop demos' countdown, and the others' words** (the templates rebuilt anyway; vmdisks' demo files replaced
  without regard for what's there, the user's words): the Firefox demo's countdown says that on the demo network the
  web is poor next to the local helper or a tailnet; that Chromium is installed too; that packages install with
  `sudo pacman -S <package>`, the `arch` user's password being `arch` (the user, 2026-11-19: the hosted demo server's
  allowlist already has the Arch image's package repository, so pacman works on the demo network; the cards' summaries
  in deploy/disks/demos.json, which say pacman can't reach its mirror, change with it); some of this applies to the
  other demos too. **Bug:** Ctrl+C at the countdown
  closes foot (the user's report): the countdown runs as `bash -c '$HOME/<script>; exec bash'`, and the SIGINT likely ends that
  `bash -c` too; Ctrl+C must leave the terminal open with a shell (most visitors don't know sway). Copy rules
  (docs/copy.md) for every word; the cards' summaries in deploy/disks/demos.json too.

- **Fresh image bases** (the user, 2026-11-19: `pacman -Syu` in the desktop demos finds plenty to update): rebuild the
  demos' images from today's bases before the templates are made again: the Arch desktop (`images/arch/desktop.sh`:
  base.sh's bootstrap tarball and the mirror's packages of the day) and alpine-demo (from alpine-uefi's pinned cloud
  image: move its pin to Alpine's current release; images/SHA256SUMS moves with it). Decision 13 kept CI's images
  (`alpine-uefi`, `target/arch/desktop.qcow2`) as they were; the demos build from those same files, so this changes
  CI's too: decisions.md is updated in the same change (the user's call, made here).

**3. The whole CI set** on the head after the fixes: ci.sh, ci-net, ci-debian `--platform`, ci-graphics, ci-machines,
ci-audio, ci-jit, ci-fp, ci-deqp, ci-deqp-vk, ci-usb (one at a time in ../waarm64-ci; link the rebuilt images,
`target/demos` and `target/vkframes` in first).

**4. The deployed numbers** (runbook step 7; bench/demo has no target for the deployed store yet: add one), into
bench/demo/REPORT.md and comparison.md §3. Today's single runs (not the bench's numbers), the deployed page at
4e81858b: on the VM (SwiftShader) alpine-term a command at 4.1 s, `apk add python3` at 13.7 s, the terminal 159×55 and
the guest's tty the same; arch-desktop Firefox's window at 56.3 s; arch-3d the shader demo's at 39.4 s; on the Mac
(Chrome for Testing, Apple M4 through ANGLE's Metal) arch-desktop 42.4 s, arch-3d 30.3 s, 3D on, no virtio-gpu error.
The check: bench/results/local/deployed-check.ts (git-ignored: `node <it> <out-dir> [id…]`; on the Mac, copied to
`~/waarm64-gpu-bench/check/` and run with `CHROMIUM` its Chrome for Testing, under `perl -e 'alarm N'`).

**5. The track's end** (kickoff "The end"): check once more that docs/ says what DEMO-KICKOFF.md,
plans/first-demo.md and this file say that's long-term; drop docs/README.md's row for plans/first-demo.md; PLAN.md's
DEMO row set to done (one line); then delete DEMO-KICKOFF.md, this file and docs/plans/first-demo.md in that commit.
"Awaiting the user's review" and "Before you load this build" go to the user first (or into the docs where they're
facts).

**Deploy facts not in the runbook:** `target/dist` in the main checkout is an old copy (27eb7884): never deploy it.
The main checkout's `target/disks` is now the deployed site (hard links of the CI worktree's, with the ledger
`.publish.json`): link it into the next deploy's checkout (runbook step 3). The site's files answer 404 for some
seconds after `deploy.sh` (seen once for `alpine-term/snapshot.json`): check again before calling a file missing.

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
- **Disk:** 150 GB, ~31 GB free. A desktop template build needs ~6 GB of scratch; clean `.work/` and plain
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

- **Review 4's engineering calls** (f6252749): when the agent's connection ends, the serial terminal stops fitting and
  keeps the size last told (not 80×25: the guest's tty keeps it); a new run (start, reboot, restore) is 80×25 again,
  and a restored guest's tty has the snapshotting page's size until its agent's HELLO. The agent's hold on the tty is
  kept though neither tested guest needs it. #5 (a desktop demo waiting for good if its first run ends before the
  HELLO) filed rather than fixed: a record field or a template rebuild for a window of about a second.
- **Review 3's fixes, the engineering calls** (cbe02be1): a forwarder that dies is given back by the root and started
  again at once unless it lived under 10 s (then at the next CARDS); 8 TCP children at most, each killed with the
  forwarder and after 15 s; the rooms' search domains now **after** the upstream's (musl stops at the first failing
  search domain; on the demo network there is no upstream domain, so nothing changes there); the agent marks the cards
  it brought up in `/run/waarm64-cards` and brings a marked one up again when its udhcpc6 is gone; the OpenRC stop falls
  back to `umount -l` (a guest-visible change to the service, in alpine-demo and the installer); a demo's room is made
  last and removed when the import fails. Not done: wrapping the import in the write lock (#7: a nested shared lock
  would deadlock behind a queued sweep), filed with the sweep the page never calls.
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
