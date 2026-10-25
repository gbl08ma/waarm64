/*
 * The driver's command buffers, sync objects and submits (wg_private.h). Commands are recorded in the runtime's
 * command queue (vk_cmd_enqueue, as lavapipe records them); a submit runs the ones that write memory a guest reads
 * (Venus's feedback: fills, updates and copies of buffers, query results, timestamps, events) and draws nothing.
 * Everything a submit does is done when it returns, so every sync is signalled there and every wait is satisfied
 * by what came before it.
 */
#include <string.h>

#include "util/os_time.h"
#include "vk_cmd_queue.h"
#include "vk_util.h"

#include "wg_private.h"

void (*wg_submitted)(void);

static void
wg_cmd_buffer_destroy(struct vk_command_buffer *cmd)
{
   vk_command_buffer_finish(cmd);
   vk_free(&cmd->pool->alloc, cmd);
}

static VkResult
wg_cmd_buffer_create(struct vk_command_pool *pool, VkCommandBufferLevel level, struct vk_command_buffer **out)
{
   struct wg_cmd_buffer *cmd = vk_zalloc(&pool->alloc, sizeof(*cmd), 8, VK_SYSTEM_ALLOCATION_SCOPE_OBJECT);
   if (!cmd)
      return vk_error(pool->base.device, VK_ERROR_OUT_OF_HOST_MEMORY);
   VkResult result = vk_command_buffer_init_with_params(&cmd->vk, &(struct vk_command_buffer_init_params){
      .pool = pool,
      .ops = &wg_cmd_buffer_ops,
      .level = level,
      .needs_cmd_queue = true,
   });
   if (result != VK_SUCCESS) {
      vk_free(&pool->alloc, cmd);
      return result;
   }
   *out = &cmd->vk;
   return VK_SUCCESS;
}

static void
wg_cmd_buffer_reset(struct vk_command_buffer *cmd, VkCommandBufferResetFlags flags)
{
   vk_command_buffer_reset(cmd);
}

const struct vk_command_buffer_ops wg_cmd_buffer_ops = {
   .create = wg_cmd_buffer_create,
   .reset = wg_cmd_buffer_reset,
   .destroy = wg_cmd_buffer_destroy,
};

VKAPI_ATTR VkResult VKAPI_CALL
wg_BeginCommandBuffer(VkCommandBuffer commandBuffer, const VkCommandBufferBeginInfo *pBeginInfo)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   vk_command_buffer_begin(&cmd->vk, pBeginInfo);
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_EndCommandBuffer(VkCommandBuffer commandBuffer)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   return vk_command_buffer_end(&cmd->vk);
}

/* The commands that write memory. */

static VkDeviceSize
wg_range(struct wg_buffer *b, VkDeviceSize offset, VkDeviceSize size)
{
   return size == VK_WHOLE_SIZE ? b->vk.size - offset : size;
}

static void
wg_copy(struct wg_buffer *src, VkDeviceSize src_offset, struct wg_buffer *dst, VkDeviceSize dst_offset,
        VkDeviceSize size)
{
   uint8_t *d = wg_buffer_data(dst, dst_offset);
   if (!d)
      return;
   const uint8_t *s = wg_buffer_data(src, src_offset);
   /* From memory with no bytes (device-local, which nothing renders into in VK1): zeros. */
   if (s)
      memmove(d, s, size);
   else
      memset(d, 0, size);
}

static void
wg_query_results(struct wg_query_pool *pool, uint32_t first, uint32_t count, struct wg_buffer *dst,
                 VkDeviceSize offset, VkDeviceSize stride, VkQueryResultFlags flags)
{
   for (uint32_t i = 0; i < count; i++) {
      uint8_t *out = wg_buffer_data(dst, offset + stride * i);
      if (!out)
         return;
      const uint64_t v = pool->values[first + i];
      if (flags & VK_QUERY_RESULT_64_BIT) {
         memcpy(out, &v, 8);
         if (flags & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT)
            memcpy(out + 8, &(uint64_t){ 1 }, 8);
      } else {
         memcpy(out, &(uint32_t){ (uint32_t)v }, 4);
         if (flags & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT)
            memcpy(out + 4, &(uint32_t){ 1 }, 4);
      }
   }
}

static void
wg_execute(struct vk_command_buffer *cmd)
{
   list_for_each_entry (struct vk_cmd_queue_entry, e, &cmd->cmd_queue.cmds, cmd_link) {
      switch (e->type) {
      case VK_CMD_FILL_BUFFER: {
         VK_FROM_HANDLE(wg_buffer, b, e->u.fill_buffer.dst_buffer);
         uint32_t *d = (uint32_t *)wg_buffer_data(b, e->u.fill_buffer.dst_offset);
         const VkDeviceSize n = wg_range(b, e->u.fill_buffer.dst_offset, e->u.fill_buffer.size) / 4;
         for (VkDeviceSize i = 0; d && i < n; i++)
            d[i] = e->u.fill_buffer.data;
         break;
      }
      case VK_CMD_UPDATE_BUFFER: {
         VK_FROM_HANDLE(wg_buffer, b, e->u.update_buffer.dst_buffer);
         uint8_t *d = wg_buffer_data(b, e->u.update_buffer.dst_offset);
         if (d)
            memcpy(d, e->u.update_buffer.data, e->u.update_buffer.data_size);
         break;
      }
      case VK_CMD_COPY_BUFFER: {
         VK_FROM_HANDLE(wg_buffer, src, e->u.copy_buffer.src_buffer);
         VK_FROM_HANDLE(wg_buffer, dst, e->u.copy_buffer.dst_buffer);
         for (uint32_t i = 0; i < e->u.copy_buffer.region_count; i++) {
            const VkBufferCopy *r = &e->u.copy_buffer.regions[i];
            wg_copy(src, r->srcOffset, dst, r->dstOffset, r->size);
         }
         break;
      }
      case VK_CMD_COPY_BUFFER2: {
         const VkCopyBufferInfo2 *info = e->u.copy_buffer2.copy_buffer_info;
         VK_FROM_HANDLE(wg_buffer, src, info->srcBuffer);
         VK_FROM_HANDLE(wg_buffer, dst, info->dstBuffer);
         for (uint32_t i = 0; i < info->regionCount; i++)
            wg_copy(src, info->pRegions[i].srcOffset, dst, info->pRegions[i].dstOffset, info->pRegions[i].size);
         break;
      }
      case VK_CMD_RESET_QUERY_POOL: {
         VK_FROM_HANDLE(wg_query_pool, pool, e->u.reset_query_pool.query_pool);
         memset(&pool->values[e->u.reset_query_pool.first_query], 0,
                e->u.reset_query_pool.query_count * sizeof(uint64_t));
         break;
      }
      case VK_CMD_WRITE_TIMESTAMP: {
         VK_FROM_HANDLE(wg_query_pool, pool, e->u.write_timestamp.query_pool);
         pool->values[e->u.write_timestamp.query] = os_time_get_nano();
         break;
      }
      case VK_CMD_WRITE_TIMESTAMP2: {
         VK_FROM_HANDLE(wg_query_pool, pool, e->u.write_timestamp2.query_pool);
         pool->values[e->u.write_timestamp2.query] = os_time_get_nano();
         break;
      }
      case VK_CMD_END_QUERY: {
         /* Occlusion and the rest: nothing was drawn. */
         VK_FROM_HANDLE(wg_query_pool, pool, e->u.end_query.query_pool);
         pool->values[e->u.end_query.query] = 0;
         break;
      }
      case VK_CMD_COPY_QUERY_POOL_RESULTS: {
         VK_FROM_HANDLE(wg_query_pool, pool, e->u.copy_query_pool_results.query_pool);
         VK_FROM_HANDLE(wg_buffer, dst, e->u.copy_query_pool_results.dst_buffer);
         wg_query_results(pool, e->u.copy_query_pool_results.first_query, e->u.copy_query_pool_results.query_count,
                          dst, e->u.copy_query_pool_results.dst_offset, e->u.copy_query_pool_results.stride,
                          e->u.copy_query_pool_results.flags);
         break;
      }
      case VK_CMD_SET_EVENT:
         wg_event_from_handle(e->u.set_event.event)->set = true;
         break;
      case VK_CMD_SET_EVENT2:
         wg_event_from_handle(e->u.set_event2.event)->set = true;
         break;
      case VK_CMD_RESET_EVENT:
         wg_event_from_handle(e->u.reset_event.event)->set = false;
         break;
      case VK_CMD_RESET_EVENT2:
         wg_event_from_handle(e->u.reset_event2.event)->set = false;
         break;
      case VK_CMD_EXECUTE_COMMANDS:
         for (uint32_t i = 0; i < e->u.execute_commands.command_buffer_count; i++) {
            VK_FROM_HANDLE(vk_command_buffer, secondary, e->u.execute_commands.command_buffers[i]);
            wg_execute(secondary);
         }
         break;
      default:
         break;
      }
   }
}

VkResult
wg_queue_submit(struct vk_queue *queue, struct vk_queue_submit *submit)
{
   for (uint32_t i = 0; i < submit->command_buffer_count; i++)
      wg_execute(submit->command_buffers[i]);
   for (uint32_t i = 0; i < submit->signal_count; i++) {
      VkResult r = vk_sync_signal(queue->base.device, submit->signals[i].sync, submit->signals[i].signal_value);
      if (r != VK_SUCCESS)
         return r;
   }
   if (wg_submitted)
      wg_submitted();
   return VK_SUCCESS;
}

/* A sync of either kind on the CPU: a binary one is 0 or 1, a timeline one its value. A wait for a value nothing
 * reached yet times out rather than block: nothing here could signal it meanwhile (a later submit of the guest's
 * would, after the wait returns). */
struct wg_sync {
   struct vk_sync base;
   uint64_t value;
};

static VkResult
wg_sync_init(struct vk_device *device, struct vk_sync *sync, uint64_t initial_value)
{
   ((struct wg_sync *)sync)->value = initial_value;
   return VK_SUCCESS;
}

static void
wg_sync_finish(struct vk_device *device, struct vk_sync *sync)
{
}

static VkResult
wg_sync_signal(struct vk_device *device, struct vk_sync *sync, uint64_t value)
{
   struct wg_sync *s = (struct wg_sync *)sync;
   s->value = (sync->flags & VK_SYNC_IS_TIMELINE) ? value : 1;
   return VK_SUCCESS;
}

static VkResult
wg_sync_get_value(struct vk_device *device, struct vk_sync *sync, uint64_t *value)
{
   *value = ((struct wg_sync *)sync)->value;
   return VK_SUCCESS;
}

static VkResult
wg_sync_reset(struct vk_device *device, struct vk_sync *sync)
{
   ((struct wg_sync *)sync)->value = 0;
   return VK_SUCCESS;
}

static VkResult
wg_sync_move(struct vk_device *device, struct vk_sync *dst, struct vk_sync *src)
{
   ((struct wg_sync *)dst)->value = ((struct wg_sync *)src)->value;
   ((struct wg_sync *)src)->value = 0;
   return VK_SUCCESS;
}

static VkResult
wg_sync_wait_many(struct vk_device *device, uint32_t count, const struct vk_sync_wait *waits,
                  enum vk_sync_wait_flags flags, uint64_t abs_timeout_ns)
{
   uint32_t met = 0;
   for (uint32_t i = 0; i < count; i++) {
      const struct wg_sync *s = (const struct wg_sync *)waits[i].sync;
      const uint64_t want = (waits[i].sync->flags & VK_SYNC_IS_TIMELINE) ? waits[i].wait_value : 1;
      if (s->value >= want)
         met++;
   }
   return met == count || (met && (flags & VK_SYNC_WAIT_ANY)) ? VK_SUCCESS : VK_TIMEOUT;
}

/* Sync files, for Venus's WSI: the guest imports a signaled one (-1, which vk_sync_import_sync_file signals before
 * this is called) and exports one only once its work is done here. wasm has no fds to pass. */
static VkResult
wg_sync_import_sync_file(struct vk_device *device, struct vk_sync *sync, int sync_file)
{
   return vk_error(device, VK_ERROR_INVALID_EXTERNAL_HANDLE);
}

static VkResult
wg_sync_export_sync_file(struct vk_device *device, struct vk_sync *sync, int *sync_file)
{
   *sync_file = -1;
   return VK_SUCCESS;
}

const struct vk_sync_type wg_sync_type = {
   .size = sizeof(struct wg_sync),
   .features = VK_SYNC_FEATURE_BINARY | VK_SYNC_FEATURE_TIMELINE | VK_SYNC_FEATURE_GPU_WAIT |
               VK_SYNC_FEATURE_GPU_MULTI_WAIT | VK_SYNC_FEATURE_CPU_WAIT | VK_SYNC_FEATURE_CPU_RESET |
               VK_SYNC_FEATURE_CPU_SIGNAL | VK_SYNC_FEATURE_WAIT_ANY | VK_SYNC_FEATURE_WAIT_PENDING,
   .init = wg_sync_init,
   .finish = wg_sync_finish,
   .signal = wg_sync_signal,
   .get_value = wg_sync_get_value,
   .reset = wg_sync_reset,
   .move = wg_sync_move,
   .wait_many = wg_sync_wait_many,
   .import_sync_file = wg_sync_import_sync_file,
   .export_sync_file = wg_sync_export_sync_file,
};
