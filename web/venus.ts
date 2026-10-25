// Venus on virtio-gpu, the device's side (docs/devices.md "virtio-gpu"; docs/plans/graphics.md): the capset and the
// blob resources' constants. The renderer behind it (virglrenderer's vkr in the GPU worker) answers the protocol; the
// device checks the commands and keeps the tables, as for virgl.

/** VIRTIO_GPU_CAPSET_VENUS. */
export const CAPSET_VENUS = 4;

/** `struct virgl_renderer_capset_venus` (virglrenderer `src/venus_hw.h` at the Venus oracle's commit): 40 u32s. */
export const VENUS_CAPSET_BYTES = (5 + 32 + 3) * 4;

/**
 * A capset as `vkr_get_capset` writes it (virglrenderer `src/venus/vkr_renderer.c`): the protocol's versions (venus-protocol
 * 1.1.3: wire format 1, vk.xml 1.4.357, VK_EXT_command_serialization 1, VK_MESA_venus_protocol 4), blob id 0 supported, the
 * extension mask's validity bit with `extensions` (Vulkan extension numbers the renderer's protocol has), waits allowed,
 * timelines per ring, no guest VRAM (the window is ours: blobs map into it). The page's machine is given vkr's own.
 */
export function venusCapset(extensions: number[] = []): Uint8Array {
  const c = new Uint32Array(VENUS_CAPSET_BYTES / 4);
  c[0] = 1;
  c[1] = (1 << 22) | (4 << 12) | 357;
  c[2] = 1;
  c[3] = 4;
  c[4] = 1;
  for (const n of extensions) c[5 + (n >> 5)] |= 1 << (n & 31);
  c[5] |= 1;
  c[37] = 1;
  c[38] = 1;
  c[39] = 0;
  return new Uint8Array(c.buffer);
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
