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

/* The profile's tables (vk/profile.ts): features and limits; its formats aren't used (WebGPU's are: wg_format.c). */
struct wg_format {
   VkFormat format;
   VkFormatFeatureFlags linear, optimal, buffer;
};
extern const struct vk_device_extension_table wg_profile_extensions;
void wg_profile_features(struct vk_features *f);
void wg_profile_properties(struct vk_properties *p);

/* The WebGPU device's optional features the driver uses (venus_init's flags, from the GPU worker). */
enum wg_feature {
   WG_FEATURE_BC = 1 << 0,
   WG_FEATURE_ETC2 = 1 << 1,
   WG_FEATURE_ASTC = 1 << 2,
   WG_FEATURE_D32S8 = 1 << 3,
   WG_FEATURE_FLOAT32_FILTER = 1 << 4,
   WG_FEATURE_DEPTH_CLIP = 1 << 5,
   WG_FEATURE_DUAL_SOURCE = 1 << 6,
   WG_FEATURE_CLIP_DISTANCES = 1 << 7,
   WG_FEATURE_DEVICE = 1 << 31, /* a device at all (none in Node: objects are kept, nothing runs) */
};
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
   /* Submits whose work isn't done yet, oldest first (struct wg_submit). */
   struct list_head pending;
   uint32_t serial;
};

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
};

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
};

/* A view as Vulkan made it (`view`: sampled or storage), and as an attachment (`att`: one level, one layer, 2D). */
struct wg_image_view {
   struct vk_image_view vk;
   const struct wg_texture_format *fmt;
   uint32_t view;
   uint32_t att;
};

struct wg_buffer_view {
   struct vk_buffer_view vk;
};

struct wg_sampler {
   struct vk_sampler vk;
   uint32_t id;
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
};

#define WG_SET_GROUPS 4
struct wg_descriptor_set {
   struct vk_object_base base;
   struct wg_descriptor_set_layout *layout;
   struct list_head link;   /* its pool's */
   uint32_t version;        /* bumped by each update */
   /* Bind groups made of it, by bind group layout, for the version they were made of. */
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

/* What a pipeline's shaders share: its bind group layouts and pipeline layout (from the resources both stages declare)
 * and, for graphics, its render pipelines by the state WebGPU bakes into them. */
struct wg_program {
   uint32_t refs;
   uint32_t bgl[WGSL_MAX_SETS];
   uint32_t layout;
   uint32_t group_count;    /* sets used: groups 0 .. group_count - 1 are set */
   uint32_t resource_count;
   struct wgsl_resource resources[WGSL_MAX_RESOURCES]; /* by group, then binding */
   int16_t dynamic[WGSL_MAX_RESOURCES];                /* the slot's dynamic index in its set, or -1 */
   uint32_t immediate_size;
   uint32_t compute;        /* a compute pipeline */
   struct hash_table *pipelines;
};

struct wg_shader {
   struct vk_shader vk;
   char *wgsl;
   struct wgsl_info info;
   uint32_t module;
   struct wg_program *program;
};

extern const struct vk_device_shader_ops wg_device_shader_ops;
void wg_cmd_bind_shaders(struct vk_command_buffer *cmd, uint32_t count, const mesa_shader_stage *stages,
                         struct vk_shader **const shaders);
void wg_program_unref(struct wg_program *p);

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
   uint8_t stencil_read, stencil_write, depth_bias, pad;
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

struct wg_query_pool {
   struct vk_query_pool vk;
   uint64_t *values;
   uint32_t set;  /* occlusion: a WebGPU query set */
};

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
      uint32_t samples;
   } pass;
   /* What was last recorded, so that unchanged state isn't recorded again. */
   struct wg_pipeline_key last_key;
   bool have_key;
   uint32_t emitted; /* WG_EMIT_* bits valid */
   uint8_t last_dyn[64];
   struct wg_descriptor_set *last_sets[2][WGSL_MAX_SETS];
   uint32_t last_bgl[2][WGSL_MAX_SETS];
   uint32_t last_dynamic[2][WGSL_MAX_SETS][32];
   uint8_t last_push[256];
   uint32_t last_push_size;
   struct wg_op_vb last_vb[8];
   struct wg_op_ib last_ib;
   struct wg_shader *last_compute;
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
/* The devices whose submits wg_complete looks in; a device's pending submits dropped (it's being destroyed). */
void wg_device_register(struct wg_device *dev, bool add);
void wg_device_drain(struct wg_device *dev);
/* Forgets a memory in the pending submits' readbacks (it's being freed). */
void wg_submits_forget(struct wg_device *dev, struct wg_device_memory *mem);

/* The bytes at `mem` + `offset` for a buffer's range, or NULL if its memory has none. */
uint8_t *wg_buffer_data(struct wg_buffer *buffer, VkDeviceSize offset);

/* Points a memory's bytes elsewhere (vkr's map of a blob into the window, and back): the renderer's only way to move
 * memory, since wasm can't remap pages. */
void wg_memory_rebind(VkDeviceMemory memory, void *data);

/* Where the host-visible window is in memory 0 (venus_init's). */
extern uintptr_t wg_window_at, wg_window_bytes;
/* Called after each submit's work is done. */
extern void (*wg_submitted)(void);
