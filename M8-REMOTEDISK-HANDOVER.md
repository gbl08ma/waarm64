# M8 remote disks: handover (2026-10-17)

The page is now a static site (`npm run dist`, docs/frontend.md "A static copy") deployed at `https://vm.tny.im`, and
it can boot a disk from another server (`?disk=<url>`). The disk reader was built for localhost: one blocking request
per read, no cache. This handover starts the work of making a remote disk fast. **The plan is
[docs/plans/remote-disks.md](docs/plans/remote-disks.md)**: today's reader (§1), the numbers so far (§2), where to host
an image, Cloudflare's options among them (§3), the design and its loops R0–R5 (§4), the deployment.

Read first: remote-disks.md; docs/devices.md (blk, qcow2, the overlay); bench/io/REPORT.md (the local-disk I/O work:
its method and why it changed little); `web/devices.ts` (`httpSource`, `blk`), `web/qcow2.ts`, `web/overlay.ts`,
`web/iostats.ts`, `bench/io/` (suite, page, guest.sh).

## The first loop: R0, measure

1. Count a boot's base reads with the existing timers: a blk spec's `stats` wraps `Source.read` as `base.read`
   (web/iostats.ts, reported by `vm.close()`); the page doesn't expose them, so a bench page or a query switch is
   needed (bench/io/page.ts is the model). Per boot: reads, sizes (histogram), bytes, time in them, share of the boot.
2. The image: `https://static.gbl08ma.com/diskimages/desktop.qcow2` (the Arch desktop guest, images/arch/desktop.sh;
   1.58 GB, qcow2 v3; CORS is set up there for any origin). Boot it on `https://vm.tny.im/web/app/?disk=…` and on
   localhost (`npm run serve` with a local copy of the image, and with latency added: a delay in a test server's
   range answers is enough, no netem needed) to separate latency from bandwidth. `ready` is a getty's login prompt;
   the desktop starts after it, so pick an end marker that means "desktop up" (the guest-session tools in
   `bench/gpu/` find sway's and Firefox's).
3. Also measure what the blocked device worker costs besides the disk: input and display latency while a read
   waits (bench/io's screen-latency check under a continuous read is the model).
4. Write `bench/remote-disk/REPORT.md` with the JSON behind it, then pick R1's design from the numbers.

## Measure the inflate pool (a cloud session, 2026-10-18: built, not timed)

A request's compressed qcow2 clusters are now inflated as one batch, shared between the reading thread and up to
four workers (`web/inflate-pool.ts`, docs/devices.md "qcow2"); before, one after another on the reading thread.
Unmeasured (cloud CPU isn't for timing). On the dev VM, A/B against its parent commit, alternating:
- bench/io's sequential 1 MiB and 128 KiB reads and random 4 KiB reads, over a qcow2 of compressed clusters
  (`qemu-img convert -c`, 64 KiB clusters as Debian's published image) in place of the raw file;
- a Debian boot from its published (95% compressed) image on the page, and a stored disk's import of it
  (`importImage` in the disk worker) and a whole-disk export (the export worker), the last two with
  `?machine=debian` and the Machines page;
- the pool's size: 4 against 2 and 1 while vCPUs run (the device worker's pool shares the cores with them).
If a pool doesn't pay where the vCPUs run, give `blk` none (`openDisk`'s default inflates in place) and keep it in
the disk workers. Also run `scripts/ci-debian.sh` and `scripts/ci-machines.sh` (the cloud can't build EDK2).

## Rules that bite here

- Don't add dependencies (no bundler, no zstd library) without asking; Node's and the browser's APIs first.
- A disk change that the guest sees (read sizes, timing in deterministic mode) can move step counts: deterministic
  tests use local files and `file:` sources, so keep HTTP-only changes off those paths, or check `tests/steps.txt`.
- The overlay's identity is a URL's path and the size today: a chunked image needs an identity that changes when the
  content does (remote-disks.md §4.1).
- Cloudflare: deploying (`wrangler pages deploy`, R2 uploads, Cache Rules, DNS) is outward-facing: only when the user
  asks. Credentials are in `~/.config/cloudflare/webpc.env` (mode 600): source it, never print it. The token has Pages
  Edit and DNS Edit on `tny.im`, not R2 or Cache Rules; ask the user to extend it when a loop needs them. In the
  `tny.im` zone, only `vm` is ours.
- Measurements from the dev VM go through the Mac's network: say so beside the numbers, and repeat a remote number
  at another time of day before trusting a difference under ~20%.

## What exists for it

- `npm run dist` (tools/dist.ts), `npm run dist -- --serve` (preview with tools/serve.ts over the copy:
  headers and ranges, as a host must give), `tests/dist.test.ts`.
- `bench/results/local/live-pages.ts` (a Debian boot from a local file on a deployed page; `MAP="vm.tny.im <ip>"` maps
  the name in Chromium) and `bench/results/local/cors-probe.ts` (HEAD, range and suffix range from a page origin to a
  disk URL): untracked ad-hoc tools; move them to `bench/remote-disk/` if R0 keeps them.
