/*
 * The renderer's Vulkan driver (vk/README.md): Mesa's Vulkan runtime over WebGPU, prefix wg. In VK1 it is the null
 * driver: it answers what Venus asks (the advertised Vulkan, a profile's: vk/profile.ts), keeps every object, records
 * every command (the runtime's command queue) and at a submit runs only what writes memory the guest reads (fills,
 * updates and copies of buffers, queries, timestamps, events: Venus's feedback slots); it draws nothing.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

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
#include "vk_sync.h"

#include "wg_entrypoints.h"

/* The profile's tables (vk/profile.ts). */
struct wg_format {
   VkFormat format;
   VkFormatFeatureFlags linear, optimal, buffer;
};
extern const struct vk_device_extension_table wg_profile_extensions;
void wg_profile_features(struct vk_features *f);
void wg_profile_properties(struct vk_properties *p);
extern const struct wg_format wg_profile_formats[];
extern const uint32_t wg_profile_format_count;

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
};

/* Memory: a host-visible one's bytes are wherever `data` says (the renderer's storage, or the window while its blob is
 * mapped: wg_memory_rebind); a device-local one has none (nothing reads it back in VK1). */
struct wg_device_memory {
   struct vk_device_memory vk;
   uint8_t *data;
};

struct wg_buffer {
   struct vk_buffer vk;
   struct wg_device_memory *mem;
   VkDeviceSize offset;
};

struct wg_image {
   struct vk_image vk;
   struct wg_device_memory *mem;
   VkDeviceSize offset;
   VkDeviceSize size;
};

struct wg_image_view {
   struct vk_image_view vk;
};

struct wg_buffer_view {
   struct vk_buffer_view vk;
};

struct wg_sampler {
   struct vk_sampler vk;
};

/* What draws in VK2 and is only kept in VK1. */
struct wg_object {
   struct vk_object_base base;
};

struct wg_descriptor_set_layout {
   struct vk_descriptor_set_layout vk;
};

struct wg_query_pool {
   struct vk_query_pool vk;
   uint64_t *values;
};

struct wg_event {
   struct vk_object_base base;
   bool set;
};

struct wg_cmd_buffer {
   struct vk_command_buffer vk;
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
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_query_pool, vk.base, VkQueryPool, VK_OBJECT_TYPE_QUERY_POOL)
VK_DEFINE_NONDISP_HANDLE_CASTS(wg_event, base, VkEvent, VK_OBJECT_TYPE_EVENT)

/* The objects VK1 only keeps, of whatever type: a handle the runtime can name. */
#define wg_object_to_handle(o) ((uint64_t)(uintptr_t)(o))
#define wg_object_from_handle(h) ((struct wg_object *)(uintptr_t)(h))

extern const struct vk_command_buffer_ops wg_cmd_buffer_ops;
extern const struct vk_sync_type wg_sync_type;

VkResult wg_queue_submit(struct vk_queue *queue, struct vk_queue_submit *submit);

/* The bytes at `mem` + `offset` for a buffer's range, or NULL if its memory has none. */
uint8_t *wg_buffer_data(struct wg_buffer *buffer, VkDeviceSize offset);

/* Points a memory's bytes elsewhere (vkr's map of a blob into the window, and back): the renderer's only way to move
 * memory, since wasm can't remap pages. */
void wg_memory_rebind(VkDeviceMemory memory, void *data);

/* Called after each submit has run (the glue counts the window's written pages there). */
extern void (*wg_submitted)(void);
