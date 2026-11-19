# DEMO: handover

The kickoff is [DEMO-KICKOFF.md](DEMO-KICKOFF.md); the plan [docs/plans/first-demo.md](docs/plans/first-demo.md).

## Current state

- **Loop 0 (measure the gap) is done** (2026-11-19): `bench/demo/` (`run.ts`, `targets.ts`, `netlog.ts`,
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
