# A disk on a remote server (docs/plans/remote-disks.md)

Measured from the dev VM (Lima vz, 8 vCPUs, arm64; Chromium 153.0.8010.52 headless, SwiftShader's WebGL2), through
the Mac's network to `static.gbl08ma.com` (Caddy, HTTP/2). The page on localhost: the image's host is cross-origin
either way, so CORS preflights, connections and the HTTP cache behave as on `https://vm.tny.im`.

## R0: where a remote desktop boot's time goes (2026-10-23)

`node bench/remote-disk/boot.ts <label> <disk>`: the Arch desktop guest (`images/arch/desktop.sh`; qcow2 v3, 64 KiB
clusters, 1.58 GB file) opened by its URL on the page (`?disk=`, a fresh overlay: the image's first boot), 4 vCPUs,
2.5 GiB, 3D. Marks: the boot loader's menu, systemd's first output, the serial login prompt, the user's shell on the
screen, sway's IPC socket, Firefox's window (started through sway's IPC) and its first paint (about:blank: the screen
turns white). The page's `?iostats` (new) gives the disk's stage timers and a trace of every base read (time, offset,
length, ms: `web/iostats.ts`), read through a BroadcastChannel from the device worker. The local server
(`bench/remote-disk/server.ts`) serves a copy of the image with latency added per request (`/d47/`) and logs each
request. `summary.ts` sums a run per phase, `simulate.ts` replays its trace through a block cache.

The real server's latency, from the VM (curl, 64 KiB ranges at random offsets): **~47 ms a request on a reused
connection** (~180 ms on a new one: TCP and TLS), throughput 16–31 MB/s on one stream.

| run | loader | init | login prompt | shell | sway | Firefox window | **painted** |
|---|---|---|---|---|---|---|---|
| local, no latency (`results/r0-local.json`) | 4.4 | 10.8 | 28.5 | 36.8 | 41.1 | 63.5 | **64.1 s** |
| local, 47 ms a request (`r0-local-d47.json`) | 5.2 | 17.3 | 97.8 | 110.3 | 119.0 | 177.8 | **180.9 s** |
| static.gbl08ma.com (`r0-remote.json`) | 5.6 | 20.1 | 104.0 | 116.9 | 128.6 | 195.2 | **195.9 s** |

The remote run, per phase (seconds; base reads, MB read, seconds inside the reads):

| phase | wall | reads | MB | in reads |
|---|---|---|---|---|
| to the loader | 5.6 | 14 | 0.4 | 0.9 (17%) |
| to init (the loader reads the kernel and initramfs) | 14.5 | 110 | 55.9 | 8.3 (57%) |
| to the login prompt | 83.9 | 1253 | 191.1 | 67.1 (80%) |
| to the user's shell | 12.9 | 76 | 1.9 | 4.3 (34%) |
| to sway | 11.7 | 98 | 61.5 | 8.7 (74%) |
| to Firefox's window | 66.6 | 609 | 140.1 | 39.2 (59%) |
| **all** | 195.9 | **2160** | **451** | **129.8 (66%)** |

- **The boot is the disk's round trips.** Remote, 130 s of the 196 are inside base reads; the local run's 64 s plus
  those 130 s is the remote run's time within 3%. Added latency alone reproduces it (47 ms locally: 181 s), so the
  local server with a delay stands in for the remote host in the loops below, and bandwidth isn't the limit yet:
  451 MB in 130 s is 3.5 MB/s.
- **Reads:** 2160 of them, one at a time; median 27 KiB, 10% over 580 KiB, up to 3.4 MiB (qcow2's merged reads of a
  request's clusters). 451 MB of the file for 949 MB the guest asked for (the clusters are compressed).
- **First boot:** a fresh overlay is the image's first boot every time (and every visitor's to a hosted image):
  `systemd-analyze blame` puts `ldconfig.service` (rebuilding the linker cache, `ConditionNeedsUpdate=/etc`) first at
  44 s; its reads are most of the 191 MB before the login prompt.
- **Chromium's HTTP cache** already answers some repeated ranges (the server sends `Last-Modified` and `ETag`): locally
  ~7% of the reads before the login prompt never reached the server.
- **The device worker blocks behind the reads.** Back-to-back reads (a request's merged reads, a queue of requests
  answered in one `poll`) hold it with no turn of its event loop: remote, 392 spans over 100 ms, 14 over 500 ms, the
  longest **2.2 s** (local without latency: the longest 177 ms). Keys, the pointer, the display's damage and sound wait
  for the span's end (bench/io/REPORT.md "Loop 5" measured the same on localhost: 22–33 ms worst).
- **sway takes no IPC at once** on a slow disk (its socket exists before it answers): the harness retries
  `swaymsg exec` (a first run that didn't, `remote-1`, isn't kept).

### What a cache would save (the 47 ms run's trace replayed, `simulate.ts`)

Aligned blocks, an LRU, adjacent missing blocks in one request; time = requests × 47 ms + bytes ÷ 25 MB/s (one at a
time, as the device worker reads):

| policy | requests | MB fetched | estimate |
|---|---|---|---|
| none (today: each read a request) | 2148 | 451 | 119 s |
| 256 KiB blocks, 256 MiB | 719 | 482 | 53 s |
| **1 MiB blocks, 256 MiB** | **421** | **562** | **42 s** |
| 1 MiB blocks, 128 MiB | 505 | 664 | 50 s |
| 2 MiB blocks, 256 MiB | 299 | 688 | 42 s |
| 4 MiB blocks, 256 MiB | 219 | 969 | 49 s |
| 1 MiB blocks, unbounded | 407 | 545 | 41 s |

Read-ahead of the next blocks on sequential reads changes nothing (±1 s: qcow2 already merges a request's clusters).
Even unbounded, a cache fetches 545 MB: the floor is the bytes, so past a block cache the levers are concurrency
(R4: several requests at once, which also unblocks the device worker), what is fetched before it's asked for (R5),
and the image's first-boot work (above).

**R1's design, from these numbers:** 1 MiB blocks, 256 MiB kept, no read-ahead.

## R1: a block cache in the device worker (2026-10-23)

`web/blockcache.ts` under every HTTP source the device worker opens: 1 MiB aligned blocks, 256 MiB kept (an LRU), a
read's missing blocks fetched in one request per run of adjacent ones (`tests/blockcache.test.ts`). Its counters
come with `?iostats` (`cache`: block hits and misses, requests, bytes and ms fetching). Nothing the guest sees
changes (deterministic boots keep their step counts: the cache only changes which host reads answer a request).

| run | login prompt | sway | **painted** | requests | MB fetched | in requests |
|---|---|---|---|---|---|---|
| 47 ms, before (`r0-local-d47.json`) | 97.8 | 119.0 | **180.9 s** | 2148 | 451 | 114 s |
| 47 ms, R1 (`r1-local-d47.json`) | 39.6 | 54.7 | **82.2 s** | 422 | 561 | 23 s |
| static.gbl08ma.com, before (`r0-remote.json`) | 104.0 | 128.6 | **195.9 s** | 2160 | 451 | 130 s |
| static.gbl08ma.com, R1 (`r1-remote.json`) | 55.3 | 73.8 | **109.7 s** | 425 | 562 | 55 s |

- **Remote: 196 → 110 s to Firefox's first paint (−44%), 104 → 55 s to the login prompt.** One run each, which is
  enough at this size (the plan's rule: repeat under ~20%).
- The cache hits 79% of block lookups; the requests (425) are what the simulation said (421).
- **The remote run is now bandwidth-bound:** 562 MB in 55 s is 10 MB/s on one request at a time (curl's single
  stream: 16–31 MB/s), against the local server's 24 MB/s with the same latency. What's left is one stream's
  throughput plus 425 round trips (20 s): requests in parallel (R4) take both.

## R2: a chunked image (2026-10-23)

`tools/chunk-image.ts` cuts an image into equal pieces named by their SHA-256 (`pieces/<sha256>.bin`) and writes
`manifest.json` (the size, the piece size, the hashes, and an id hashed from them); `web/chunked.ts` reads it as one
file under the block cache, by range where the host answers ranges and whole pieces where it answers a range with
the whole file (as Cloudflare Pages does: the local server's `/pages/`). A `.json` disk URL is a manifest. Its id is
the image's identity (the URL check gives it as the disk's `etag`): a new image under the same URL doesn't meet the
old overlay. All arms at 47 ms a request and 20 MB/s (the local server), one boot each:

| arm | login prompt | **painted** | requests | MB over the network |
|---|---|---|---|---|
| the whole file, ranges (`r2-whole.json`) | 54.4 | **108.9 s** | 422 | 560 |
| 8 MiB pieces, ranges (`r2-c8-ranges.json`) | 55.3 | **108.9 s** | 438 | 561 |
| no ranges, 8 MiB pieces, the source keeping 64 MiB of whole pieces (`r2-c8-pages.json`) | 81.2 | 145.1 s | 188 | 1561 |
| the same, 4 MiB (`r2-c4-pages.json`) | 65.0 | 123.7 s | 244 | 1016 |
| the same, 25 MiB (`r2-c25-pages.json`) | 155.8 | 309.7 s | 175 | 4540 |
| no ranges, the block cache keeping whole pieces: 1 MiB (`r2b-c1-pages.json`) | 57.7 | 115.9 s | 537 | 561 |
| **2 MiB** (`r2b-c2-pages.json`) | 53.9 | **108.1 s** | 326 | 681 |
| 4 MiB (`r2b-c4-pages.json`) | 57.9 | 116.7 s | 221 | 920 |
| 25 MiB (`r2b-c25-pages.json`) | 146.8 | 284.4 s | 153 | 3943 |
| static.gbl08ma.com, 8 MiB pieces, ranges (`r2-remote-c8.json`) | 56.6 | **112.4 s** | 421 | 560 |

- **The format costs nothing where the host has ranges**: pieces by range boot as the whole file does, locally and on
  the real server (112.4 s against R1's 109.7 s, one run each). 47 ms and 20 MB/s locally lands where the real server
  does (108.9 against 109.7 s): that pair stands in for it from here.
- **Without ranges, the bytes are the cost:** the boot touches nearly every piece of the file, so the first design
  (a few whole pieces kept by the source) fetched each 8 MiB piece about once (1.56 GB) and 25 MiB pieces several
  times (4.5 GB). The source now says what a read fetches anyway (`Source.span`: the whole piece) and the block cache
  takes all of it: **2 MiB pieces then boot as fast as ranges do** (108.1 s, 681 MB). 25 MiB pieces still refetch
  (3.9 GB: 256 MiB of memory holds ten of them; R3's store on OPFS holds them all).
- **The tool's default is 2 MiB** (753 files for this image: Cloudflare Pages allows 20,000 a site and 25 MiB a
  file, so up to ~40 GB at 2 MiB).
