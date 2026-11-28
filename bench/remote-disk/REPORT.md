# A disk on a remote server (docs/remote-disks.md)

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

## R3: the blocks kept in OPFS (2026-10-23)

`web/diskcache.ts` under the block cache: a block missing in memory is read from OPFS before it is fetched, and what
is fetched is written there (`remote-cache/<key>/`, keyed by the image's identity: a chunked image's id, or the URL,
size and validator). `BOOTS=2` boots again in the same browser profile with the disk's overlay removed (so the guest
does the same first-boot work), at 47 ms and 20 MB/s; A without the store (`?diskcache=0`), B with it:

| arm | first boot: login / **painted** | second boot: login / **painted** | second boot's requests |
|---|---|---|---|
| no store (`r3-nostore*.json`) | 55.4 / **109.0 s** | 55.4 / **108.8 s** | 421 (560 MB) |
| store (`r3-store*.json`) | 56.5 / **110.1 s** | 26.8 / **62.9 s** | **0** |

- **The second boot reads nothing from the network: 109 → 63 s**, which is the local file's 64 s (R0). Chromium's
  own HTTP cache gave the second boot nothing (421 requests again: in a fresh profile's memory cache the ranges don't
  stay).
- The first boot pays for writing the blocks: 520 block writes in 2.2 s (a write and a flush each), within one run's
  noise of the arm without (110.1 against 109.0 s).
- The second boot's 536 store reads took 0.6 s.
- **The quota can be smaller than the browser says.** 25 MiB pieces without ranges, with the store
  (`r3-c25-pages.json`): the first attempt hung after login with the guest's own writes failing ("Buffer I/O error …
  lost async page write"): the store had taken its budget (767 MiB: a quarter of what `estimate()` called free), and
  the overlay's writes then fell short. A fresh Playwright profile (incognito) reports a 3.2 GB quota but takes 832 MiB
  of OPFS before a sync handle's write comes back short (4294967288: −8, not an exception;
  `bench/remote-disk/quota-probe.ts`). Since then the store checks every write's count and gives up for the session
  on a short one (its map cleared, its data cut off), and a disk write that fails makes every open store give up
  and is tried once more (`releaseStores`; `tests/devices.test.ts`, with the retry left out as the planted bug): the
  guest's writes go before kept blocks. With that, the same arm boots to Firefox in **122.9 s** (284.4 s without the
  store, R2), its 25 MiB pieces fetched 46 times (1.16 GB) instead of 153 (3.9 GB).

## R4: requests in parallel (2026-10-23)

In realtime mode the device worker reads a remote disk without blocking: `fetch` instead of synchronous XHRs
(`readAsync` on the HTTP and chunked sources and on the block cache, which fetches a block being fetched once and at
most 8 at a time), qcow2 reads a request's L2 tables and merged ranges at once (`openDisk`'s `readAsync`), and
`Devices.poll` completes a `concurrent` backend's requests as they resolve instead of in order (a read waits for the
last write, flush or discard before it; those wait for everything before them). The deterministic mode, Node and the
disk jobs keep the synchronous path. A snapshot's quiesce first drains the requests in flight (`Devices.drain`).
The local server's `/R<MB/s>` paces all responses together (one link shared by parallel requests).

| arm (47 ms a request, one shared 20 MB/s link unless said) | **painted** | requests |
|---|---|---|
| R3's code, one request at a time (R2/R3 arms: 108.9, 108.9, 109.0, 110.1) | **~109 s** | 422 |
| R4 (`r4-d47-R20.json`) | **106.6 s** | 409 |
| R4, a 40 MB/s link (`r4-d47-R40.json`) | 90.0 s | 405 |
| R4, static.gbl08ma.com (`r4-remote.json`; R1 and R2's runs there: 109.7, 112.4 s) | **100.6 s** | 405 |

**The device worker's answer time** (`PING=1`: the page asks it every 250 ms over the `?iostats` channel; a worker
inside a disk read answers after it), A the code before R4 (`../waarm64-base` at 3c1614f), B R4, alternated, 47 ms and
20 MB/s shared, two rounds (`r4ab-*.json`):

| | painted | answer p50 / p99 / longest | answers over 100 ms |
|---|---|---|---|
| A, round 1 / 2 | 116.1 / 116.4 s | 2.6 / 261 / **761 ms**; 2.8 / 274 / **679 ms** | 62 / 64 |
| B, round 1 / 2 | 105.9 / 105.4 s | 0.8 / 9.0 / **13.9 ms**; 0.8 / 10.2 / **17.1 ms** | 0 / 0 |

- **The device worker no longer stops behind the network:** its longest answer 0.7 s → 17 ms, so keys, the pointer,
  the display's damage and sound don't wait for a disk read (R0's remote run had spans of 2.2 s).
- **The boot gains ~9% in the alternated A/B** (116 → 105.5 s: the rounds don't overlap; the asks themselves slow A,
  whose answers carry the trace, which is why A is 116 here against ~109 without them) and ~9% on the real server in
  one run each (100.6 against 109.7 and 112.4 s). The guest mostly has one read outstanding, and the bytes (~540 MB)
  over the link set the floor; a faster link is what moves it (40 MB/s: 90 s).

## R5: a boot's reads fetched ahead (2026-10-23)

`node tools/disk-trace.ts <run.json> <manifest.json> [out.json]` writes a run's base reads up to its last mark (here
Firefox's paint: 518 blocks of 1 MiB, in the order the boot first read them; `r4-d47-R20.json`'s trace) into a chunked
image's manifest as `prefetch` (`results/desktop-chunk8-prefetch.json`; the id doesn't change). Opening such an image
in realtime mode, the block cache fetches the list in the background (`prefetch`): runs of adjacent blocks one request
each, at most 4 of the 8 fetches, the guest's reads first in the queue, and no further ahead of the guest's place in
the list than half of what can hold them (the store's slots; memory's blocks without one), the prefetched blocks into
the store alone where there is one. A, the image without the list; B, with it; alternated at 47 ms and a shared
20 MB/s link, two rounds:

| arm | login prompt | **painted** | requests | MB | prefetched / used |
|---|---|---|---|---|---|
| A, round 1 / 2 (`r5-A-*.json`) | 54.7 / 54.7 | **104.1 / 104.5 s** | 428 / 427 | 543 | |
| B, round 1 / 2 (`r5-B-*.json`) | 27.7 / 27.7 | **65.1 / 63.7 s** | 291 / 291 | 544 | 518 / 518 |
| B without the store (`?diskcache=0`, `r5-nostore-B.json`) | 37.9 | 83.2 s | 395 | 715 | 518 / 518 |
| B, 2 MiB pieces, no ranges (`r5-c2pages-B.json`) | 27.7 | 64.1 s | 201 | 612 | 421 / 519 |
| static.gbl08ma.com, A (`r5-remote-A.json`) | 48.1 | **96.3 s** | 406 | 543 | |
| static.gbl08ma.com, B (`r5-remote-B.json`) | 29.1 | **65.0 s** | 258 | 544 | 518 / 518 |

- **A first boot from the remote server now takes what a local file does: 65 s to Firefox's paint** (64 s, R0),
  the login prompt at 29 s (28.5). The network's time hides under the guest's: the boot needs 544 MB and its own
  ~64 s of CPU, and the prefetch starts fetching at the page's start.
- Every prefetched block was read by the guest (518 of 518): the list from one boot fits the next.
- Without the store the window is memory's (128 blocks): blocks fetched ahead get pushed out before they're used,
  and 715 MB are fetched instead of 544 (83 s). The store is what lets the prefetch run far ahead.
- Found on the way, both fixed with a test each: a synchronous read (the image's opening: qcow2's header and L1) of a
  block the prefetch is fetching assembled without it, so the disk never opened and the firmware sat waiting
  (`tests/blockcache.test.ts`, the planted bug fails it); and the fetch queue now grants slots in order, the guest's
  first (a liveness test with reads out of the list's order).

**From the start of the day (the first boot, the real server, to Firefox's paint): 196 s (R0) → 110 s (R1, a block
cache) → 101 s (R4, parallel reads) → 65 s (R5, the boot's reads fetched ahead), as a local file boots; a second boot
63 s (R3, kept in OPFS).**

## Compression and the first boot (2026-10-23)

- **Compression (plan §4.6) has nothing to take:** the desktop image is 34,614 compressed clusters (957 MB) and 9,621
  plain ones (631 MB: those qemu-img's `-c` couldn't shrink); the 543 MB the boot reads compress to 98.9% (gzip -6),
  99.2% (brotli 5) and 99.3% (zstd 3), per 2 MiB piece as a host would encode them. Not built.
- **The image's first boot costs little now:** a second boot keeping the first's overlay (`KEEP_OVERLAY=1`, local,
  no latency) reaches the login prompt 1.7–5 s sooner and Firefox's paint 1.4–4.6 s sooner, and reads the same bytes
  (567 against 565 MB without the store): what `ldconfig` reads, the rest of the boot reads anyway. R0's 44 s for
  `ldconfig.service` was the slow disk's. Left in docs/backlog.md (building a hosted image already "updated").

## The Desktop Demo, hosted (2026-10-23)

The updated desktop image (1.95 GB, `images/arch/desktop.sh`), cut into 2 MiB pieces with its own boot's reads (525
MiB) in `prefetch.json`, named "Desktop Demo" (`tools/chunk-image.ts --name`). A first boot (fresh profile, the page on
localhost through the Mac's network) to Firefox's paint, from:

| Host | Painted |
|---|---|
| `static.gbl08ma.com/diskimages/desktop/prefetch.json` (Caddy, ranges; `hosted-gbl08ma.json`) | 66.5 s |
| `vmdisks.tny.im/desktop/prefetch.json` (a Worker's static assets, no ranges), its first boot ever: Cloudflare's edge fetching each piece from its storage (`hosted-vmdisks-cold.json`) | 78.1 s |
| the same, the next first boot (the edge holding the pieces; `hosted-vmdisks-warm.json`) | **62.9 s** |

The warm edge is a local file's time (64 s, R5). Why the images are on static assets and not R2: docs/remote-disks.md
"Hosting on Cloudflare".

## R6: a paced prefetch (2026-10-23)

R5's prefetch ran ahead of the guest by half of what the store holds, which in practice is the whole boot trace: a
visitor at the boot menu had fetched ~380 MiB before choosing anything. Now it runs a window ahead of the guest's place
in the list (16 blocks, widened by 8 each time the guest waits on a block the window held back, up to 128; docs/devices.md
"Over HTTP"). `bench/remote-disk/boot.ts` now records the bytes fetched at each mark (`fetched`). The Desktop Demo from
`vmdisks.tny.im/desktop/` (warm edge), the page on localhost through the Mac's network, Chromium 153, fresh profiles,
alternated:

| arm | fetched at the boot menu | at systemd's start | login prompt | **painted** |
|---|---|---|---|---|
| A, no prefetch (`manifest.json`; `r6-A-*.json`) | 4 MiB | 56 MiB | 34.4 / 34.6 s | **73.8 / 75.0 s** |
| B, R5's prefetch (`r6-B-*.json`) | 378 / 395 MiB | 509 / 512 MiB | 26.8 / 27.4 s | **64.3 / 64.9 s** |
| C, paced, from 16 (`r6-C-*.json`) | 20 MiB | 100 / 104 MiB | 28.6 / 28.8 s | **66.1 / 66.1 s** |

A second session, three rounds each, with the keyboard change of the same commit (a `?disk=` machine follows the
browser's layout, so the guest runs the layout's unit at boot):

| arm | fetched at the boot menu | login prompt | **painted** |
|---|---|---|---|
| C, paced, from 64 (`r6-C64-*.json`) | 77–80 MiB | 29.2–29.8 s | **66.6–67.1 s** |
| C, paced, from 16 (`r6-C16k-*.json`) | 20 MiB | 29.4–29.8 s | **66.6–67.1 s** |

- **The prefetch still pays on a warm edge:** without it the boot is 9–10 s slower (A against B or C), each dependent
  miss (qcow2's L2 table, then the cluster) a round trip.
- **Paced, a visitor at the menu has fetched 20 MiB, not 380**; the boot to Firefox's paint costs ~1.5 s more than R5's
  (rounds don't overlap: 2%), all of it before the login prompt. The total is the same (~585 MiB).
- **The window isn't what costs it:** it widened once or twice (16 → 24 or 32; the guest waited on the list 2–3 times),
  and starting at 64 changes nothing but the menu's bytes. What R5 had was the menu's idle seconds: by systemd's start
  it held 510 MiB, so the boot's fetching (the network, the store's writes) never ran beside the guest. Left in
  docs/backlog.md (running eagerly once the guest is past its menu).

## PERF loop 102: the prefetch eager past the boot menu, and paced without the store (2026-11-28)

Issues #28 (the paced prefetch's 1.5 s, R6) and #29 (without the OPFS store it refetched what memory pushed out: 83
against 65 s, 715 MB against 544, R5). Both re-measured on today's tree first, with R5's setup: the Desktop Demo
(`target/disks/desktop/`, linked as `target/images/remote/desktop`: 2 MiB pieces, its boot trace of 531 blocks in
`prefetch.json`) on `bench/remote-disk/server.ts` at 47 ms a request and one shared 20 MB/s link
(`node bench/remote-disk/boot.ts <label> local:/d47/R20:desktop/prefetch.json`; `QUERY=diskcache=0` without the store;
`manifest.json` without the trace), dev VM, Chromium 153 headless, fresh profiles, one boot to Firefox's paint each.
Since DEMO's review the pieces are fetched whole on every host (web/chunked.ts), so a fetch brings two 1 MiB blocks.
Three sessions, the arms alternated in each; painted (s, each round), median, and MiB the server sent
(`results/p102-*.json`, `p102b-*`, `p102c-*`):

| session | arm | painted, rounds | **median** | login (median) | MiB at the menu | MiB sent |
|---|---|---|---|---|---|---|
| 1 | C: today's, paced (window from 16, widening) | 65.9 / 65.3 / 66.0 | **65.9** | 30.2 | 24 | 590 |
| 1 | E: R5's way, the window at its ceiling (128) from the start | 57.7 / 61.3 / 58.4 | **58.4** | 24.9 | 72–74 | 590 |
| 1 | N: today's without the store | 93.0 / 91.6 / 91.5 | **91.6** | 41.2 | 24 | 904–908 |
| 1 | A: no prefetch | 96.4 | 96.4 | 51.3 | 6 | 590 |
| 1 | NA: no prefetch, no store | 100.6 | 100.6 | 51.8 | 6 | 664 |
| 2 | C | 65.3 / 65.7 / 65.8 | **65.7** | 29.8 | 24 | 590 |
| 2 | R: C, and at its ceiling once the guest read 16 blocks of the list | 61.5 / 62.5 / 61.3 | **61.5** | 28.3 | 24 | 590 |
| 2 | N | 90.9 / 92.5 / 90.9 | **90.9** | 41.0 | 24 | 900–906 |
| 2 | NR: R without the store, and no more than half of memory held ahead | 82.0 / 83.6 / 82.0 | **82.0** | 38.2 | 24 | 804–810 |
| 3 | C | 65.1 / 65.3 / 65.9 | **65.3** | 29.9 | 24 | 590 |
| 3 | **F: kept** (16 until 16 blocks read, then 128 over a store; 16 without; no widening) | 61.6 / 61.2 / 61.6 | **61.6** | 28.5 | 24 | 590 |
| 3 | N | 90.4 / 91.8 / 90.1 | **90.4** | 40.7 | 24 | 902–910 |
| 3 | **FN: kept, without the store** | 78.4 / 78.9 / 77.3 | **78.4** | 35.1 | 24 | 678–686 |
| 3 | FN8: FN with a window of 8 | 79.7 / 78.9 / 80.1 | 79.7 | 36.8 | 16 | 672–674 |

- **#28's gap is larger on this link than R6 measured: 7.5 s, not 1.5** (C 65.9 against E 58.4, rounds apart). R6
  ran from a warm Cloudflare edge, where the network keeps up with the guest; over 20 MB/s it doesn't, and the paced
  window (16, widened by 8 only when it held the guest back) had reached 40 blocks by the login prompt: the guest
  waited on the list 69–101 times (E: once).
- **Kept: the window goes to its ceiling once the guest has read 16 blocks of the list** (`EAGER_AFTER`). At the
  menu the guest has read 4 (the firmware, the loader; the loader then reads the kernel and initramfs, 55 blocks by
  systemd's start), so the menu's bytes are unchanged (24 MiB: what the guest read and a window), and the boot to Firefox's paint
  is **65.3 → 61.6 s (−5.7%, rounds apart in two sessions)**, the login prompt 29.9 → 28.5; the guest waited on the
  list 22–26 times. E's other 3 s are the menu's idle seconds, bought with 48 MiB fetched before anyone chose to boot:
  not taken (R6's reason for pacing).
- **#29's refetching was still there, and worse: 904–910 MiB for 590**, 90–92 s. Without the store the prefetch keeps
  its blocks in memory (256 MiB) beside the guest's, the widened window reached 128 list entries, and each brings its
  piece's sibling block: 256 blocks, all of memory. Kept: **without the store the window stays at 16** (no widening,
  not eager): **90.4 → 78.4 s (−13%), 906 → 684 MiB.** A held-ahead bound with the eager window (NR, half of memory)
  still fetched 804 MiB; 8 fetched 10 MiB less and was 1.3 s slower.
- A replay of N's reads through a 256-block LRU with the prefetch always as far ahead as allowed (ad hoc; its "no
  prefetch" arm gives NA's 664 MiB exactly) says the same: the boot's own reads already refetch 66 MiB at this memory
  size, a window of 16 fetches 706, 32 740, 64 800, 128 ~1,190; no bound on what is held ahead does better than a
  small window.
- **What's left without the store is memory's:** 78.4 s and 684 MiB against 61.6 and 590 with it. Only a larger memory
  budget while the prefetch runs would take it (the issue's other idea), at hundreds of MiB for a case (another tab has
  the image, no room in OPFS) that the store covers otherwise: not built.
- The widening rule is gone (no arm needed it: past the menu the window is the ceiling over a store, and a wider one
  hurts without). Memory: unchanged (the block cache's 256 MiB, the store's slots). The guest sees nothing (realtime
  mode's fetching only; the deterministic mode doesn't prefetch).
