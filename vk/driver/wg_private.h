/*
 * The renderer's Vulkan driver (vk/README.md "The driver"): Mesa's Vulkan runtime over WebGPU, prefix wg. Its
 * "hardware" is the GPU worker's WebGPU device, reached through the module's imports (wg_gpu.h). Memory, buffers and
 * images are WebGPU buffers and textures; shaders go SPIR-V → NIR → WGSL (vk/compiler/); command buffers are recorded
 * into a list of our own (wg_cmd.c) and replayed into a WebGPU command encoder at each submit, which completes later:
 * its syncs signal once the GPU's work is done and what it wrote to host-visible memory has been read back.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "util/hash_table.h"
#include "util/list.h"
#include "util/mesa-blake3.h"
#include "util/u_dynarray.h"
#include "util/vma.h"
#include "vk_alloc.h"
#include "vk_buffer.h"
#include "vk_buffer_view.h"
#include "vk_command_buffer.h"
#include "vk_command_pool.h"
#include "vk_descriptor_set_layout.h"
#include "vk_device.h"
#include "vk_device_memory.h"
#include "vk_image.h"
#include "vk_instance.h"
#include "vk_log.h"
#include "vk_object.h"
#include "vk_physical_device.h"
#include "vk_query_pool.h"
#include "vk_queue.h"
#include "vk_sampler.h"
#include "vk_shader.h"
#include "vk_sync.h"

#include "wg_entrypoints.h"
#include "wg_gpu.h"
#include "wgsl.h"

/* The WebGPU device's optional features the driver uses (venus_init's flags, from the GPU worker: web/venus-gpu.ts
 * `gpuFeatures`). */
enum wg_feature {
   WG_FEATURE_BC = 1 << 0,
   WG_FEATURE_ETC2 = 1 << 1,
   WG_FEATURE_ASTC = 1 << 2,
   WG_FEATURE_D32S8 = 1 << 3,
   WG_FEATURE_FLOAT32_FILTER = 1 << 4,
   WG_FEATURE_DEPTH_CLIP = 1 << 5,
   WG_FEATURE_DUAL_SOURCE = 1 << 6,
   WG_FEATURE_CLIP_DISTANCES = 1 << 7,
   WG_FEATURE_INDIRECT_FIRST_INSTANCE = 1 << 8,
   WG_FEATURE_TIER1 = 1 << 9,          /* texture-formats-tier1 */
   WG_FEATURE_TIER2 = 1 << 10,         /* texture-formats-tier2 (read-write storage; the translator's access) */
   WG_FEATURE_RG11B10_RENDER = 1 << 11, /* rg11b10ufloat-renderable */
   WG_FEATURE_FLOAT32_BLEND = 1 << 12, /* float32-blendable */
   WG_FEATURE_BGRA8_STORAGE = 1 << 13, /* bgra8unorm-storage */
   WG_FEATURE_TIER1_STORAGE = 1 << 14, /* storage offered for tier1's formats: the worker sets it unless held back
                                        * (`?gpu=vkhold=tier1-storage`, web/venus-gpu.ts `gpuFeatures`) */
   WG_FEATURE_SUBGROUPS = 1 << 15,     /* subgroups (the translator's subgroup operations: wg_subgroup_size) */
   WG_FEATURE_F16 = 1 << 16,           /* shader-f16 (16-bit floats in the translator) */
   WG_FEATURE_SWIZZLE = 1 << 17,       /* texture-component-swizzle (image views' component mappings) */
   /* Not the adapter's: VK3 L9a's suspects back at 4fdc69fb's behaviour for the NVIDIA run's A/B (`?gpu=vkl9=…`,
    * web/venus-gpu.ts `L9_SUSPECTS`; never by default): each pipeline's bind group layouts their own uids (wg_shader.c
    * `bgl_uid`), memories' GPUBuffers without WG_MEMORY_PAD. */
   WG_FEATURE_L9_PAD = 1 << 28,
   WG_FEATURE_L9_BGL_UIDS = 1 << 29,
   WG_FEATURE_YCBCR = 1 << 30, /* not the adapter's (VK3 L7.2): samplerYcbcrConversion and the multi-planar formats
                                * (wg_ycbcr_format), on by default since L7.3; `?gpu=vkycbcr=off` holds them */
   WG_FEATURE_DEVICE = 1 << 31, /* a device at all (none in Node: objects are kept, nothing runs) */
};

/* The WebGPU device's limits and its maker (venus_init's, from the GPU worker: web/venus-gpu.ts `LIMITS`, in this order, each
 * clamped to 32 bits). */
struct wg_limits {
   uint32_t max_texture_1d, max_texture_2d, max_texture_3d, max_texture_array_layers, max_bind_groups,
      max_dynamic_uniform_buffers, max_dynamic_storage_buffers, max_sampled_textures, max_samplers,
      max_storage_buffers, max_storage_textures, max_uniform_buffers, max_uniform_buffer_binding_size,
      max_storage_buffer_binding_size, min_uniform_buffer_offset_alignment, min_storage_buffer_offset_alignment,
      max_vertex_buffers, max_buffer_size, max_vertex_attributes, max_vertex_buffer_array_stride,
      max_inter_stage_shader_variables, max_color_attachments, max_compute_workgroup_storage_size,
      max_compute_invocations_per_workgroup, max_compute_workgroup_size_x, max_compute_workgroup_size_y,
      max_compute_workgroup_size_z, max_compute_workgroups_per_dimension, max_immediate_size,
      max_storage_buffers_in_fragment_stage, max_storage_textures_in_fragment_stage,
      max_storage_buffers_in_vertex_stage, max_storage_textures_in_vertex_stage, max_bindings_per_bind_group,
      /* Not a limit: the adapter's maker as a PCI vendor ID (web/venus-gpu.ts `VENDORS`; 0 for one it doesn't know). */
      vendor_id,
      /* Not limits: the adapter's subgroup sizes (GPUAdapterInfo's; 0 without `subgroups`). */
      subgroup_min_size, subgroup_max_size;
};
extern struct wg_limits wg_limits;
/* The bytes a memory's GPUBuffer has past its end: a uniform block's largest (wg_device.c `wg_memory_buffer`). */
#define WG_MEMORY_PAD ((wg_features & WG_FEATURE_L9_PAD) ? 0 : MIN2((uint64_t)wg_limits.max_uniform_buffer_binding_size & ~3ull, 64ull << 10))

/* What the device advertises, from the features and limits (wg_caps.c); wg_caps_init sets them (venus_init's). */
int wg_caps_init(uint32_t features, const uint32_t *limits, uint32_t count);
/* The subgroups' size the translator targets: the adapter's where it has `subgroups` of one size (WGSL has no control of
 * it), else 1 (subgroups of one invocation, the basic operations only). */
uint32_t wg_subgroup_size(void);
void wg_caps_extensions(struct vk_device_extension_table *e);
void wg_caps_features(struct vk_features *f);
void wg_caps_properties(struct vk_properties *p);
/* Whether a set layout with mutable descriptors fits a stage's bindings whatever types they're written as (VK4 T34). */
bool wg_mutable_layout_fits(const VkDescriptorSetLayoutCreateInfo *info);
struct wg_program;
struct vk_descriptor_set_layout;
/* Whether a program's bindings fit WebGPU's limits by stage and by layout (wg_caps.c, the one place that counts the
 * bindings WebGPU takes for what Vulkan binds, which the advertised limits follow), with `xfb_storage` storage buffers
 * more in the compute stage (a capture's); else false, with the cause in `error`. */
bool wg_bindings_fit(const struct wg_program *p, struct vk_descriptor_set_layout *const *layouts, char *error,
                     size_t error_size);
/* The storage buffers and uniform buffers a captured vertex stage's compute pass takes besides the stage's
 * (web/venus-gpu.ts `xfbPipeline`). */
#define WG_XFB_STORAGE 2
#define WG_XFB_UNIFORMS 1

extern uint32_t wg_features, wg_max_immediates;

/* Formats (wg_format.c). */
enum wg_format_flags {
   WG_FMT_COLOR = 1 << 0,
   WG_FMT_SAMPLE = 1 << 1,
   WG_FMT_FILTER = 1 << 2,
   WG_FMT_RENDER = 1 << 3,
   WG_FMT_BLEND = 1 << 4,
   WG_FMT_STORAGE = 1 << 5,
   WG_FMT_UINT = 1 << 6,
   WG_FMT_SINT = 1 << 7,
   WG_FMT_DEPTH = 1 << 8,
   WG_FMT_STENCIL = 1 << 9,
   WG_FMT_NOCOPY = 1 << 10,
   WG_FMT_FLOAT32 = 1 << 11,
   WG_FMT_BC = 1 << 12,
   WG_FMT_ETC2 = 1 << 13,
   WG_FMT_ASTC = 1 << 14,
   WG_FMT_D32S8 = 1 << 15,
   /* What the adapter's features add (wg_format_init resolves them into the flags above). */
   WG_FMT_T1_RENDER = 1 << 16,  /* render, blend (and multisample) with texture-formats-tier1 */
   WG_FMT_T1_STORAGE = 1 << 17, /* storage with texture-formats-tier1 */
   WG_FMT_TIER1 = 1 << 18,      /* the format itself only with texture-formats-tier1 (16-bit normalized) */
   WG_FMT_RG11B10 = 1 << 19,    /* render and blend with rg11b10ufloat-renderable */
   WG_FMT_BGRA8 = 1 << 20,      /* storage with bgra8unorm-storage */
   /* WebGPU has storage textures of it. WG_FMT_STORAGE alone: offered for storage all the same, by the image's words. */
   WG_FMT_STORAGE_TEXTURE = 1 << 21,
   /* A format WebGPU has no texture of (packed texels of 8, 16 or 32 bits; three channels, scaled and the other orders:
    * VK4 T31): a texture of its channels (rgba8unorm, rg8unorm, rgb10a2*, a wider one), its texels unpacked and packed
    * by the worker's copies (`packed` there); OPAQUE: without alpha, which stays 1 (wg_format_lacks). */
   WG_FMT_PACKED = 1 << 22,
   WG_FMT_OPAQUE = 1 << 23,
   /* D16_UNORM_S8_UINT: a depth24plus-stencil8 texture whose depth a buffer holds as 16-bit unorm (the worker's
    * `depth16`), its depth bias in D16's units. */
   WG_FMT_D16 = 1 << 24,
   /* Not advertised as a colour attachment (its texture is drawn to all the same: the worker's clears and blits). Vulkan
    * wants every colour attachment format at framebufferColorSampleCounts, and WebGPU multisamples no 32-bit float
    * texture of more than one channel; R32G32B32_SFLOAT isn't a required attachment, as most GPUs' drivers lack it. */
   WG_FMT_NO_ATTACHMENT = 1 << 25,
   /* A8_UNORM (maintenance5, VK4 T38): an r8unorm texture whose red holds alpha. Sampled through a view's swizzle (with
    * texture-component-swizzle only), cleared and drawn with alpha moved to red (the fragment stage's `wg_ar`); not
    * blended (WebGPU's red would blend by the colour factors). */
   WG_FMT_ALPHA8 = 1 << 26,
};

struct wg_texture_format {
   VkFormat vk;
   const char *name;
   uint8_t bytes, bw, bh;
   uint32_t flags;
};

void wg_format_init(uint32_t features);
struct vk_format_ycbcr_info;
/* A multi-planar format the device offers (with WG_FEATURE_YCBCR: every plane a format WebGPU samples and filters),
 * or NULL. */
const struct vk_format_ycbcr_info *wg_ycbcr_format(VkFormat format);
const struct wg_texture_format *wg_texture_format(VkFormat format);
bool wg_format_filterable(const struct wg_texture_format *f);
/* The bytes of a texel of `f` in the guest's buffers: a packed format's own (not its texture's), else the texture's. */
uint32_t wg_texel_bytes(const struct wg_texture_format *f);
/* The channels of `f`'s texture (bit i: R, G, B, A) its Vulkan format lacks (VK4 T31): kept 0 (colours) or 1 (alpha) by
 * copies, clears and write masks, and read so through a view's swizzle. */
uint32_t wg_format_lacks(const struct wg_texture_format *f);
/* A clear value as `f`'s texture takes it: what the format lacks 0 or 1, a scaled format's integers rounded. */
void wg_clear_color(const struct wg_texture_format *f, const VkClearColorValue *in, VkClearColorValue *out);
/* A vertex format's WebGPU name, or the pulled fetch's for one WebGPU's vertex buffers lack (`*pulled`: VK4 T31). */
const char *wg_vertex_format(VkFormat format);
bool wg_vertex_format_pulled(VkFormat format);
bool wg_texel_buffer_layout(VkFormat format, uint32_t *x, uint32_t p1[3], bool *storage);
void wg_format_features(VkFormat format, VkFormatFeatureFlags *linear, VkFormatFeatureFlags *optimal,
                        VkFormatFeatureFlags *buffer);
/* What views of an image of `f` can do, in the formats of `list` (NULL: any it can be viewed in), with optimal tiling:
 * an image with EXTENDED_USAGE's usage comes from these, not its own format. */
VkFormatFeatureFlags wg_view_formats_features(const struct wg_texture_format *f, const VkFormat *list, uint32_t count);

/* Building JSON for gpu_create and friends. */
struct wg_json {
   char *data;
   uint32_t len, cap;
};
void wg_json_printf(struct wg_json *j, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void wg_json_free(struct wg_json *j);
uint32_t wg_create_json(enum wg_kind kind, struct wg_json *j); /* makes it under a new id, frees the JSON */

struct wg_instance {
   struct vk_instance vk;
};

struct wg_physical_device {
   struct vk_physical_device vk;
   const struct vk_sync_type *sync_types[2];
};

struct wg_queue {
   struct vk_queue vk;
};

/* The queue families (VK4 T22): graphics, compute and transfer; compute and transfer; transfer. Each has one queue,
 * and every queue is the WebGPU device's one queue: one order of submits, in which ownership transfers between the
 * families are no-ops. */
#define WG_QUEUE_FAMILIES 3

struct wg_device {
   struct vk_device vk;
   struct wg_queue queues[WG_QUEUE_FAMILIES]; /* of the families the device was made with, `queue_count` of them */
   uint32_t queue_count;
   bool padded_views;   /* a view of a padded image, or an E5B9G9R9 one of words, was made: draws look for them
                         * (wg_cmd.c `program_keys`) */
   bool slice_views;    /* a 2D view of a 3D image was made: draws look for them (WGSL_SLICE_KEY) */
   /* Host-visible memories (their writes are uploaded at each submit). */
   struct list_head host_memories;
   /* Memories with a shared image bound (wg_device_memory.image). */
   struct list_head shared_memories;
   /* Linear images bound to host-visible memory (wg_image.linear_link): the guest reads and writes their bytes there. */
   struct list_head linear_images;
   /* Shared images with words (wg_image.words_link): a submit's writes to the words go back to the texture others read. */
   struct list_head shared_words;
   /* Submits whose work isn't done yet, oldest first (struct wg_submit). */
   struct list_head pending;
   /* Submits held for a timeline value nothing has signalled or will signal yet, or for a binary semaphore a held submit
    * signals (wg_cmd.c `struct held`), oldest first: each queue's replayed in its order once their waits are met. */
   struct list_head held;
   /* The window's pages written since this device last uploaded (a bit each; wg_cmd.c `take_pages`: the write-watch is
    * the window's, so each look's pages go to every device), with the words [pages_lo, pages_hi) that may hold bits;
    * `pages_all`: every page counts. */
   uint32_t *pages;
   uint32_t pages_lo, pages_hi;
   bool pages_all;
   /* Push constants past the immediates (wg_cmd.c): a uniform buffer the draws read at dynamic offsets, written from
    * `push_data` before each submit; `push_size` bytes (grown before a submit that could fill it), `push_gen` naming
    * it among every device's push buffers (bind groups of it are kept by it). */
   uint32_t push_buffer;
   uint8_t *push_data;
   uint32_t push_used, push_size, push_gen;
   uint32_t fan_indices;   /* wg_fan_indices */
   /* Attachments of passes that have none (WebGPU's passes need one; wg_cmd.c `dummy_attachment`): by size and samples. */
   struct wg_dummy *dummies[16];
   uint32_t twin_mark; /* feedback_copies' marks: taken in order, across command buffers */
   uint32_t query_mux; /* the query set of a pass of several pools' queries (`query_count` in wg_cmd.c) */
   uint32_t query_scratch, query_scratch_size; /* where a pass's occlusion queries are resolved (wg_cmd.c end_pass) */
   bool aliased;           /* an image has aliases: the replay looks at what each scope binds (wg_cmd.c `scope_images`) */
   /* Copies of what a usage scope reads from a GPUBuffer it also binds as writable storage (VK4 T3; wg_cmd.c
    * `shadow_place`): `shadow_size` bytes, places taken in order within a submit from `shadow_used`. [0] those only read,
    * [1] those written and copied back: a GPUBuffer written in a scope can't be read otherwise in it, shadows included. */
   uint32_t shadow[2];
   uint64_t shadow_size[2], shadow_used[2];
   /* What storage bindings a program's variant doesn't read bind, each its own 256 bytes (`storage_alias` in wg_cmd.c). */
   uint32_t alias_dummy;
   /* Memory with device addresses (VK4 T7; vk/README.md "Device addresses"): all of it in one GPUBuffer, grown in place
    * (`address_gen` counts that, for the bind groups that name it), an address being a byte of it. */
   uint32_t address_buffer, address_gen;
   uint64_t address_size;
   struct util_vma_heap address_heap;
   bool address_heap_made;
   struct list_head address_memories;
   /* Render pipelines made at vkCreateGraphicsPipelines (wg_cmd.c `wg_pipeline_premake`): a command buffer of the
    * device's that a new pipeline is bound into for its state, and what a dynamic viewport is guessed to be (the last
    * draw's flips). */
   struct vk_command_pool *premake_pool;
   struct wg_cmd_buffer *premake_cmd;
   bool premake_flip, premake_flip_z;
};
#define WG_PUSH_BUFFER_SIZE (1u << 20)
/* The bytes a memory's GPUBuffer has past it, for a uniform block declared past the range bound. */
uint32_t wg_address_buffer(struct wg_device *dev);
/* (A memory the size of the largest GPUBuffer has what's left.) */
#define wg_memory_pad(mem) ((mem)->address ? (uint64_t)(64u << 10) : MIN2(WG_MEMORY_PAD, (uint64_t)wg_limits.max_buffer_size - MIN2((mem)->size, (uint64_t)wg_limits.max_buffer_size)))
/* Whether Venus's guest doesn't wait for an allocation's result, as vkr's users don't: wg_AllocateMemory. */
extern bool wg_unwaited_allocations;
#define WG_FAN_VERTICES 65536
/* Whether a vertex shader's outputs are captured by transform feedback (wgsl_info.xfb_stride). */
#define wg_shader_xfb(s) ((s)->info.xfb_stride[0] | (s)->info.xfb_stride[1] | (s)->info.xfb_stride[2] | (s)->info.xfb_stride[3])
/* A vertex stage that writes storage (VK4 T33, vertexPipelineStoresAndAtomics): run as compute before its draw, in a
 * cut of the render pass (wg_cmd.c `vs_prepass`), its outputs drawn by a pass-through vertex stage (web/venus-gpu.ts
 * `vsPrepass`); its resources are the compute stage's, the pre-pass's own bindings WG_XFB_STORAGE and WG_XFB_UNIFORMS
 * on top, in a group after the program's or, where it has four, in group 3 with its own. */
#define wg_shader_stores(s) ((s)->info.stores)
/* gpu_provoke's modes: each primitive's vertices rotated so that the one Vulkan provokes comes first (their order, and so
 * the winding, kept): the last vertex's of triangle lists, strips and fans and of line lists and strips, the first's of
 * indexed fans (WebGPU has no fans: their non-indexed draws take the device's fan indices). */
enum { WG_PROVOKE_TRI_LIST, WG_PROVOKE_TRI_STRIP, WG_PROVOKE_FAN_LAST, WG_PROVOKE_FAN_FIRST, WG_PROVOKE_LINE_LIST,
       WG_PROVOKE_LINE_STRIP };
uint32_t wg_fan_indices(struct wg_device *dev);

/* Memory: a GPU buffer (made at the first buffer bound to it, with every buffer usage: buffers alias by offset), and
 * for host-visible memory its bytes in memory 0 (vkr's storage, or the window while its blob is mapped:
 * wg_memory_rebind), uploaded to the buffer at each submit where the guest wrote them. Images are textures of their
 * own and don't use the buffer. */
struct wg_device_memory {
   struct vk_device_memory vk;
   uint8_t *data;
   uint32_t gpu;
   uint64_t gpu_at; /* where it starts in `gpu`: 0 but in the device's address buffer (`address`) */
   uint64_t size;   /* the buffer's (4-byte aligned) */
   bool address;    /* allocated for device addresses */
   struct list_head address_link;
   bool host;
   bool dirty;      /* all of it written (made, moved): uploaded whole at the next submit */
   bool owned;      /* `data` is ours to free */
   bool placeholder; /* one that couldn't be had, for a guest that didn't wait to hear so (wg_AllocateMemory) */
   struct list_head link;
   /* A shared image bound to it (a WSI image's dedicated memory, which the guest's compositor imports into virgl by
    * its resource: web/venus-share.ts), on the device's shared_memories while set. */
   struct wg_image *image;
   struct list_head shared_link;
   /* Imported from a dma-buf that is another renderer's resource (vkr passes its id as the fd): a virgl texture, e.g. a
    * VA-API surface's plane, whose bytes the GPU worker writes into the textures of images bound here
    * (gpu_texture_import; web/venus-import.ts). 0: not imported. */
   uint32_t import_res;
   /* Imports of it besides itself (the guest's own export imported again: an opaque fd, wg_AllocateMemory), each
    * freed as one: the memory goes with the last. */
   uint32_t aliases;
};

/* The texture of the shared image bound to a memory, or 0 (glue.c's venus_resource_texture). */
uint32_t wg_memory_texture(VkDeviceMemory memory);
/* The GPUBuffer of a memory no image is bound to, or 0 (glue.c's venus_resource_buffer): Mesa's prime blit exports a
 * buffer each frame is copied into (web/venus-share.ts). */
uint32_t wg_memory_shared_buffer(VkDeviceMemory memory);

struct wg_buffer {
   struct vk_buffer vk;
   struct wg_device_memory *mem;
   VkDeviceSize offset;     /* in its memory's GPUBuffer (past `gpu_at`) */
   VkDeviceSize mem_offset; /* in its memory, as the CPU's bytes are */
};

#define WG_IMAGE_ALIASES 7
#define WG_IMAGE_WORDS (WG_IMAGE_ALIASES + 1) /* where `valid` and an op's alias take the image's words for a texture */
/* An image is a texture, made with the image (its memory is only where its bytes are said to be). */
struct wg_image {
   struct vk_image vk;
   struct wg_device_memory *mem;
   VkDeviceSize offset;
   VkDeviceSize size;
   const struct wg_texture_format *fmt;
   uint32_t tex;
   uint32_t loop_tex; /* a copy of `tex` (wg_view_loop): what draws sample while it's an attachment of their pass */
   bool shared;     /* dma-buf memory or a DRM modifier: a WSI image the virgl renderer may sample */
   /* A linear image in host-visible memory, on the device's linear_images: its texture is loaded from the memory at
    * each submit's start and stored back at its end (wg_cmd.c), so the guest's maps see it. */
   bool linear_host;
   struct list_head linear_link;
   bool imported;   /* bound to imported memory: its texture is another renderer's resource's (gpu_texture_import) */
   /* Views in a format WebGPU won't view its texture in (VK4 T4; vk/README.md "Views in another format"): a texture of
    * that format each, the same size. `valid`, NULL without one: for each plane, level and layer (wg_image_valid), a
    * bit for each texture that holds its bytes, bit 0 its own, i + 1 aliases[i] and WG_IMAGE_WORDS the buffer below; the
    * replay keeps it, in queue order. */
   uint32_t alias_count;
   struct wg_image_alias {
      uint32_t tex;
      const struct wg_texture_format *fmt;
      uint32_t plane;
   } aliases[WG_IMAGE_ALIASES];
   uint16_t *valid;
   /* A storage image can go by words in a buffer (VK4 T7, T11; vk/README.md "Storage images as words"), made at their first
    * binding: rows 256-aligned as WebGPU's copies want them, a level and a slice at whole rows from `words_at[level]`. */
   struct list_head words_link; /* a shared image's, on wg_device.shared_words */
   uint32_t words;
   uint64_t words_at[15];
   /* A multi-planar format's planes (VK3 L7.2), each a texture of its own (plane 0's are `tex` and `fmt` above), and
    * where its bytes are: in the image's (`offset` past the image's own), or, disjoint, in a memory bound to the plane.
    * 1 for every other format. */
   uint32_t plane_count;
   struct wg_image_plane {
      uint32_t tex;
      const struct wg_texture_format *fmt;
      VkExtent2D extent;          /* level 0's, in the plane's texels */
      VkDeviceSize offset, size;  /* in the image's bytes */
      struct wg_device_memory *mem;
      VkDeviceSize mem_offset;
   } planes[3];
};
/* The plane an aspect names (PLANE_n, or 0). */
uint32_t wg_image_plane(const struct wg_image *image, VkImageAspectFlags aspect);
/* The layers `valid` counts: a 3D image's level is one. */
static inline uint32_t
wg_image_valid_layers(const struct wg_image *image)
{
   return image->vk.image_type == VK_IMAGE_TYPE_3D ? 1 : image->vk.array_layers;
}
static inline uint16_t *
wg_image_valid(const struct wg_image *image, uint32_t plane, uint32_t level, uint32_t layer)
{
   return &image->valid[((plane * image->vk.mip_levels + level) * wg_image_valid_layers(image)) + layer];
}
/* The formats Vulkan's atomics take on images and texel buffers here. */
static inline bool
wg_atomic_format(VkFormat format)
{
   return format == VK_FORMAT_R32_UINT || format == VK_FORMAT_R32_SINT;
}
/* Whether a storage image of this format can go by its words (atomics, or an access WebGPU has no texture for). */
bool wg_storage_words(VkFormat format);
/* The image's words (made at the first call), a row's bytes and the rows of a slice at a level. */
uint32_t wg_image_words(struct wg_image *image);
static inline uint32_t
wg_image_row_bytes(const struct wg_image *image, uint32_t level)
{
   return align(DIV_ROUND_UP(u_minify(image->vk.extent.width, level), image->fmt->bw) * image->fmt->bytes, 256);
}
/* Where a level and layer of an image is in its memory, as GetImageSubresourceLayout says. */
void wg_image_subresource(const struct vk_image *image, uint32_t level, uint32_t layer, VkSubresourceLayout *out);

/* maxMultiviewViewCount. */
#define WG_MAX_VIEWS 8
#define WG_MAX_LAYERS 256 /* of a pass: its load and store ops and clears reach them (wg_CmdBeginRendering) */
/* A view as Vulkan made it (`view`: sampled or storage), and as an attachment (`att`: one level, one layer, 2D). */
struct wg_image_view {
   struct vk_image_view vk;
   const struct wg_texture_format *fmt;
   uint32_t view;
   uint32_t storage; /* a cube or cube-array view's faces as a 2D array, for a storage binding (WebGPU has no cube storage
                      * views); 0: `view` serves */
   uint32_t sampled; /* `view` with the component mapping, which WebGPU allows only on a view that's just sampled (0: none) */
   uint32_t faces;   /* an integer cube view's faces as a 2D array, sampled (the translator fetches: wgsl_sampler.c) */
   bool rgb9e5;      /* an E5B9G9R9 view of a 32-bit integer image: `view` is of its own texture, which the shader
                      * fetches as words and decodes (VK4 T23; wgsl_sampler.c `rgb9e5_decode`) */
   bool padded;      /* of a compressed image larger in its texture (whole blocks: the filter is the shader's, and a
                      * cube's `view` is its faces, a texture not square having no cube view) */
   uint32_t att;
   int32_t slice;   /* a 3D image's: the attachment is its level's 3D view, drawn into at this depth slice (else -1) */
   /* A multi-planar view's planes (VK3 L7.2: each plane's texture's, plane 0's `view`); a sampler's YCbCr conversion
    * samples each (wgsl_lower_ycbcr). */
   uint32_t plane_count;
   uint32_t planes[3];
   uint32_t first_plane; /* of a one-plane view */
   uint32_t alias;       /* the image's texture it views: 0 its own, i + 1 aliases[i] */
   /* A copy of what the view shows, read where its image is an attachment of the pass (wg_view_twin, `feedback_copies`
    * in wg_cmd.c), and the mark it was made at. */
   uint32_t twin_tex, twin, twin_mark;
   uint32_t twin_depth; /* the twin's depth aspect alone, of a depth and stencil view (wg_view_twin_depth) */
   /* The view of a copy of the image's texture (wg_image.loop_tex), which a draw samples where the view covers an
    * attachment of its pass (a feedback loop: wg_view_loop, `feedback_copies`); its twin_mark is the copy's. */
   struct wg_image_view *loop;
   /* What the view's attachment is drawn in by a pass rendering it at `ms_samples` samples
    * (VK_EXT_multisampled_render_to_single_sampled: wg_view_ms), resolved into it. */
   struct wg_image_view *ms;
   uint32_t ms_samples;
   uint32_t *layer_atts;  /* multiview, layered passes: layers past the first as attachments (wg_view_att), WG_MAX_LAYERS - 1 of them */
   struct wg_view_crop *crops; /* the attachment in a pass smaller than it (wg_view_crop) */
   /* A sampled 2D array view of one layer as a 2D view, for a shader that declares it 2D (0: none). Vulkan wants the
    * view's type to be the shader's; Godot binds its 2D array default texture to 2D samplers (SDFGI's compute stages),
    * which native drivers read as its layer, and WebGPU refuses the bind group (GD G4). */
   uint32_t flat;
   uint32_t flat_storage; /* the same, for a storage binding (one level, the view's format: VK4 T37) */
};

/* A view's attachment for multiview's view `view`: its layer past the view's first. */
uint32_t wg_view_twin(struct wg_image_view *view);
/* The view, of a copy of the image, that a feedback loop's draw samples (made at the first call). */
struct wg_image_view *wg_view_loop(struct wg_image_view *view);
/* A multisampled image of the view's level and layers, its format and size, and its view (made at the first call). */
/* NULL where WebGPU can't multisample the view's format (or for another count than the first call's). */
struct wg_image_view *wg_view_ms(struct wg_image_view *view, uint32_t samples);
/* Whether WebGPU multisamples textures of the format. */
bool wg_format_multisamples(const struct wg_texture_format *f);
/* The twin's view of its depth alone (a depth-only view's twin is that already). */
uint32_t wg_view_twin_depth(struct wg_image_view *view);
/*
 * WebGPU wants a render pass's attachments of one size; Vulkan only that the render area fits each. An attachment larger
 * than its pass's others is drawn in a texture of the pass's size, the crop, copied from it before the pass and back
 * after (wg_cmd.c `crop_copies`). `wg_view_crop` is the crop, `wg_crop_att` a layer's attachment of it.
 */
struct wg_view_crop {
   struct wg_view_crop *next;
   uint32_t width, height, texture;
   uint32_t atts[]; /* a layer's view, of the view's layers */
};
struct wg_view_crop *wg_view_crop(struct wg_image_view *view, uint32_t width, uint32_t height);
uint32_t wg_crop_att(struct wg_image_view *view, struct wg_view_crop *crop, uint32_t index);
uint32_t wg_view_att(struct wg_image_view *view, uint32_t index);

/* A texel buffer's view: where its words are bound from (the memory's GPUBuffer, at a storage-aligned offset) and
 * its parameters for the translator's loads and stores (wg_texel_buffer_layout: 32 bytes of its group's table, wg_cmd.c
 * `param_table`); `offered`: of a format texel buffers offer. */
struct wg_buffer_view {
   struct vk_buffer_view vk;
   struct wg_device_memory *mem;
   uint64_t at, size;
   uint32_t params[8];
   bool offered;
};

struct wg_sampler {
   struct vk_sampler vk;
   uint32_t refs;      /* its own, and each set layout's that has it immutable */
   uint32_t id;
   uint32_t nearest;   /* its twin with nearest filters, for unfilterable views (0: it is one) */
   bool compare;
   /* What the shader must do of it (wgsl_sampler.c; `key.texture` and the rest filled per binding by wg_cmd.c
    * `pair_key`): `emulated` for any float texture, whose other samplers are WebGPU's alone. */
   bool emulated;
   struct wgsl_sampler_key key;
};

/* A set layout as slots: binding b's elements are slots first[b] .. first[b] + count[b] - 1 (wgsl.h). */
/* A descriptor type's bit in a binding's `types`: the core types' own, inline uniform blocks 11, the rest 12. */
static inline uint32_t
wg_type_bit(VkDescriptorType t)
{
   return t <= VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT ? 1u << t : t == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK ? 1u << 11 : 1u << 12;
}

struct wg_descriptor_set_layout {
   struct vk_descriptor_set_layout vk;
   uint32_t binding_count;  /* the highest binding number + 1 */
   uint32_t immutable_count; /* the entries of `immutable` */
   uint32_t slot_count;
   uint32_t dynamic_count;
   int32_t *first;
   uint32_t *count;
   VkDescriptorType *type;  /* by binding */
   VkShaderStageFlags *stages; /* by binding */
   uint32_t *inline_bytes;  /* by binding: an inline uniform block's bytes */
   uint32_t *types;         /* by binding: the types it may hold, wg_type_bit's (a mutable one's list: VK4 T34) */
   uint32_t inline_size;    /* a set's bytes of inline uniform blocks, each block 256-aligned */
   int16_t *dynamic;        /* by slot: its index among the dynamic offsets, or -1 */
   struct wg_sampler **immutable; /* by slot, or NULL */
   /* YCbCr (VK3 L7.2): by binding, the slot its elements' other planes start at (wgsl.h; -1: none), and by slot, the
    * immutable sampler's conversion (NULL: none) and, for a plane slot, the element's slot (-1: not a plane's). The
    * tables are NULL in a layout without conversions. */
   int32_t *planes;
   const struct vk_ycbcr_conversion_state **ycbcr;
   int32_t *owner;
};

struct wg_descriptor {
   VkDescriptorType type;
   uint8_t plane;           /* a plane slot's: the element's view's plane it binds (wg_descriptor_set_layout.owner) */
   struct wg_buffer *buffer;
   VkDeviceSize offset, range;  /* an inline uniform block's: its bytes in its set's buffer, `inline_buffer` */
   uint32_t inline_buffer;
   uint32_t inline_room;    /* and the bytes from its start to that buffer's end */
   struct wg_image_view *view;
   struct wg_sampler *sampler;
   struct wg_buffer_view *texel;
};

#define WG_SET_GROUPS 4
struct wg_descriptor_set {
   struct vk_object_base base;
   struct wg_descriptor_set_layout *layout;
   struct list_head link;   /* its pool's */
   uint32_t version;        /* bumped by each update */
   uint32_t uid;            /* the set's own number, never reused */
   uint8_t *inline_data;    /* its inline uniform blocks' bytes (wg_descriptor.c) */
   uint32_t inline_buffer;
   /* Bind groups made of it (and of the sets after it in group 3: their versions hashed), by bind group layout (its
    * uid), for the version they were made of. */
   struct { uint32_t bgl, version, group, table; } groups[WG_SET_GROUPS]; /* table: its parameter table's buffer */
   uint32_t next_group;
   struct wg_descriptor slots[];
};

struct wg_descriptor_pool {
   struct vk_object_base base;
   struct list_head sets;
};

struct vk_descriptor_update_template;
struct wg_descriptor_set *wg_descriptor_set_create(struct wg_device *dev, struct wg_descriptor_set_layout *layout);
void wg_descriptor_set_destroy(struct wg_device *dev, struct wg_descriptor_set *set);
void wg_descriptor_write(struct wg_descriptor_set *set, const VkWriteDescriptorSet *w);
void wg_descriptor_write_template(struct wg_descriptor_set *set, const struct vk_descriptor_update_template *t,
                                  const void *data);

/* The sets a bind group holds at most: sets 3 and up share group 3. */
#define WG_GROUP_SETS (WGSL_MAX_SETS - WGSL_MAX_GROUPS + 1)
#define WG_DYNAMIC_PUSH (-2)
/* What a pipeline's shaders share: its bind group layouts and pipeline layout (from the resources both stages declare)
 * and, for graphics, its render pipelines by the state WebGPU bakes into them. */
/*
 * A storage binding of a variant whose bytes overlap another writable binding of its draw or dispatch, which WebGPU
 * refuses ("Writable storage buffer binding aliasing"): the first of such a run binds all of it (`reach` bytes) and the
 * others' accesses go through it, `delta` bytes on. `bytes`: the size the shader asks of it (the variant's text replaces
 * its `arrayLength`). `res` and `to` as res_index: equal for the first.
 */
struct wg_storage_alias {
   uint32_t res, to;
   uint32_t delta, bytes, reach;
};

struct wg_program {
   uint32_t refs;
   uint32_t bgl[WGSL_MAX_GROUPS];
   uint32_t bgl_uid[WGSL_MAX_GROUPS]; /* never reused (ids are): what sets key their bind groups by */
   uint32_t layout;
   uint32_t group_count;    /* groups 0 .. group_count - 1 are set */
   uint32_t set_count;      /* the pipeline layout's */
   uint8_t set_group[WGSL_MAX_SETS];
   uint32_t set_base[WGSL_MAX_SETS];                   /* its first slot in its group */
   uint32_t resource_count;
   struct wgsl_resource resources[WGSL_MAX_RESOURCES]; /* by group, then binding */
   int16_t dynamic[WGSL_MAX_RESOURCES];                /* the slot's dynamic index in its set, -1, or WG_DYNAMIC_PUSH */
   int8_t res_set[WGSL_MAX_RESOURCES];                 /* the set a resource is of (-1: the push constants') */
   uint32_t immediate_size;
   uint32_t push_ubo_size;  /* push constants read from the device's push buffer */
   uint32_t push_group;     /* a group 3 of the push buffer alone (no set there) */
   uint32_t push_group_gen; /* ... of the push buffer `wg_device.push_gen` */
   uint8_t vis[WGSL_MAX_RESOURCES];                    /* the stages that see each resource */
   uint32_t pair_count;
   uint32_t pairs[WGSL_MAX_PAIRS][2];                  /* textures and the samplers they're sampled with */
   uint32_t int_pair_count;                            /* integer textures': WGSL fetches them, no sampler bound */
   uint32_t int_pairs[WGSL_MAX_PAIRS][2];
   uint32_t key_pair_count;                            /* wgsl_info's: pairs an op needs a key for */
   uint32_t key_pairs[WGSL_MAX_PAIRS][3];
   bool pairs_full;          /* program_create's: its stages' pairs past WGSL_MAX_PAIRS (the pipeline refused) */
   uint32_t compute_module;
   char *compute_wgsl;       /* a compute program's WGSL (a base's: its variants' modules are made from it) */
   struct wg_stage_nir *compute_nir; /* a base's, with it */
   bool owns_compute_module; /* the shader that made it was destroyed while others shared the program: it frees it */
   /* Variants of the program for what the shader didn't type (wg_program_variant): textures declared filterable
    * float bound to depth or unfilterable views, and a dispatch's read-only storage buffers bound from a memory it
    * writes through another, by a mask of those resources, and samplers WebGPU's can't express, by `keys` (each pair's
    * that isn't plain, in the program's order); a base's list, through `variants`. */
   uint64_t mask[2];
   uint64_t mixed[2]; /* a base's: wg_program_mixed */
   bool mixed_known;
   char *refused;     /* a variant's: why a stage doesn't print against its keys, its draws dropped */
   struct wgsl_sampler_key *keys;
   uint32_t key_count;
   /* Writable storage bindings of one range (`wg_storage_alias`). */
   struct wg_storage_alias *aliases;
   uint32_t alias_count;
   struct wg_program *variants;
   struct wg_program *base;  /* a variant's program */
   /* A variant's split samplers (wg_program_variant): (group, texture's binding, sampler's binding), the texture
    * sampled through the sampler's twin at the binding before it; its render modules with them (0: the stage's own). */
   uint32_t split_count;
   uint32_t splits[8][3];
   uint32_t vs_module, fs_module;
   bool stage_modules_made;
   uint32_t fs_no_depth;    /* the fragment module without its depth output, and whose it is (fragment_without_depth) */
   const struct wg_shader *fs_no_depth_of;
   uint32_t compute;        /* a compute pipeline */
   bool vs_stores;          /* its vertex stage writes storage (wg_shader_stores) */
   bool uses_base;          /* its stage reads workgroup or global ids */
   struct wg_based {        /* the pipelines of vkCmdDispatchBase's bases */
      uint32_t base[3], pipeline;
      struct wg_based *next;
   } *based;
   struct hash_table *pipelines;
   struct wg_pull *pulls;   /* wg_pipeline_pull's, by the bindings pulled */
   struct wg_dst *dsts;     /* wg_pipeline_dst's */
   struct wg_dst_module { struct wg_dst_module *next; uint32_t id; } *dst_modules; /* their fragment modules */
   /* What identifies the program across shaders (wg_shader.c `program_link`): its data and its stages' WGSL. Stages
    * compiled or loaded from a cache separately find their program by it (`programs`), so that a vertex and fragment
    * shader of one link share one program however they came. */
   blake3_hash link;
   bool listed;
   /* Programs of this one's stages with another program's (wg_program_merge), by that one's link (`with`): a list
    * through `merged`, freed with this one. */
   struct wg_program *merged;
   blake3_hash with;
};

/* A stage's lowered NIR, serialized, for the variants that print it against sampler keys (a stage that samples: another
 * stage's is NULL), and what else its print took. */
struct wg_stage_nir {
   void *data;
   size_t size;
   bool has_fs;
   struct wgsl_varyings fs;
};

struct wg_shader {
   struct vk_shader vk;
   char *wgsl;
   struct wg_stage_nir *nir;
   struct wgsl_info info;
   uint32_t module;
   uint32_t empty_fs; /* a vertex shader's: the fragment stage of its pipelines without one in a pass with colour */
   struct wg_program *program;
};

extern const struct vk_device_shader_ops wg_device_shader_ops;
void wg_sampler_unref(struct wg_device *dev, struct wg_sampler *sampler, const VkAllocationCallbacks *alloc);
void wg_program_mixed(struct wg_program *p);
bool wg_counts_sane(uint32_t resources, uint32_t pairs, uint32_t int_pairs, uint32_t key_pairs);
void wg_cmd_bind_shaders(struct vk_command_buffer *cmd, uint32_t count, const mesa_shader_stage *stages,
                         struct vk_shader **const shaders);
void wg_program_unref(struct wg_program *p);
/* The driver's build ID (vk/gen.ts), the shader caches' identity. */
const char *wg_build_id(void);
/* The variant of a program whose textures in `mask` (by resource index) are bound as unfilterable float, and the
 * samplers they're sampled with as non-filtering, whose read-only storage buffers in it as writable storage, and whose
 * stages print against `keys`; made at its first use, kept with the program. */
uint32_t wg_compute_based(struct wg_program *p, uint32_t x, uint32_t y, uint32_t z);
struct wg_program *wg_program_variant(struct wg_program *p, const uint64_t *mask, const struct wgsl_sampler_key *keys,
                                      uint32_t key_count, const struct wg_storage_alias *aliases, uint32_t alias_count);
void wg_variant_modules(struct wg_program *v, const struct wg_shader *vs, const struct wg_shader *fs);
struct wg_program *wg_program_merge(struct wg_program *a, const struct wg_program *b, const struct wgsl_info *vs,
                                    const struct wgsl_info *fs);
/* VK4 T37's test of the merge's refusal (wg_test.c `wgt_merge_refused`). */
int wg_merge_refuses(void);

/* The state a render pipeline is made with (wg_cmd.c fills it at each draw; zeroed whole so it hashes as bytes). */
#define WG_VERTEX_BINDINGS 16

struct wg_pipeline_key {
   struct wg_shader *vs, *fs;
   uint8_t topology, strip_index, front_face, cull, unclipped, flip, samples, alpha_to_coverage;
   uint32_t sample_mask;
   uint32_t color_count;
   VkFormat colors[8];
   VkFormat depth;
   uint8_t depth_test, depth_write, depth_compare, stencil_test;
   uint8_t view, view_pad[3]; /* multiview, a stage reading the view: `wg_view` (0 else) */
   uint8_t stencil[2][4];   /* front, back: fail, pass, depth fail, compare */
   uint8_t stencil_read, stencil_write, depth_bias, flip_z; /* flip_z: the viewport's depth range inverted */
   float bias_constant, bias_slope, bias_clamp;
   struct {
      uint8_t enable, src, dst, op, asrc, adst, aop, mask;
   } blend[8];
   uint32_t vb_count;
   struct {
      uint16_t stride;
      uint8_t instance;
      uint8_t pull;         /* read through a storage binding (wg_vertex_pull) */
   } vb[WG_VERTEX_BINDINGS];
   struct {
      uint8_t binding, pad[3];
      VkFormat format;
      uint32_t offset;
   } attr[32];
   /* What the fragment stage reads of the attachments it writes (VK4 T32, wg_shader.c `fragment_dst`): the depth bounds
    * test (the attachment's depth in [bounds_min, bounds_max]), a logic op (VkLogicOp + 1, 0 none) on the colour
    * attachments in `logic_mask` (integer and normalized ones: blending off), and advanced blends by attachment
    * (VkBlendOp - VK_BLEND_OP_ZERO_EXT + 1, 0 none; flags: 1 source premultiplied, 2 destination, 4 results clamped;
    * overlap a VkBlendOverlapEXT). Each reads a copy of the attachment made before the draw. */
   uint8_t depth_bounds, logic_op, logic_mask, dst_pad;
   /* The colour attachments' locations (VK_KHR_dynamic_rendering_local read's map: attachment i takes the fragment
    * output at color_map[i], 0xff none), where `mapped` (else attachment i takes location i). */
   uint8_t mapped, color_map[8];
   float bounds_min, bounds_max;
   struct {
      uint8_t op, flags, overlap, pad;
   } adv[8];
};

uint32_t wg_render_pipeline(struct wg_program *p, const struct wg_pipeline_key *key);
/* The same, made at the pipeline's creation (wg_pipeline_premake): marked for the worker's count of those a draw uses. */
uint32_t wg_render_pipeline_premade(struct wg_program *p, const struct wg_pipeline_key *key);
/* A graphics pipeline's render pipelines made at its creation, from its static state and the render pass it is for (a
 * dynamic viewport's flip guessed, not indexed, nothing pulled for offsets: a draw that differs makes its own), unless
 * a draw's dynamic state would decide them (vk/README.md "Pipelines made asynchronously"). */
void wg_pipeline_premake(struct wg_device *dev, VkPipeline pipeline, const VkGraphicsPipelineCreateInfo *info);
void wg_pipeline_premake_finish(struct wg_device *dev);
extern bool wg_premake_off;
/* The queue families advertised (glue.c `venus_queue_families`; the page's `?gpu=vkqueues=`), WG_QUEUE_FAMILIES by default. */
extern uint32_t wg_queue_families;
/* What the emulated paths did since the start (VK4 T23; glue.c `venus_emul_counts`, the render stats' `venusEmul`):
 * the copies a usage scope's shadows took and gave back and the passes its barriers cut (T3, R2), the copies between a
 * view format's texture and another's (T4) and between a texture and its words (T11), a feedback loop's copies (T12),
 * the draws whose vertices were pulled (T5), the variants made and the draws and dispatches through a keyed one (T8,
 * T9, T18, G5), the passes made before a render pass (provoking vertices, indexed and indirect fans: VK3 L7.4, T12). */
enum wg_emul {
   WG_EMUL_SHADOW_COPIES,
   WG_EMUL_SHADOW_BYTES,
   WG_EMUL_SHADOW_BACK_BYTES,
   WG_EMUL_SCOPE_CUTS,
   WG_EMUL_VIEW_COPIES,
   WG_EMUL_VIEW_BYTES,
   WG_EMUL_WORDS_COPIES,
   WG_EMUL_WORDS_BYTES,
   WG_EMUL_FEEDBACK_COPIES,
   WG_EMUL_FEEDBACK_BYTES,
   WG_EMUL_PULLED_DRAWS,
   WG_EMUL_VARIANTS,
   WG_EMUL_KEYED_DRAWS,
   WG_EMUL_PREPASSES,
   WG_EMUL_VS_PREPASSES, /* draws whose vertex stage writes storage, run as compute before them (VK4 T33) */
   WG_EMUL_COUNT,
};
extern double wg_emul[WG_EMUL_COUNT];
/* The emulated work left out (glue.c `venus_emul_skip`; the page's `?gpu=vkskip=`, A/B only: what it leaves is wrong
 * pixels, never a refused command): the copies between view formats, those to and from words, a feedback loop's. */
enum {
   WG_SKIP_VIEWS = 1 << 0,
   WG_SKIP_WORDS = 1 << 1,
   WG_SKIP_FEEDBACK = 1 << 2,
   /* Not a skip: E5B9G9R9 views of 32-bit integer images made from then on take a texture of their own and its copies,
    * as before VK4 T23 (the decode's A/B). */
   WG_SKIP_RGB9E5 = 1 << 3,
};
extern uint32_t wg_emul_skip;
const double *wg_emul_counts(uint32_t *n);
/* WebGPU's vertex buffers for a draw: Vulkan's binding b is slot b, except that an attribute reaching past its
 * binding's stride (Vulkan allows offsets up to maxVertexInputAttributeOffset, WebGPU wants offset + size within the
 * stride) reads a slot of its own, a free one, bound to the same buffer `base` bytes further. A pulled binding
 * (wg_vertex_pull) stays at slot b with its offsets, whatever they are. */
struct wg_vertex_slots {
   uint32_t used;           /* slots */
   uint8_t binding[WG_VERTEX_BINDINGS]; /* by slot: the Vulkan binding */
   uint32_t base[WG_VERTEX_BINDINGS];   /* by slot: bytes past the binding's offset */
   uint8_t slot[32];        /* by attribute location */
   uint32_t offset[32];     /* by attribute location: its offset in its slot */
   uint32_t stuck;          /* bindings with an attribute past the stride that no slot of its own serves */
};
void wg_vertex_slots(const struct wg_pipeline_key *k, uint32_t inputs, struct wg_vertex_slots *out);
/* A pipeline whose fragment stage reads its attachments (VK4 T32): their copies in a bind group of their own, the first
 * free one past the program's and the pull's (binding i colour attachment i, 8 depth). `types` by binding: 0 none, else
 * WG_DST_* | WG_DST_MS. */
enum { WG_DST_FLOAT = 1, WG_DST_SINT, WG_DST_UINT, WG_DST_DEPTH, WG_DST_MS = 8 };
#define WG_DST_DEPTH_BINDING 8
struct wg_dst {
   struct wg_dst *next;
   uint32_t pull_slots;
   uint8_t types[9];
   uint32_t group, bgl, layout;
};
/* The key's, or NULL: it reads none, or no group is free (its draw is refused). */
const struct wg_dst *wg_pipeline_dst(struct wg_program *p, const struct wg_pipeline_key *key);
/* The fragment output location attachment `i` takes (0xff: none). */
static inline uint8_t
wg_key_location(const struct wg_pipeline_key *k, uint32_t i)
{
   return k->mapped ? k->color_map[i] : (uint8_t)i;
}
/* Whether a key reads its attachments. */
static inline bool
wg_key_reads_dst(const struct wg_pipeline_key *k)
{
   if (k->depth_bounds || k->logic_op)
      return true;
   for (uint32_t i = 0; i < 8; i++)
      if (k->adv[i].op)
         return true;
   return false;
}
/* Whether a key's pulled bindings can be, on `p`: else its draw is refused. */
bool wg_pipeline_pull_ok(struct wg_program *p, const struct wg_pipeline_key *k);
/* Sets the key's `pull` on the bindings WebGPU's vertex buffers can't take (VK4 T5; `bound`: each binding's byte in its
 * GPUBuffer): a stride, a bound offset or an attribute's offset WebGPU refuses. The vertex stage reads them from a
 * storage binding (web/venus-gpu.ts `pulledCode`). */
void wg_vertex_pull(struct wg_pipeline_key *k, uint32_t inputs, const uint64_t *bound);
/* What a pipeline's pulled bindings take: a bind group `group` of layout `bgl`, the storage bindings of `slots` and
 * their offsets' remainders' uniform, in a pipeline layout `layout` of the program's groups with it. */
struct wg_pull {
   struct wg_pull *next;
   uint32_t slots, group, bgl, layout;
};
/* The pipeline's, or NULL: nothing pulled, or no group free (four sets bound: the pipeline stays refused). */
const struct wg_pull *wg_pipeline_pull(struct wg_program *p, const struct wg_pipeline_key *key);

/* A query pool. Occlusion queries count on the GPU: the WebGPU query set `set` (a slot a query), resolved at the end of
 * each pass that used it into `buf` (each query's last value, 8 bytes a query), which vkCmdCopyQueryPoolResults copies
 * from; a submit reads back what its queries wrote into `values` at its completion. Timestamps are the CPU's at the
 * replay (`values`). `avail`: a query's availability in the queue's order (the replay's: what a copy sees); `ended`:
 * the serial of the submit that last ended it (0: reset since), available to the host once that submit completed. */
struct wg_query_pool {
   struct vk_query_pool vk;
   uint64_t *values;
   uint8_t *avail;
   uint32_t *ended;
   uint32_t set, buf;
   /* Occlusion: slots of the set past the pool's queries, each render pass's to carry on a query a clear draw cut
    * (wg_cmd.c `OP_CLEAR_RECTS`); the buffer holds their values too. */
   uint32_t spares;
};
/* The serial of the last submit completed (submits complete in their order). */
extern uint32_t wg_completed_serial;

struct wg_event {
   struct vk_object_base base;
   bool set;
};

/* A vertex or index buffer as a replay binds it. */
struct wg_op_vb {
   uint32_t slot, buffer;
   double offset, size;
};

struct wg_op_ib {
   uint32_t buffer, wide;
   double offset, size;
};

/* An attachment for passes without any (wg_cmd.c `dummy_attachment`): its ids released at its last reference's end,
 * the device's (while it keeps it) and each command buffer's that names it. */
struct wg_dummy {
   uint32_t width, height, samples, texture, view, refs;
};
void wg_dummy_unref(struct wg_dummy *d);

struct wg_cmd_buffer {
   struct vk_command_buffer vk;
   struct util_dynarray cmds;
   struct util_dynarray dummies; /* struct wg_dummy *: the attachments its passes without any name */
   struct util_dynarray push_sets; /* struct wg_descriptor_set *: push descriptors, the command buffer's own */
   struct vk_vertex_input_state vi;
   struct vk_sample_locations_state sample_locations;
   /* Recording state (wg_cmd.c). */
   struct wg_shader *shaders[MESA_SHADER_STAGES];
   struct {
      struct wg_descriptor_set *set;
      uint32_t dynamic[32];
   } sets[2][WGSL_MAX_SETS]; /* graphics, compute */
   uint8_t push[256];
   struct {
      struct wg_buffer *buffer;
      VkDeviceSize offset, size;
   } vbs[WG_VERTEX_BINDINGS];
   /* The draw being recorded: what WebGPU checks its vertex buffers against (a non-indexed draw's vertices, 0 for an
    * indexed one; any draw's instances, 0 for an indirect one): a binding it reads past is pulled (VK4 T37). */
   struct {
      uint32_t vertices, first, instances, first_instance;
   } reach;
   /* The last program_for's writable storage bindings of one range can't be one (wg_cmd.c `storage_aliases`): its draw
    * or dispatch is refused (VK4 T37: WebGPU refused it, the submit lost). */
   bool aliases_refused;
   struct wg_buffer *ib;
   VkDeviceSize ib_offset, ib_size;
   VkIndexType ib_type;
   struct {
      bool active;
      uint32_t width, height;
      uint32_t color_count;
      VkFormat colors[8];
      VkFormat depth, stencil;
      bool depth_ro, stencil_ro; /* attached in a read-only layout: WebGPU's depthReadOnly, stencilReadOnly */
      /* The depth and stencil resolves at the pass's end (WebGPU resolves colour only: the worker's draws). */
      struct wg_image_view *resolve_src[2], *resolve_dst[2]; /* depth, stencil */
      VkResolveModeFlagBits resolve_mode[2];
      struct wg_image_view *resolve_color_src[8], *resolve_color_dst[8]; /* what WebGPU's resolve can't make */
      VkRect2D area; /* the render area (depth and stencil resolves keep to it) */
      bool suspending;
      uint32_t samples;
      uint32_t dummy; /* the device's attachment's index + 1, in a pass without any (0: none) */
      /* Its view's id in the recorded pass (ten digits at that byte of `cmds`), until the pass's first draw gives its
       * samples (dummy_samples; 0: not this command buffer's pass, or given). */
      size_t dummy_at;
      uint32_t view_mask;    /* multiview: the pass replays once a view */
      uint32_t layer_mask;   /* multiview's views: what its resolves cover */
      uint32_t layer_count;  /* or a layered pass's layers */
      struct { struct wg_image_view *view; struct wg_view_crop *crop; } crops[10]; /* `crop_copies` */
      struct wg_image_view *color_views[8], *depth_view; /* what a draw reading them reads (VK4 T32) */
      uint32_t crop_count;
   } pass;
   /* What was last recorded, so that unchanged state isn't recorded again. */
   struct wg_pipeline_key last_key;
   bool have_key;
   uint32_t draws;   /* draws and dispatches recorded (secondaries' included): at most a push buffer place each */
   uint32_t draw_index; /* the next draw's gl_DrawID: VK_EXT_multi_draw's element (VK4 T26), else 0 */
   uint32_t emitted; /* WG_EMIT_* bits valid */
   uint8_t last_dyn[64];
   struct wg_descriptor_set *last_sets[2][WGSL_MAX_GROUPS][WG_GROUP_SETS];
   uint32_t last_bgl[2][WGSL_MAX_GROUPS];
   const struct wg_program *last_aliased[2][WGSL_MAX_GROUPS]; /* the variant with storage aliases a group was bound for */
   uint32_t last_dynamic[2][WGSL_MAX_GROUPS][32];
   uint8_t last_push[256];
   uint32_t last_push_size;
   struct wg_op_vb last_vb[WG_VERTEX_BINDINGS];
   struct wg_op_ib last_ib;
   struct wg_shader *last_compute;
   struct wg_program *last_program[2];
   uint32_t last_based;     /* the compute pipeline the last dispatch ran with (wg_compute_based) */
   /* Transform feedback (VK3 L7.4): the bound buffers, and whether it's active (between its begin and end). */
   struct {
      struct wg_buffer *buffer;
      VkDeviceSize offset, size;
   } xfb[4];
   bool xfb_active;
   bool xfb_record; /* record_draw records a draw's state even where it rasterizes nothing (its capture needs it) */
};

VK_DEFINE_HANDLE_CASTS(wg_instance, vk.base, VkInstance, VK_OBJECT_TYPE_INSTANCE)
VK_DEFINE_HANDLE_CASTS(wg_physical_device, vk.base, VkPhysicalDevice, VK_OBJECT_TYPE_PHYSICAL_DEVICE)
VK_DEFINE_HANDLE_CASTS(wg_device, vk.base, VkDevice, VK_OBJECT_TYPE_DEVICE)
VK_DEFINE_HANDLE_CASTS(wg_cmd_buffer, vk.base, VkCommandBuffer, VK_OBJECT_TYPE_COMMAND_BUFFER)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_device_memory, vk.base, VkDeviceMemory, VK_OBJECT_TYPE_DEVICE_MEMORY)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_buffer, vk.base, VkBuffer, VK_OBJECT_TYPE_BUFFER)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_image, vk.base, VkImage, VK_OBJECT_TYPE_IMAGE)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_image_view, vk.base, VkImageView, VK_OBJECT_TYPE_IMAGE_VIEW)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_buffer_view, vk.base, VkBufferView, VK_OBJECT_TYPE_BUFFER_VIEW)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_sampler, vk.base, VkSampler, VK_OBJECT_TYPE_SAMPLER)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_descriptor_set_layout, vk.base, VkDescriptorSetLayout,
                               VK_OBJECT_TYPE_DESCRIPTOR_SET_LAYOUT)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_descriptor_set, base, VkDescriptorSet, VK_OBJECT_TYPE_DESCRIPTOR_SET)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_descriptor_pool, base, VkDescriptorPool, VK_OBJECT_TYPE_DESCRIPTOR_POOL)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_query_pool, vk.base, VkQueryPool, VK_OBJECT_TYPE_QUERY_POOL)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_event, base, VkEvent, VK_OBJECT_TYPE_EVENT)

extern const struct vk_command_buffer_ops wg_cmd_buffer_ops;
extern const struct vk_sync_type wg_sync_type;

VkResult wg_queue_submit(struct vk_queue *queue, struct vk_queue_submit *submit);
/* A memory's GPU buffer, made if it has none (0 without a device). */
uint32_t wg_memory_buffer(struct wg_device_memory *mem);
/* The devices whose submits wg_complete looks in and the window's written pages go to (at most 16: false when full);
 * a device's pending submits dropped (it's being destroyed). */
bool wg_device_register(struct wg_device *dev, bool add);
void wg_device_drain(struct wg_device *dev);
/* Forgets a memory in the pending submits' readbacks (it's being freed). */
void wg_submits_forget(struct wg_device *dev, struct wg_device_memory *mem);
/* A query pool destroyed while submits that read its queries back are pending: their values land nowhere. */
void wg_submits_forget_pool(struct wg_device *dev, const struct wg_query_pool *pool);

/* The bytes at `mem` + `offset` for a buffer's range, or NULL if its memory has none. */
uint8_t *wg_buffer_data(struct wg_buffer *buffer, VkDeviceSize offset);

/* Points a memory's bytes elsewhere (vkr's map of a blob into the window, and back): the renderer's only way to move
 * memory, since wasm can't remap pages. */
void wg_memory_rebind(VkDeviceMemory memory, void *data);

/* Where the host-visible window is in memory 0 (venus_init's). */
extern uintptr_t wg_window_at, wg_window_bytes;
/* Called after each submit's work is done. */
extern void (*wg_submitted)(void);
