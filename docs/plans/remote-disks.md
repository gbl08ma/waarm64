# Disks from a remote server (done, 2026-10-23)

**Status:** R0 (the measurement), R1 (a block cache), R2 (the chunked format: `tools/chunk-image.ts`,
`web/chunked.ts`; 2 MiB pieces boot as fast as ranges where a host has none), R3 (the blocks kept in OPFS,
`web/diskcache.ts`), R4 (requests in parallel, the device worker never blocked: its longest answer 0.7 s → 17 ms)
and R5 (a boot's reads in the manifest, fetched ahead: `tools/disk-trace.ts`) done: a remote desktop boot to Firefox
196 → 65 s, a local file's time, and a second boot 63 s (bench/remote-disk/REPORT.md); compression (§4.6) measured
and not built (the boot's bytes are qcow2's compressed clusters: 99% with gzip, brotli or zstd). Loose ends in
docs/backlog.md "Remote disks' loose ends". How it works now: docs/devices.md "blk" ("Over HTTP", "A chunked image"). Decided with the user (2026-10-23): no Cloudflare in this track (R2's pieces are
measured on the user's server and on a local one that answers as Pages does; after it, images on Cloudflare went to a Worker's static assets, never R2: §3 "Decided"), the cache kept in OPFS bounded by
min(4 GiB, 25% of the free quota) with an LRU across images, the loops R0–R5 then compression in order.

The page can boot a disk image from a URL (`?disk=<url>`, docs/frontend.md "Your own disk"), and since 2026-10-17 it is
deployed publicly (below, "Where the page is deployed"). A disk on another server, not localhost, is what a hosted page's
users get, and the reader of the time was built for localhost. This plan is how to make a remote disk fast, and where
to host one. §1 and §2 describe the starting point; the status line above, what was built.

## 1. Today's reader

- `httpSource` (`web/devices.ts`): a `HEAD` for the size, then **one synchronous XHR per read**, in the device worker,
  one at a time. No cache, no read-ahead, no concurrency (docs/backlog.md "virtio-blk over HTTP"; docs/devices.md).
- Above it, qcow2 (`web/qcow2.ts`) merges a request's clusters into host reads (ranges within 64 KiB of each other, up
  to 8 MiB), keeps every L2 table and the 16 most recent compressed clusters. Nothing is merged across requests.
- Above that, the OPFS overlay (`web/overlay.ts`) holds the guest's writes; reads of blocks it doesn't hold go to the
  base, every time (the guest's page cache is the only read cache).
- The device worker blocks while an XHR waits: every vCPU's disk I/O, and the other devices' work on that worker
  (input, the display's damage, sound, the network), waits behind one round trip. How much that stalls besides the
  disk is part of R0's measurement.
- Bench: `bench/io` (`io_stats`: per-stage counts, time and bytes through `web/iostats.ts`, a blk spec's `stats`) was
  built for a local `File` (bench/io/REPORT.md): there, file reads were 3.9% of a Debian boot and nothing was worth
  changing. Over a network, each read is a round trip instead of ~0.3 ms.

## 2. Numbers so far (2026-10-17, from the dev VM, not from a browser)

- `https://static.gbl08ma.com/diskimages/desktop.qcow2` (Caddy, the user's server; the Arch desktop guest, qcow2 v3,
  64 KiB clusters, ~22 GB virtual, 1.58 GB file): ~50 ms TCP connect, ~180 ms to the first byte of a 64 KiB range on a
  new connection, ~16 MB/s on a 32 MiB sequential range. CORS is set up for `/diskimages/` (any origin, `Range`
  allowed, `Content-Range` exposed, preflights answered), checked from `https://vm.tny.im` in Chromium: HEAD, a
  range and a suffix range all read.
- Not yet measured: how many base reads a boot makes, their sizes, the bytes, the time inside them. Guess: thousands
  of reads, so minutes of round trips for a desktop boot. R0 replaces the guess.

## 3. Where to host an image

What a host must give: range requests (or the chunked format below, which needs none), CORS for the page's origin
(`Access-Control-Allow-Origin`; `Access-Control-Expose-Headers: Content-Range`; answers to `OPTIONS` preflights with
`Range` allowed: a plain `bytes=a-b` range is CORS-safelisted, other forms aren't), HTTPS. A CORS response satisfies
the page's `Cross-Origin-Embedder-Policy: require-corp`; CORP isn't needed. The Caddy snippet the user's server uses:
`@diskimages path /diskimages/*` with `header @diskimages { Access-Control-Allow-Origin *; Access-Control-Expose-Headers
"Content-Range, Content-Length, Accept-Ranges, ETag" }`, and `handle` of `OPTIONS` there answering 204 with
`Allow-Methods: GET, HEAD`, `Allow-Headers: Range`, `Max-Age: 86400`.

### Decided (2026-10-23): images on Cloudflare are a Worker's static assets, never R2

**Where images are hosted:** `https://vmdisks.tny.im`, the Worker `webpc-disks` with static assets only (no script;
`deploy/disks/`: `wrangler.jsonc`, `_headers`, `deploy.sh`), serving `target/disks/` from the dev VM: a chunked image
per directory (`<name>/manifest.json`, `<name>/prefetch.json`, `<name>/pieces/`, 2 MiB pieces). The Desktop Demo:
`?disk=https://vmdisks.tny.im/desktop/prefetch.json`. Its `_headers`: CORS `*` on everything, pieces `immutable` (named
by their hash), manifests 5 minutes. Deploying replaces the whole site, so `target/disks/` holds every image that
stays; wrangler uploads only the pieces it hasn't seen. Deploy only when the user asks. The user's own server
(`static.gbl08ma.com/diskimages/`, Caddy, below) keeps the whole `desktop.qcow2` and the same chunked copy in `desktop/`.

**Why static assets:** Cloudflare's Workers pricing says "Requests to static assets are free and unlimited", and an
assets-only Worker runs no script: there is no per-request bill anyone could run up, a 404 or a made-up header
included. Checked: after a day of boots, URL comparisons and 404s against the page's assets-only Worker, the account's
Workers analytics (`workersInvocationsAdaptive`) counted **zero invocations**. Even a Worker with a script, on the
Workers Free plan, isn't billed past its 100,000 requests a day: it answers error 1027 (an outage, not a bill). Limits:
25 MiB a file and 20,000 files a version on the free plan (`deploy.sh` checks), no total size listed: ~40 GB at 2 MiB.
**No byte ranges** (measured on vm.tny.im: a `Range` gets 200 and the whole file, as Pages did), which is what the
chunked format is for: 2 MiB pieces boot as fast as ranges (bench/remote-disk/REPORT.md "R2").

**Why not R2** (set up and torn down the same day; the bucket `webpcimages` is deleted): every read R2 serves that the
edge cache didn't is one billed Class B operation, $0.36 a million past the free 10 M a month, and on a public bucket
anyone chooses how many of those happen (a "denial of payment"). Closing that took more than one rule, and the last
hole stayed open:
- `Cache-Control: no-cache` downloads are uncached reads too
  (https://community.cloudflare.com/t/questions-about-the-calculation-of-b-class-requests-for-cloudflare-r2/609909/3):
  a Cache Rule must force caching with its own edge TTL. `r2.dev` is never cached: off. An object over 512 MB can't
  be cached on the free plan at all (the whole image): pieces only.
- A query string is part of the cache key: `?random` missed every time until the rule took it out of the key.
- With CORS set on the bucket, R2 answers `Vary: Origin` and the edge keeps a copy per `Origin` value: a made-up
  `Origin` missed every time (measured). A WAF custom rule (it runs before the cache) refusing every `Origin` but the
  page's closed it.
- **A path that doesn't exist** misses every time (a 404 is cached per path, and random paths are endless). R2's
  pricing page doesn't say whether a 404 is billed (only that unauthorized requests aren't). The free plan's one
  rate-limiting rule can't help: it matches on the path only (not the host), counts every request per IP (HITs too;
  counting only 404s or misses needs Business), over a fixed 10 s with a 10 s block. A limit above a real VM's bursts
  (up to 8 fetches at once, over 100 requests a second while prefetching, more behind a NAT) still lets one IP make
  ~17 M requests a day, more than the month's free 10 M; a lower one blocks real users.
- A Worker in front of R2 (answering the 404s itself) counts every request, real ones included, against the free
  plan's 100,000 a day: a first boot is 600–900 pieces, so ~100–160 first boots a day before error 1027.

**Other options considered** (free plan, from Cloudflare's docs, 2026-10-17):

| Option | Ranges | Edge cache | Limits | Verdict |
|---|---|---|---|---|
| **Worker static assets, pieces ≤ 25 MiB** (chosen) | no | yes | 20,000 files a version, 25 MiB a file; requests free and unlimited | nothing billable |
| R2, the whole image or pieces, on a custom domain | yes | objects ≤ 512 MB, with a Cache Rule | 10 GB-month, 10 M Class B reads a month free, egress free | billed per uncached read: above |
| Pages, pieces ≤ 25 MiB | no | yes | 20,000 files a site, 25 MiB a file | the same as static assets; Cloudflare's legacy product (the page moved off it: docs/frontend.md) |
| Proxying `static.gbl08ma.com` through Cloudflare | yes | no for files over 512 MB | | no gain |

- **Cache misses on big pieces:** on a cold miss Cloudflare fetches the whole object from the origin (or
  cache-aligned ranges of it) and collapses concurrent misses into one; each data centre caches on its own, and rarely
  read objects are evicted early on the free plan. 2 MiB pieces keep that small.
- **"Abuse":** Cloudflare's 2023 terms limit serving mostly large non-HTML files through its CDN in front of someone
  else's origin, not from its own storage and hosting; a disk image in a Worker's static assets is the intended use.
- **The Cloudflare token** (docs/frontend.md "Deployed at vm.tny.im") needs no R2, Cache Rules or WAF permission for
  this; if images ever go to a bucket again, every point above comes back first.

## 4. The design, to measure piece by piece

1. **A chunked image:** a manifest (JSON: total size, piece size, the pieces' URLs relative to it, a hash per piece
   for identity and integrity) and the file cut into equal pieces at byte offsets, so qcow2 and the overlay are
   unchanged: it's another `Source` (`read(off, len)` mapped to pieces). A piece is fetched whole where the host has
   no ranges (Pages) or as a range where it has (R2, Caddy). A tool cuts an image (Node only, no dependency;
   `tools/`). `?disk=` takes the manifest's URL; the overlay's identity is the manifest's (a URL's path today: a new
   image under the same URL must not meet the old overlay; the pieces' hashes give an identity that changes with
   the content).
2. **A read cache of large aligned blocks** (1–4 MiB, or the piece) in the device worker, LRU, with read-ahead on
   sequential access. Many small guest reads become one request. Over HTTP whole files too, not only pieces.
3. **The cache kept in OPFS** (beside the overlay, or in it as read-only "base" blocks): a reload, a second boot,
   a Suspend's resume read locally. Quota and eviction rules needed (the overlay has no quota handling yet).
4. **Requests concurrently:** the guest has many requests in flight (virtio queue, readahead); today the device
   worker answers them one by one, blocking. Asynchronous `fetch` with completions through `Devices.poll` (qcow2's
   compressed clusters already complete asynchronously) lets HTTP/2 carry several at once and keeps the device
   worker serving input and display while a read waits. Deterministic mode must stay exact (it uses local `File`s
   and `file:` sources, so async HTTP may be realtime-only).
5. **A boot's read trace shipped with the image:** record which pieces a boot reads in what order, put the list in
   the manifest, and prefetch those pieces in parallel when the page opens the disk. Likely the biggest win for a
   first boot; measure after 2–4.
6. **Compression:** the pieces compressed (`Content-Encoding` from the host, or zstd/deflate inside, inflated with
   `DecompressionStream`), where the image isn't qcow2-compressed already (Debian's image is 95% compressed
   clusters; the desktop image's share is unmeasured).

Loops: **R0** measure (a desktop boot from `static.gbl08ma.com` on `vm.tny.im` and on localhost with added latency:
reads, bytes, sizes, time in reads, the device worker's stalls), **R1** the cache and read-ahead (2), **R2** the
chunked format and the tool (1) with Pages and R2 measured, **R3** OPFS persistence (3), **R4** concurrency (4),
**R5** the boot trace (5). Each ranked by the time from opening the disk to the desktop and by the second boot's.

## Where the page is deployed

`https://vm.tny.im` (since 2026-10-17; a Cloudflare Worker with static assets since 2026-10-23): how it's set up and redeployed from the dev VM is in
docs/frontend.md "Deployed at vm.tny.im".
