# VK4 handover

## T32. What reads the attachment it writes

**State (2026-11-06).** Five of the six done and in the list: `depthBounds`, `logicOp`,
`VK_EXT_blend_operation_advanced`, `VK_KHR_dynamic_rendering_local_read` (vk/README.md "Reading the attachments",
"Colour attachment locations") and `VK_EXT_attachment_feedback_loop_layout` with its dynamic state (a sampled view over
a copy of the image: "Feedback loops"; 561 cases). bench/vulkan/REPORT.md "VK4 T32" (both parts) has the numbers;
docs/backlog.md "Reading the attachments' leftovers" and "Feedback loops' leftovers" what they leave.

**Left: one.**
- `VK_EXT_multisampled_render_to_single_sampled` (95: 86 `pipeline.monolithic.multisample.multisampled_render_to_single_sampled`,
  9 `api.info` format queries): a pass (dynamic rendering's `VkMultisampledRenderToSingleSampledInfoEXT`, or a subpass's)
  renders single-sampled attachments at N samples. The pass draws into a multisampled texture of its own per attachment
  (4 samples: WebGPU's only count; 2, 8 and 16 not supported), loaded from the attachment where its load op is LOAD (a
  draw: WebGPU can't copy into a multisampled texture) and resolved into it at the end (colour by WebGPU's resolve
  target, depth and stencil by the worker's drawn resolves with the pass's resolve modes, T27's). The api.info cases
  want `VkSubpassResolvePerformanceQueryEXT` and the format feature bits. Next step: advertise, run the 95, start from
  `begin_rendering`'s attachments (the crops of R3 are the nearest pattern: a texture of the pass's own standing for an
  attachment, copied in and out). Note: `vk/build.sh` prints only the tail of `target/vk/wasm-build.log` on failure,
  which may be protocol warnings: check its exit code and that log.

Then: both hosts' runs of their cases (SwiftShader, the M4 through `bench/gpu/sway-mac.sh`), their passing cases into
`tests/deqp/vk.txt`, `scripts/ci.sh` and `scripts/ci-deqp-vk.sh`, the kickoff's row marked done, this section deleted.
