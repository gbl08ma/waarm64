# M8 remote disks: handover (2026-10-23)

Making a disk on another server fast. **The plan is [docs/plans/remote-disks.md](docs/plans/remote-disks.md)**
(its status line has the user's decisions of 2026-10-23); **the numbers are bench/remote-disk/REPORT.md**.

## Where it stands

- **R0 done:** a desktop boot from `https://static.gbl08ma.com/diskimages/desktop.qcow2` is its disk's round trips
  (2160 reads one at a time, ~47 ms each from the dev VM; 196 s to Firefox's paint against 64 s locally). A local
  server with 47 ms added per request reproduces it (181 s): iterate on that, check on the real server.
- **R1 done:** `web/blockcache.ts` (1 MiB blocks, 256 MiB LRU) under every HTTP source of the device worker: 196 →
  110 s remote, 181 → 82 s at 47 ms. Remote is now one stream's bandwidth (10 MB/s) plus 425 round trips.
- **R2 done:** the chunked format (`tools/chunk-image.ts`, `web/chunked.ts`: a `.json` disk URL is a manifest;
  content-addressed pieces, by range or whole). Free where the host has ranges; 2 MiB pieces (the tool's default)
  boot as fast as ranges where it has none. An 8 MiB cut is on the user's server:
  `https://static.gbl08ma.com/diskimages/webpc-test/desktop-chunk8/manifest.json`. Local cuts at 1, 2, 4, 8 and 25 MiB
  in `target/images/remote/chunk*/`. 47 ms and 20 MB/s locally (`local:/d47/r20`) lands where the real server does.
- **R3 done:** `web/diskcache.ts` keeps the fetched blocks in OPFS (`remote-cache/<key>/`, keyed by a chunked image's
  id or the URL, size and validator): a second boot 109 → 63 s, no requests. The guest's writes go first: a short OPFS
  write makes the store give up, a failed disk write releases every store and is retried (Chromium's incognito
  quota is ~0.8 GB though `estimate()` says 3.2). The Machines page's storage footer shows and clears it.
- **R4 next:** requests in parallel (`Devices.poll` awaits each request in order today, and the device worker blocks
  up to 2.2 s behind back-to-back reads); only in realtime mode. Then R5 (a boot's read trace in the manifest,
  prefetched), then compression (§4.6).
- **An image finding to act on:** a fresh overlay is the image's first boot, so `ldconfig.service` runs (44 s of the
  remote boot): a hosted image should be built with `/etc/.updated` and `/var/.updated` newer than `/usr`
  (`ConditionNeedsUpdate`), or booted once before publishing. Not yet tried.

## Tools

- `node bench/remote-disk/boot.ts <label> <url | local:/d47[/r20][/pages]>`: one boot to Firefox's paint, JSON in
  `bench/results/local/remote-disk/`; `summary.ts` per phase; `simulate.ts` replays a trace through a block cache.
  Needs `target/images/remote/desktop.qcow2` (a copy of the hosted image: `curl -o` it from the URL above).
- The page's `?iostats`: `window.__ioStats()` gives the disks' stage timers, base-read traces and cache counters.
- Each boot is 1.5–3.5 min: run it in the background with `timeout`, under a `systemd-run` memory cap.

## Rules that bite here

- **No Cloudflare work and no deploys** (the user's, 2026-10-23).
- **The user's server** (production): `rsync … skybox-diskimages:` (an ssh alias, an rrsync-only key into
  `/srv/http/static.gbl08ma.com/diskimages`, served at `https://static.gbl08ma.com/diskimages/`). Our files go under
  `webpc-test/` only, uploaded with `--chmod=D755,F644`; never touch `desktop.qcow2`.
- Don't add dependencies without asking. Deterministic boots must keep their step counts: the cache and the chunked
  source change only host reads; concurrency (R4) must stay out of deterministic mode.
- Measurements go through the Mac's network: repeat a remote number at another time of day before trusting a
  difference under ~20%.
