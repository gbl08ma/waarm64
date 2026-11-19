# DEMO: handover

The kickoff is [DEMO-KICKOFF.md](DEMO-KICKOFF.md); the plan [docs/plans/first-demo.md](docs/plans/first-demo.md).

## Before you load this build

- **Loop 4 (definitions v2):** nothing to export first. Definitions of version 1 still import (the reader takes 1 and
  2), and machine records are unchanged but for an optional `fromDemo`. One thing to know: an exported definition is now
  version 2, which a page from before loop 4 refuses.

- **Loop 3 (snapshot codec 3):** nothing to export first. Kept snapshots stay LZ4 and load as before; only templates made
  with `--deflate` are the new container version 3, which a page from before loop 3 refuses as newer.

## Where things stand (the coordinator, 2026-11-19 morning)

**Done and pushed** (each with its CI tier; waarm64 at `46901e44`, waarm64-demonet at `f8a6354`):
- Page: loops 0, 1, 2, 3, 4, 5, 6, 10, 10b (the slow lane's words, the held flap), 13; two out-of-context reviews of
  the page's demo code (`review/demo-page`, `review/demo-page-2`) and their fixes. Every commit passed ci.sh plus its
  topic scripts (ci-machines, ci-net, ci-debian as the area asked) in the CI worktree `../waarm64-ci`; failures seen
  under load (tailnet leases, page-open, page-ram) were rerun alone and passed, and the harness bug behind the tailnet
  ones was fixed (tests/serial-console.ts `run`).
- Fork: loops 7, 8, 9, 11 (its review: 10 findings fixed), 14 (the slow lane, off by default) and the slow lane's own
  review (8 findings fixed); `go test -race ./...` clean on a quiet machine (241 s).
- **The Alpine demo meets the goal's numbers locally:** click → command answered 2.9–3.0 s, 24.7 MB on the wire at a
  modelled 100 Mbit/s / 20 ms (bench/demo/REPORT.md "DEMO loop 3"). Not yet on the deployed page (no deploy).

**Blocked, for you:**
- **Loop 12 (the desktop and 3D demos) is stopped, uncommitted in the working tree:** auto mode refused its build
  command (`systemd-run … node tools/build-demos.ts --only arch-desktop --no-images --no-publish`, the same kind that
  ran three times before) with no reason given; the coordinator didn't work around it. Its state, its files and the
  remaining steps: `bench/results/local/demo/LOOP12-STATE.md` (git-ignored). Untested so far: the sway
  XDG_RUNTIME_DIR fix, the 3D demo's app, the screen-likeness threshold. Also its: review demo-page-2 #12 (below, Next).
- **The disk filled overnight** (100 %): freed 18 GB (the gdb debug guest, cargo's target/debug caches). ~19.5 GB of
  Podman images (old `webpc-*` tags among them) and a few old qcow2s are listed in the coordinator's memory to ask about.

**Left of the kickoff:** loop 12 (above); loop 15's last part (the comparison's numbers, the docs' final pass); the
deploys (yours: vm.tny.im, vmdisks.tny.im, the fork on your server, "Before a deploy" below) and the check by hand on
the deployed page; at the end, the whole CI set (ci-graphics, ci-jit, ci-deqp…) and the track's close.

## How the track runs (the user, 2026-11-19)

- The kickoff's "Needs the user's OK" is red lines (deploys, allowlist rules past `dl-cdn.alpinelinux.org`, new
  dependencies, the slow lane's numbers) and engineering calls the loops make and list here. Definition format
  changes: no migration if it costs too much, said under "Before you load this build". Hosting the fork is the
  user's follow-up, not loop 11's.
- CI is the coordinator's: loop agents run targeted, capped tests and commit unpushed; the coordinator runs the CI
  scripts one at a time and pushes.
- Two lanes: the page (this checkout) and the fork (`../waarm64-demonet`, its own `HANDOVER.md`: its state, open
  calls for the owner, what the page must add).

## Current state

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
- **Loop 2, the agent on Alpine, done** (2026-11-19, committed unpushed): an OpenRC service for the agent
  (`web/app/guest-agent.ts` `agentOpenrc`), reaching a user's own Alpine through a one-command installer the machine
  gives over fw_cfg (`opt/waarm64/openrc`: `modprobe qemu_fw_cfg; sh /sys/firmware/qemu_fw_cfg/by_name/opt/waarm64/openrc/raw`),
  since nothing stock on Alpine reads fw_cfg/SMBIOS/credentials at boot (devices.md "On OpenRC"); LEASE renews udhcpc
  (SIGUSR1) and dhcpcd (`dhcpcd -n`) found among the processes (`agent/src/lease.rs`); POWER falls back to busybox's
  `poweroff`/`reboot`; `body[data-lease]` says what a restore's lease renewal did. The clock and "ready" needed no new
  code: the agent's HELLO sets the clock and marks the machine up. Test: `tests/page-alpine-agent.test.ts` (ci-net.sh,
  ~2 min).

- **Loop 10, the page's side of the demo network, done** (2026-11-19, committed unpushed;
  [docs/networking/demo-network.md](docs/networking/demo-network.md)): the connection kind `demo` (no lock: any machines
  and adapters at once, a socket each; rules 2 and 4 of adapters.md and decisions.md's Network row changed), its client
  (web/demo-net.ts in web/demo-net-worker.ts: `waarm64-demonet.v1`'s control messages kept as the status and notices,
  reconnects by close code), its words (web/app/demo-view.ts; the Network menu's status, the message bar, the
  details), the wizard's step (NetDemoStep.svelte), and **for loop 4: `attachDemoNetwork(store, machine, adapter = 0,
  url?)` in web/app/net-demo.ts** (what `demo.network: "demo"` calls; `demoConnection` finds or makes the browser's one
  record). Tests: `tests/demo-net.test.ts` (fake server), `tests/net-live.test.ts`'s demo case, and
  `tests/page-demonet.test.ts` in `scripts/ci-net.sh` (Alpine against the fork built at the commit
  `tests/waarm64-demonet.ts` pins, `73d9a2d`; `WAARM64_DEMONET_SRC` overrides; cloud sessions SKIP).

- **Loop 4, definitions and the store's data, done** (2026-11-19, committed unpushed; machines.md §6.2,
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

- **Loop 3, the alpine-demo image, done** (2026-11-19, committed unpushed; docs/images.md `alpine-demo`,
  [bench/demo/REPORT.md](bench/demo/REPORT.md) "DEMO loop 3"): `images/build.sh alpine-demo` (alpine-uefi's image cut to
  Alpine's base, `images/alpine-demo/`; 73.0 MB, bit for bit, in SHA256SUMS); `bench/demo/make-template.ts` waits for
  the agent and deflates the template; **snapshot frame codec 3, raw deflate** (the core's miniz_oxide, no new export:
  `repackFrames` in web/snapshot-file.ts, `deflateCodec` in web/lz.ts, `tools/snapshot-template.ts --deflate`; the reader
  and the load pool's workers read 2 and 3; a file with deflate frames is container version 3). **Numbers at 100/20:
  click → command 2.9–3.0 s, 24.7 MB on the wire** (LZ4: 3.6–3.7 s, 33.5 MB): the goal's numbers met. Checked by hand
  through the local helper: python3, community's fastfetch and lua installed on first use.

- **Loop 6, the store's page, done** (2026-11-19, committed unpushed; docs/frontend.md "The demo store"): `/demos`
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

- **Review fixes (review/demo-page, 2026-11-19, committed unpushed):** R1 a chunked image's bytes checked against its
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

- **Loop 13, templates under New machine, done** (2026-11-19, committed unpushed; machines.md §6.3): New machine opens a
  dialog (`web/app/NewMachine.svelte`): Empty machine (what it made before) and our store's demos marked
  `demo.template: true` (`templatesOf`), each made by `machineFromStoreTemplate` (the definition without `demo`: no
  snapshot, no demo network, no `fromDemo`; a cold boot). The store unreachable: said, Try again, Empty machine works.
  `deploy/disks/demos.json`'s alpine-term is marked. Tests that clicked New machine use `tests/page-home.ts`
  `newEmptyMachine` (answers our store empty: no request leaves the machine). Tests: tests/demo-store.test.ts,
  demo-site.test.ts (Node); tests/page-demos.test.ts's New machine case (Chromium).

- **Loop 5, the automated demo build, done** (2026-11-19, committed unpushed; remote-disks.md "Building the demos"):
  `node tools/build-demos.ts [--core <wasm | target/dist>] [--apply]` remakes every demo with a `recipe` in
  deploy/disks/demos.json (the image name, the machine with a fixed MAC, the disk's serial) under its id into
  `target/demos/<id>/` (the image rebuilt if stale; make-template.ts with `--definition`, `--core` routed into the page,
  `--thumbnail`: thumb.webp), prunes the build's unnamed pieces, and plans the publish (dry run; `--apply` writes
  target/disks). ~32 s for alpine-term; the shape hash the same across builds (aa731d0b…, checked on two builds; the
  snapshot ids differ: RAM isn't reproducible). `target/demos/alpine-term` is built (from d686e684's core).
  scripts/ci-machines.sh builds it into target/ci-demos and runs tests/page-demos-guest.test.ts on it (passed: 21 s).

- **Loop 10b, the page's slow lane and the late address, done** (2026-11-19, committed unpushed): the demo client and
  its words take the fork's slow lane (off on the server by default: forward-compatible; demo-network.md): the lane
  `slow`, the slow budget and `slow-threshold`, `hello.limits.slow` in the status's details, every refusal's reason in
  words (`slow-connections`, `slow-spent` among them; an unknown one: the name alone), 4010's `closing.lane`. **The
  late address after a restore** (devices.md "The network after a restore"): a restored card holds the flap its switch
  onto the helper's or the demo network's frames owes until `LeaseActions` settles (`{type: 'settled', renewed}`;
  `HOLD_MS` 120 s at most), so the agent's LEASE no longer runs under a link that's down. page-alpine-agent (passed
  under load ~13) asserts `carrier_changes` unchanged across the restore; there the address came 5.6 s after the page's
  load (agent 1.4 s; dhcpcd). Not measured on alpine-demo's udhcpc template yet (loop 5's build, ci-machines).

- **Review fixes (review/demo-page-2, 2026-11-19, committed unpushed):** #1 a demo's start is its interstitial's (one
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

- Loop 5 is done (below). The remaining page loops: 12 (the desktop demo; give it a `recipe` in demos.json if it can
  be built the same way, or a hand-made build without one; **also review demo-page-2 #12**: `tools/demo-site.ts`
  `readSource` must require `build` to resolve under target/ (or `--out`) in a directory of its own, and
  `bench/demo/make-template.ts` refuse a `--name` with `/` or `..`, before its `rmSync(recursive)`), 14, 15.

## Open questions

None.

## Awaiting the user's review

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

- **Loop 10:** the default server URL is a placeholder, **`wss://demonet.tny.im/` (web/demo-net.ts `DEMO_URL`): the
  user's to confirm** once the fork is hosted (a connection keeps its URL: changing the default later needs a new
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
  fallback is left too. The page shows nothing new to a user: the install command is in docs/devices.md only (whether
  the page should say it, e.g. in Settings beside "Run the guest agent", is the user's call).
