# Static review: graphics and video host code (web/virgl*, venus*, gpu*, video-*, gl-enums, surface, display, edid)

Read-only review of the code as it stands at 2b1b26fb. Nothing was run. Confidence tags:
**confirmed** means I traced the path by reading it; **plausible** means the path exists but whether it happens
depends on guest or browser behaviour I could not check.

Scope note: `web/surface.ts` is the disk/RAM *surface inspector* (block maps, qcow2 tables), not graphics. I reviewed
it anyway (one small perf item, no defects found).

---

## 1. Real defects

### D1. The display "floor" isn't clamped to EDID_MAX: GET_EDID throws and the device worker fails (confirmed)
- `web/gpu.ts:807-813` (`setScanout`): with `keepConsole`, a scanout rectangle at the origin that is smaller than its
  resource raises `floor` to the resource's size. `report()` (`gpu.ts:783-788`) takes `max(wanted, floor)` and only
  `wanted` goes through `clampSize` (≤ 4095).
- `GET_EDID` (`gpu.ts:320-324`) then calls `edid(this.width, …)`, and `edid()` throws `RangeError` past 4095
  (`edid.ts:165`). The exception leaves `Gpu.control` → `gpuBackend.request` → the device poll loop
  (`devices.ts:1488`, no catch there), so the machine fails.
- `fallbackModes()` (`gpu.ts:761-770`) also lists `shown`/`floor` sizes above 4095 with no upper bound. `dtd()` then
  truncates `hActive` to 12 bits and the EDID carries a nonsense mode.
- **Scenario:** a page machine (keepConsole on) whose guest scans out the top-left of a buffer wider or taller than
  4095. One way is Xorg with `xrandr --fb 6000x3000`, or any virtual screen bigger than the mode: the root pixmap is the
  scanout resource and the CRTC sits at 0,0. The guest's next display event (raised right away by `setScanout`) makes
  the kernel re-read the EDID, and that read throws.
- **Fix:** clamp `floor` (and `shown` in `fallbackModes`) to `EDID_MAX`, or skip the floor rule for resources past
  `EDID_MAX`. Also make GET_EDID answer `ERR_UNSPEC` rather than throw, as defence in depth.

### D2. The floor survives a virtio reset, so a rebooted guest is held at the previous boot's console size (confirmed)
- `Gpu.reset()` (`gpu.ts:992-1012`) clears `shown` but not `floor` or `bounce`, and doesn't call `report()`. `width`
  and `height` keep `max(wanted, oldFloor)`.
- **Scenario:** during boot the user shrinks the page and fbcon crops, which raises the floor. The user then reboots
  the guest, or a guest-initiated reset happens. The new boot (firmware, kernel, desktop) is told the old,
  larger size, and every later `setSize` still reports at least that size for the rest of the session.
- Related (plausible, a design gap): the floor never comes down. Once the boot console has tripped it, a desktop that
  starts later can't go below it either. That contradicts docs/devices.md ("a desktop that changes its mode isn't held
  back").
- **Fix:** in `reset()`, set `floor = {0,0}`, `bounce = false`, then `report()`. Consider dropping the floor when the
  cropped resource is unref'd or a scanout appears that isn't cropped.

### D3. VenusShare drops WebGPU canvas contexts without unconfiguring them; resizing churns swap chains (plausible)
- `web/venus-share.ts:394-406`: `canvases` is keyed by `${w}x${h}`. When it holds more than 8 it is `clear()`ed, and
  the old `GPUCanvasContext`s are never `unconfigure()`d. Each one keeps its swap-chain textures until GC.
- **Scenario:** a Vulkan window resized by dragging, where every frame has a new size, on the bitmap or canvas way.
  Each size makes a new OffscreenCanvas plus a configured context, and nothing frees them deterministically. The
  file's own comment on `staging()` records Dawn growing per-frame allocations without bound on SwiftShader.
- **Fix:** call `ctx.unconfigure()` on eviction, and evict by LRU, not all at once. Better: keep one canvas and
  reconfigure it, or set `canvas.width/height`, when the size changes.

### D4. VenusShare `forget()` leaves per-id state that a reused id then inherits (plausible, rare)
- `venus-share.ts:302-309`: `forget` clears `copied`, `blits`, `converted` and `buffers`, but not `unshared` or
  `holds`.
- With a readback or check still in flight for id X, its `finally` later calls `unhold(X)`. If the guest has already
  reused X for a new external resource that took its own `hold(X)`, the shared counter releases the new resource's hold
  early. That submit then runs before its bytes arrive: one stale or black frame. A reused id also never gets the
  "not shown" warning or the `unshared` stat again.
- **Fix:** key holds and in-flight work by the `ExternalResource` object, not by id, or drop `unshared` and `holds`
  in `forget` and have the late `finally` check `r.dead`.

### D5. Venus imports aren't detached when a virgl resource is unref'd while attached to a Venus context (plausible, low)
- `gpu.ts:349-364` (RESOURCE_UNREF) expects a resource to be unref'd while still attached: it deletes the id from every
  context's set. For a 3D resource attached to a Venus context (an import), it sends `unref` but no
  `blob-ctx detach`.
- `VenusRenderer.imported` (`venus-host.ts:432-436`) then keeps `"ctx:res"`, and vkr keeps the imported resource.
  When the id is reused and attached to the same context, `imported.has` is true, so it is **not** imported again and
  Venus keeps the stale import, with the old size.
- Linux detaches on GEM close before the final unref, so this needs another order. The device code itself anticipates
  that order for virgl contexts.
- **Fix:** in RESOURCE_UNREF, for each Venus context in `contexts` whose set held the id, send
  `{t:'blob-ctx', attach:false, size}`.

### D6. `forgetShader` can remove the wrong program id when the lists disagree (plausible, latent)
- `virgl-renderer.ts:414`: `other.splice(other.indexOf(id), 1)`. If `id` is missing, `indexOf` is −1 and the call
  removes the *last* element of the other shader's list. That program is then never deleted (a GL program leak), and
  the lists drift further apart.
- Today the lists stay consistent, because `program()` pushes ids only on a miss and always `programs.set`s them. Any
  exception between the push and the `set` (`gl.*` under context loss, a translator throw outside the `try`) breaks
  that.
- **Fix:** guard with `const i = other.indexOf(id); if (i >= 0) other.splice(i, 1);`, or keep the lists as `Set`s.

(Checked and **not** defects: Gpu.restore only runs on a freshly built device (`devices.ts:1339`), so the stale
`venusContexts` and `blobBytes` there can't be reached; GPU worker loss makes the page crash the run (`runner.ts:206`),
so portHost's promises that never settle don't matter; `copyPicture`'s default `copyTo` rect is `visibleRect`, so the
offsets are right; FenceGate releases after a Venus context's destroy through the destroy's own hold fence.)

---

## 2. Performance (ranked by frequency × cost)

### P1. Every submit's words are walked three or four times, twice with per-command allocations (per submit, per command; confirmed)
- Device worker: `gpu.ts:617`, `this.stream.count(words)` runs on **every** SUBMIT_3D, even with a real host and no
  stats. Per command it calls `commandName()`, which builds a template string for CREATE/BIND/DESTROY_OBJECT (the most
  common commands), and does a Map get and set (`virgl.ts:58-70`). At the start of control(), each control command also
  does `type.toString(16)` plus an object-key update (`gpu.ts:305-306`).
- GPU worker: `CallQueue.pass` (`virgl-host.ts:405`) calls `decodeOnly(m.words)`, a full `walk` with a closure,
  **before** checking whether anything is busy or pending. In the common case (no video) the result is unused.
  `pass` also allocates 3 `Set`s and 2 closures per call (`virgl-host.ts:388-394`). While stalled, it re-walks every
  queued submit at every push and every 20 ms tick (O(queued × words)).
- The renderer walks the words again (`virgl-renderer.ts:894-912`), allocating a `subarray` per command (`:903`).
- **Fix:**
  1. On the device, validate with `walk(words)` (no visitor) and count only under a stats or trace flag, or count by
     numeric key (`cmd | obj<<8` into a `Uint32Array`) and build names in `json()`.
  2. In `pass`, test `busy.has(ctx)` and pending first and compute `decodeOnly` lazily. Cache it per queue entry at
     `push` (`{m, n, decode?: boolean}`). Hoist the Sets onto the instance and `clear()` them.
  3. In the renderer, pass `(words, at, len)` down instead of a subarray, or reuse one view only where the payload has
     to be kept.
- **Gain:** likely the largest JS-side saving per frame for a GL desktop (thousands of commands a frame). Worth an A/B
  on `bench/gpu` (sway, glmark-like scenes).

### P2. Per draw: the program cache key is a JSON string of a freshly built object graph (per draw; confirmed)
- `virgl-renderer.ts:2112-2127` builds `key` (arrays for attribs, samplers through `samplerKey` per view, cbufs with
  copied `write` arrays) and `program()` does `JSON.stringify(key)` (`:1959`) on every draw.
- Each draw also allocates: `feedbackCopies` (a Map, array spreads `[...s.fb.cbufs, s.fb.zs]`, a per-target array
  concat at `:2010-2013`), `sampleMask`'s spread (`:2434`), `faces` arrays, `[0,1,2,3].map` for the blend colour,
  closures `set1` and `fac`, and template-string uniform lookups (`` `${st[0]}c0` ``). When the constant buffer is
  short of the program's count, `new Uint32Array(n*4)` is made per draw (`:2136`).
- **Fix:** keep a per-`Sub` "program state" version, bumped by the commands that change key inputs (BIND_SHADER,
  SET_SAMPLER_VIEWS, SET_FRAMEBUFFER_STATE, BIND rasterizer/DSA/blend/VE, SET_STREAMOUT_TARGETS, SET_POLYGON_STIPPLE,
  resource SET_TYPE), and cache `(version, mode-is-points) → Program` on the sub. Pre-resolve uniform locations into
  fields on `Program` (`loc.vc0` and so on). Hoist the scratch arrays.
- **Gain:** moderate per draw (the JSON of ~10 nested arrays is microseconds). At thousands of draws a frame,
  milliseconds a frame on the GPU worker. Measure.

### P3. Index buffers: any write to a buffer re-uploads its whole CPU copy at the next indexed draw (per draw after a write; confirmed)
- `upload()` sets `r.idirty = true` for any buffer write (`virgl-renderer.ts:720`, also `:1480`, `:2535`), and the
  draw then calls `gl.bufferData(ELEMENT_ARRAY_BUFFER, r.shadow)` with the **whole** shadow (`:2390-2395`).
- **Scenario:** Mesa streams small index arrays (and vertices) into its upload buffer (a 1 MiB stream buffer) between
  draws. Each indexed draw after a small write then re-uploads the full buffer: up to ~1 MiB per draw, plus the
  `holdsMax` cache dropped.
- **Fix:** keep a dirty byte range `[lo, hi)` on the resource, merged on each write, and `bufferSubData` just that range
  into `ibuf` (allocate `ibuf` once at full size). Invalidate `imax` entries only where they overlap.

### P4. Video: 2–3 frame-sized allocations per decoded picture, plus padding copies (per frame; confirmed)
- `copyPicture` (`virgl-video.ts:605-628`) allocates `raw` (`allocationSize()`, about 3 MB at 1080p), then fresh `y`
  and `uv` arrays it repacks into: about 6 MB of garbage a frame, 180–360 MB/s at 30–60 fps.
- `padPlane` allocates again whenever the coded size exceeds the visible size (1080 → 1088 is the common case).
  I420 planes allocate `u` and `v` (`virgl-renderer.ts:1100-1106`).
- **Fix:**
  - For NV12, `copyTo(dst, { rect: visibleRect, layout: [{offset:0, stride:w}, {offset:w*h, stride:cw*2}] })` into
    one pooled buffer, with `y` and `uv` as subarrays (no repack).
  - For I420, copy with an explicit layout into a pooled buffer and interleave from there.
  - Pool by size, keeping 2–3 per stream, but note `VenusImport.last` keeps `p.data`: copy only when an import holds
    it.
  - Pad by uploading with `UNPACK_ROW_LENGTH` and a second small upload for the edge column and row, instead of
    building a padded copy.
- **Gain:** large reduction in GC pressure during playback, and fewer major-GC hitches (frame drops).

### P5. 2D transfers redo backing-wide checks and allocate views per call (per TRANSFER_TO_HOST_2D: hundreds/s on a scrolling console; confirmed)
- `gpu.ts:858-861` (`fits`) reduces over the whole backing (up to 16384 entries).
- `:897` runs `ram.every` and `backing.every` per transfer and builds `srcs`, a new `Uint32Array` per RAM memory, on
  every call (`:898-899`).
- The raw path does `bytes(ram, b).subarray(...)`, two typed-array allocations per page run per row (`:880`).
  A full 1080p frame comes to about 4,000 allocations.
- **Fix:** at ATTACH_BACKING, compute and store `backingLen` and `aligned` on the resource. Cache the per-memory
  `Uint8Array`/`Uint32Array` views (rebuilt only when `ram()`'s buffers change identity).

### P6. Venus imports: a rest-args wrapper around every WebGPU import call (per call: thousands a frame; plausible)
- `venus-gpu.ts:458-466` wraps each import as `(...a) => f(...a)` inside a try. That allocates an arguments array per
  call (setBindGroup, setVertexBuffer, draw and so on), unless TurboFan elides it, which isn't guaranteed through the
  closure.
- **Fix:** build fixed-arity wrappers from `f.length` (`switch (f.length) { case 2: return (a, b) => { try { return f(a, b) } … } }`),
  or call the module's entry points (`venus_submit`, `venus_poll`) inside one try and keep the imports bare.
- **Gain:** plausible but unmeasured. The `later()` closure per command remains either way; it's by design.

### P7. Device → GPU worker: submit bytes copied more often than they need to be (per submit; confirmed)
- `gather` always copies (`devices.ts:432`). Virgl's SUBMIT_3D then copies again (`cmd.buffer.slice`, `gpu.ts:615`)
  before transferring.
- Venus's `vsubmit` copies with `cmd.slice` (`gpu.ts:610`) and is then **cloned**, not transferred:
  `portHost.call` transfers only `submit` (`virgl-host.ts:566`). That is a third copy before `withBytes`' copy into
  the module heap.
- **Fix:** add `else if (c.t === 'vsubmit') port.postMessage(c, [c.bytes.buffer])`. The slice is a fresh buffer owned
  by nobody else.
- **Gain:** small: Venus commands mostly go through shared-memory rings, so vsubmits are notifies and fenced submits.

### P8. ShaderCache rewrites an entry to IndexedDB on every hit (per hit, so a program's start; confirmed)
- `venus-cache.ts:118-124`: a hit updates `used` and marks the entry `dirty`. A second later `flush` writes the whole
  entry, bytes included, back to IndexedDB.
- A program start that hits hundreds of entries rewrites megabytes just to record use times.
- **Fix:** keep `used` in a separate small record (or a second store keyed by `key`), or write back use times only for
  entries never yet persisted in this session, or batch them at a coarse granularity (once a minute).

### P9. Smaller per-message costs (low)
- `FenceGate.release` (`virgl-host.ts:135-145`) allocates a Set and a filtered array on every poll (each task while
  spinning).
- Venus's `retired()` builds a `"ctx:ring:id"` string per check (`venus-host.ts:380`), and so does `retire()` per fence.
  Key by `ctx<<8|ring` → `Set<bigint>` instead.
- `cursorSender` builds two strings per cursor move (`gpu-present.ts:73`): compare the numbers.
- `pollQueries` filters `this.queries` into a new array per poll (`virgl-renderer.ts:2786`).
- `share.prepare` calls `v.gpu.idle()` per submit message: while submits are held, that makes a Promise and pushes a
  resolver every time, even when the context has no externals (`venus-share.ts:280`). Check `externalsOf` first.
- `Screen.damage` uploads each damaged rectangle as it comes (`virgl-screen.ts:109-113`) while the draw is
  coalesced to one per frame. Coalesce the rectangles as `canvasPresenter` does and upload once in `draw()`.
- `surface.ts:128`: `countRange` makes an `Int32Array` view per range (16k per walk of a 64 GiB disk). Hoist it into
  `rangeCounts`.

---

## 3. Code quality and architecture

### Q1. `gpu-worker.ts`: the `init` handler is one ~270-line closure doing six jobs (confirmed)
Lines 262-538 set up GL, probe video, build the renderer and screen, bring up Venus asynchronously (`venus-init`,
~45 lines), run the query poll and fence gate, dispatch calls, and emit two stats reports. Line 494 is a single
~1,900-character statement.

Seams:
1. `startVenus(init, knobs, gl, renderer) → {venus, share, imports, adapter}` (`gpu-worker.ts:354-399`).
2. A `QueryPoller`/`FencePoller` class in virgl-host.ts owning `poll`, `pollTimer`, `queryPolls`, `pendingSince` and
   the stuck warning (`:301-352`).
3. `renderStats()` and `statusStats()` builders with one generic `delta(now, last)` helper. That replaces the
   hand-written `lastShare`, `lastImport`, `lastTextures` and `last` pairs (`:487-507`).
4. The `render-stats` message type (`:245`) as named sub-types (`ShareStats`, `ImportStats` deltas, and so on) rather
   than an inline 1-line object type.

### Q2. File sizes and seams (confirmed by structure)
- **`virgl-renderer.ts` (3362 lines):**
  - snapshots: `snapshotRefusal` … `loadValue`, `:2814-3245`, ~430 lines, into `virgl-snapshot.ts`;
  - queries: `:2635-2800`, into `virgl-queries.ts`;
  - blits, resolves, copies and depth/stencil draws: `:1412-1830`, into `virgl-blit.ts`;
  - video glue: `:1055-1262`;
  - `draw()` alone is ~350 lines (`:2083-2429`). Split it into `programFor`, `applyUniforms`, `bindSamplers`,
    `applyRaster`, `applyBlend`, `applyDepthStencil`, `bindAttribs`, `issue`.
- **`venus-gpu.ts` (3738 lines):**
  - `calls()` is a ~430-line object literal of imports;
  - the emulations (depth/stencil copies `:1058-1366`, transform feedback `:2043-2350`, the VS pre-pass `:2351-2570`,
    provoking-vertex and fans `:2592-2885`, packing `:2886-3051`) each make a module;
  - the WGSL generators (`pulledCode`, `vertexDecode`, `BLIT_FILTER_*`, `vertexFetch`) go in `venus-wgsl.ts`.
- **`gpu.ts` (1375 lines):**
  - `gpuBackend`'s reply scheduling (held, rings, carry, pacing, occupancy: `:1176-1375`) into `gpu-replies.ts`;
  - `control3d` (virgl and Venus tables: `:432-640`) into `gpu-3d.ts`;
  - pixel helpers (`transfer`, `rgba`, `readBacking`, `makeOpaque`, `hashRgba`) into `gpu-pixels.ts`.

### Q3. Module-level mutable singletons shared across instances (confirmed)
- `busy` (`gpu.ts:202`) and `fenceLag` (`virgl-host.ts:501`) are module globals that the presenters write and reset.
- `gpu-worker.ts:250-260` keeps `ram`, `snapshotBytes`, `grab` and `venusSkip` as module `let`s.
- Two Gpu instances in one worker (tests, or a future multi-head) would mix the counts. It also cuts against the
  project's "no mutable globals" rule, which is for the Rust core but applies in spirit here.
- **Fix:** hang `busy` off the `Gpu` (or the backend) and pass it to the presenter; keep the worker's handles in one
  object created at `init`.

### Q4. Duplicated logic (confirmed)
- The `busy` reset object literal appears verbatim twice, as does the 4 ms lag timer (`gpu-present.ts:117-125` and
  `:234-240`). Adding a field to `busy` means editing three places. Fix: `resetBusy()` in gpu.ts and a
  `drawStatsTimer(port, extra)` helper.
- Swizzle tables are re-derived in several places:
  - `FORMATS.get(res.format)!.slice(0, 3)` in both `hostScanout` and `announce` (`gpu.ts:823`, `:844`);
  - per-byte reorders in `rgba()`, `readCursor` and the slow path of `transfer`;
  - `src.swizzle ?? [0,1,2]` twice in gpu-present.ts.
- `concat(parts)` exists in `virgl-video.ts:571`, `video-av1.ts:820`, `encodeTrace` and `video-h264.ts:435`. One
  bytes utility would do.
- Three walkers of the command stream (`virgl.ts walk`, `renderer.submit`'s loop, `submitTouches`) plus
  `decodeOnly`/`destroysSub`. A single per-submit summary computed on the device would serve both `CallQueue` and the
  stats: a bitmask of the command numbers present, sent alongside `words` (ties into P1).

### Q5. Types could state invariants that are now optional fields plus `!` (confirmed)
- `HostCall`'s `scanout` (`virgl-host.ts:29`) is `{pixels?, swizzle?, res?}`. `Screen.scanout` checks
  `!c.pixels && !c.res` and `draw()` uses `s.res!`. A union states it:
  `{kind:'2d', pixels, swizzle?} | {kind:'3d', res} | {kind:'off'}`.
- `Gpu`'s `Resource` (`gpu.ts:80-103`) is one shape with optional `three`, `blob` and `raw`. Code checks
  `res.three && !res.pixels.length`, `res.blob` and so on. A discriminated `Resource2d | Resource3d | ResourceBlob`
  would make RESOURCE_UNREF, SET_SCANOUT and CTX_ATTACH exhaustive.
- `Batch.waits` vs `Later.ready`: fine. `Json = Record<string, any>` flows through `create`, `meta` and
  `gpu_render_pass` in venus-gpu.ts. Typed descriptors per `kind` would catch field typos the driver's JSON could
  carry.

### Q6. Dead code and stray comments (confirmed, trivial)
- `virgl-renderer.ts`:
  - `maxVertex = Math.max(maxVertex, 0)` is always 0 (`:2335`, and `maxVertex` is never read);
  - `void fbw; void fbh;` (`:2215`);
  - `void c` parameters in `samplerKey` and `queryState` (`:1949`, `:2776`);
  - duplicated doc comments on `Backing` (`:22-23`).
- `gpu-present.ts:26`: a doc comment ("With `stats`: once a second, the draws…") sits on `capture` instead of
  `draw-stats`.
- `gpu.ts`: two stacked JSDoc blocks on `busy` (`:199-201`) and a blank-line pair at `:23-24`.
- `runCall`'s `case 'ram': return;` and the Venus `default` comment (`virgl-host.ts:113-114`). Fine, but the `WorkerCall`
  dispatch in gpu-worker.ts handles `ram` before `runCall`, so the case can't be reached.

### Q7. Inconsistent patterns (low)
- Three schedulers of "one draw per frame" (`Screen.present`, `canvasPresenter.schedule`, `showFramebuffer`), each
  with its own rAF-or-timer fallback and FRAME_MS constant (15 vs 1000/60). Share one `frameScheduler()` helper.
- Error throttling exists three ways: `VirglRenderer.error` (kinds, 5 each, 200 total), `VenusGpu.warn` (200 keys) and
  `VenusShare.warn`/`VenusImport.warn` (unbounded `Set`s of messages that include ids, so they grow with distinct ids).
  The latter two can grow without limit on a long session. Share one bounded `onceLogger`.
