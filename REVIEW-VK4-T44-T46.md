# Review: VK4 T44–T46 (cc2d95e7..02ef89db)

A static, out-of-context review of the code those commits changed: vk/driver/wg_cmd.c (pulled vertex input's first
instance, draws by a byte count, captures of draw-indirect-count records, occlusion queries in the device's set, GPU
timestamps, vkCmdCopyQueryPoolResults as one dispatch), wg_shader.c (`wg_vertex_pull`, `wg_pipeline_pull`'s group-3
pull), wg_device.c (query pools, vkGetQueryPoolResults), wg_caps.c, vk/compiler (gl_PointSize kept for captures), and
web/venus-gpu.ts (`pullBind`, `pulledCode`, `vertexDecode`, `runXfb`/`xfbQuery`, `byteCount`, `timestamp`,
`queryAdd`, `copyQueries`, `xfbOpen`). Nothing was run; findings ranked by how likely and how bad.

## Findings

### 1. Medium-high: timestamp slots aren't recycled when no timestamp write is pending: an index past the set, the submit lost

`vk/driver/wg_cmd.c:3605` (`timestamps_flush`), with `timestamp_slot` (3623) and `begin_pass` (4888).

`timestamps_flush` returns early on `if (!n || !r->ts_next)`: with no `timestamp_write` entries it doesn't reset
`r->ts_next`. `timestamp_slot` calls it when `ts_next >= WG_TIMESTAMP_SET` (256) and then returns `ts_next++`
regardless, so it hands out 256, 257, ... on a 256-slot set.

Slots are taken without entries: `begin_pass` takes an end-write slot for **every part** of a pass with `ts_pass`
(each cut: `dst_copies`, `feedback_copies`, `vs_prepass`, `scope_cut`, `byte_count_cut`), and `ts_pass` is set as
well when the only timestamp is *after* the pass (`timestamp_after`). Entries are only appended when a timestamp op is
replayed, and `OP_COPY_QUERY`'s flush empties the list.

Scenario: a submit (or the stretch after a vkCmdCopyQueryPoolResults) whose first GPU timestamp follows a render pass
of ≥256 parts, e.g. 300 draws with a logic op, an advanced blend or the depth bounds test (a `dst_copies` cut each),
then `vkCmdWriteTimestamp2(BOTTOM_OF_PIPE)` after the pass (a GPU profiler's pattern). The 257th part's descriptor gets
`endOfPassWriteIndex: 256`, which WebGPU rejects (index ≥ the set's count); the encoder is invalid and the whole
submit's work is lost. The final flush would also `resolveQuerySet(set, 0, 257+...)`, out of range too.

Fix: reset `ts_next` (and resolve only what entries need) whenever the slots run out, entries or not.

Test: in `wg_test.c` with the GPU stubbed (or a venus-driver page case with timestamp-query), one submit: a render pass
of 300 draws through a logic-op pipeline followed by a bottom-of-pipe timestamp; assert every `timestampEnd` /
`gpu_timestamp` index the replay emits is < 256 (an assert in `timestamp_slot` catches it), and no WebGPU validation
error on the page.

### 2. Medium-low: `begin_pass` takes the end slot before the begin slot; a flush between them strands the end slot

`vk/driver/wg_cmd.c:4888–4899` (`begin_pass`).

With `ts_pass` and `ts_before` (a top-of-pipe timestamp right before a pass that writes or is followed by
timestamps), `begin_pass` takes `ts_part = timestamp_slot()` and then the beginning slot with a second
`timestamp_slot()`. When the first call returns 255, the second finds `ts_next == 256` and flushes: it resolves slot
255 before the pass has written it, resets `ts_next` to 0 and returns 0. `ts_part` stays 255: the pass's end write
goes to slot 255, every timestamp inside that part (and `ts_after`, a timestamp right after the pass) is recorded at
slot 255, but the next flush resolves only `0..ts_next`. Those timestamps get copied from `scratch[255*8]`, which holds
the value resolved before the pass wrote it (0) or whatever an occlusion resolve of ≥256 slots put there since: a
timestamp of 0 or stale, earlier than the top-of-pipe timestamp before it (non-monotonic). The same stranding can
happen through `end_pass`'s `ts_pending` slot followed by `r->ts_after = last` at `OP_PASS_END` (5816–5818), though
`ts_pending` looks unreachable now that `pass_queries` sees every in-pass timestamp.

Fix: take both slots before writing either (flush first if fewer than two are left), or the beginning one first.

Test: one submit that uses exactly 255 slots (255 timestamps outside passes, each after a dispatch so they don't
share `ts_after`), then a top-of-pipe timestamp, a render pass with a timestamp inside, and a timestamp after it;
check the three values are non-zero and non-decreasing.

### 3. Low: the pull's uniform bindings aren't counted against the vertex stage's uniform buffers (T44 adds a second)

`vk/driver/wg_shader.c:2026–2030` and `2063–2065` (`wg_pipeline_pull`).

`wg_pipeline_pull` checks the vertex stage's storage buffers against WebGPU's limit but not its uniform buffers. The
pull binds `wgv_at` (uniform, binding base+16), and with a divisor now also `wgv_dp` (uniform, base+17). Vulkan's
`maxPerStageDescriptorUniformBuffers` is `max_uniform_buffers - 1 + folded` (wg_caps.c:392, the 1 the push buffer's),
so a vertex stage at or near the advertised count plus one or two pull uniforms is past WebGPU's 12 per stage: the
pipeline layout / render pipeline is refused by WebGPU (a validation error) instead of being refused by the driver
(`wg_pipeline_pull_ok`). The `wgv_at` half predates T44; the divisor's `wgv_dp` lowers the threshold by one.

Test: a vertex stage with `maxPerStageDescriptorUniformBuffers - 1` uniform buffers and an instance binding with
divisor 2 (or an unaligned stride, which pulls); expect the draw to work or the pipeline to be refused with the
driver's message, not a WebGPU validation error.

### 4. Low (accuracy): a timestamp right after a render pass precedes the pass's own work the worker runs at its end

`vk/driver/wg_cmd.c:5816–5818` (`ts_after`) with web/venus-gpu.ts `endPass` (runs the pass's transform feedback
captures, `runXfb`) and `end_pass` (query resolves, `scope_end`'s shadow write-backs).

`ts_after` makes a bottom-of-pipe timestamp after a pass read the render pass's end write. The captures of that
pass's draws (Vulkan's vertex processing of the pass) and the copies of what it wrote to shadows run as compute after
that write, so the timestamp is earlier than work Vulkan orders before it. Values stay monotonic (later timestamps are
later still); a GPU timer of a pass with transform feedback under-reports it.

Test: a pass with a large captured draw and rasterizer discard, timestamps before and after it: the difference should
cover the capture's dispatch (compare with `?gpu=vkgputime`'s per-pass times).

### 5. Note (docs): vk/README.md says the timestamp set has 4,096 slots

vk/README.md ("the set's 4,096 run out (`timestamps_flush`)") vs `WG_TIMESTAMP_SET 256` (wg_cmd.c:3470).

## Checked and found fine

- **Occlusion slots** (`query_count`, `query_carry_on`, `resolve_queries`): slots taken in order across every part of a
  Vulkan pass and each layered pass's layer; one resolve, runs coalesced only when pool, index and slot are all
  consecutive; passing ones written through `query_passing` with `r->pass` already NONE (no append while iterating);
  adds after the copies, one dispatch a pool, 64-bit carry right; a query begun outside a pass (first pass a copy,
  later ones adds; none: 0); a begin past 4,096 slots reported passing at its end. `gpu_update` is encoder-ordered.
- **vkCmdCopyQueryPoolResults' dispatch**: word offsets, strides, the 256-aligned window, 32/64-bit, availability
  after `vals` values, partial, unavailable values untouched; occlusion, timestamp and transform feedback layouts
  (`vals` 2, 16 bytes a query) agree between the copy, the readback (`lo * 8 * vals`), `complete` and
  vkGetQueryPoolResults; `timestamps_flush` runs before the copy; resolves before readbacks at the submit's end.
- **Transform feedback queries**: begin/end jobs in the captures' order (at once outside a pass, else queued); counts
  carried through `xfbCounts` and the session's words 4–5 (cleared, seeded at begin, copied out at finish); the end's
  difference and zero high words.
- **`xfbOpen`/`endPass`**: a cut runs only the jobs before an open session's begin; `open == 0` runs none.
- **Draws by a byte count**: tickets in `prepasses` and the replay agree (also refused, storing and layered paths);
  the arguments' dispatch (bias, stride, 256-aligned counter window); `byte_count_cut` ends the occlusion query and
  carries it on, the pass begun storing (`pass_byte_count_cut` in `reads`), captures closed so far run at the cut; the
  capture reads the counter (`wgx_load`, pad0/pad1); `scan_pass` records the counter's read.
- **Draw-indirect-count captures**: record index + 1 vs the count (pad2/pad3), copied after the arguments.
- **Captures with restart and the provoking vertex**: `wgx_cut` at the index type's all-ones, segments' primitives,
  strip parity reset per segment, `s +` the fan's hub; `wgx_j` matches Vulkan's first/last-vertex orders for strips and
  fans; the 32-word `WgxP` and the 128-byte parameters.
- **Divisors**: `recordIndex` (`first + (iid - first) / d`, 0: first); the first instance's place (direct draws a
  place where it changes, indirect ones `prepasses`' copy of base vertex and first instance, byte counts `{0, first}`);
  dp place 256-aligned, 144 bytes bound; `dp_places` produced and consumed one a record on every path; the BGL's
  binding 17 and `pulledCode`'s `wgv_dp` declared under the same condition; the key (memcmp/hash of the whole struct)
  includes the divisor.
- **Group-3 pull**: bindings 976–993 below the driver's 994–999, the room check's range, the merged layout (`with`),
  the bind group from the program's current group 3 entries and its dynamic offsets (pull entries aren't dynamic), set
  again whenever RD_GROUPS sets group 3.
- **Legacy vertex attributes**: the C side's numeric type (`vk_format_is_sint/uint`, scaled as float) matches
  `vertexDecode`'s `natural`; every decoded component's WGSL type is the format kind's, so `bitcast<T>` is well typed.
- **gl_PointSize/viewport/primitive ID kept for captures**: `nir_io_xfb` has four entries in this Mesa; removed when
  not captured; the printer writes them to `wg_xo` only.
- **Timestamps otherwise**: `ts_before` only when the next work op is a pass in the same command buffer; begin and end
  writes distinct; kept entries (`UINT32_MAX - 1`) survive a flush and get the next beginning write or a write of
  their own at the submit's end; scratch shared by occlusion resolves and timestamp flushes in encoder order.

## Triage (2026-11-08, the fix loop)

All five confirmed and fixed on main (commit ad089b3e), each with a driver test (tests/venus-driver.test.ts) that
failed first and fails again with its fix planted out:

1. **Fixed.** `timestamps_flush` frees the set's slots whether or not a timestamp reads them (it resolves and copies
   only when one does). Test `misc: a timestamp after a render pass of 300 parts…` (wg_test.c 125: 300 logic-op draws,
   then a bottom-of-pipe timestamp): before, WebGPU's "endOfPassWriteIndex (256) exceeds the number of queries (256)"
   and the submit lost.
2. **Fixed.** `begin_pass` takes the end and beginning slots together (`timestamp_slots(r, 2)`, flushing first when
   fewer are left). Test `misc: timestamps around and in a render pass that begins at the device set's last slot…`
   (wg_test.c 126: 255 timestamps, a top-of-pipe one, a pass with one inside, one after): before, 2 of 258 were 0.
   The `end_pass` → `ts_after` path the review named is closed too: `ts_after` is dropped when the set was flushed
   since the pass's slot was taken (`ts_flushes`).
3. **Fixed (refused, not drawn).** `wg_pipeline_pull` counts the vertex stage's uniform buffers with the pull's one or
   two against WebGPU's limit; past it the draw is refused by the driver (`wg_pipeline_pull_ok`'s message now names
   uniform buffers). Test `passes: ANGLE's layout with a vertex input pulled…` (wgt_angle_ubo's `pulled`:
   t46/angle-pull.vert, an instance binding with divisor 2 at an unaligned offset): before, WebGPU's "The number of
   uniform buffers (13) in the Vertex stage exceeds the maximum per-stage limit (12)". Drawing it (the pull's
   parameters as read-only storage where room is left) filed: docs/backlog.md "Pulled vertices' leftovers" (S).
4. **Fixed (small).** A pass whose worker-side work follows its end write (captures run at `endPass`, shadow
   write-backs in `scope_end`) sets `ts_tail`; a timestamp right after it is then a write of its own, after that work.
   Test `transform feedback: a timestamp right after a pass with a capture follows the capture` (wgt_xfb 15: the
   worker's timestamp writes 2, the pass's alone before). The mirror case (a top-of-pipe timestamp before a pass reads
   its beginning write, after the pass's `prepasses` work) filed: docs/backlog.md "Queries" (XS).
5. **Fixed.** vk/README.md says 256, and how the slots are freed.

Runs: `scripts/ci.sh` all green except `tests/virgl-browser.test.ts`'s damaged-chunk video test (a call waited
216–222 ms against its 200 ms bound, twice under the suite; passes alone; nothing in this loop reaches virgl's video:
filed in docs/backlog.md "Tests and tools"), `scripts/ci-graphics.sh` OK (261 s), `scripts/ci-deqp-vk.sh` OK (1,100 s:
a sample of 11,009 of 81,619, seed 3025452439, 0 failing).
