# Review: VK4 T47–T49 (6b9eed27..dec5012b)

A static out-of-context review of the code those commits changed: vk/compiler/wgsl_print.c (inlining of single-use
values, float vectors, uniform word indexing, multisampled arrays, the atomic min/max loop, integer output clamps),
vk/driver/ (256 bytes of push constants and the draw parameters past them, `timestamps_lead`, `wg_ic`, shared images'
textures made at bind, disjoint multi-planar imports) and web/venus-share.ts, web/venus-import.ts, web/venus-gpu.ts.
I compiled a few GLSL stages with `target/vk/wgsl` (built after T49: its output inlines) to check the printer. I did
not run Tint, Chromium or any CI.

## Findings, ranked

### 1. Medium (wrong results, confirmed in the printer's output): a barycentric's source is read at the `load_interpolated_input`, not where the barycentric is

`vk/compiler/wgsl_print.c:3412` (`inline_ok`), `:2104` (`alias_loads`), `:2660-2668` (`emit_input`), `:2876` (the
barycentric prints nothing).

`load_barycentric_at_sample` / `_at_offset` print nothing. Their source (the sample index, the offset) is printed by
each `load_interpolated_input` that uses the barycentric, through `src_comp(c, &bary->src[0], 0)` /
`src_name(c, &bary->src[0])`. NIR's CSE merges equal barycentrics, so one barycentric can feed several loads, some of
them after a register store. Both name-based shortcuts treat the barycentric instruction as the source's use:

- `inline_ok` (T49) sets `inl_end` to the barycentric. `inline_value` then checks for register stores only between the
  def and the barycentric. The inlined text is evaluated later, at each load.
- `alias_loads` (older) does the same for a `load_reg` read by the barycentric. It stops scanning once the barycentric
  "reads" the load, so a store to the register after the barycentric and before a later load isn't seen.

Reproduction (`glslc -O`, `target/vk/wgsl 4`):

```glsl
#version 450
layout(location = 0) in vec4 v;
layout(location = 1) in vec4 w;
layout(location = 0) out vec4 o;
layout(set=0,binding=0) uniform U { int n; } u;
void main() {
  vec4 acc = vec4(0);
  int s = 0;
  for (int i = 0; i < u.n; i++) {
    int k = (s + 1) & 3;              // T49 inlining; with `int k = s;` the alias_loads variant
    acc += interpolateAtSample(v, k);
    s = s * 5 + int(acc.x);
    acc += interpolateAtSample(w, k);
  }
  o = acc;
}
```

The printed loop body has:

```
{ let d = wg_sample_pos(((t0 + t9) & t15)) - ...; ... t18 = ...; }   // v at k
t0 = ((t0 * t27) + ...);                                             // s stored
{ let d = wg_sample_pos(((t0 + t9) & t15)) - ...; ... t32 = ...; }   // w at the NEW s's k: wrong
```

With `int k = s;`, both loads print `wg_sample_pos(t0)` on either side of the store to `t0`. That is the alias
variant, which predates T49.

**Fix direction:** in `inline_ok` and `alias_loads`, a use by a barycentric counts as uses by every
`load_interpolated_input` of that barycentric (or never inline or alias it). Also scan for stores up to the last of
those loads, or simply refuse when the use is a barycentric.

**Test:** add the stage above to tests/wgsl.test.ts with a check that the second `wg_sample_pos` argument doesn't name
the register stored between. Better, run it at the sample rate on the page and compare to a reference that computes
`k` once.

### 2. Medium (GPU hang; depends on the backend, not observed): the unsigned min/max compare-exchange loop exits only on `exchanged`

`vk/compiler/wgsl_print.c:2444-2458` (T47). The swap loop at `:2437-2442` has a related, older form of the problem.

The new loop starts from `wg_old = atomicLoad(...)` and retries from `wg_cas.old_value` until `wg_cas.exchanged`. The
T47 fix relies on what SwiftShader does: a helper invocation's compare-exchange returns `old_value = 0`, and Tint's
SPIR-V computes `exchanged` as `old == cmp`, which turns true on the second try. WGSL gives no such guarantee for a
helper invocation, which performs no atomic and returns an indeterminate result. Tint's DemoteToHelper transform also
guards every atomic after a `discard` with `if (!discarded)`, so the result is the zero-initialised struct
(`exchanged = false`, `old_value = 0`). Dawn uses that transform where the backend has no native demote (as I
understand it, Metal and D3D, and Vulkan without demote-to-helper).

Under that transform, a fragment invocation that discarded (Vulkan demote, which the translator prints as `discard`) and
then reaches an unsigned `atomicMin`/`atomicMax` on a signed-atomic array never sees `exchanged`, and the loop never
ends. The older swap loop (`exchanged || old_value != cmp`) has the same hole whenever the compared value is 0 (a
CAS(0, 1) spin lock, for example).

**Fix direction:** stop when a try makes no progress. Break out when `!exchanged && old_value == wg_old` repeats, or
bound the loop. Alternatively skip the loop for helper or demoted invocations (`wg_helper`, or a flag set at `discard`),
whose results don't matter.

**Test:** a fragment stage that demotes half its fragments and then does `atomicMin(uint)` on a buffer that also takes
signed atomics (vkd3d's `test_atomic_instructions` shape), run through `bench/gpu/sway-mac.sh` (Metal: DemoteToHelper).
Today that should lose the device. Statically, tests/wgsl.test.ts can check that the printed loop has an exit that
doesn't depend on `exchanged`.

### 3. Low (stale or overwritten push constants within one submit): a direct draw can take two 512-byte push places against one reserved

`vk/driver/wg_cmd.c:5529` and `:5553` (`apply`), `:6660` (`push_reserve(dev, draws * align(WG_PUSH_PLACE_DP, 256))`).

A direct draw whose program reads its draw parameters, and whose pipeline pulls a binding with a divisor, takes two
places:

- `push_place(dev, p->push_ubo_size)`, which is 512 bytes because `push_ubo_size` is `WGSL_DRAW_PARAMS + 16`;
- `r->fi_place = push_place(r->dev, WG_PUSH_PLACE_DP)`, another 512, whenever the first instance changes.

The submit reserves 512 bytes a draw. Past the reserve, `push_place` wraps `push_used` to 0. It prints one stderr line
ever, and later draws' places overwrite earlier ones in the same submit. The default buffer is 1 MiB, so this takes
about 1,024 such draws (each changing its push constants and first instance) in one submit.

The ratio was the same before T47 (256 + 256 against 256), but the fix is simple: when `params && !placed`, the push
place already holds the first instance at +260, so `fi` could be `r->push_offset` instead of a new place.

**Test:** wg_test with a divisor pull plus draw parameters, about 1,100 direct draws with distinct push constants and
first instances in one submit, then check each draw's output.

## Checked and found fine

- **Inlining (T49).**
  - Evaluation order against register stores: the store scan covers the def to its use, and to the block's end for an
    if's condition. That holds except for finding 1.
  - Chains of inlined values: a later value's scan covers the earlier one's text, which it contains.
  - Values printed twice by their use (f2i's range check, `bitfield_select`, per-word offsets, the atomic loop's word):
    `inline_uses` counts the text, so a let is made.
  - The 16-entry `inl_used` cap only leaves doubled pure text.
  - Name matching (`find_whole`, `names`, the `t1` inside `t12` case); parenthesisation of non-primary text.
  - Scoping: same block, or the if right after it; the braces some uses open.
  - `loop_once` bodies; uniform conditions (`workgroupUniformLoad`, the `uc_save` paths).
  - WGSL const-expressions can't arise: every source prints as a let's name.
- **Float vectors (T49).**
  - `float_vector_line` only rewrites one-line `tN = E;` and otherwise clears the bit before `place_value`.
  - Uses are ALU float reads only: `vecN`, `bcsel`, `mov` and the bit-field sources are excluded via
    `alu_reads_typed`.
  - Declared types come from `place_values` before the pass, and vars are excluded.
- **Uniform word indexing (T49).** Constant indices are bounded by the declared array (UBO `r.size` after
  `declare_resources`, the immediates' `pc` length). The aligned path's `align_offset % 16` swizzle is correct for
  `align_mul > 16`. Push constants in the push UBO simply don't take the constant path, which is only a missed
  optimisation.
- **Multisampled arrays (T47).** Resource dim versus the view: `wg_device.c:1837` and `MsLayers.createView` force 2D;
  the `txs` and `txf_ms` paths are consistent with that. The single-layer size is documented.
- **Integer clamps (T48).**
  - Outputs are always `vec4` in `Out`, so `min` and `clamp` type-check.
  - The ranges are right for 8, 16 and 10-10-10-2, signed and unsigned.
  - `wg_ic` is only set when the stage declares it.
  - `int_range` takes channel[0] of A2R10G10B10 and A2B10G10R10 (10 bits).
  - The early-return `fs_return` copies use per-location braces.
  - `wgsl_info` is serialized whole, and caches are keyed by the build's shaderBinaryUUID.
- **256-byte push constants (T47).**
  - `record_push` and `r->push` are 256 bytes; `draw_params` is `push_ubo_size > 256`.
  - Place sizes are 512 with the parameters.
  - The pull shader's `wgv_dp[16]` matches the binding size of 272.
  - Indirect draws' prepass places are 512 bytes.
- **`timestamps_lead`.** Every call site is outside a pass. `begin_pass` no longer begins with a write after it. A
  flush inside `timestamp_slot` happens before the slot is taken.
- **Shared images' textures made at bind (T48).** Nothing names `image->tex` before the bind: views need memory,
  `image_track` only allocates `valid`, and memory allocation doesn't read it. Destroying an image that was never bound
  is fine. In the worker, `onImport(make, …)` makes no texture when the resource gives its own, and borrowed textures
  aren't destroyed.
- **Disjoint multi-planar imports.** One import per plane, each plane's import undone at destroy, and no double import
  of plane 0.
- **web/venus-share.ts `stored`/`storedOf`.** The swizzles come from virgl's `sample` (B8G8R8A8, X8R8G8B8, B10G10R10A2,
  B5G6R5's R-high packing); `raw` is detected right; X alpha is forced to 1 on conversion; the converted texture is
  freed with its resource.

## Triage (2026-11-09, the fix loop)

1. **Confirmed, fixed** (7ea7196a). Both shapes reproduced in the printer's output (`int k = (s + 1) & 3;` inlined,
   `int k = s;` aliased). `use_deferred` in vk/compiler/wgsl_print.c: neither `inline_ok` nor `alias_loads` takes a value
   whose use is a barycentric at a sample or offset, so the source is a let evaluated at its def. Test:
   tests/wgsl.test.ts "a barycentric at a sample read by two loads…" (tests/venus/t49/bary-store.frag, both variants),
   failing first; each half planted alone fails its variant.
2. **Confirmed, fixed** (066dd8c1). Hangs reproduced two ways: on SwiftShader with
   `--disable-dawn-features=vulkan_use_demote_to_helper_invocation_extension` (Tint's DemoteToHelper; the queue hung 20 s),
   and on the Mac's Metal (Chrome for Testing 157, apple metal-3: the device lost, "Discarded (victim of GPU
   error/recovery)"), with a stage that demotes half its fragments then does unsigned min and max on an atomic<i32>
   array and a compare-exchange of 0 (tests/venus/t47/minmax-demote.frag). Fix: in a fragment stage both loops end after
   1,024 tries in a row that saw the value they compared (only a spurious failure stalls a real invocation), and the
   min/max loop after 65,536 tries in all (a helper's indeterminate, varying results). Compute stages print as before.
   With the fix: [0, 7, 1, 1] natively, under DemoteToHelper and on Metal. Each loop's bound planted off fails the test.
3. **Not a defect as stated** (660c15ab, a test only). `record_draw` (wg_cmd.c, since T44) already adds a place per
   draw for a pull with a divisor (`cmd->draws += pass_replays(cmd)`), so the submit reserves 1,024 bytes for such a
   draw and the 1,100-draw submit grows the push buffer to 2 MiB. Driver test `pullDivisorsMany` (wg_test.c scenario 7:
   1,100 direct draws, each its own push constants and first instance) passes as the code is; with that reservation
   planted off it overflows and fails (topLeft clear), so it now guards it. Reusing the push place for the first
   instance was not taken: `fi` would then change at every draw and rebind the pull's group each time.
