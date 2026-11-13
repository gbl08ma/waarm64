# Disk images on a server

The page boots a disk from a URL (`?disk=<url>`, or a URL disk on the Machines page: [frontend.md](frontend.md) "Your
own disk"). How the reader works (the block cache, the OPFS store, parallel reads, the prefetch, the chunked format)
is [devices.md](devices.md) "blk" ("Over HTTP", "A chunked image"). This page covers what a server must give, how an
image is published, where ours are hosted and why there, and what a remote boot costs. Measurements:
`bench/remote-disk/REPORT.md` (`node bench/remote-disk/boot.ts`, [benchmarking.md](benchmarking.md)). Open items:
[backlog.md](backlog.md) "Remote disks' loose ends".

## What a remote boot costs

The Arch desktop guest (`images/arch/desktop.sh`) booted to Firefox's first paint, the page on localhost through the
Mac's network (a deployed page's numbers are the same: both are cross-origin to the image's host), its first boot in a
fresh profile:

| The reader | Painted |
|---|---|
| One synchronous XHR per read, one at a time (before 2026-10-23): 2,160 reads of ~47 ms each, the device worker frozen up to 2.2 s behind them | 196 s |
| A block cache in memory (1 MiB blocks): 425 requests | 110 s |
| Requests in parallel (realtime mode), the device worker never waiting on the network (its longest answer 0.7 s → 17 ms) | 101 s |
| A boot's reads in the manifest, fetched ahead | **65 s** |
| The same, paced: a window ahead of the guest, not the whole list at once (20 MiB fetched at the boot menu, not 380; R6, from vmdisks.tny.im, against 64.6 s there) | 66 s |
| A local file | 64 s |
| The next boot (the blocks kept in OPFS): no requests | 63 s |

The chunked format costs nothing against ranges where the host has them, and 2 MiB pieces boot as fast as ranges
where it hasn't. From the hosts below (the Desktop Demo, 2026-10-23): 66.5 s from `static.gbl08ma.com`; from
`vmdisks.tny.im` 78.1 s on the very first fetch of each piece (Cloudflare's edge filling from its storage), then
62.9 s.

Findings worth not re-measuring:
- **Compression gains nothing on a qcow2 that is already compressed:** the desktop boot's 543 MB compress to 98.9%
  with gzip, 99.2% with brotli 5, 99.3% with zstd 3 (per 2 MiB piece, as a host would encode them): they are qcow2's
  compressed clusters. So pieces aren't compressed, and a host's `Content-Encoding` is moot. An image converted
  without `qemu-img convert -c` would differ.
- **The browser's HTTP cache gives nothing across boots;** the OPFS store is what makes a second boot local. It sits
  in an expiring Storage Bucket (a week after its last use, at most 2 GiB, which the browser may take back under
  pressure), so a visit to a demo doesn't keep its blocks for good.
- **The prefetch pays on a warm edge too** (R6: 9–10 s to Firefox's paint): a dependent miss is a round trip however
  fast the host.
- **A hosted image's first boot runs its update jobs** (`ldconfig.service` by `ConditionNeedsUpdate`): 2–5 s of the
  guest's time, no extra bytes (backlog).
- The deterministic mode reads a remote disk one request at a time with synchronous XHRs, by design (its step
  counts); everything above is realtime mode.

## Off the record

In an off-the-record profile (an Incognito window; Playwright's `newContext`) OPFS lives in memory, and Chromium's
sync handles refuse writes at ~0.8 GB in all while `estimate()` reports ~3.2 GB. The block cache sizes its budget
from that estimate (a quarter of the free quota, web/diskcache.ts), so it can hold what was the room for everything
else. Nothing tells a page it is off the record, so the cache isn't made smaller there; instead what needs the room
gets it back: a guest's disk write that is refused empties the open stores (`releaseStores`) and is tried once more,
and a kept snapshot, a Suspend, a Restore's fork, a snapshot file's import, a stored disk's import or merge and Import
changes… do the same through `makeRoom` (every
image's cache, as the Machines page's Clear: a running machine's device worker gives its store up over the
BroadcastChannel). What they freed is fetched again from the server. Still refused, the error says the storage is
full with `estimate()`'s numbers (docs/machines.md "Storage"). tests/page-incognito.test.ts reads a URL disk's whole
image into the cache off the record, then keeps a snapshot, restores it (a fork) and suspends.

## What a server must give

HTTPS (or the page's own origin, or localhost); CORS for the page's origin (`Access-Control-Allow-Origin`, `*` is
fine; `Access-Control-Expose-Headers: Content-Range, Content-Length, ETag`); and either **byte ranges** (`Range:
bytes=a-b` answered 206 with `Content-Range`) for a whole image file, or nothing more for a **chunked image** (a
manifest and its pieces: any static host). A plain `bytes=a-b` range is a CORS-safelisted request header, so the page's
reads need no preflight; other forms do (`OPTIONS` answered with `Range` allowed). A CORS response satisfies the page's
`Cross-Origin-Embedder-Policy: require-corp`; CORP isn't needed. The URL check (`web/app/urlcheck.ts`) says in words
what a server lacks.

The user's Caddy (`static.gbl08ma.com`): `@diskimages path /diskimages/*` with `header @diskimages {
Access-Control-Allow-Origin *; Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges, ETag" }`,
and a `handle` of `OPTIONS` there answering 204 with `Allow-Methods: GET, HEAD`, `Allow-Headers: Range`, `Max-Age:
86400`. A Worker's static assets: `deploy/disks/_headers`.

An image's identity (what its overlays and kept blocks belong to) is a chunked image's `id` (a hash of its pieces'
hashes: it changes with the content, whatever the URL), or for a whole file its URL, size and the server's `ETag` or
`Last-Modified`. Replacing a whole file under the same URL leaves the machines that had it with overlays that no
longer match (refused at open).

## Publishing an image

```sh
node tools/chunk-image.ts <image> target/images/remote/<name> 2 --name "<what the page calls it>"  # manifest.json, pieces/
node bench/remote-disk/boot.ts <label> local::<name>/manifest.json      # a boot from it, its reads traced
D=target/images/remote/<name>; node tools/disk-trace.ts bench/results/local/remote-disk/<label>.json $D/manifest.json $D/prefetch.json
cp -al target/images/remote/<name> target/disks/<name> && deploy/disks/deploy.sh   # vmdisks.tny.im (below)
```

(`bench/remote-disk/boot.ts` boots the desktop guest's session; another guest needs its own marks.)

- **Pieces:** 2 MiB by default (`chunk-image.ts`'s third argument, in MiB), named by their SHA-256, so a new version
  of an image shares the pieces it didn't change, and repeated pieces (zeros) are one file. Smaller pieces cost
  requests where a host has ranges, and bytes where it hasn't (a read fetches its whole piece, and a boot touches
  nearly every piece of the file): there, 8 MiB pieces fetched the whole file (1.56 GB) and 25 MiB ones 3.9 GB (memory
  holds ten; the OPFS store holds them all), while 2 MiB fetched 681 MB and booted as fast as ranges.
- **The name:** the manifest's `name` is what the page calls a machine opened by `?disk=` on it and a disk added by its
  URL (not `prefetch.json`); the image's file name by default.
- **The boot trace** (`prefetch`): the image file's 1 MiB blocks in the order a boot first read them, up to the run's
  last mark (`--until <mark>` for an earlier one; `bench/remote-disk/boot.ts` marks the loader, init, login, the
  session, sway, Firefox and its paint). `local::` serves `target/images/remote/` (`local:/d47/r20:` adds 47 ms and 20
  MB/s); the trace is the guest's, so a local run's is a remote one's. Not part of the `id`: `manifest.json` and
  `prefetch.json` are the same image, with and without it.
- Publish the pieces before the manifests, so a manifest never names a piece that isn't there yet.

## Where our images are

- **`https://vmdisks.tny.im`** (the Desktop Demo: `?disk=https://vmdisks.tny.im/desktop/prefetch.json`): the Worker
  `waarm64-disks` on the user's Cloudflare account, static assets only, no script (`deploy/disks/`: `wrangler.jsonc`,
  `_headers`, `deploy.sh`), serving the dev VM's `target/disks/` (`<name>/manifest.json`, `prefetch.json`, `pieces/`).
  `_headers`: CORS `*` everywhere, pieces `Cache-Control: immutable` (named by their hash), manifests 5 minutes. A deploy
  replaces the whole site, so `target/disks/` holds every image that stays; wrangler uploads only pieces it hasn't
  seen. `deploy.sh` refuses past 20,000 files. **Deploy only when the user asks** (credentials: [frontend.md](frontend.md)
  "Deployed at vm.tny.im").
- **`https://static.gbl08ma.com/diskimages/`** (the user's server, Caddy, with ranges): `desktop.qcow2` (the whole
  image) and `desktop/` (the same chunked copy). Uploads by an rsync-only key confined to that directory: it can't
  replace or delete the root-owned files there (upload under another name; the user moves it), and the server allows
  one rsync session at a time.

## Hosting on Cloudflare: a Worker's static assets, never R2

Decided with the user, 2026-10-23, after setting R2 up and tearing it down the same day.

**Static assets bill nothing per request.** Cloudflare's Workers pricing: "Requests to static assets are free and
unlimited", and an assets-only Worker runs no script, so nobody can run up a bill on it, with a 404, a query string or
any header. Checked: after a day of boots, URL comparisons and 404s against the page's assets-only Worker, the
account's Workers analytics (`workersInvocationsAdaptive`) counted zero invocations. Even a Worker with a script, on
the Workers Free plan, isn't billed past 100,000 requests a day: it answers error 1027 (an outage, not a bill). Limits
(free plan): 25 MiB a file, 20,000 files a version, no total size listed (~40 GB at 2 MiB). **No byte ranges:** a
`Range` gets 200 and the whole file (measured), which is what the chunked format is for.

**R2 bills every read its edge cache doesn't serve,** one Class B operation each ($0.36 a million past the free 10 M
a month), and on a public bucket anyone decides how many happen: a denial of payment. Each of these got past the cache
(measured on a bucket at a custom domain):
- `Cache-Control: no-cache` downloads count too
  (https://community.cloudflare.com/t/questions-about-the-calculation-of-b-class-requests-for-cloudflare-r2/609909/3).
  Closed by a Cache Rule forcing caching with its own edge TTL. `r2.dev` access is never cached (off). An object over
  512 MB can't be cached on the free plan at all, so a whole image there is always exposed.
- A query string is part of the cache key: `?random` missed every time. Closed by taking it out of the key.
- With CORS on the bucket, R2 answers `Vary: Origin`, and the edge keeps a copy per `Origin` value: a made-up `Origin`
  missed every time. Closed by a WAF custom rule (it runs before the cache) refusing every `Origin` but the page's.
- **A path that doesn't exist misses every time**, and random paths are endless. Not closed. R2's pricing page
  doesn't say whether a 404 is billed (only that unauthorized requests aren't). The free plan's one rate-limiting rule
  can't bound it: it matches on the path only (not the host), counts every request per IP (cache hits too: counting
  only 404s or misses needs the Business plan) over a fixed 10 s with a 10 s block. A limit above a real VM's bursts
  (8 fetches at once, over 100 requests a second while prefetching, more behind a NAT) still lets one IP make ~17 M
  requests a day, more than a month's free reads; a lower one blocks real users.
- A Worker in front of R2 (answering 404s itself) counts every request against the free plan's 100,000 a day, real
  ones too: a first boot is 600–900 pieces, so ~100–160 first boots a day before error 1027.

Other options (free plan, Cloudflare's docs, 2026-10-17): Pages serves pieces as static assets do (no ranges, 25 MiB a
file, 20,000 files), but is Cloudflare's legacy product (the page moved off it: [frontend.md](frontend.md));
proxying `static.gbl08ma.com` through Cloudflare caches nothing over 512 MB and gains nothing. Cloudflare's 2023 terms
limit serving mostly large non-HTML files through its CDN in front of someone else's origin, not from its own
hosting: a disk image in static assets is the intended use. On a cold miss the edge fetches the whole object from
storage and collapses concurrent misses; each data centre caches on its own, and rarely read objects leave early on
the free plan; small pieces keep that cheap.

The Cloudflare token needs no R2, Cache Rules or WAF permission. If images ever go to a bucket again, every point
above comes back first.
