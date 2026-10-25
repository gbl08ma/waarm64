/*
 * The renderer module's exports (vk/README.md): what the GPU worker calls, around virglrenderer's vkr_renderer API
 * (the render server's), over our driver (vk/driver/). The module runs on the VM's memory 0, so a resource's mapping
 * is a plain address in it (the host-visible window's), and the guest's bytes are read where they are.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "virtgpu_drm.h"
#include "vkr_renderer.h"

/* The driver's (vk/driver/wg_private.h; not included: its headers are Mesa's, vkr's util is its own copy). */
void wg_memory_rebind(VkDeviceMemory memory, void *data);
extern void (*wg_submitted)(void);

#define EXPORT __attribute__((visibility("default")))
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))

/* The GPU worker's: a fence of `ring_idx` retired (the device answers the guest's fenced command), and a submit ran
 * (the window's written pages are taken then: web/window.ts). */
IMPORT("venus_retire") void venus_retire(uint32_t ctx_id, uint32_t ring_idx, uint64_t fence_id);
IMPORT("venus_submitted") void venus_submitted(void);

int venus_init(void);
uint32_t venus_capset(void *out);
int venus_context_create(uint32_t ctx_id, const char *name, uint32_t nlen);
void venus_context_destroy(uint32_t ctx_id);
int venus_submit(uint32_t ctx_id, void *cmd, uint32_t size);
int venus_submit_fence(uint32_t ctx_id, uint32_t flags, uint32_t ring_idx, uint64_t fence_id);
int venus_resource_create(uint32_t ctx_id, uint32_t res_id, uint64_t blob_id, uint64_t size, uint32_t flags);
void venus_resource_destroy(uint32_t ctx_id, uint32_t res_id);
int venus_resource_map(uint32_t ctx_id, uint32_t res_id, void *where);
int venus_resource_unmap(uint32_t ctx_id, uint32_t res_id);
void *venus_resource_data(uint32_t ctx_id, uint32_t res_id);
int venus_poll(void);
void *venus_alloc(uint32_t size);
void venus_free(void *p);

static void
log_message(enum virgl_log_level_flags level, const char *message, void *user_data)
{
   (void)level, (void)user_data;
   fputs(message, stderr);
}

static void
retire_fence(uint32_t ctx_id, uint32_t ring_idx, uint64_t fence_id)
{
   venus_retire(ctx_id, ring_idx, fence_id);
}

static const struct vkr_renderer_callbacks callbacks = {
   .debug_logger = log_message,
   .retire_fence = retire_fence,
};

void
vkr_wasi_memory_moved(VkDeviceMemory memory, void *data)
{
   wg_memory_rebind(memory, data);
}

/* Starts vkr: 1, or 0 if it couldn't. */
EXPORT int
venus_init(void)
{
   wg_submitted = venus_submitted;
   return vkr_renderer_init(VKR_RENDERER_THREAD_SYNC | VKR_RENDERER_ASYNC_FENCE_CB, &callbacks);
}

/* The VENUS capset into `out` (its size returned). */
EXPORT uint32_t
venus_capset(void *out)
{
   return (uint32_t)vkr_get_capset(out, 0);
}

EXPORT int
venus_context_create(uint32_t ctx_id, const char *name, uint32_t nlen)
{
   return vkr_renderer_create_context(ctx_id, VIRTGPU_DRM_CAPSET_VENUS, nlen, name);
}

EXPORT void
venus_context_destroy(uint32_t ctx_id)
{
   vkr_renderer_destroy_context(ctx_id);
}

/* A SUBMIT_3D's bytes (copied into the module's heap by the caller). */
EXPORT int
venus_submit(uint32_t ctx_id, void *cmd, uint32_t size)
{
   return vkr_renderer_submit_cmd(ctx_id, cmd, size);
}

EXPORT int
venus_submit_fence(uint32_t ctx_id, uint32_t flags, uint32_t ring_idx, uint64_t fence_id)
{
   return vkr_renderer_submit_fence(ctx_id, flags, ring_idx, fence_id);
}

EXPORT int
venus_resource_create(uint32_t ctx_id, uint32_t res_id, uint64_t blob_id, uint64_t size, uint32_t flags)
{
   enum virgl_resource_fd_type type;
   int fd;
   uint32_t map_info;
   struct virgl_resource_vulkan_info info;
   return vkr_renderer_create_resource(ctx_id, res_id, blob_id, size, flags, &type, &fd, &map_info, &info);
}

EXPORT void
venus_resource_destroy(uint32_t ctx_id, uint32_t res_id)
{
   vkr_renderer_destroy_resource(ctx_id, res_id);
}

/* Maps a resource at `where` (an address in the host-visible window, which is memory 0's: the module's own). */
EXPORT int
venus_resource_map(uint32_t ctx_id, uint32_t res_id, void *where)
{
   return vkr_renderer_map_resource(ctx_id, res_id, where);
}

EXPORT int
venus_resource_unmap(uint32_t ctx_id, uint32_t res_id)
{
   return vkr_renderer_unmap_resource(ctx_id, res_id);
}

EXPORT void *
venus_resource_data(uint32_t ctx_id, uint32_t res_id)
{
   return vkr_renderer_resource_data(ctx_id, res_id);
}

/* Runs the rings and retires fences: 1 while a ring is active (poll again soon), 0 when all are idle. */
EXPORT int
venus_poll(void)
{
   return vkr_renderer_poll();
}

/* The module's heap, for the caller's copies of submits. */
EXPORT void *
venus_alloc(uint32_t size)
{
   return malloc(size);
}

EXPORT void
venus_free(void *p)
{
   free(p);
}

