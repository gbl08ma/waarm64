# Venus L5b + L6a: static review

**Range:** `git diff 2c33a8df a82e482d` (VK3 L5b and L6a). All files read as of `a82e482d`.

**Scope:** `vk/driver/wg_cmd.c`, `wg_device.c`, `wg_caps.c`, `wg_shader.c`, `wg_private.h`, `vk/compiler/wgsl_print.c`
and `wgsl.h`, `web/venus-gpu.ts`, and the new tests (`vk/driver/wg_test.c` misc 10–13, `tests/wgsl.test.ts`,
`tests/venus/l5b/*`, `tests/venus-driver.test.ts`, `tests/venus-renderer.test.ts`). The bench JSON and the dEQP case
lists were skipped. Mesa's runtime (`target/vk/mesa/src/vulkan/runtime`, mesa-26.2.4) was read to check how it calls
the driver.

**Bottom line:** I found 8 defects and 1 note. The most serious one is in the new held-submit queue (L6a). An empty
submit that only signals skips past held submits. So a fence, `vkQueueWaitIdle`, or vkr's ring fence can report work
as done before it has even been replayed, and the held submit can then replay command buffers and objects that have
been freed or re-recorded. L5b's change that makes every compute storage buffer `read_write` fixes one usage-scope
conflict but creates others: a read-only SSBO next to a UBO or indirect buffer in the same memory now breaks the
dispatch, where it used to work. In the occlusion queries, one path calls `gpu_update` while a compute pass is open,
which invalidates the whole submit. The queries also count the samples of the worker's clear draws. The rest are low:
a test that never reads the word it says it checks, one combination the advertised shared-memory limit can't compile,
and comments that say less than the code does.

---

## 1. High: empty "signal only" submits skip past held submits, breaking queue order and object lifetimes

**Where:** `vk/driver/wg_cmd.c:2518` (`wg_queue_submit`):
```c
bool met = list_is_empty(&dev->held) || (!submit->command_buffer_count && !submit->wait_count);
```

**Defect:** A submit with no command buffers and no waits runs at once (`submit_now`) even when earlier submits are
held. Its signals fire when its own (empty) GPU work completes, which can be long before the held submits are
replayed. In Vulkan, a fence or semaphore signalled by a later submission means that all earlier submissions on the
queue have completed. The comment admits the submit "signals early", but the cost is worse than a timing difference:

- Mesa's `vk_common_QueueWaitIdle` (`vk_queue.c:1462`) is exactly such a submit: `vk_queue_signal_sync` with no waits
  and no command buffers. So does `vkDeviceWaitIdle` through it. Both return success while a held submit has not even
  been replayed.
- After that the application (or vkr on the guest's behalf) may free or reset the command buffers, query pools,
  buffers and pipelines the held submit refers to. `struct held` (`wg_cmd.c:463ff`) keeps raw `vk_command_buffer *`
  pointers, and every op payload holds raw object pointers (`op_query.pool`, `op_copy_query.dst`, programs,
  secondaries in `OP_EXEC`). When the semaphore is signalled later, `flush_held` → `submit_now` → `replay` reads freed
  or re-recorded command buffers. That is a use-after-free in the wasm heap, or wrong work. `wg_submits_forget` covers
  freed memories only for submits already in `pending`, not for held ones. Query pools have no such guard at all:
  `complete()` writes into `q->pool->values`.
- The vkr ring-fence case the comment gives as the reason works the same way. The guest retires the ring seqno, and
  with it the command buffers ("the guest's driver waits for those before it reuses its command buffers"), while the
  held submit still points at them. The exemption opens exactly the reuse window it describes.

**Triggers:** any `vkQueueSubmit(queue, 0, NULL, fence)`, `vkQueueWaitIdle` or `vkDeviceWaitIdle` (and vkr's ring
fences) issued while a submit waits on a timeline value the host hasn't signalled yet.

**Confirming test:** a `wgt_misc` scenario like 13. Submit A (copy src→out) waits on timeline value 1. Then call
`vkQueueSubmit(queue, 0, NULL, fence2)`, poll `fence2` until it signals, and check that A's copy hasn't landed yet
(`out` still 0). That shows the order violation. To show the lifetime bug, after `fence2` signals, call
`vkResetCommandBuffer` on A's command buffer and re-record it as a fill of 0x33. Then signal value 1. The output is
0x33 instead of the copy (or it crashes if the command buffer is freed instead).

**Possible fix:** when held submits exist, hold the empty submit too. Avoid the vkr deadlock some other way: for
example, let the empty submit's signal wait only on non-held work when its sync is vkr's ring fence. If the empty
submit must still go first, copy everything a held submit refers to.

---

## 2. Medium: making compute storage buffers `read_write` breaks dispatches that used to work (UBO or indirect buffer beside a read-only SSBO in one memory)

**Where:** `vk/compiler/wgsl_print.c:2076-2078` (every `WGSL_STORAGE_READ` becomes `WGSL_STORAGE` in compute), which
reaches the bind-group layout as `"storage"` (`vk/driver/wg_shader.c:186`). Each `VkDeviceMemory` is still bound as
one GPUBuffer (`wg_cmd.c` bind groups, `wg_memory_buffer`).

**Defect:** WebGPU's usage-scope rule lets `storage` (writable) share a buffer only with more `storage`. It conflicts
with `uniform`, `read-only-storage` and `indirect` alike. Before L5b, a compute dispatch could read a UBO and a
read-only SSBO from the same memory (all read-only usages), or read a read-only SSBO from the memory that holds its
`vkCmdDispatchIndirect` arguments. Now the read-only SSBO is `storage`, so both combinations are invalid. The dispatch
fails validation, and through the pass the submit's command buffer fails too. The backlog entry (`docs/backlog.md`
"Usage scopes") lists "a dispatch that reads a uniform buffer and **writes** a storage buffer of one memory". The new
failures, where nothing in that memory is written, are not listed. dEQP mostly allocates one memory per buffer, so the
pass lists won't show this. Sub-allocating programs (VMA, DXVK/vkd3d, engines) will: a UBO and an input SSBO in one
block is the usual layout.

**Triggers:** a compute pipeline with a uniform buffer and a `readonly` storage buffer bound from the same
`VkDeviceMemory` (output elsewhere), or `vkCmdDispatchIndirect` whose argument buffer shares a memory with a
`readonly` SSBO the shader reads.

**Confirming test:** a `wgt_misc` scenario like 12. A compute shader reads `ubo.k` and `readonly ssbo.a[i]`, both
bound from one memory, and writes `b[i] = a[i] + k` into a second memory. Expect the values and no WebGPU error. Today
the page logs a usage-scope error and `b` stays zero. A second variant uses `vkCmdDispatchIndirect` with its arguments
in `a`'s memory.

**Possible fix:** widen to `read_write` only when another binding of the same program writes a buffer that could share
the memory. Better, decide per bind group at record time from the bound memories, which takes a program variant. Or
take the backlog's route of giving such a read-only binding its own GPUBuffer.

---

## 3. Medium: an occlusion query that ends after a dispatch invalidates the submit (copy recorded while a compute pass is open)

**Where:** `vk/driver/wg_cmd.c:1538-1546` (`query_passing`), reached from `wg_cmd.c:2208` (`OP_QUERY` kind 3);
`web/venus-gpu.ts:443-449` (`gpu_update` → `self.enc!.copyBufferToBuffer`).

**Defect:** `query_passing` checks only `r->pass == RENDER`. In any other state it calls `gpu_update`, which records
`copyBufferToBuffer` on the command encoder. When `r->pass == COMPUTE`, a compute pass is still open: `OP_QUERY` does
not call `end_pass`, and dispatches leave the pass open. WebGPU then rejects the encoder because it is locked, so
`finish()` fails and the whole submit is dropped.

**Triggers:** Vulkan allows an occlusion query to begin outside a render pass and span work. For example:
`vkCmdBeginQuery(occlusion)` outside a pass (warned, reported as passing), then `vkCmdDispatch`, then
`vkCmdEndQuery`. The same happens with render passes between the begin and the end, as long as a dispatch comes last.

**Confirming test:** in `wgt_misc`, do `vkCmdResetQueryPool`, `vkCmdBeginQuery`, `vkCmdDispatch` (writing a host
buffer), `vkCmdEndQuery`, then `vkCmdCopyQueryPoolResults`. Expect the dispatch's output and the query value 1. Today
there is a WebGPU validation error and neither lands.

**Fix:** call `end_pass(r)` before `gpu_update` when `r->pass == COMPUTE`, or queue the write until the pass ends.

---

## 4. Medium-low: `vkCmdClearAttachments` inside an active occlusion query adds to the query's count

**Where:** `vk/driver/wg_cmd.c:2034-2038` (`OP_CLEAR_RECTS` → `gpu_clear_rects`), `web/venus-gpu.ts:1182ff`
(`clearRects` draws with the render pass's encoder). The query is begun by `gpu_begin_occlusion` (`wg_cmd.c:2190`).

**Defect:** The worker clears attachments with a draw in the same WebGPU render pass. While an occlusion query is
active, WebGPU counts that draw's samples. In Vulkan a clear is not a drawing command, and occlusion queries count
only drawing commands; drivers that clear with draws (RADV, ANV meta) suspend queries around them. The result is a
nonzero ("visible") value where Vulkan gives 0, or a larger count. This was harmless before L6a, when every query
reported 1. Now that queries really count, it gives wrong answers.

**Triggers:** `vkCmdBeginQuery`, then `vkCmdClearAttachments`, then `vkCmdEndQuery` in a render pass with no draws (or
draws that fail the depth test).

**Confirming test:** a render pass with an occlusion query around one `vkCmdClearAttachments` of the whole colour
attachment. Expect 0; today it is nonzero.

**Fix:** end the WebGPU query before the clear draw. WebGPU can't resume the same index in a pass, so carry on in a
second query slot (a spare range of the set) and add the two at resolve, or draw the clear outside the query.

---

## 5. Low: the "first word saved and restored" test never reads that word

**Where:** `tests/venus/l5b/shared-full.comp:12`, checked in `tests/wgsl.test.ts:565ff`.

**Defect:** The test says it checks the `uc_save` path (`wgsl_print.c:1992-2001`), where `shm[0]` holds the condition
and is restored afterwards. The shader reads `s[4095 - lidx*64]` for `lidx` 0..63, so indices 4095 down to 63.
`s[0]` is never read after the restore. Also `s[0] = 0` while the condition stores 1, so a missing or wrong restore
(for example `shm[0] = ucs` dropped) would leave `s[0] = 1`, and the test would still pass. The test only shows that
the WGSL compiles and that the barrier sequence doesn't hang.

**Confirming test:** plant the bug by removing `line(c, "shm[0] = ucs%u;", n);` and rebuild. The test still passes.
Fix the test so one invocation (for example `lidx == 0`) also writes `s[0]` (expected 0), or seed `s[0]` with a value
other than 0 or 1.

---

## 6. Low: `maxComputeSharedMemorySize` is advertised in full, but one valid shader can't be compiled

**Where:** `vk/driver/wg_caps.c:241`; `vk/compiler/wgsl_print.c:2089-2090`, `1990-1991`.

**Defect:** When shared memory uses atomics, its size is a multiple of 16 bytes, it fills the WebGPU limit, and the
shader has a barrier under an `if` (or a `break` in a loop with a barrier), `uc_none` makes the stage fail ("a uniform
condition with shared memory of atomics filling the workgroup's storage"). The shader stays within the advertised
limit, so `vkCreateComputePipelines` failing on it is a gap in what the advertisement promises. This is documented in
vk/README.md but not checked anywhere: no test covers the failure path or the error the driver returns.

**Test:** a compute shader with `shared uint s[4096]`, an `atomicAdd` on it, and `if (cond) { barrier(); }`. Today
translation fails. Expected: it compiles (for example with a separate saved word through `atomicExchange`, or by
advertising 16 bytes less only when there are atomics, which a per-device limit can't express, so the fix belongs in
the translator).

---

## 7. Low: the face-split draw changes more than stencil ordering

**Where:** `vk/driver/wg_cmd.c:748-764` (`draw_faces`) and the three callers.

**Defect:** When the front and back stencil references or masks differ, a draw is recorded twice (front faces, then
back faces). The comment says only that "the stencil ops of the later face then run last". The same reordering also
changes:

- **blending:** non-commutative blending (for example alpha blending of a two-sided closed mesh) composites every
  back face after every front face;
- **depth with equal values:** `LESS_OR_EQUAL`/`EQUAL` ties now resolve by face, not by primitive order;
- **vertex work:** the vertex stage runs twice. That only costs time while `vertexPipelineStoresAndAtomics` is off,
  but turning that feature on (the backlog wants it for `timeline_semaphore.wait_before_signal`) would double-count
  vertex-stage atomics and stores.

**Test:** stencil test on with different front and back references, cull `NONE`, alpha blending, and two overlapping
triangles: back-facing first, then front-facing, in one draw. Compare against Vulkan's primitive-order result: the
back face's colour should be under the front face's.

---

## 8. Low: the GPUBuffer behind a query pool isn't covered by the "freed while pending" handling

**Where:** `vk/driver/wg_cmd.c:2780-2781` (`complete()` → `gpu_readback_copy(... &q->pool->values[q->lo] ...)`),
`vk/driver/wg_device.c:1230ff` (`wg_DestroyQueryPool`).

**Defect:** `struct query_readback` keeps a raw `wg_query_pool *`. Memories get `wg_submits_forget` when they are freed
while a submit is pending; query pools get nothing similar. If a pool is destroyed while the host wrongly believes its
submit is done, `complete()` writes 8 × n bytes into freed heap memory. Under Vulkan rules that is the application's
error, but finding 1 makes "wrongly believes" happen with valid applications, and the driver already defends
memories against it.

**Test:** together with finding 1: after the early `vkQueueWaitIdle`, destroy the query pool that the held submit
ends a query in, then signal. Under ASan-like checks (or a canary next to `values`), a write to freed memory shows up.

---

## Note (not counted): colour resolves still cover the whole attachment

L5b limits depth and stencil resolves to the render area (`end_rendering` sends `area`; `resolveDepth` sets a
scissor), and DONT_CARE over a partial area now stores. Colour resolves still go through WebGPU's `resolveTarget`,
which resolves the whole texture. With a partial render area, the resolve target's texels outside the area are
overwritten with whatever the multisampled attachment holds there. Vulkan leaves them alone. This predates the change
but sits next to what it fixes. A test would be like misc 11, but with a colour attachment.

Also, as documented: `vkGetQueryPoolResults` with `VK_QUERY_RESULT_WAIT_BIT` returns `VK_NOT_READY`
(`wg_device.c:1246ff`). The spec doesn't allow that when the wait is asked for. Venus's guest query feedback avoids it;
a vkr path or any direct user of the driver (`VN_PERF=no_query_feedback`) doesn't.
