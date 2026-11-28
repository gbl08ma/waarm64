# Review: the remote disk's block cache and its prefetch

A static review of `web/blockcache.ts` and what it sits on: `web/disk-sources.ts` (`httpSource`, `remoteSource`),
`web/chunked.ts` (`chunkedSource`, `fetchBytes`), `web/diskcache.ts` (the OPFS store), `web/blk-device.ts` and
`web/devices.ts` / `web/device-worker.ts` (the plumbing), against docs/devices.md "Over HTTP" and docs/remote-disks.md.
Ranked by severity. Two findings were confirmed with small Node scripts against the cache (no browser); they are
quoted below.

## 1. Medium-high: one read far down the trace opens the prefetch's window to the whole list before it

`web/blockcache.ts:184-189` (`reached = at`), `:250` (`i - reached > prefetched.window`); `web/disk-sources.ts:85`,
`web/devices.ts:857`.

The guest's "place in the list" is the **highest** list index any read has touched, and the window is measured from
it. A single read of a block that sits late in the trace moves `reached` there at once, and every list entry before it
is then inside the window: the prefetch fetches the whole prefix (plus the window), 4 fetches at a time. `EAGER_AFTER`
is a position too (`reached >= 16`), so the same read also switches a store's window to the ceiling.

Where it happens: the trace is fetched for every realtime start of a chunked image with a `prefetch`, whatever the
start is. `remoteSource` doesn't know about `init.state`, so a **Suspend's resume or a snapshot restore** of a machine
on `…/prefetch.json` (the Desktop Demo's URL) runs the boot trace too. The restored guest's first reads are of
whatever it's doing then (Firefox's files, late in the list), so the prefetch fetches the firmware, kernel, initramfs
and early userspace that it will never read again. Smaller versions of the same thing happen in a boot that differs
from the traced one (another menu entry, systemd's ordering).

- **Without a store** (another tab has the image, no room, the bucket taken back under pressure, after Clear), those
  blocks go into memory, ahead of the guest's own: a few hundred blocks through the 256-block LRU evict everything the
  guest held, and it fetches it all again. This is the case PERF loop 102 kept at a 16-block window to avoid.
- **With a store**, they take store slots, and the slots are reused FIFO, so on a store smaller than the image they
  push out blocks the guest uses. They also take 4 of the 8 fetch slots while the restored guest wants its own.

Confirmed (64 KiB blocks, a 500-block trace, no store): idle, the prefetch held at 16 blocks; one `readAsync` of
list index 400 → **416 blocks fetched**, `window: 16` unchanged.

Fix directions: don't start the trace on a restore, or start it only from the opening; measure the place as a count of
list blocks read, or advance `reached` only past entries that are contiguous with it (for example the lowest index not
yet read), not the maximum.

## 2. Medium: a whole file's ranges aren't pinned to the validator the cache is keyed by

`web/disk-sources.ts:52-60` (`read`/`readAsync`), `:72-81` (the identity).

The store of a whole-file image (not chunked) is keyed by URL, size and the ETag/Last-Modified of the start's HEAD,
but the range GETs send neither `If-Match` nor `If-Range`. If the file is replaced on the server during a session (an
in-place re-upload), the reads that follow return the new file's bytes beside cached blocks of the old one: the guest
reads a torn image (qcow2 L2 tables from one, clusters from the other) and writes its overlay on top of that. The new
blocks are also written into the store under the **old** identity. That's harmless only as long as the validator
changes. With Last-Modified (1 s resolution) or an mtime-and-size ETag (Caddy, nginx), a replacement of the same size
copied with its mtime kept (`rsync -a`, `cp -p`) keeps the identity, and a later session serves the stale blocks as
current. Chunked images aren't affected (content ids, hashed pieces).

Fix: send `If-Match: <validator>` (or `If-Range`, then refuse a 200) on every range read when there's an ETag, and
treat a 412 as a failed read.

## 3. Medium-low (latent): the store isn't keyed by its block size or a format version

`web/disk-sources.ts:80` (`openBlockStore(await cacheKey(identity), src.size, BLOCK_CACHE.block)`),
`web/diskcache.ts:394-419`, `:266-276`.

A store's directory is named by the image's identity alone, and its `map` holds slot numbers whose byte offset is
`slot * block` with the **current** `BLOCK_CACHE.block`. If the block size ever changes (it's a measured choice, R1;
another measurement could move it), a store written with 1 MiB slots is read with the new size: every mapped block is
served from the wrong offset of `data`, silently (nothing checks stored blocks: pieces are hashed only when fetched).
The disk surface's `withKept` has the same issue. Put the block size (or a format number) in `cacheKey`'s input.

## 4. Low: fetches outlive `close`; their completions write to a closed store and reject unhandled

`web/blockcache.ts:291-296` (`close`), `:150-166`, `:260-263`; `web/diskcache.ts:402`, `web/overlay.ts:209-224`.

`close` closes the store's sync handles and releases its lock, but nothing aborts the fetches in flight: up to 4 of
the prefetch (runs of 8 blocks, widened to pieces) and the guest's own. `Devices.close` follows `drain`, which waits
for the blk requests, not for the prefetch. When one completes, `fetched` → `store.put` → `data.write` on a closed
handle throws `InvalidStateError`. `shortOnFull` turns only `QuotaExceededError` into a short count, so the error
propagates, `fetchAsync`'s promise rejects, and the prefetch's `void fetchAsync(...).finally(...)` is an unhandled
rejection in the device worker. The downloads also go on until the worker ends. On a failed start (`allOrClose` closes
this source because another disk failed) the prefetch has already started. More generally, `put`/`get` aren't
guarded against non-quota errors (`flush`, `truncate` and `read` aren't wrapped), so such an error during a guest's
read surfaces as an IOERR instead of the store giving up. That contradicts the comment at `diskcache.ts:402` ("never
throws into a read"). Fix: an `AbortController` for the cache's fetches aborted by `close`, `fetched` ignoring results
after `closed`, and `put`/`get` catching any error and giving up.

## 5. Low: a mapped slot that reads short is fetched every time and never repaired; two readers disagree on it

`web/diskcache.ts:431-443` (`get`), `:443` (`put` skips mapped blocks), `:409-419` against `:266-276`.

If `get` reads fewer bytes than the block (the data file shorter than the map says), `gather` treats the block as
missing and fetches it, but `put` returns at `if (... map[b] ...)`, so it's never rewritten: every read of it is a
network request for the rest of the session and the next ones, and `kept.has` still reports it held. `keptSlots` (the
surface's reader of the same files) drops slots past `data`'s size, but `blockStore`'s open doesn't, so the surface
and the running cache disagree about the same map. Fix: check slots against `data.getSize()` at open as `keptSlots`
does, and on a short `get` clear the entry so the refetched block is stored.

## 6. Low: the prefetch's stats are wrong in the case PERF loop 102 decided on

`web/blockcache.ts:183`, `:190`, `:258`.

- `used` counts a prefetched block as used when the guest first reads it, even if it was evicted before then and the
  guest fetched it again (`ahead` isn't cleared on eviction). That's the no-store case, where the point was to measure
  blocks pushed out before the guest got to them.
- `late` stops counting once the loop is `done`, though those reads still needed the network.
- `fetched` adds list entries (`j - i`), not blocks: a chunked image's widened piece brings twice as many.

Confirmed (8-block memory, trace `[0,2,4,6]`, 8 off-list reads in between, then the 4 list blocks): `requests 4`
(all refetched), but `used: 4, late: 0`.

## 7. Low: a guest read waiting on a queued prefetch fetch waits behind every queued guest fetch

`web/blockcache.ts:126-148`, `:200-201`.

A guest read of a block the prefetch has `pending` waits for that fetch. If the fetch hasn't started (it's in
`queuedAhead`), it's granted a slot only when `queued` is empty, so under heavy guest I/O the read is served last,
behind requests made after it. Nothing deadlocks (the guest's queue is bounded), but the read pays the prefetch's
priority. Moving the waited-on fetch into `queued` when a guest read joins it would fix that.

## 8. Low: the disk surface's inspect reads go through the guest's cache

`web/blk-device.ts:370-393` (`liveImage`), `web/blockcache.ts:297-304`.

`examine` reads a remote qcow2's tables through `src.read`, the cache's synchronous path. Each kept block it touches
is read from the store into the memory LRU (up to `ALLOCATION_MAX` worth of tables, each pulling in a whole 1 MiB
block), which evicts the guest's working set, and those reads count in the cache's hit/miss stats (`?iostats`). A
block that `kept.has` reports held but whose store read fails (5) is fetched by a **synchronous XHR** on the device
worker while the machine runs. That contradicts the comment above `liveImage` ("nothing is fetched for the map"). The
surface should read the store directly, without filling the LRU and never fetching.

## 9. Low: the store's FIFO order restarts at slot 0 each session, and a smaller budget leaves dead space

`web/diskcache.ts:407-420`.

`next = used % slots`: once a store has wrapped, `used === slots`, so a new session reuses slot 0 first rather than the
oldest-filled slot. docs/devices.md says slots are "reused in the order they were filled", which holds within a
session only. When `slots` shrinks between sessions (less free quota), blocks past it are dropped from the map, but
`data` isn't truncated, so its tail is space the cache holds and no longer uses until the image's cache expires or
gives up.
