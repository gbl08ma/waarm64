# Disks from a remote server (in progress since 2026-10-23)

**Status:** R0 (the measurement) and R1 (a block cache) done: a remote desktop boot to Firefox 196 → 110 s
(bench/remote-disk/REPORT.md). Decided with the user (2026-10-23): no Cloudflare in this track (R2's pieces are
measured on the user's server and on a local one that answers as Pages does), the cache kept in OPFS bounded by
min(4 GiB, 25% of the free quota) with an LRU across images, the loops R0–R5 then compression in order.

The page can boot a disk image from a URL (`?disk=<url>`, docs/frontend.md "Your own disk"), and since 2026-10-17 it is
deployed publicly (below, "Where the page is deployed"). A disk on another server, not localhost, is what a hosted page's
users get, and today's reader was built for localhost. This plan is how to make a remote disk fast, and where to host
one. Its first session starts from `M8-REMOTEDISK-HANDOVER.md`.

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

Cloudflare's free plan (checked 2026-10-17 in Cloudflare's docs):

| Option | Ranges | Edge cache | Limits | Code change |
|---|---|---|---|---|
| **R2, the whole image**, on a custom domain (not `r2.dev`: rate-limited, development only, never cached) | yes | **no**: the free plan caches objects up to **512 MB** | 10 GB-month storage, 10 M reads (Class B) and 1 M writes a month, egress free; one read per range | none |
| **R2, the image in pieces ≤ 512 MB**, a Cache Rule making them eligible (`.qcow2` or a made-up extension isn't in the default cached list; `.bin`, `.iso`, `.zst` are) | yes, from the cache once cached | yes, per data centre | as above, but cached ranges cost no R2 reads | the chunked format (§4) |
| **Pages, the image in pieces ≤ 25 MiB** (the `webpc` project or another) | **no**: Pages answers a `Range` with 200 and the whole file (measured on `QEMU_EFI.fd`) | yes | 20,000 files a site, 25 MiB a file, bandwidth unmetered | the chunked format, whole pieces |
| Proxying `static.gbl08ma.com` through Cloudflare | yes | no for files over 512 MB | | none, and no gain |

- **Cache misses on big pieces:** on a cold miss Cloudflare fetches the whole object from the origin (or, with its
  newer origin range fetching, cache-aligned ranges of it) and collapses concurrent misses into one. So the first
  read of a 512 MB piece in a data centre may wait on far more than it asked for. Smaller pieces (tens of MiB) are
  cached the same and fill faster; the size is a measurement (R2 below), not 512 MB because it's allowed. Each data
  centre caches on its own, and rarely read objects are evicted early on the free plan.
- **"Abuse":** Cloudflare's 2023 terms limit serving mostly large non-HTML files through its CDN in front of someone
  else's origin, not from its own storage and hosting (R2, Pages); a disk image on R2 or Pages is the intended use.
  Pieces don't change that; they only make the image cacheable.
- **Recommendation:** one chunked format (§4) that works on any static host. On Cloudflare, either Pages (small whole
  pieces; no ranges) or R2 with pieces of tens of MiB and a Cache Rule (ranges inside a cached piece). R2 pieces
  likely win per read (a 64 KiB read doesn't pull a whole piece), Pages wins on setup (it's where the page already is).
  Measure both from the page before choosing.

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

`https://vm.tny.im` (Cloudflare Pages, since 2026-10-17): how it's set up and redeployed from the dev VM is in
docs/frontend.md "Deployed at vm.tny.im".
