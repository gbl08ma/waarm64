# DEMO: handover

The kickoff is [DEMO-KICKOFF.md](DEMO-KICKOFF.md); the plan [docs/plans/first-demo.md](docs/plans/first-demo.md).

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

- **The fork, loop 7 done** (waarm64-demonet `6de5a2b`, pushed): renamed, its own docs, a network per WebSocket,
  per-IP budgets, the TOML file with reload and `--check`, close codes 4001/4003/4008–4010; fails closed (no
  forwarding) until loop 8. An idle network costs ~210 KiB RSS and 14 goroutines. wireguard-go and
  gvisor-tap-vsock agree on one gVisor. Loop 8 (the allowlist and egress) is running.

- **Loop 0 (measure the gap) is done** (2026-11-19, ci-fast.sh, pushed): `bench/demo/` (`run.ts`, `targets.ts`, `netlog.ts`,
  `procmem.ts`), numbers in [bench/demo/REPORT.md](bench/demo/REPORT.md) "DEMO loop 0" with `results/demo-0/*.json`,
  and in docs/comparison.md §3. Headline: unkernel answers a command 1.3 s after its link with 6.7 MiB and installs
  python3 in 7.7 s; our Desktop Demo 31.7 s and 420 MiB, no network; Alpine's cloud image on our page 48 s to a
  login prompt (33 s of it OpenRC/tiny-cloud after the kernel, waiting on DHCP with no adapter connection).
- The harness's targets: `unkernel`, `v86-buildroot`, `v86-arch`, `waarm64-desktop` (deployed vm.tny.im),
  `waarm64-alpine` (an `npm run dist -- --out bench/results/local/demo/dist` build served locally with
  `target/images/alpine-uefi/alpine.qcow2`), `blank`. A target is a URL, a console to read and type on, a prompt test,
  an optional login, `echo` and `apk` commands, and console `phases`. Results share one schema (`summary`: medians
  and IQRs of prompt/command/apk ms, bytes by mark, PSS/RSS).

## Next: loop 1, the spike

Add a target for the Alpine template restored from a snapshot (local hosting under the final path layout, fresh
profile, offline): a `serve` that hosts the build plus the template, a `prompt` on `running`, `echo` after the
restore (it's a logged-in shell). Notes for it:
- The local preview server sends the page uncompressed (78.7 MiB to the cloud image's prompt with the page's 46 MiB
  of files); for a deployment-like byte count, count the disk's and snapshot's bytes apart from the page's or serve
  compressed. The deployed page's own bytes are 6.1 MiB (vm.tny.im in the Desktop Demo runs).
- The Desktop Demo had 414 MiB of its disk fetched by the login prompt (remote-disk R6 measured ~100 MiB by
  systemd's start): the paced prefetch runs well ahead by then. Worth keeping in mind for the demo disks' bytes.
- `measureUserAgentSpecificMemory` reports ~24 GiB for our page (the shared memories' reservations): use PSS.

## Open questions

None.

## Awaiting the user's review

None yet.
