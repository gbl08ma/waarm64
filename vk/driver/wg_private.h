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
   WG_FEATURE_TIER1_STORAGE = 1 << 14, /* storage for tier1's formats: the worker sets it with texture-formats-tier1 unless
                                        * held back (`?gpu=vkhold=tier1-storage`, web/venus-gpu.ts `gpuFeatures`) */
   WG_FEATURE_SUBGROUPS = 1 << 15,     /* subgroups (the translator's subgroup operations: wg_subgroup_size) */
   WG_FEATURE_F16 = 1 << 16,           /* shader-f16 (16-bit floats in the translator) */
   WG_FEATURE_YCBCR = 1 << 30, /* not the adapter's: `?gpu=vkycbcr` advertises samplerYcbcrConversion, not translated
                                * (experiments only, VK3 L7.1b: Chromium's own Vulkan device wants it) */
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
      /* Not a limit: the adapter's maker as a PCI vendor ID (web/venus-gpu.ts `VENDORS`; 0 for one it doesn't know). */
      vendor_id,
      /* Not limits: the adapter's subgroup sizes (GPUAdapterInfo's; 0 without `subgroups`). */
      subgroup_min_size, subgroup_max_size;
};
extern struct wg_limits wg_limits;

/* What the device advertises, from the features and limits (wg_caps.c); wg_caps_init sets them (venus_init's). */
int wg_caps_init(uint32_t features, const uint32_t *limits, uint32_t count);
/* The subgroups' size the translator targets: the adapter's where it has `subgroups` of one size (WGSL has no control of
 * it), else 1 (subgroups of one invocation, the basic operations only). */
uint32_t wg_subgroup_size(void);
void wg_caps_extensions(struct vk_device_extension_table *e);
void wg_caps_features(struct vk_features *f);
void wg_caps_properties(struct vk_properties *p);

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
};

struct wg_texture_format {
   VkFormat vk;
   const char *name;
   uint8_t bytes, bw, bh;
   uint32_t flags;
};

void wg_format_init(uint32_t features);
const struct wg_texture_format *wg_texture_format(VkFormat format);
bool wg_format_filterable(const struct wg_texture_format *f);
const char *wg_vertex_format(VkFormat format);
bool wg_texel_buffer_layout(VkFormat format, uint32_t *x, uint32_t p1[3], bool *storage);
void wg_format_features(VkFormat format, VkFormatFeatureFlags *linear, VkFormatFeatureFlags *optimal,
                        VkFormatFeatureFlags *buffer);

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

struct wg_device {
   struct vk_device vk;
   struct wg_queue queue;
   /* Host-visible memories (their writes are uploaded at each submit). */
   struct list_head host_memories;
   /* Memories with a shared image bound (wg_device_memory.image). */
   struct list_head shared_memories;
   /* Linear images bound to host-visible memory (wg_image.linear_link): the guest reads and writes their bytes there. */
   struct list_head linear_images;
   /* Submits whose work isn't done yet, oldest first (struct wg_submit). */
   struct list_head pending;
   /* Submits held for a timeline value nothing has signalled or will signal yet (wg_cmd.c `struct held`), oldest
    * first: replayed in order once their waits are met. */
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
   uint32_t query_scratch, query_scratch_size; /* where a pass's occlusion queries are resolved (wg_cmd.c end_pass) */
};
#define WG_PUSH_BUFFER_SIZE (1u << 20)
#define WG_FAN_VERTICES 65536
uint32_t wg_fan_indices(struct wg_device *dev);

/* Memory: a GPU buffer (made at the first buffer bound to it, with every buffer usage: buffers alias by offset), and
 * for host-visible memory its bytes in memory 0 (vkr's storage, or the window while its blob is mapped:
 * wg_memory_rebind), uploaded to the buffer at each submit where the guest wrote them. Images are textures of their
 * own and don't use the buffer. */
struct wg_device_memory {
   struct vk_device_memory vk;
   uint8_t *data;
   uint32_t gpu;
   uint64_t size;   /* the buffer's (4-byte aligned) */
   bool host;
   bool dirty;      /* all of it written (made, moved): uploaded whole at the next submit */
   bool owned;      /* `data` is ours to free */
   struct list_head link;
   /* A shared image bound to it (a WSI image's dedicated memory, which the guest's compositor imports into virgl by
    * its resource: web/venus-share.ts), on the device's shared_memories while set. */
   struct wg_image *image;
   struct list_head shared_link;
   /* Imported from a dma-buf that is another renderer's resource (vkr passes its id as the fd): a virgl texture, e.g. a
    * VA-API surface's plane, whose bytes the GPU worker writes into the textures of images bound here
    * (gpu_texture_import; web/venus-import.ts). 0: not imported. */
   uint32_t import_res;
};

/* The texture of the shared image bound to a memory, or 0 (glue.c's venus_resource_texture). */
uint32_t wg_memory_texture(VkDeviceMemory memory);

struct wg_buffer {
   struct vk_buffer vk;
   struct wg_device_memory *mem;
   VkDeviceSize offset;
};

/* An image is a texture, made with the image (its memory is only where its bytes are said to be). */
struct wg_image {
   struct vk_image vk;
   struct wg_device_memory *mem;
   VkDeviceSize offset;
   VkDeviceSize size;
   const struct wg_texture_format *fmt;
   uint32_t tex;
   bool shared;     /* dma-buf memory or a DRM modifier: a WSI image the virgl renderer may sample */
   /* A linear image in host-visible memory, on the device's linear_images: its texture is loaded from the memory at
    * each submit's start and stored back at its end (wg_cmd.c), so the guest's maps see it. */
   bool linear_host;
   struct list_head linear_link;
   bool imported;   /* bound to imported memory: its texture is another renderer's resource's (gpu_texture_import) */
};
/* Where a level and layer of an image is in its memory, as GetImageSubresourceLayout says. */
void wg_image_subresource(const struct vk_image *image, uint32_t level, uint32_t layer, VkSubresourceLayout *out);

/* A view as Vulkan made it (`view`: sampled or storage), and as an attachment (`att`: one level, one layer, 2D). */
struct wg_image_view {
   struct vk_image_view vk;
   const struct wg_texture_format *fmt;
   uint32_t view;
   uint32_t storage; /* a cube or cube-array view's faces as a 2D array, for a storage binding (WebGPU has no cube storage
                      * views); 0: `view` serves */
   uint32_t att;
   int32_t slice;   /* a 3D image's: the attachment is its level's 3D view, drawn into at this depth slice (else -1) */
};

/* A texel buffer's view: where its words are bound from (the memory's GPUBuffer, at a storage-aligned offset) and
 * its parameters for the translator's loads and stores (a uniform buffer of 32 bytes: wg_texel_buffer_layout). */
struct wg_buffer_view {
   struct vk_buffer_view vk;
   struct wg_device_memory *mem;
   uint64_t at, size;
   uint32_t params;
};

struct wg_sampler {
   struct vk_sampler vk;
   uint32_t id;
   uint32_t nearest;   /* its twin with nearest filters, for unfilterable views (0: it is one) */
   bool compare;
};

/* A set layout as slots: binding b's elements are slots first[b] .. first[b] + count[b] - 1 (wgsl.h). */
struct wg_descriptor_set_layout {
   struct vk_descriptor_set_layout vk;
   uint32_t binding_count;  /* the highest binding number + 1 */
   uint32_t slot_count;
   uint32_t dynamic_count;
   int32_t *first;
   uint32_t *count;
   VkDescriptorType *type;  /* by binding */
   int16_t *dynamic;        /* by slot: its index among the dynamic offsets, or -1 */
   struct wg_sampler **immutable; /* by slot, or NULL */
};

struct wg_descriptor {
   VkDescriptorType type;
   struct wg_buffer *buffer;
   VkDeviceSize offset, range;
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
   /* Bind groups made of it (and of the sets after it in group 3: their versions hashed), by bind group layout (its
    * uid), for the version they were made of. */
   struct { uint32_t bgl, version, group; } groups[WG_SET_GROUPS];
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
   uint32_t compute_module;
   char *compute_wgsl;       /* a compute program's WGSL (a base's: its variants' modules are made from it) */
   bool owns_compute_module; /* the shader that made it was destroyed while others shared the program: it frees it */
   /* Variants of the program for what the shader didn't type (wg_program_variant): textures declared filterable
    * float bound to depth or unfilterable views, and a dispatch's read-only storage buffers bound from a memory it
    * writes through another, by a mask of those resources; a base's list, through `variants`. */
   uint64_t mask;
   struct wg_program *variants;
   uint32_t compute;        /* a compute pipeline */
   struct hash_table *pipelines;
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

struct wg_shader {
   struct vk_shader vk;
   char *wgsl;
   struct wgsl_info info;
   uint32_t module;
   uint32_t empty_fs; /* a vertex shader's: the fragment stage of its pipelines without one in a pass with colour */
   struct wg_program *program;
};

extern const struct vk_device_shader_ops wg_device_shader_ops;
void wg_cmd_bind_shaders(struct vk_command_buffer *cmd, uint32_t count, const mesa_shader_stage *stages,
                         struct vk_shader **const shaders);
void wg_program_unref(struct wg_program *p);
/* The driver's build ID (vk/gen.ts), the shader caches' identity. */
const char *wg_build_id(void);
/* The variant of a program whose textures in `mask` (by resource index) are bound as unfilterable float, and the
 * samplers they're sampled with as non-filtering, and whose read-only storage buffers in it as writable storage; made
 * at its first use, kept with the program. */
struct wg_program *wg_program_variant(struct wg_program *p, uint64_t mask);
struct wg_program *wg_program_merge(struct wg_program *a, const struct wg_program *b);

/* The state a render pipeline is made with (wg_cmd.c fills it at each draw; zeroed whole so it hashes as bytes). */
struct wg_pipeline_key {
   struct wg_shader *vs, *fs;
   uint8_t topology, strip_index, front_face, cull, unclipped, flip, samples, alpha_to_coverage;
   uint32_t sample_mask;
   uint32_t color_count;
   VkFormat colors[8];
   VkFormat depth;
   uint8_t depth_test, depth_write, depth_compare, stencil_test;
   uint8_t stencil[2][4];   /* front, back: fail, pass, depth fail, compare */
   uint8_t stencil_read, stencil_write, depth_bias, flip_z; /* flip_z: the viewport's depth range inverted */
   float bias_constant, bias_slope, bias_clamp;
   struct {
      uint8_t enable, src, dst, op, asrc, adst, aop, mask;
   } blend[8];
   uint32_t vb_count;
   struct {
      uint16_t stride;
      uint8_t instance, pad;
   } vb[8];
   struct {
      uint8_t binding, pad[3];
      VkFormat format;
      uint32_t offset;
   } attr[32];
};

uint32_t wg_render_pipeline(struct wg_program *p, const struct wg_pipeline_key *key);
/* WebGPU's vertex buffers for a draw: Vulkan's binding b is slot b, except that an attribute reaching past its
 * binding's stride (Vulkan allows offsets up to maxVertexInputAttributeOffset, WebGPU wants offset + size within the
 * stride) reads a slot of its own, a free one, bound to the same buffer `base` bytes further. */
struct wg_vertex_slots {
   uint32_t used;           /* slots */
   uint8_t binding[8];      /* by slot: the Vulkan binding */
   uint32_t base[8];        /* by slot: bytes past the binding's offset */
   uint8_t slot[32];        /* by attribute location */
   uint32_t offset[32];     /* by attribute location: its offset in its slot */
};
void wg_vertex_slots(const struct wg_pipeline_key *k, uint32_t inputs, struct wg_vertex_slots *out);

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

struct wg_cmd_buffer {
   struct vk_command_buffer vk;
   struct util_dynarray cmds;
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
   } vbs[8];
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
      VkRect2D area; /* the render area (depth and stencil resolves keep to it) */
      bool suspending;
      uint32_t samples;
   } pass;
   /* What was last recorded, so that unchanged state isn't recorded again. */
   struct wg_pipeline_key last_key;
   bool have_key;
   uint32_t draws;   /* draws and dispatches recorded (secondaries' included): at most a push buffer place each */
   uint32_t emitted; /* WG_EMIT_* bits valid */
   uint8_t last_dyn[64];
   struct wg_descriptor_set *last_sets[2][WGSL_MAX_GROUPS][WG_GROUP_SETS];
   uint32_t last_bgl[2][WGSL_MAX_GROUPS];
   uint32_t last_dynamic[2][WGSL_MAX_GROUPS][32];
   uint8_t last_push[256];
   uint32_t last_push_size;
   struct wg_op_vb last_vb[8];
   struct wg_op_ib last_ib;
   struct wg_shader *last_compute;
   struct wg_program *last_program[2];
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
