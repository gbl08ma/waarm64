# Static review: storage images, sampled images and views, from descriptors to WGSL and bind groups

Scope: vk/compiler/wgsl_print.c (gather, texture_images, word images, image load/size), vk/compiler/wgsl.h,
vk/driver/wg_shader.c (layouts, merge, cross-stage checks, serialization), vk/driver/wg_cmd.c (bind_group,
bind_images, scope_images, image_use), vk/driver/wg_device.c (wg_texture_create, image_alias,
view_format_aliasable, wg_CreateImageView `flat`), web/venus-gpu.ts (gpu_copy_tt, copyPacked, pack, unpack,
packPass). The working tree as it stands (GD G4's uncommitted read-only-images-as-textures, `flat` views and
packed aliases), read with the code around it. Static only: nothing was built or run.

Overall: the new paths are internally consistent in the common case (layout entry, WGSL declaration, bound view,
texture usage, scope scan and alias copies agree for a read-only storage image of a declared format). The findings
below are the cases where they don't, ranked by likely impact. None of them can, by itself, make a GPU loop run
forever; see the last section for the stall.

## 1. A read-only storage image now always takes a sampled-texture slot: legal pipelines past WebGPU's 16 textures are refused (regression)

- wgsl_print.c:930-934 (`gather`): every read-only, non-atomic, non-multisampled storage image becomes a texture,
  unconditionally.
- wg_caps.c:233-296 advertises `maxPerStageDescriptorSampledImages` = WebGPU's sampled textures (16) and
  `maxPerStageDescriptorStorageImages` = WebGPU's storage textures, separately.
- wg_caps.c `wg_bindings_fit` (≈line 490) counts the image as `WG_COUNT_TEXTURE`.

Scenario: a stage within Vulkan's advertised limits that samples 14-16 textures and also reads 1-3 storage
images (common in deferred/GI fragment and compute shaders: a G-buffer of sampled textures plus a read-only
`uimage` mask or count image). Before, the read-only images were storage textures, within that count; now they
are textures, the stage binds 17+ textures, `wg_bindings_fit` refuses the pipeline and it draws/dispatches nothing.
The choice should be by room: textures while the stage has sampled-texture room, storage textures (or words)
after, or the other way round (fill storage textures first, overflow into textures, which is what Godot's SDFGI
case needs).

## 2. Size-only access of a storage image without a declared format: wrong sample type, invalid bind group (regression from "refused" to "submit lost")

- wgsl_print.c:540-547 (`texture_image`): with no load, the sample type comes from `nir_intrinsic_format`; for
  `PIPE_FORMAT_NONE` that is `WGSL_SAMPLE_UNFILTERABLE`, `texture_*<f32>`, layout `unfilterable-float`.
- wg_shader.c:281-287 makes the layout entry from it; wg_cmd.c:3771-3772 binds the storage view.

Scenario: `layout(...) uniform readonly uimage2D img;` declared without a format (SPIR-V `Unknown`, legal for
`OpImageQuerySize` without any capability) and only `imageSize(img)` used in the stage, bound to an `R32_UINT`
view. The bind group's view (r32uint, sample type uint) doesn't match `unfilterable-float`: `createBindGroup`
fails, the dispatch's command buffer is invalid and the whole submit is dropped. Before GD G4 the same stage
failed to translate (`a storage image of format none`) and only that pipeline did nothing.
Related (wg_shader.c:739-751 `resource_merge`): `sample` isn't reconciled between stages, so a vertex stage that
loads the image (`uint`) and a fragment stage that only asks its size (format-less → f32) give one layout entry
with the first stage's type and a module with the other's: the render pipeline is invalid. The cross-stage check
at wg_shader.c:1253-1260 compares kind and access only, not `sample`.
Fix: take the sample type from the image variable's sampled type (available before deref lowering, or carried on
the intrinsic as `dest_type` is for loads), not from the format; and refuse or reconcile differing `sample` across
stages.

## 3. One subresource read through one binding and written through another in one usage scope: the dispatch or pass is invalid (pre-existing; the texture path removes the cheap way out)

- wg_cmd.c:3293-3333 (`bind_images`, `scope_images`) only keeps the alias textures and words in step; nothing
  looks for the same image level/layer bound twice in one scope with a write.

WebGPU's per-subresource usage rule allows several writable `storage` usages (the "usage scope storage exception")
but not `storage` beside any read-only usage. Vulkan allows a shader to bind one image through a `readonly` and a
`writeonly` descriptor (disjoint regions, or a 3D image whose whole level is one WebGPU subresource: cascades or
probe grids stacked along z in one 3D texture, as GI implementations do). Now the reader is a texture (`input`
usage) beside `storage`: the dispatch is a validation error and its submit is lost. It was already invalid before
(`storage-read` beside `storage`), but then the reader could have been promoted to `read_write` where the format
allows it (r32 formats in core, tier2's list), the way `program_for` promotes read-only storage buffers; a texture
can't be promoted without re-printing the stage. Worth a scan check (a subresource in `r->images` both written and
read through another binding) that either binds the reader read-write (variant) or reads a copy, as the buffer
scopes do with shadows. If Godot's SDFGI hits this anywhere, it is a whole lost submit per frame, not a wrong texel.

## 4. A storage image's 2D-array view of one layer where the shader declares a 2D image: still an invalid bind group

- wg_cmd.c:3771-3776: `res->image_texture` returns `d->view->storage` or `d->view->view` before the new
  `d->view->flat` case is reached; `flat` is also made only for views with `VK_IMAGE_USAGE_SAMPLED_BIT`
  (wg_device.c:1657-1658).

Scenario: the same Godot pattern the `flat` fix addresses (a 2D-array default texture of one layer bound where the
shader declares 2D), but through a storage descriptor (`image2D` read-only, or written). Layout says `2d`, the bound
view is `2d-array`: `createBindGroup` fails. For `image_texture` the `flat` view would serve (it is a texture view);
for a written storage texture a storage-usable 2D view of the layer would be needed (and `flat` carries the
swizzle's `"usage":4`, so it can't be used as a storage view).

## 5. `wg_program_merge` skips the cross-stage storage-image checks

- wg_shader.c:960-1040: when a draw's vertex and fragment stages come from different links, resources are merged
  with `resource_merge`, which keeps the first's `kind` and ORs storage access. None of the refusals at
  wg_shader.c:1246-1275 run. A vertex stage that reads image X as a texture (`image_texture`) merged with a fragment
  stage that writes X as a storage texture gives a `texture` layout entry and a fragment module declaring
  `texture_storage_*`: invalid render pipeline (an error, not a refusal). Same for `image_words` disagreement. Rare
  (it needs a cache whose entries disagree), but it turns a refusal into an invalid object.

## 6. packPass silently truncates large bindings (copyPacked, pack, unpack)

- web/venus-gpu.ts:2259-2265 (`range` in `packPass`): the binding size is clamped to
  `maxStorageBufferBindingSize` with no check; past it the shader's indices read and write out of bounds (WGSL
  clamps), so a large packed image's copy is quietly wrong rather than refused. With copyPacked's temporary of
  `bpr * h * depth` (2 bytes a texel, rows 256-aligned) and `unpack`'s of 4 bytes a texel, a 3D packed alias of
  256x256x512 needs a 128 MiB+ binding for the unpack temp. Also each `image_use` copy of an array image goes a layer
  at a time (wg_cmd.c:3256-3289), each layer creating two temporary buffers and two compute passes of
  `@workgroup_size(1)` workgroups: correct but costly for arrays with many layers that alternate written/sampled.

## 7. Format-less storage image writes still fail the stage (pre-existing, in the area)

- wgsl_print.c:627-633: a written image of `PIPE_FORMAT_NONE` reaches `failf("a storage image of format none")`;
  `shaderStorageImageWriteWithoutFormat` isn't advertised (no mention in wg_caps.c), yet Godot's shipped SPIR-V
  uses it: bench/results/local/godot-tools/spv/game/0x1fb0d8e5….comp (`OpCapability StorageImageWriteWithoutFormat`,
  binding 1 `image2D` of `Unknown` written). That pipeline is created empty and does nothing (whatever effect it is
  draws nothing). The format is known at bind time (the view's), so a variant keyed by the bound view's format, as the
  unfilterable variants are keyed, would serve.

## Checked and found consistent (no finding)

- `texture_image` + `emit_intrinsic` image_load: `textureLoad(t, xy[, layer], 0)` at the view's base level, typed by
  the load's base type; size queries print `textureDimensions`/`textureNumLayers` the same for textures and storage
  textures; cubes are 2D arrays in both the declaration (`image_dim`) and the bound view (`view->storage`).
- Texture usage: `wg_texture_create` adds `TEXTURE_BINDING` for storage images of every color format (all have
  `WG_FMT_SAMPLE`), alias textures included (they go through `wg_texture_create` with the image's usage); views carry
  no explicit usage except the swizzled ones (`"usage":4`), which are never storage-bound.
- `bind_images` counts an `image_texture` binding as a read in `v->alias`, the texture whose view is bound, so
  `image_use` brings words or another alias's bytes into it before the dispatch.
- Packed aliases: `view_format_aliasable`'s packed branch needs both formats 2 bytes, 1x1 blocks, no depth;
  `image_alias` makes the packed texture with its `packed` key; `gpu_copy_tt` routes any packed/non-packed or
  differently packed pair through `copyPacked`; pack and unpack round correctly (`(x*m*2+255)/510`,
  `(v*510+m)/(2m)`); words <-> packed go through `gpu_copy_tb`/`gpu_copy_bt`, which pack/unpack with the image's row
  stride.
- `flat`: made from the same texture (alias), format, aspect and swizzle as the view, one layer, released in
  `wg_DestroyImageView`; chosen only for non-multisampled 2D declarations; the bind-group cache key (bgl uid from the
  layout JSON) distinguishes `2d` from `2d-array` entries.
- Serialization: `image_texture` is in `RESOURCE_FIELDS`; the cache UUID is the build's.

## The stall (Godot SDFGI, first frame, M4/Metal)

Nothing in these paths loops on the GPU: `textureLoad`/`textureDimensions` replace storage loads one for one, and
packPass loops `w` times per invocation. The 15-image SDFGI store shader
(…/spv/game/0xccd7fbbf….comp: 13 read-only images incl. an array of 8 R8 3D images, 2 written, one R16ui) has only
constant-bounded loops and barriers in uniform control flow. If a submit never completes, the likelier sources are
(a) an invalid submit whose completion the guest waits on through something only that submit would have written
(findings 2, 3 and 4 each invalidate a whole submit rather than one pipeline), or (b) a ray-march loop elsewhere
whose step comes from data a missed alias/words copy left stale. Check the GPU worker's validation errors for that
submit first: a `createBindGroup` sample-type/dimension mismatch or a usage-scope conflict points at 2-4.
