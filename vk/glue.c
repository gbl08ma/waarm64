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
extern bool wg_unwaited_allocations;
extern bool wg_premake_off;
void wg_memory_rebind(VkDeviceMemory memory, void *data);
uint32_t wg_memory_texture(VkDeviceMemory memory);
extern void (*wg_submitted)(void);
extern uintptr_t wg_window_at, wg_window_bytes;
int wg_caps_init(uint32_t features, const uint32_t *limits, uint32_t count);
const char *wg_build_id(void);
void wg_complete(uint32_t serial);

#define EXPORT __attribute__((visibility("default")))
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))

/* The GPU worker's: a fence of `ring_idx` retired (the device answers the guest's fenced command), and a submit's
 * work is done. */
IMPORT("venus_retire") void venus_retire(uint32_t ctx_id, uint32_t ring_idx, uint64_t fence_id);
IMPORT("venus_submitted") void venus_submitted(void);

int venus_init(uint32_t features, const uint32_t *limits, uint32_t nlimits, void *window, uint32_t window_bytes);
const char *venus_build_id(void);
void venus_premake(int on);
uint32_t venus_arena_end(void);
void venus_complete(uint32_t serial);
uint32_t venus_capset(void *out);
int venus_context_create(uint32_t ctx_id, const char *name, uint32_t nlen);
void venus_context_destroy(uint32_t ctx_id);
int venus_submit(uint32_t ctx_id, void *cmd, uint32_t size);
int venus_submit_fence(uint32_t ctx_id, uint32_t flags, uint32_t ring_idx, uint64_t fence_id);
int venus_resource_create(uint32_t ctx_id, uint32_t res_id, uint64_t blob_id, uint64_t size, uint32_t flags);
void venus_resource_destroy(uint32_t ctx_id, uint32_t res_id);
int venus_resource_import(uint32_t ctx_id, uint32_t res_id, uint64_t size);
int venus_resource_map(uint32_t ctx_id, uint32_t res_id, void *where);
int venus_resource_unmap(uint32_t ctx_id, uint32_t res_id);
int venus_test_peers(uint32_t ctx_id, uint32_t res_id, VkDeviceMemory memory, int import_first);
void *venus_resource_data(uint32_t ctx_id, uint32_t res_id);
uint32_t venus_resource_texture(uint32_t ctx_id, uint32_t res_id);
int venus_poll(void);
const uint32_t *venus_cmd_counts(void);
uint32_t venus_cmd_types(void);
const uint32_t *venus_ring_events(void);
const uint32_t *venus_ring_alive(void);
const char *venus_cmd_name(uint32_t type);
void venus_ring_idle(uint32_t us);
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

/* Starts vkr on a WebGPU device with `features` (wg_private.h's wg_feature) and `limits` (`nlimits` words: its
 * struct wg_limits), the host-visible window at `window`: 1, or 0 if it couldn't. */
EXPORT int
venus_init(uint32_t features, const uint32_t *limits, uint32_t nlimits, void *window, uint32_t window_bytes)
{
   if (!wg_caps_init(features, limits, nlimits))
      return 0;
   wg_window_at = (uintptr_t)window;
   wg_window_bytes = window_bytes;
   wg_submitted = venus_submitted;
   wg_unwaited_allocations = true;
   return vkr_renderer_init(VKR_RENDERER_THREAD_SYNC | VKR_RENDERER_ASYNC_FENCE_CB, &callbacks);
}

/* `?gpu=vkpremake=on` (A/B): render pipelines made at vkCreateGraphicsPipelines too, not only at their first draw
 * (wg_pipeline_premake; the page turns it off by default: VK4 T17 measured it a loss on cold compiles). */
EXPORT void
venus_premake(int on)
{
   wg_premake_off = !on;
}

/* The driver's build ID (vk/gen.ts: a hash of vk/'s sources), a NUL-terminated string: the worker's shader store
 * keeps entries of this build only (web/venus-cache.ts). */
EXPORT const char *
venus_build_id(void)
{
   return wg_build_id();
}

/* Where the module's arena ends (vk/wasi/arena.c: its data, stack and heap from memory 1's bottom to there, the window
 * after it): the host refuses a module whose arena isn't the one it keeps (web/ram.ts VENUS_ARENA). */
EXPORT uint32_t
venus_arena_end(void)
{
   return VENUS_ARENA_END;
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

/* Another renderer's resource attached to a Venus context (a virgl texture the guest imports as a dma-buf: a VA-API
 * surface's plane), `size` bytes as the guest sees it: a dma-buf whose "fd" is its id (vkr's patch), which the driver
 * imports as memory whose images' textures the GPU worker fills (web/venus-import.ts). */
EXPORT int
venus_resource_import(uint32_t ctx_id, uint32_t res_id, uint64_t size)
{
   return vkr_renderer_import_resource(ctx_id, res_id, VIRGL_RESOURCE_FD_DMABUF, (int)res_id, size);
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

/* tests/venus-renderer.test.ts: a resource's memory and an import of it, one freed; `memory` the driver's. */
EXPORT int
venus_test_peers(uint32_t ctx_id, uint32_t res_id, VkDeviceMemory memory, int import_first)
{
   return vkr_wasi_test_peers(ctx_id, res_id, memory, import_first);
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

/* The WebGPU texture (its id in web/venus-gpu.ts) of the image whose memory a resource was exported from, or 0: a WSI
 * image, which the guest's compositor imports into virgl (web/venus-share.ts). */
EXPORT uint32_t
venus_resource_texture(uint32_t ctx_id, uint32_t res_id)
{
   VkDeviceMemory memory = vkr_renderer_resource_memory(ctx_id, res_id);
   return memory != VK_NULL_HANDLE ? wg_memory_texture(memory) : 0;
}

/* A submit's GPU work is done (and its readbacks mapped): its syncs signal. */
EXPORT void
venus_complete(uint32_t serial)
{
   wg_complete(serial);
}

/* Runs the rings and retires fences: 1 while a ring is active (poll again soon), 0 when all are idle. */
EXPORT int
venus_poll(void)
{
   return vkr_renderer_poll();
}

/* vkr's counts (vk/README.md "Calls and rings"; the patch's vkr_cs.h): the commands dispatched, [where: ring, virtqueue,
 * nested][asks for a reply][type < venus_cmd_types()], and the rings' events [went idle, woken by a notify, or a
 * vkWaitRingSeqnoMESA]; never reset, u32s that wrap (the host sums their differences modulo 2^32). */
extern uint32_t vkr_wasi_cmds[];
uint32_t vkr_wasi_cmd_types(void);
extern uint32_t vkr_wasi_ring_events[2];
extern uint64_t vkr_wasi_idle_ns;
const char *vkr_wasi_cmd_name(uint32_t type);

EXPORT const uint32_t *
venus_cmd_counts(void)
{
   return vkr_wasi_cmds;
}

EXPORT uint32_t
venus_cmd_types(void)
{
   return vkr_wasi_cmd_types();
}

EXPORT const uint32_t *
venus_ring_events(void)
{
   return vkr_wasi_ring_events;
}

/* The monitored rings' status words for the ticker (web/venus-ticker.ts) to set alive from its own thread (GD G3; the
 * patch's vkr_ring.h `vkr_wasi_alive`: [0] a lock, [1] the report period in us, [2] the count, then the addresses). */
extern uint32_t vkr_wasi_alive[];

EXPORT const uint32_t *
venus_ring_alive(void)
{
   return vkr_wasi_alive;
}

EXPORT const char *
venus_cmd_name(uint32_t type)
{
   return vkr_wasi_cmd_name(type);
}

/* A ring stays active this long at least after its last command, whatever the guest's idle timeout (Mesa's 1 ms). */
EXPORT void
venus_ring_idle(uint32_t us)
{
   vkr_wasi_idle_ns = (uint64_t)us * 1000;
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

