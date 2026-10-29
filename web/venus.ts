// Venus on virtio-gpu, the device's side (docs/devices.md "virtio-gpu"; docs/graphics.md "Vulkan through Venus"): the capset and the
// blob resources' constants. The renderer behind it (virglrenderer's vkr in the GPU worker) answers the protocol; the
// device checks the commands and keeps the tables, as for virgl.

/** VIRTIO_GPU_CAPSET_VENUS. */
export const CAPSET_VENUS = 4;

/** `struct virgl_renderer_capset_venus` (virglrenderer `src/venus_hw.h` at the Venus oracle's commit): 40 u32s. */
export const VENUS_CAPSET_BYTES = (5 + 32 + 3) * 4;

/**
 * The capset `vkr_get_capset` writes (virglrenderer `src/venus/vkr_renderer.c`) in the renderer's build (vk/build.sh):
 * the protocol's versions (venus-protocol 1.1.3: wire format 1, vk.xml 1.4.357, VK_EXT_command_serialization 1,
 * VK_MESA_venus_protocol 4), blob id 0 supported, the extension mask (bit N for Vulkan extension N the renderer's
 * protocol has, bit 0 its validity), waits allowed, timelines per ring, no guest VRAM (the window is ours: blobs map
 * into it). The guest reads the mask to know what the renderer can carry, so it must be vkr's: tests/venus-renderer.test.ts
 * checks these words against the built module's.
 */
export const VENUS_CAPSET_WORDS = [1, 4211045, 1, 4, 1, 536985601, 809508864, 6253551, 3260440768, 4038813977, 2724564492,
  1093731682, 4041505551, 2519053428, 134481229, 850856538, 3321889331, 1342314299, 524490, 9240912, 135888900,
  12836865, 2166915143, 536871568, 8396834, 262152, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0];

export function venusCapset(): Uint8Array {
  return new Uint8Array(Uint32Array.from(VENUS_CAPSET_WORDS).buffer);
}

/** RESOURCE_CREATE_BLOB's `blob_mem`. */
export const BLOB_MEM_GUEST = 1, BLOB_MEM_HOST3D = 2, BLOB_MEM_HOST3D_GUEST = 3;
/** Its `blob_flags`. */
export const BLOB_FLAG_USE_MAPPABLE = 1, BLOB_FLAG_USE_SHAREABLE = 2, BLOB_FLAG_USE_CROSS_DEVICE = 4;
/** RESOURCE_MAP_BLOB's answer: the mapping's cache type (VIRTIO_GPU_MAP_CACHE_CACHED). */
export const MAP_CACHE_CACHED = 1;
/** CTX_CREATE's `context_init`: the capset in its low byte. */
export const CONTEXT_INIT_CAPSET_ID_MASK = 0xff;
/** The control header's flags: a fence, and one on the ring in `ring_idx`. */
export const FLAG_INFO_RING_IDX = 2;
