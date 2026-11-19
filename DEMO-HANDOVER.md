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

- **The fork, loop 7 done** (waarm64-demonet `6de5a2b`, pushed): a network per WebSocket, per-IP budgets, the TOML
  file with reload and `--check`, close codes 4001/4003/4008–4010; fails closed until loop 8 (running beside).
- **Loop 0** (pushed): `bench/demo/` and the gap, [bench/demo/REPORT.md](bench/demo/REPORT.md) "DEMO loop 0".
- **Loop 1, the spike, done** (2026-11-19, committed unpushed): an Alpine template restored in a fresh profile,
  offline, through a modelled 100 Mbit/s / 20 ms link: **click → a command answered in ~3.4 s, ~32 MB on the wire**
  (page 2.5 MiB brotli'd, snapshot 24.0 MiB, disk 4.0 MiB), with the image booted with `init_on_free=1` and the
  guest's caches dropped before the snapshot (REPORT.md "DEMO loop 1"). Code: a chunked image's identity is its
  content (`{kind:'url', chunked, bytes}`, machines.md §3.1), a machine from a template (`web/app/template.ts`,
  `restoreFirst` on the record, machines.md §6.1), a machine's first restore fills its fresh overlays, one shared
  `pieces/` (`tools/chunk-image.ts --pieces`, `_headers`). The harness: target `waarm64-template` (`DEMO_LINK`,
  `DEMO_TEMPLATE`), `bench/demo/make-template.ts`, `spike-image.sh`, `site.ts`, `snapinfo.ts`, `ramcodec.ts`.

## Next: loop 2, the guest agent on Alpine

Decision 14: an OpenRC service for the agent (from fw_cfg or the image), udhcpc (and dhcpcd: the cloud image runs
dhcpcd, not udhcpc) in `agent/src/lease.rs`, the clock set at a restore; tested with a template restored with an old
clock (`apk` over TLS works after it). What loop 1 leaves for it and later loops:
- The spike's template has no agent: the restored guest's clock is the template's (the page's `clocksync` needs the
  agent), and its lease is whatever dhcpcd got at the template's boot (IPv4LL with no connection).
- **For loop 3's image (measured, do these):** `init_on_free=1` on the kernel's command line (free memory is zero in
  the snapshot: −7.7 MB of LZ4), Limine's `timeout: 0` (the spike image's boot is 23 s to the prompt, 10 s less), no
  tiny-cloud, sshd, chronyd. **For loop 5's builder:** drop the guest's caches before the template's snapshot (−7 MB;
  costs one more 2 MiB piece by the first command). `bench/demo/make-template.ts` is the builder's seed.
- **The next biggest cut (not built, a format change):** the template's RAM frames packed with deflate (the
  browser's `DecompressionStream('deflate-raw')`, no dependency; the core inflates already) instead of LZ4: the
  snapshot's RAM 25.0 → 16.0 MB, the whole download ~32 → ~23 MB. A new frame codec the reader takes beside LZ4
  (republished templates only); loop 3 or 5 should build it (REPORT.md "What would close the gap").
- The store's click (loop 6) calls `machineFromUrls` (web/app/template.ts) as the `?hooks` hook does; the definition
  format's `demo.snapshot` (loop 4) replaces the hook's second argument. The site's layout is decision 17's: the
  publish tool (loop 4) writes it with `chunk-image.ts --pieces`.

## Open questions

None.

## Awaiting the user's review

- **Loop 1's engineering calls:** a chunked image's disk identity is now `{kind: 'url', chunked: <manifest id>, bytes}`
  (no path), for disks added from now on; disks added before keep their old identity (path + `etag`), so their
  overlays and snapshots stay valid, and adding the same URL again finds them: no migration, nothing to export first.
  A machine record may carry `restoreFirst` (a kept snapshot its first start restores without asking). A machine's
  first restore writes into its never-written overlays rather than forking beside them (only then: a restore the
  user asks for leaves their overlays alone).
