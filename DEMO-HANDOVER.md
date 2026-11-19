# DEMO: handover

The kickoff is [DEMO-KICKOFF.md](DEMO-KICKOFF.md); the plan [docs/plans/first-demo.md](docs/plans/first-demo.md).

## Before you load this build

- **Loop 4 (definitions v2):** nothing to export first. Definitions of version 1 still import (the reader takes 1 and
  2), and machine records are unchanged but for an optional `fromDemo`. One thing to know: an exported definition is now
  version 2, which a page from before loop 4 refuses.

## How the track runs (the user, 2026-11-19)

- The kickoff's "Needs the user's OK" is red lines (deploys, allowlist rules past `dl-cdn.alpinelinux.org`, new
  dependencies, the slow lane's numbers) and engineering calls the loops make and list here. Definition format
  changes: no migration if it costs too much, said under "Before you load this build". Hosting the fork is the
  user's follow-up, not loop 11's.
- CI is the coordinator's: loop agents run targeted, capped tests and commit unpushed; the coordinator runs the CI
  scripts one at a time and pushes.
- Two lanes: the page (loops 0–6, this checkout) and the fork (loops 7–9, `../waarm64-demonet`, its own
  `HANDOVER.md`). Loop 7's waarm64 side (`tests/waarm64-demonet.ts`, devenv.md) moved to loop 10.

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

## Next: loop 5, the automated demo build

- One command that makes each demo's build into **`target/demos/<id>/`**, which is where `deploy/disks/demos.json`
  points (`bench/demo/make-template.ts --site target/demos --name alpine-term` writes that layout: `manifest.json`,
  `snapshot.json`, `definition.json`, pieces in `target/demos/pieces/`), then runs `tools/publish-demos.ts`. The tool
  refuses a template whose core format or shape hash differs from the checkout's: that's the cue to rebuild. An id's
  image must not change (a new image is a new id with `replaces`).
- make-template.ts still writes a version-1-looking export (it calls `exportDefinition`, now version 2) with no `demo`:
  the card comes from demos.json, so nothing more is needed. The card's `download` can be left out (the tool writes the
  floor: snapshot + thumbnail + the image's prefetched pieces); a boot trace in the image's manifest makes that floor
  include the disk's reads.
- `scripts/ci-machines.sh` test: make a template from the local build, publish it into a temporary site, and restore
  it through `fetchStore` + `machineFromDemo` (tests/page-template-first.test.ts's second case is the stand-in version).

## Next: loop 3, the alpine-demo image

`images/build.sh alpine-demo` (decision 14, the user's barebones list). What loops 1–2 leave for it:
- **The agent's service baked in:** `/etc/init.d/waarm64-agent` with `agentOpenrc()`'s text (web/app/guest-agent.ts; e.g.
  `node -e` importing it, or a small tool, on the host before Podman) and its symlink in `/etc/runlevels/default/`. It
  runs nothing where the machine gives no agent. **udhcpc** as the client (no dhcpcd package: ifupdown-ng then runs
  udhcpc), which LEASE renews by SIGUSR1 (seen working in the test: busybox 1.37 logs "sending renew to server").
- **Measured in loop 1, do these:** `init_on_free=1` on the kernel's command line (−7.7 MB of LZ4), Limine's
  `timeout: 0` (−10 s of boot), no tiny-cloud, sshd, chronyd. **For loop 5's builder:** drop the guest's caches
  before the template's snapshot (−7 MB). `bench/demo/make-template.ts` is the builder's seed; with the agent in the
  image the template's boot reaches `running` (no more `booting` with root logged in), and a restore sets the clock.
- `tests/page-alpine-agent.test.ts` is the seed for loop 5's ci-machines test (it makes a template on the page and
  restores it in a fresh profile through `machineFromTemplate`; its card on the local helper).
- **The next biggest cut (not built, a format change):** the template's RAM frames packed with deflate (the
  browser's `DecompressionStream('deflate-raw')`, no dependency; the core inflates already) instead of LZ4: the
  snapshot's RAM 25.0 → 16.0 MB, the whole download ~32 → ~23 MB (REPORT.md "What would close the gap"); loop 3 or 5.
- The store's click (loop 6) calls `machineFromUrls` (web/app/template.ts) as the `?hooks` hook does; the definition
  format's `demo.snapshot` (loop 4) replaces the hook's second argument. The site's layout is decision 17's: the
  publish tool (loop 4) writes it with `chunk-image.ts --pieces`.

## Open questions

None.

## Awaiting the user's review

- **Loop 4's engineering calls:** version 2 is version 1 plus `demo`, so there's no migration; exports write 2. No
  `needs` field: 3D, Vulkan and RAM come from the machine's own fields, so they can't disagree. `replaces` is a list,
  so v3 can name v1 and v2 both. The page ignores fields it doesn't know, while the publish tool refuses them. A
  store's unreadable demo is skipped and said, not fatal. `fromDemo.store` is the store's absolute URL (another host's
  store with the same id is another demo). A copy keeps `fromDemo` and drops `restoreFirst` (that mark used to be copied:
  a small bug). Publishing is a dry run unless `--apply`. Retired demos keep their files until the 15,000-file budget,
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
