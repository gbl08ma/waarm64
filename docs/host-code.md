# The host's code: rules of thumb

Rules for `web/*.ts`: the devices' backends, the workers, the renderers and the network clients, the TypeScript that
runs beside the core and never draws the page (that is `web/app/`, whose rules are [frontend-code.md](frontend-code.md)).
Here performance rules: a rule gives way to a measured cost on a hot path, and a comment there says so. The linters
(§4) enforce what can be checked mechanically; the rest is for review.

## 1. Hot paths

A path is hot when it runs per packet, per frame, per command or draw, per block request, per transfer descriptor or
per audio period; cold when it runs per attach, start, lease or snapshot. On a hot path:

1. **No allocation per event that a reused buffer would do.** Scratch typed arrays, views of guest memory cached
   until `memory.buffer` changes (a grown memory detaches nothing but gives a new buffer), records parsed into
   reused objects. A copy that exists to make an exact-sized buffer for a transfer is the one copy to keep; the
   others go (`subarray` where the receiver doesn't keep the bytes).
2. **Transfer, don't clone**, when the sender is done with a buffer (`postMessage(m, [buf])`); batch many small
   messages into one where the receiver takes a batch (an IP port takes `ArrayBuffer[]`).
3. **Index loops are fine** (typed arrays, strides, subranges); `for…of` where it reads better and the path is cold.
4. **`!` and casts state what a protocol or a parsed structure guarantees**, where a check would cost a branch for
   nothing. Not to silence a type that is really optional: there, narrow.
5. **A speedup is measured** (CLAUDE.md "Performance"): hot-path changes get a Chromium A/B (several may share one
   that shows no regression); a cold path's allocation fix ships with its test and the reason.

## 2. Correctness

1. **Teardown frees what start took**: listeners on `navigator.usb`/`navigator.hid`/`window`, timers, workers,
   sockets, WebGPU contexts (`unconfigure`), GL objects, locks, open files. A device detached and attached again must
   not find its last session's leftovers.
2. **A worker's failure reaches its owner after start too**: `onerror` and `messageerror` lead to the same path as a
   posted error, not only to the start's promise (a promise settled once ignores a later reject).
3. **Network fetches have a deadline** (`AbortSignal.timeout`) where a hang would hold a start, a drain or a lock.
4. **Requests and answers pair by id**, not by arrival order, when two can be in flight.
5. **Reads that must agree come from one transaction** (IndexedDB: keys and values, read-then-write with `add`).
6. **Fix what a plausible scenario triggers**: a guest's behavior, a user's action, a peer, a timing. A check for a
   state no input can reach doesn't go into a hot path.
7. **Errors for the user are keys and data** ([i18n.md](i18n.md)): only the page renders words.

## 3. Modules

1. **A module has one job**; the seams the HOST track cut are the map: `core.ts` (the core instance's plumbing,
   `VM_CONFIG`), `device-host.ts`, `coordinator.ts`, `jit-host.ts`, `counters.ts`, `warm-workers.ts`,
   `test-guests.ts` (fixtures: only tests, bench and tools import it) out of `vm.ts`; `virtio.ts` (the queue's
   layout, `Ctx`, `Backend`, `gather`/`scatter`) and one file per backend or source out of `devices.ts`; the
   renderers' state types and pixel helpers apart from their classes. A worker's entry imports only what it runs
   (`vcpu-worker.ts` doesn't load the devices).
2. **Shared shapes are written once**: an IP-port worker's port (`ts-port.ts` `ipPortHost`), a page-side worker
   handle (`tailscale.ts` `workerHandle`), a frame socket (`local-net.ts` `framePath`), bytes and addresses
   (`bytes.ts`, `ip6.ts`). A third copy of a pattern is a helper's cue.
3. **A class whose methods share private state stays whole** (`VirglRenderer`, `VenusGpu`, `Gpu`): its seams are
   methods, and moving them is a rewrite, not a move.
4. **A move is checked past tsc**: the harness pages' inline imports (`tools/harness-imports.ts`, in the static
   checks) and the paths in evaluated strings (`page.evaluate`'s `import('/web/…')`) aren't in tsc's program.

## 4. The linters

`npm run lint` (in `scripts/ci.sh` and `scripts/ci-fast.sh`) covers `web/*.ts` beside `web/app/`
(`tools/lint/eslint.config.ts`, the host's block; typed through `tsconfig.host.json`, under tools/lint's TypeScript 6).

- **Prettier**: web/app's options (120 columns, single quotes); `npm run format` writes. The reformat's commit is in
  `.git-blame-ignore-revs`.
- **ESLint**: typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked`, with what both blocks share
  (`no-floating-promises`, `no-misused-promises`, `prefer-nullish-coalescing`, `no-empty` with a comment in a catch,
  the taste rules tuned out: frontend-code.md §7). Unlike the page: **no size rules** (`max-lines`,
  `max-lines-per-function`, `complexity`: a renderer's `draw` or a decoder's switch is long by nature; a split is a
  review's call), `no-non-null-assertion` and `non-nullable-type-assertion-style` off (§1.4), `prefer-for-of` off
  (§1.3), `require-await` off (an interface's async method may have nothing to wait for), `no-unused-expressions`
  allows `a && f()` and `c ? f() : g()`, unused parameters and variables named `_x`, and `only-throw-error` allows
  9P's `Err` (an errno without a stack, thrown on paths as common as a lookup that misses).
- **Suppressions**: what failed when the rules came is grandfathered in `tools/lint/eslint-suppressions.json`, which
  only shrinks (frontend-code.md §7 "Suppressions": `--prune-suppressions` after a fix; never `--suppress-all` to
  let new code in).
