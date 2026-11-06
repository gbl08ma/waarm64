# VK4 handover

## T32. What reads the attachment it writes

**State (2026-11-06).** Four of the six done and in the list: `depthBounds`, `logicOp`,
`VK_EXT_blend_operation_advanced` (a copy of the attachment before each draw that reads it, the fragment stage printed
for the key: vk/README.md "Reading the attachments") and `VK_KHR_dynamic_rendering_local_read` (the colour attachment
map in the key, the stage's outputs moved: "Colour attachment locations"). bench/vulkan/REPORT.md "VK4 T32" has the
numbers; docs/backlog.md "Reading the attachments' leftovers" what they leave.

**Left: two, each its own design.**
- `VK_EXT_attachment_feedback_loop_layout` (48 of the census): an attachment **sampled** (combined image sampler or
  sampled image) by a draw of its own pass, the image with `VK_IMAGE_USAGE_ATTACHMENT_FEEDBACK_LOOP_BIT_EXT`. T12's
  `feedback_copies` takes input attachments only, whose twin is one level and layer of 2D; dEQP-VK's cases
  (`pipeline.*.attachment_feedback_loop_layout.sampler.*`, vktPipelineAttachmentFeedbackLoopLayoutTests.cpp) sample
  the image through every view type (1D, arrays, cubes, 3D), its levels and layers past the attachment's, and depth and
  stencil read while written (`*_read_write_same_pixel`). So the twin must be a copy of the whole range the sampled view
  covers, in the view's shape (the T4 alias machinery's `image_alias` is the nearest: a texture of the image's shape,
  copied where used), renewed at the pass's barriers (`OP_PASS_READ`), and `feedback_att` must match a sampled
  descriptor whose view covers the attachment's subresource. Also `attachmentFeedbackLoopDynamicState` (dynamic state
  only). Next step: advertise the extension and its feature, run the census's 48 (`census2` sample, `DETAIL_NOTSUPPORTED`)
  to see which view types fail, then build the twin of a range.
- `VK_EXT_multisampled_render_to_single_sampled` (95: 86 `pipeline.monolithic.multisample.multisampled_render_to_single_sampled`,
  9 `api.info` format queries): a pass (dynamic rendering's `VkMultisampledRenderToSingleSampledInfoEXT`, or a subpass's)
  renders single-sampled attachments at N samples. The pass draws into a multisampled texture of its own per attachment
  (4 samples: WebGPU's only count; 2, 8 and 16 not supported), loaded from the attachment where its load op is LOAD (a
  draw: WebGPU can't copy into a multisampled texture) and resolved into it at the end (colour by WebGPU's resolve
  target, depth and stencil by the worker's drawn resolves with the pass's resolve modes, T27's). The api.info cases
  want `VkSubpassResolvePerformanceQueryEXT` and the format feature bits. Next step: advertise, run the 95, start from
  `begin_rendering`'s attachments (the crops of R3 are the nearest pattern: a texture of the pass's own standing for an
  attachment, copied in and out).

Then: both hosts' runs of their cases (SwiftShader, the M4 through `bench/gpu/sway-mac.sh`), their passing cases into
`tests/deqp/vk.txt`, `scripts/ci.sh` and `scripts/ci-deqp-vk.sh`, the kickoff's row marked done, this section deleted.
