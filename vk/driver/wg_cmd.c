/*
 * Command buffers, submits and syncs (wg_private.h). Recording writes a list of our own ops (`cmds`): each draw and
 * dispatch records the state it needs where it changed (a render pipeline's key, viewport and scissor, bind groups by
 * set and pipeline layout, vertex and index buffers, push constants), so a replay never looks at the runtime's state.
 * A submit uploads what the guest wrote to host-visible memory, replays its command buffers into one WebGPU command
 * encoder (bind groups and render pipelines are made there, the first time they are needed), copies what the GPU
 * wrote to host-visible memory into staging buffers, and submits; its syncs signal when the worker says the work is
 * done (wg_complete), once those copies are back in memory 0 and the fills and updates of host-visible memory (Venus's
 * feedback) are applied there too.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "util/os_time.h"
#include "vk_descriptor_update_template.h"
#include "vk_format.h"
#include "vk_pipeline_layout.h"
#include "vk_render_pass.h"
#include "vk_util.h"

#include "wg_private.h"

void (*wg_submitted)(void);


/* The ops. */
enum op {
   OP_PASS,            /* JSON of the render pass, then the attachments' size */
   OP_PASS_END,
   OP_CLEAR_RECTS,     /* JSON */
   OP_PIPELINE,        /* struct op_pipeline */
   OP_COMPUTE,         /* struct wg_program * */
   OP_DYN,             /* struct op_dyn */
   OP_BIND,            /* struct op_bind */
   OP_VB,              /* struct op_vb */
   OP_IB,              /* struct op_ib */
   OP_PUSH,            /* size, bytes */
   OP_DRAW,            /* uint32_t[4] */
   OP_DRAW_INDEXED,    /* struct op_draw_indexed */
   OP_DRAW_INDIRECT,   /* struct op_indirect */
   OP_DISPATCH,        /* uint32_t[3] */
   OP_DISPATCH_INDIRECT,
   OP_COPY_BB,         /* struct op_copy_bb */
   OP_COPY_BT,         /* struct op_copy_bt */
   OP_COPY_TB,
   OP_COPY_TT,         /* struct op_copy_tt */
   OP_FILL,            /* struct op_fill */
   OP_UPDATE,          /* struct op_fill, then the bytes */
   OP_META,            /* JSON (gpu_blit) */
   OP_QUERY,           /* struct op_query */
   OP_COPY_QUERY,      /* struct op_copy_query */
   OP_EVENT,           /* struct op_event */
   OP_EXEC,            /* struct wg_cmd_buffer * */
};

struct op_head {
   uint16_t op;
   uint16_t pad;
   uint32_t size; /* of the payload, which follows 8-aligned */
};

struct op_pipeline {
   struct wg_program *program;
   struct wg_pipeline_key key;
};

struct op_dyn {
   float viewport[6];
   int32_t scissor[4];
   float blend[4];
   uint32_t stencil_ref;
};

/* A bind group: the sets of its group (group 3 holds sets 3 and up), by their index from the group's first. */
struct op_bind {
   uint8_t compute, group;
   uint16_t offset_count;
   struct wg_program *program;
   struct wg_descriptor_set *sets[WG_GROUP_SETS];
   uint32_t offsets[32];
};

#define op_vb wg_op_vb
#define op_ib wg_op_ib

struct op_draw_indexed {
   uint32_t count, instances, first;
   int32_t base;
   uint32_t first_instance;
};

struct op_indirect {
   uint32_t buffer, indexed, count, stride;
   double offset;
};

struct op_copy_bb {
   uint32_t src, dst;
   double src_offset, dst_offset, size;
   struct wg_device_memory *dst_mem;    /* host-visible: read back */
   VkDeviceSize dst_mem_offset;
};

struct op_copy_bt {
   uint32_t buffer, bpr, rows, tex, mip, x, y, z, w, h, d, aspect, block_h;
   double offset;
   struct wg_device_memory *mem;        /* image to host-visible buffer: read back */
   VkDeviceSize mem_offset, mem_size;
};

struct op_copy_tt {
   uint32_t src, src_mip, sx, sy, sz, dst, dst_mip, dx, dy, dz, w, h, d, aspect;
};

struct op_fill {
   uint32_t buffer, value, size;
   double offset;
   struct wg_device_memory *mem;        /* host-visible: applied on the CPU at completion too */
   VkDeviceSize mem_offset;
};

struct op_query {
   struct wg_query_pool *pool;
   uint32_t first, count;
   uint8_t kind; /* 0 reset, 1 timestamp, 2 begin, 3 end */
};

struct op_copy_query {
   struct wg_query_pool *pool;
   uint32_t first, count;
   VkQueryResultFlags flags;
   VkDeviceSize stride;
   struct wg_buffer *dst;
   VkDeviceSize offset;
};

struct op_event {
   struct wg_event *event;
   bool set;
};

static void *
emit(struct wg_cmd_buffer *cmd, enum op op, const void *data, uint32_t size)
{
   const uint32_t padded = align(size, 8);
   struct op_head *h = util_dynarray_grow_bytes(&cmd->cmds, 1, sizeof(*h) + padded);
   if (op >= OP_DRAW && op <= OP_DISPATCH_INDIRECT)
      cmd->draws++;
   *h = (struct op_head){ .op = op, .size = padded };
   void *payload = h + 1;
   if (data)
      memcpy(payload, data, size);
   return payload;
}

static void
emit_json(struct wg_cmd_buffer *cmd, enum op op, struct wg_json *j)
{
   char *p = emit(cmd, op, NULL, j->len + 1);
   memcpy(p, j->data, j->len);
   p[j->len] = 0;
   wg_json_free(j);
}

/* Forget what was recorded last: the next draw or dispatch records all its state. */
static void
forget(struct wg_cmd_buffer *cmd)
{
   cmd->have_key = false;
   memset(cmd->last_dyn, 0xff, sizeof(cmd->last_dyn));
   memset(cmd->last_sets, 0, sizeof(cmd->last_sets));
   memset(cmd->last_bgl, 0, sizeof(cmd->last_bgl));
   cmd->last_push_size = ~0u;
   cmd->last_compute = NULL;
   memset(cmd->last_program, 0, sizeof(cmd->last_program));
   cmd->emitted = 0;
}

/* Command buffers. */

struct push_set {
   struct wg_descriptor_set *set;
};

static void
free_push_sets(struct wg_cmd_buffer *cmd)
{
   struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
   util_dynarray_foreach (&cmd->push_sets, struct wg_descriptor_set *, s)
      wg_descriptor_set_destroy(dev, *s);
   util_dynarray_clear(&cmd->push_sets);
}

static void
wg_cmd_buffer_destroy(struct vk_command_buffer *vk)
{
   struct wg_cmd_buffer *cmd = container_of(vk, struct wg_cmd_buffer, vk);
   free_push_sets(cmd);
   util_dynarray_fini(&cmd->push_sets);
   util_dynarray_fini(&cmd->cmds);
   vk_command_buffer_finish(vk);
   vk_free(&vk->pool->alloc, cmd);
}

static VkResult
wg_cmd_buffer_create(struct vk_command_pool *pool, VkCommandBufferLevel level, struct vk_command_buffer **out)
{
   struct wg_cmd_buffer *cmd = vk_zalloc(&pool->alloc, sizeof(*cmd), 8, VK_SYSTEM_ALLOCATION_SCOPE_OBJECT);
   if (!cmd)
      return vk_error(pool->base.device, VK_ERROR_OUT_OF_HOST_MEMORY);
   VkResult result = vk_command_buffer_init(pool, &cmd->vk, &wg_cmd_buffer_ops, level);
   if (result != VK_SUCCESS) {
      vk_free(&pool->alloc, cmd);
      return result;
   }
   util_dynarray_init(&cmd->cmds, NULL);
   util_dynarray_init(&cmd->push_sets, NULL);
   /* The runtime's dynamic state keeps these where the driver says. */
   cmd->vk.dynamic_graphics_state.vi = &cmd->vi;
   cmd->vk.dynamic_graphics_state.ms.sample_locations = &cmd->sample_locations;
   *out = &cmd->vk;
   return VK_SUCCESS;
}

static void
wg_cmd_buffer_reset(struct vk_command_buffer *vk, VkCommandBufferResetFlags flags)
{
   struct wg_cmd_buffer *cmd = container_of(vk, struct wg_cmd_buffer, vk);
   vk_command_buffer_reset(vk);
   cmd->vk.dynamic_graphics_state.vi = &cmd->vi;
   cmd->vk.dynamic_graphics_state.ms.sample_locations = &cmd->sample_locations;
   util_dynarray_clear(&cmd->cmds);
   cmd->draws = 0;
   free_push_sets(cmd);
   memset(cmd->shaders, 0, sizeof(cmd->shaders));
   memset(cmd->sets, 0, sizeof(cmd->sets));
   memset(cmd->vbs, 0, sizeof(cmd->vbs));
   cmd->ib = NULL;
   memset(&cmd->pass, 0, sizeof(cmd->pass));
   forget(cmd);
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
   wg_cmd_buffer_reset(&cmd->vk, 0);
   vk_command_buffer_begin(&cmd->vk, pBeginInfo);
   /* A secondary inside a render pass: the attachments' formats from its inheritance. */
   const VkCommandBufferInheritanceRenderingInfo *inh =
      vk_get_command_buffer_inheritance_rendering_info(cmd->vk.level, pBeginInfo);
   if (inh) {
      cmd->pass.active = true;
      cmd->pass.color_count = MIN2(inh->colorAttachmentCount, 8);
      for (uint32_t i = 0; i < cmd->pass.color_count; i++)
         cmd->pass.colors[i] = inh->pColorAttachmentFormats[i];
      cmd->pass.depth = inh->depthAttachmentFormat;
      cmd->pass.stencil = inh->stencilAttachmentFormat;
      cmd->pass.samples = inh->rasterizationSamples ? inh->rasterizationSamples : 1;
   }
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_EndCommandBuffer(VkCommandBuffer commandBuffer)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   return vk_command_buffer_end(&cmd->vk);
}

void
wg_cmd_bind_shaders(struct vk_command_buffer *vk, uint32_t count, const mesa_shader_stage *stages,
                    struct vk_shader **const shaders)
{
   struct wg_cmd_buffer *cmd = container_of(vk, struct wg_cmd_buffer, vk);
   for (uint32_t i = 0; i < count; i++)
      cmd->shaders[stages[i]] = shaders[i] ? container_of(shaders[i], struct wg_shader, vk) : NULL;
}

/* Binding. */

static uint32_t
bind_point(VkShaderStageFlags stages)
{
   return (stages & VK_SHADER_STAGE_COMPUTE_BIT) ? 1 : 0;
}

static void
bind_sets(struct wg_cmd_buffer *cmd, uint32_t point, uint32_t first, uint32_t count, const VkDescriptorSet *sets,
          uint32_t offset_count, const uint32_t *offsets)
{
   uint32_t o = 0;
   for (uint32_t i = 0; i < count && first + i < WGSL_MAX_SETS; i++) {
      VK_FROM_HANDLE(wg_descriptor_set, set, sets[i]);
      cmd->sets[point][first + i].set = set;
      for (uint32_t d = 0; set && d < set->layout->dynamic_count && d < 32; d++)
         cmd->sets[point][first + i].dynamic[d] = o < offset_count ? offsets[o++] : 0;
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBindDescriptorSets2(VkCommandBuffer commandBuffer, const VkBindDescriptorSetsInfo *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (info->stageFlags & VK_SHADER_STAGE_ALL_GRAPHICS)
      bind_sets(cmd, 0, info->firstSet, info->descriptorSetCount, info->pDescriptorSets, info->dynamicOffsetCount,
                info->pDynamicOffsets);
   if (info->stageFlags & VK_SHADER_STAGE_COMPUTE_BIT)
      bind_sets(cmd, 1, info->firstSet, info->descriptorSetCount, info->pDescriptorSets, info->dynamicOffsetCount,
                info->pDynamicOffsets);
}

/* A push descriptor set: a set of the command buffer's own, a copy of the last one pushed there with these writes
 * (earlier draws keep the set they recorded). */
static struct wg_descriptor_set *
push_set(struct wg_cmd_buffer *cmd, uint32_t point, VkPipelineLayout _layout, uint32_t index)
{
   VK_FROM_HANDLE(vk_pipeline_layout, layout, _layout);
   struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
   if (index >= WGSL_MAX_SETS || index >= layout->set_count || !layout->set_layouts[index])
      return NULL;
   struct wg_descriptor_set_layout *l = container_of(layout->set_layouts[index], struct wg_descriptor_set_layout, vk);
   struct wg_descriptor_set *set = wg_descriptor_set_create(dev, l);
   if (!set)
      return NULL;
   struct wg_descriptor_set *old = cmd->sets[point][index].set;
   if (old && old->layout == l)
      memcpy(set->slots, old->slots, l->slot_count * sizeof(struct wg_descriptor));
   util_dynarray_append_typed(&cmd->push_sets, struct wg_descriptor_set *, set);
   cmd->sets[point][index].set = set;
   return set;
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdPushDescriptorSet2(VkCommandBuffer commandBuffer, const VkPushDescriptorSetInfo *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   for (uint32_t point = 0; point < 2; point++) {
      if (!(info->stageFlags & (point ? VK_SHADER_STAGE_COMPUTE_BIT : VK_SHADER_STAGE_ALL_GRAPHICS)))
         continue;
      struct wg_descriptor_set *set = push_set(cmd, point, info->layout, info->set);
      for (uint32_t i = 0; set && i < info->descriptorWriteCount; i++)
         wg_descriptor_write(set, &info->pDescriptorWrites[i]);
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdPushDescriptorSetWithTemplate2(VkCommandBuffer commandBuffer, const VkPushDescriptorSetWithTemplateInfo *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(vk_descriptor_update_template, t, info->descriptorUpdateTemplate);
   struct wg_descriptor_set *set =
      push_set(cmd, t->bind_point == VK_PIPELINE_BIND_POINT_COMPUTE, info->layout, info->set);
   if (set)
      wg_descriptor_write_template(set, t, info->pData);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdPushConstants2(VkCommandBuffer commandBuffer, const VkPushConstantsInfo *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (info->offset < sizeof(cmd->push))
      memcpy(cmd->push + info->offset, info->pValues, MIN2(info->size, sizeof(cmd->push) - info->offset));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBindVertexBuffers2(VkCommandBuffer commandBuffer, uint32_t first, uint32_t count, const VkBuffer *buffers,
                         const VkDeviceSize *offsets, const VkDeviceSize *sizes, const VkDeviceSize *strides)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   for (uint32_t i = 0; i < count && first + i < 8; i++) {
      VK_FROM_HANDLE(wg_buffer, b, buffers[i]);
      cmd->vbs[first + i].buffer = b;
      cmd->vbs[first + i].offset = offsets[i];
      cmd->vbs[first + i].size = b ? vk_buffer_range(&b->vk, offsets[i], sizes ? sizes[i] : VK_WHOLE_SIZE) : 0;
   }
   if (strides)
      vk_cmd_set_vertex_binding_strides(&cmd->vk, first, count, strides);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBindIndexBuffer2(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, VkDeviceSize size,
                       VkIndexType type);

VKAPI_ATTR void VKAPI_CALL
wg_CmdBindIndexBuffer(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, VkIndexType type)
{
   wg_CmdBindIndexBuffer2(commandBuffer, buffer, offset, VK_WHOLE_SIZE, type);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBindIndexBuffer2(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, VkDeviceSize size,
                       VkIndexType type)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   cmd->ib = wg_buffer_from_handle(buffer);
   cmd->ib_offset = offset;
   cmd->ib_size = cmd->ib ? vk_buffer_range(&cmd->ib->vk, offset, size) : 0;
   cmd->ib_type = type;
}

/* Render passes. */

/* A load op as WebGPU's. LOAD and NONE keep the contents; CLEAR and DONT_CARE clear them, but where the render area is
 * short of the attachment they load (Vulkan keeps what's outside the area: a CLEAR clears its area with a draw, the
 * pass's clear rects) and so does a pass that resumes a suspended one (the render pass instance goes on: no load op
 * applies again). */
static const char *
load_op(VkAttachmentLoadOp op, bool partial, bool resumed)
{
   if (resumed || partial || op == VK_ATTACHMENT_LOAD_OP_LOAD || op == VK_ATTACHMENT_LOAD_OP_NONE)
      return "load";
   return "clear";
}

/* A store op as WebGPU's: DONT_CARE discards, but a suspended pass stores whatever it says, since its WebGPU pass ends
 * here and the one that resumes it loads; so does a pass over part of the attachment, since WebGPU's discard is the
 * whole attachment's and Vulkan's store ops only the render area's (outside it the contents stay). */
static const char *
store_op(VkAttachmentStoreOp op, bool suspending, bool partial)
{
   return op == VK_ATTACHMENT_STORE_OP_DONT_CARE && !suspending && !partial ? "discard" : "store";
}

/* An attachment's layout that only reads its depth or its stencil: the aspect is WebGPU's read-only (it may then be
 * sampled in the pass, a usage WebGPU otherwise refuses beside the attachment's). */
static bool
depth_read_only(VkImageLayout l)
{
   return l == VK_IMAGE_LAYOUT_DEPTH_STENCIL_READ_ONLY_OPTIMAL ||
          l == VK_IMAGE_LAYOUT_DEPTH_READ_ONLY_STENCIL_ATTACHMENT_OPTIMAL ||
          l == VK_IMAGE_LAYOUT_DEPTH_READ_ONLY_OPTIMAL || l == VK_IMAGE_LAYOUT_READ_ONLY_OPTIMAL;
}

static bool
stencil_read_only(VkImageLayout l)
{
   return l == VK_IMAGE_LAYOUT_DEPTH_STENCIL_READ_ONLY_OPTIMAL ||
          l == VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_STENCIL_READ_ONLY_OPTIMAL ||
          l == VK_IMAGE_LAYOUT_STENCIL_READ_ONLY_OPTIMAL || l == VK_IMAGE_LAYOUT_READ_ONLY_OPTIMAL;
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBeginRendering(VkCommandBuffer commandBuffer, const VkRenderingInfo *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   memset(&cmd->pass, 0, sizeof(cmd->pass));
   cmd->pass.active = true;
   cmd->pass.samples = 1;
   forget(cmd);
   const VkRect2D area = info->renderArea;
   uint32_t width = 0, height = 0;
   struct wg_json j = { 0 }, clears = { 0 };
   bool partial = false, any_clear = false;
   wg_json_printf(&j, "{\"colorAttachments\":[");
   wg_json_printf(&clears, "{\"rects\":[[%d,%d,%u,%u]],\"colors\":[", area.offset.x, area.offset.y, area.extent.width,
                  area.extent.height);
   cmd->pass.color_count = MIN2(info->colorAttachmentCount, 8);
   /* The size of the first attachment: a render area short of it clears with draws, not load ops. */
   const VkRenderingAttachmentInfo *atts[10];
   uint32_t n = 0;
   for (uint32_t i = 0; i < cmd->pass.color_count; i++)
      atts[n++] = &info->pColorAttachments[i];
   if (info->pDepthAttachment)
      atts[n++] = info->pDepthAttachment;
   if (info->pStencilAttachment)
      atts[n++] = info->pStencilAttachment;
   for (uint32_t i = 0; i < n; i++) {
      VK_FROM_HANDLE(wg_image_view, v, atts[i]->imageView);
      if (v) {
         const VkExtent3D e = vk_image_mip_level_extent(v->vk.image, v->vk.base_mip_level);
         width = e.width, height = e.height;
         cmd->pass.samples = v->vk.image->samples;
         break;
      }
   }
   partial = area.offset.x || area.offset.y || area.extent.width < width || area.extent.height < height;
   cmd->pass.area = area;
   /* A pass that suspends or resumes (VK_RENDERING_SUSPENDING_BIT, RESUMING_BIT) is part of one render pass instance
    * with its neighbours: only its first part loads or clears, only its last part stores or discards. */
   const bool resumed = info->flags & VK_RENDERING_RESUMING_BIT, suspending = info->flags & VK_RENDERING_SUSPENDING_BIT;
   bool first_clear = true;
   for (uint32_t i = 0; i < cmd->pass.color_count; i++) {
      const VkRenderingAttachmentInfo *a = &info->pColorAttachments[i];
      VK_FROM_HANDLE(wg_image_view, v, a->imageView);
      if (!v || !v->att) {
         wg_json_printf(&j, "%snull", i ? "," : "");
         continue;
      }
      cmd->pass.colors[i] = v->vk.format;
      const bool clear = !resumed && a->loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR;
      const VkClearColorValue *c = &a->clearValue.color;
      char value[160];
      /* The four numbers alone: a clear value's as an array, a clear rect's after the attachment's index. */
      if (v->fmt->flags & WG_FMT_UINT)
         snprintf(value, sizeof(value), "%u,%u,%u,%u", c->uint32[0], c->uint32[1], c->uint32[2], c->uint32[3]);
      else if (v->fmt->flags & WG_FMT_SINT)
         snprintf(value, sizeof(value), "%d,%d,%d,%d", c->int32[0], c->int32[1], c->int32[2], c->int32[3]);
      else
         snprintf(value, sizeof(value), "%.9g,%.9g,%.9g,%.9g", c->float32[0], c->float32[1], c->float32[2],
                  c->float32[3]);
      wg_json_printf(&j, "%s{\"view\":%u,\"loadOp\":\"%s\",\"storeOp\":\"%s\",\"clearValue\":[%s]", i ? "," : "", v->att,
                     load_op(a->loadOp, partial, resumed), store_op(a->storeOp, suspending, partial), value);
      if (v->slice >= 0)
         wg_json_printf(&j, ",\"depthSlice\":%d", v->slice);
      VK_FROM_HANDLE(wg_image_view, r, a->resolveImageView);
      if (r && r->att && a->resolveMode != VK_RESOLVE_MODE_NONE)
         wg_json_printf(&j, ",\"resolveTarget\":%u", r->att);
      wg_json_printf(&j, "}");
      if (partial && clear) {
         wg_json_printf(&clears, "%s[%u,%s]", first_clear ? "" : ",", i, value);
         first_clear = false;
         any_clear = true;
      }
   }
   wg_json_printf(&j, "]");
   wg_json_printf(&clears, "]");
   const VkRenderingAttachmentInfo *d = info->pDepthAttachment, *s = info->pStencilAttachment;
   VK_FROM_HANDLE(wg_image_view, dv, d ? d->imageView : VK_NULL_HANDLE);
   VK_FROM_HANDLE(wg_image_view, sv, s ? s->imageView : VK_NULL_HANDLE);
   struct wg_image_view *ds = dv ? dv : sv;
   if (ds && ds->att) {
      const uint32_t flags = ds->fmt->flags;
      if (dv)
         cmd->pass.depth = dv->vk.format;
      if (sv)
         cmd->pass.stencil = sv->vk.format;
      wg_json_printf(&j, ",\"depthStencilAttachment\":{\"view\":%u", ds->att);
      /* SAMPLE_ZERO resolves (the modes advertised) of a multisampled depth or stencil, done at the pass's end. */
      cmd->pass.suspending = suspending;
      for (uint32_t a = 0; a < 2; a++) {
         const VkRenderingAttachmentInfo *at = a ? s : d;
         VK_FROM_HANDLE(wg_image_view, src, at ? at->imageView : VK_NULL_HANDLE);
         VK_FROM_HANDLE(wg_image_view, dst, at ? at->resolveImageView : VK_NULL_HANDLE);
         if (src && dst && at->resolveMode != VK_RESOLVE_MODE_NONE && src->vk.image->samples > 1 &&
             (flags & (a ? WG_FMT_STENCIL : WG_FMT_DEPTH))) {
            cmd->pass.resolve_src[a] = src;
            cmd->pass.resolve_dst[a] = dst;
         }
      }
      cmd->pass.depth_ro = (flags & WG_FMT_DEPTH) && dv && depth_read_only(d->imageLayout);
      cmd->pass.stencil_ro = (flags & WG_FMT_STENCIL) && sv && stencil_read_only(s->imageLayout);
      if (cmd->pass.depth_ro) {
         wg_json_printf(&j, ",\"depthReadOnly\":true");
      } else if (flags & WG_FMT_DEPTH) {
         const bool clear = dv && !resumed && d->loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR;
         /* Vulkan resolves before the store op; the worker's resolve reads the attachment after the pass: stored. */
         wg_json_printf(&j, ",\"depthLoadOp\":\"%s\",\"depthStoreOp\":\"%s\",\"depthClearValue\":%.9g",
                        dv ? load_op(d->loadOp, partial, resumed) : "load",
                        dv && !cmd->pass.resolve_src[0] ? store_op(d->storeOp, suspending, partial) : "store",
                        dv ? CLAMP(d->clearValue.depthStencil.depth, 0, 1) : 1.0);
         if (partial && clear) {
            wg_json_printf(&clears, ",\"depth\":%.9g", d->clearValue.depthStencil.depth);
            any_clear = true;
         }
      }
      if (cmd->pass.stencil_ro) {
         wg_json_printf(&j, ",\"stencilReadOnly\":true");
      } else if (flags & WG_FMT_STENCIL) {
         const bool clear = sv && !resumed && s->loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR;
         wg_json_printf(&j, ",\"stencilLoadOp\":\"%s\",\"stencilStoreOp\":\"%s\",\"stencilClearValue\":%u",
                        sv ? load_op(s->loadOp, partial, resumed) : "load",
                        sv && !cmd->pass.resolve_src[1] ? store_op(s->storeOp, suspending, partial) : "store",
                        sv ? s->clearValue.depthStencil.stencil : 0);
         if (partial && clear) {
            wg_json_printf(&clears, ",\"stencil\":%u", s->clearValue.depthStencil.stencil);
            any_clear = true;
         }
      }
      wg_json_printf(&j, "}");
   }
   wg_json_printf(&j, ",\"width\":%u,\"height\":%u}", width, height);
   wg_json_printf(&clears, "}");
   cmd->pass.width = width, cmd->pass.height = height;
   emit_json(cmd, OP_PASS, &j);
   if (any_clear)
      emit_json(cmd, OP_CLEAR_RECTS, &clears);
   else
      wg_json_free(&clears);
}

static void meta(struct wg_cmd_buffer *cmd, struct wg_json *j);

static void
end_rendering(struct wg_cmd_buffer *cmd)
{
   if (!cmd->pass.active)
      return;
   emit(cmd, OP_PASS_END, NULL, 0);
   cmd->pass.active = false;
   forget(cmd);
   /* A suspended pass's resolves are its last part's. */
   for (uint32_t a = 0; a < 2 && !cmd->pass.suspending; a++) {
      const struct wg_image_view *src = cmd->pass.resolve_src[a], *dst = cmd->pass.resolve_dst[a];
      if (!src)
         continue;
      const struct wg_image *si = container_of(src->vk.image, struct wg_image, vk);
      const struct wg_image *di = container_of(dst->vk.image, struct wg_image, vk);
      struct wg_json j = { 0 };
      /* Within the render area only (WebGPU has no multisampled arrays: one layer). */
      const VkRect2D *ra = &cmd->pass.area;
      wg_json_printf(&j, "{\"op\":\"resolveDepth\",\"aspect\":\"%s\",\"format\":\"%s\",\"src\":%u,\"srcMip\":%u,"
                     "\"srcLayer\":%u,\"dst\":%u,\"dstMip\":%u,\"dstLayer\":%u,\"area\":[%d,%d,%u,%u]}",
                     a ? "stencil" : "depth", di->fmt->name, si->tex, src->vk.base_mip_level, src->vk.base_array_layer,
                     di->tex, dst->vk.base_mip_level, dst->vk.base_array_layer, ra->offset.x, ra->offset.y,
                     ra->extent.width, ra->extent.height);
      meta(cmd, &j);
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdEndRendering(VkCommandBuffer commandBuffer)
{
   end_rendering(wg_cmd_buffer_from_handle(commandBuffer));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdEndRendering2KHR(VkCommandBuffer commandBuffer, const VkRenderingEndInfoKHR *info)
{
   end_rendering(wg_cmd_buffer_from_handle(commandBuffer));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdClearAttachments(VkCommandBuffer commandBuffer, uint32_t count, const VkClearAttachment *atts,
                       uint32_t rect_count, const VkClearRect *rects)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"rects\":[");
   for (uint32_t r = 0; r < rect_count; r++)
      wg_json_printf(&j, "%s[%d,%d,%u,%u]", r ? "," : "", rects[r].rect.offset.x, rects[r].rect.offset.y,
                     rects[r].rect.extent.width, rects[r].rect.extent.height);
   wg_json_printf(&j, "],\"colors\":[");
   bool first = true;
   for (uint32_t i = 0; i < count; i++) {
      if (!(atts[i].aspectMask & VK_IMAGE_ASPECT_COLOR_BIT))
         continue;
      const uint32_t a = atts[i].colorAttachment;
      if (a >= cmd->pass.color_count || !cmd->pass.colors[a])
         continue;
      const struct wg_texture_format *f = wg_texture_format(cmd->pass.colors[a]);
      const VkClearColorValue *c = &atts[i].clearValue.color;
      if (f && (f->flags & WG_FMT_UINT))
         wg_json_printf(&j, "%s[%u,%u,%u,%u,%u]", first ? "" : ",", a, c->uint32[0], c->uint32[1], c->uint32[2],
                        c->uint32[3]);
      else if (f && (f->flags & WG_FMT_SINT))
         wg_json_printf(&j, "%s[%u,%d,%d,%d,%d]", first ? "" : ",", a, c->int32[0], c->int32[1], c->int32[2],
                        c->int32[3]);
      else
         wg_json_printf(&j, "%s[%u,%.9g,%.9g,%.9g,%.9g]", first ? "" : ",", a, c->float32[0], c->float32[1],
                        c->float32[2], c->float32[3]);
      first = false;
   }
   wg_json_printf(&j, "]");
   for (uint32_t i = 0; i < count; i++) {
      if (atts[i].aspectMask & VK_IMAGE_ASPECT_DEPTH_BIT)
         wg_json_printf(&j, ",\"depth\":%.9g", atts[i].clearValue.depthStencil.depth);
      if (atts[i].aspectMask & VK_IMAGE_ASPECT_STENCIL_BIT)
         wg_json_printf(&j, ",\"stencil\":%u", atts[i].clearValue.depthStencil.stencil);
   }
   wg_json_printf(&j, "}");
   emit_json(cmd, OP_CLEAR_RECTS, &j);
   forget(cmd);
}

/* Draws: the state they need, where it changed. */

static void
record_sets(struct wg_cmd_buffer *cmd, uint32_t point, struct wg_program *p)
{
   uint32_t k = 0;
   for (uint32_t g = 0; g < p->group_count; g++) {
      struct op_bind b = { .compute = point, .group = g, .program = p };
      for (uint32_t s = g; s < p->set_count && s - g < WG_GROUP_SETS; s++)
         if (p->set_group[s] == g)
            b.sets[s - g] = cmd->sets[point][s].set;
      /* The push constants' offset is the replay's (WG_DYNAMIC_PUSH: a placeholder here). */
      for (; k < p->resource_count && p->resources[k].group == g; k++)
         if (p->dynamic[k] != -1 && b.offset_count < 32)
            b.offsets[b.offset_count++] =
               p->dynamic[k] >= 0 ? cmd->sets[point][p->res_set[k]].dynamic[p->dynamic[k]] : 0;
      if (!memcmp(cmd->last_sets[point][g], b.sets, sizeof(b.sets)) && cmd->last_bgl[point][g] == p->bgl_uid[g] &&
          !memcmp(cmd->last_dynamic[point][g], b.offsets, b.offset_count * 4))
         continue;
      memcpy(cmd->last_sets[point][g], b.sets, sizeof(b.sets));
      cmd->last_bgl[point][g] = p->bgl_uid[g];
      memcpy(cmd->last_dynamic[point][g], b.offsets, b.offset_count * 4);
      emit(cmd, OP_BIND, &b, offsetof(struct op_bind, offsets) + b.offset_count * 4);
   }
}

static void
record_push(struct wg_cmd_buffer *cmd, struct wg_program *p)
{
   const uint32_t size = MIN2(MAX2(p->immediate_size, p->push_ubo_size), sizeof(cmd->push));
   if (!size || (size == cmd->last_push_size && !memcmp(cmd->last_push, cmd->push, size)))
      return;
   cmd->last_push_size = size;
   memcpy(cmd->last_push, cmd->push, size);
   uint8_t *d = emit(cmd, OP_PUSH, NULL, size + 4);
   memcpy(d, &size, 4);
   memcpy(d + 4, cmd->push, size);
}

static uint32_t
buffer_gpu(struct wg_buffer *b)
{
   return b && b->mem ? wg_memory_buffer(b->mem) : 0;
}

/* The memory a buffer resource of a program is bound from at `point` (its texel buffer view's for a texel buffer), or
 * NULL. */
static const struct wg_device_memory *
resource_memory(const struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, uint32_t k)
{
   const int s = p->res_set[k];
   if (s < 0)
      return NULL;
   const struct wg_descriptor_set *set = cmd->sets[point][s].set;
   const uint32_t slot = p->resources[k].binding / 2 - p->set_base[s];
   if (!set || slot >= set->layout->slot_count)
      return NULL;
   const struct wg_descriptor *d = &set->slots[slot];
   if (d->type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER)
      return d->texel ? d->texel->mem : NULL;
   return d->buffer ? d->buffer->mem : NULL;
}

/* The program to draw or dispatch with: a variant where a texture the shader declared filterable float is bound to a
 * view WebGPU can't filter (a depth view, r32float without float32-filterable), or where a dispatch's read-only
 * storage buffer is bound from a memory one of its writable storage buffers is bound from too. Each VkDeviceMemory is
 * one GPUBuffer, and WebGPU's usage scope (a dispatch's) lets writable storage share a buffer only with more writable
 * storage: such a binding is "storage" in the variant's layout (WebGPU takes it for the shader's `read`), and read-only
 * everywhere else, where it may share its memory with uniform buffers and the dispatch's indirect arguments (VK3 L6c:
 * L5b made every compute storage buffer read_write, and vkQuake's first frame's dispatch, a uniform buffer and a
 * read-only storage buffer of one memory, invalidated its submit). A render pass's scope is the whole pass: draws keep
 * the shader's access (docs/backlog.md "Usage scopes"). */
static struct wg_program *
program_for(struct wg_cmd_buffer *cmd, uint32_t point, struct wg_program *p)
{
   uint64_t mask = 0;
   const uint32_t n = MIN2(p->resource_count, 64);
   for (uint32_t k = 0; k < n; k++) {
      const struct wgsl_resource *r = &p->resources[k];
      const int s = p->res_set[k];
      if (r->kind == WGSL_STORAGE_READ && point == 1) {
         const struct wg_device_memory *mem = resource_memory(cmd, point, p, k);
         for (uint32_t j = 0; mem && j < n; j++)
            if (p->resources[j].kind == WGSL_STORAGE && resource_memory(cmd, point, p, j) == mem) {
               mask |= 1ull << k;
               break;
            }
         continue;
      }
      if (r->kind != WGSL_TEXTURE || r->sample != WGSL_SAMPLE_FLOAT || r->multisampled || s < 0)
         continue;
      const struct wg_descriptor_set *set = cmd->sets[point][s].set;
      const uint32_t slot = r->binding / 2 - p->set_base[s];
      const struct wg_image_view *view = set && slot < set->layout->slot_count ? set->slots[slot].view : NULL;
      if (view && !wg_format_filterable(view->fmt))
         mask |= 1ull << k;
   }
   return mask ? wg_program_variant(p, mask) : p;
}

/* Whether a draw may go ahead (false: it draws nothing), its state recorded. */
/* Triangles have faces; points and lines are front-facing. */
static bool
has_faces(VkPrimitiveTopology t)
{
   return t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST || t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP ||
          t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN || t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST_WITH_ADJACENCY ||
          t == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP_WITH_ADJACENCY || t == VK_PRIMITIVE_TOPOLOGY_PATCH_LIST;
}

/* How many draws a draw takes: WebGPU has one stencil reference and one pair of masks, Vulkan a set a face. A draw
 * whose faces' differ, with both faces drawn, is two: its front faces with the front's (the back culled), then its back
 * faces with the back's. Order between its front and back primitives is lost where they overlap (the stencil ops of
 * the later face then run last). */
static uint32_t
draw_faces(struct wg_cmd_buffer *cmd)
{
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   const struct vk_stencil_test_face_state *f = &dyn->ds.stencil.front, *b = &dyn->ds.stencil.back;
   if (!cmd->pass.stencil || !dyn->ds.stencil.test_enable || dyn->rs.cull_mode || !has_faces(dyn->ia.primitive_topology))
      return 1;
   return f->reference != b->reference || f->compare_mask != b->compare_mask ||
                (!cmd->pass.stencil_ro && f->write_mask != b->write_mask)
             ? 2
             : 1;
}

/* `face`: 0 the whole draw, 1 its front faces, 2 its back faces (draw_faces). */
static bool
record_draw(struct wg_cmd_buffer *cmd, bool indexed, uint32_t face)
{
   struct wg_shader *vs = cmd->shaders[MESA_SHADER_VERTEX], *fs = cmd->shaders[MESA_SHADER_FRAGMENT];
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   if (!vs || !vs->program || !cmd->pass.active || dyn->rs.rasterizer_discard_enable)
      return false;
   if (dyn->rs.cull_mode == VK_CULL_MODE_FRONT_AND_BACK && dyn->ia.primitive_topology >= 3)
      return false;
   /* Its stages on one program; if they came with different ones (wg_program_merge), a program of both's. */
   struct wg_program *base = vs->program;
   if (fs && fs->program && fs->program != base)
      base = wg_program_merge(base, fs->program);
   struct wg_program *p = program_for(cmd, 0, base);

   struct wg_pipeline_key k;
   memset(&k, 0, sizeof(k));
   k.vs = vs;
   k.fs = fs && fs->program ? fs : NULL;
   k.topology = dyn->ia.primitive_topology;
   /* WebGPU takes no indexed strip without its index format, and always restarts it at the format's largest index:
    * with restart off in Vulkan, that index is a vertex (rare: it is the largest possible). */
   if (indexed && (k.topology == VK_PRIMITIVE_TOPOLOGY_LINE_STRIP || k.topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP))
      k.strip_index = cmd->ib_type == VK_INDEX_TYPE_UINT32 ? 2 : 1;
   k.front_face = dyn->rs.front_face == VK_FRONT_FACE_CLOCKWISE;
   k.cull = face == 1 ? VK_CULL_MODE_BACK_BIT : face == 2 ? VK_CULL_MODE_FRONT_BIT : dyn->rs.cull_mode & 3;
   /* The stencil's reference and masks: the back's for back faces alone (a split draw's, or front faces culled). */
   const struct vk_stencil_test_face_state *sface =
      face == 2 || (k.cull == VK_CULL_MODE_FRONT_BIT && has_faces(k.topology)) ? &dyn->ds.stencil.back
                                                                               : &dyn->ds.stencil.front;
   /* Depth clamped, or not clipped (VK_EXT_depth_clip_enable): WebGPU's unclippedDepth (which clamps to the viewport's
    * range, as the attachment would anyway). */
   const bool clip = dyn->rs.depth_clip_enable == VK_MESA_DEPTH_CLIP_ENABLE_TRUE ||
                     (dyn->rs.depth_clip_enable == VK_MESA_DEPTH_CLIP_ENABLE_NOT_CLAMP && !dyn->rs.depth_clamp_enable);
   k.unclipped = (dyn->rs.depth_clamp_enable || !clip) && (wg_features & WG_FEATURE_DEPTH_CLIP);
   k.flip = dyn->vp.viewport_count && dyn->vp.viewports[0].height < 0;
   /* WebGPU wants minDepth <= maxDepth: an inverted range (reverse-Z) is the range the right way round and the vertex
    * shader's z mirrored (w - z), which lands each depth where the inverted range would. */
   k.flip_z = dyn->vp.viewport_count && dyn->vp.viewports[0].minDepth > dyn->vp.viewports[0].maxDepth;
   k.samples = cmd->pass.samples;
   k.sample_mask = dyn->ms.sample_mask == 0xffff ? 0xffffffffu : dyn->ms.sample_mask;
   k.alpha_to_coverage = dyn->ms.alpha_to_coverage_enable && k.samples > 1;
   k.color_count = cmd->pass.color_count;
   memcpy(k.colors, cmd->pass.colors, sizeof(k.colors));
   k.depth = cmd->pass.depth ? cmd->pass.depth : cmd->pass.stencil;
   if (cmd->pass.depth) {
      k.depth_test = dyn->ds.depth.test_enable;
      k.depth_write = dyn->ds.depth.write_enable && !cmd->pass.depth_ro;
      k.depth_compare = dyn->ds.depth.compare_op;
      /* Vulkan biases polygons only; WebGPU refuses a bias on points and lines. */
      k.depth_bias = dyn->rs.depth_bias.enable && k.topology >= VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST &&
                     k.topology != VK_PRIMITIVE_TOPOLOGY_LINE_LIST_WITH_ADJACENCY &&
                     k.topology != VK_PRIMITIVE_TOPOLOGY_LINE_STRIP_WITH_ADJACENCY &&
                     k.topology != VK_PRIMITIVE_TOPOLOGY_PATCH_LIST;
      if (k.depth_bias) {
         k.bias_constant = dyn->rs.depth_bias.constant_factor;
         k.bias_slope = dyn->rs.depth_bias.slope_factor;
         k.bias_clamp = dyn->rs.depth_bias.clamp;
      }
   }
   if (cmd->pass.stencil && dyn->ds.stencil.test_enable) {
      const struct vk_stencil_test_face_state *faces[2] = { &dyn->ds.stencil.front, &dyn->ds.stencil.back };
      k.stencil_test = 1;
      for (uint32_t f = 0; f < 2; f++) {
         k.stencil[f][0] = faces[f]->op.fail;
         k.stencil[f][1] = faces[f]->op.pass;
         k.stencil[f][2] = faces[f]->op.depth_fail;
         k.stencil[f][3] = faces[f]->op.compare;
      }
      k.stencil_read = sface->compare_mask;
      k.stencil_write = cmd->pass.stencil_ro ? 0 : sface->write_mask;
   }
   for (uint32_t i = 0; i < k.color_count; i++) {
      const struct vk_color_blend_attachment_state *a = &dyn->cb.attachments[i];
      k.blend[i].enable = a->blend_enable;
      k.blend[i].mask = (dyn->cb.color_write_enables & (1u << i)) ? a->write_mask : 0;
      if (a->blend_enable) {
         k.blend[i].src = a->src_color_blend_factor;
         k.blend[i].dst = a->dst_color_blend_factor;
         k.blend[i].op = a->color_blend_op;
         k.blend[i].asrc = a->src_alpha_blend_factor;
         k.blend[i].adst = a->dst_alpha_blend_factor;
         k.blend[i].aop = a->alpha_blend_op;
      }
   }
   const struct vk_vertex_input_state *vi = dyn->vi;
   if (vi) {
      u_foreach_bit(b, vi->bindings_valid & 0xff) {
         k.vb[b].stride = dyn->vi_binding_strides[b];
         k.vb[b].instance = vi->bindings[b].input_rate == VK_VERTEX_INPUT_RATE_INSTANCE;
      }
      u_foreach_bit(a, vi->attributes_valid & vs->info.inputs) {
         if (vi->attributes[a].binding >= 8)
            continue;
         k.attr[a].binding = vi->attributes[a].binding;
         k.attr[a].format = vi->attributes[a].format;
         k.attr[a].offset = vi->attributes[a].offset;
      }
   }
   if (!cmd->have_key || memcmp(&k, &cmd->last_key, sizeof(k)) || cmd->last_program[0] != p) {
      struct op_pipeline *op = emit(cmd, OP_PIPELINE, NULL, sizeof(*op));
      op->program = p;
      op->key = k;
      /* Made now, while the command buffer is recorded (WebGPU makes it asynchronously: web/venus-gpu.ts), so that it
       * is likely ready by the submit, which otherwise waits for it; the replay finds it by its key. */
      wg_render_pipeline(p, &k);
      cmd->last_key = k;
      cmd->last_program[0] = p;
      cmd->have_key = true;
   }

   struct op_dyn d = { 0 };
   if (dyn->vp.viewport_count) {
      const VkViewport *v = &dyn->vp.viewports[0];
      d.viewport[0] = v->x, d.viewport[1] = v->height < 0 ? v->y + v->height : v->y;
      d.viewport[2] = v->width, d.viewport[3] = fabsf(v->height);
      d.viewport[4] = v->minDepth, d.viewport[5] = v->maxDepth;
   } else {
      d.viewport[2] = cmd->pass.width, d.viewport[3] = cmd->pass.height, d.viewport[5] = 1;
   }
   if (dyn->vp.scissor_count) {
      const VkRect2D *s = &dyn->vp.scissors[0];
      d.scissor[0] = s->offset.x, d.scissor[1] = s->offset.y, d.scissor[2] = s->extent.width,
      d.scissor[3] = s->extent.height;
   } else {
      d.scissor[2] = INT32_MAX, d.scissor[3] = INT32_MAX;
   }
   memcpy(d.blend, dyn->cb.blend_constants, sizeof(d.blend));
   /* WebGPU's one constant factor is Vulkan's CONSTANT_COLOR (as an alpha factor, both are the constant's alpha): a
    * colour factor of CONSTANT_ALPHA is the constant (a, a, a), unless another colour factor wants its colour. */
   bool cc = false, ca = false;
   for (uint32_t i = 0; i < k.color_count; i++) {
      if (!k.blend[i].enable)
         continue;
      const uint8_t f[2] = { k.blend[i].src, k.blend[i].dst };
      for (uint32_t n = 0; n < 2; n++) {
         cc |= f[n] == VK_BLEND_FACTOR_CONSTANT_COLOR || f[n] == VK_BLEND_FACTOR_ONE_MINUS_CONSTANT_COLOR;
         ca |= f[n] == VK_BLEND_FACTOR_CONSTANT_ALPHA || f[n] == VK_BLEND_FACTOR_ONE_MINUS_CONSTANT_ALPHA;
      }
   }
   if (ca && !cc)
      d.blend[0] = d.blend[1] = d.blend[2] = d.blend[3];
   else if (ca && cc) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: a draw's colour blends with both the constant's colour and its alpha: its colour taken\n");
      warned = true;
   }
   d.stencil_ref = sface->reference;
   if (memcmp(&d, cmd->last_dyn, sizeof(d))) {
      emit(cmd, OP_DYN, &d, sizeof(d));
      memcpy(cmd->last_dyn, &d, sizeof(d));
   }

   record_sets(cmd, 0, p);
   struct wg_vertex_slots slots;
   wg_vertex_slots(&k, vs->info.inputs, &slots);
   u_foreach_bit(b, slots.used) {
      const uint32_t binding = slots.binding[b], base = slots.base[b];
      struct op_vb v = { .slot = b, .buffer = buffer_gpu(cmd->vbs[binding].buffer) };
      if (v.buffer) {
         v.offset = cmd->vbs[binding].buffer->offset + cmd->vbs[binding].offset + base;
         v.size = cmd->vbs[binding].size > base ? cmd->vbs[binding].size - base : 0;
      }
      if (!(cmd->emitted & (1u << b)) || memcmp(&cmd->last_vb[b], &v, sizeof(v))) {
         emit(cmd, OP_VB, &v, sizeof(v));
         cmd->last_vb[b] = v;
         cmd->emitted |= 1u << b;
      }
   }
   if (indexed) {
      struct op_ib ib = { .buffer = buffer_gpu(cmd->ib), .wide = cmd->ib_type == VK_INDEX_TYPE_UINT32 };
      if (!ib.buffer)
         return false;
      ib.offset = cmd->ib->offset + cmd->ib_offset;
      ib.size = cmd->ib_size;
      if (!(cmd->emitted & (1u << 8)) || memcmp(&cmd->last_ib, &ib, sizeof(ib))) {
         emit(cmd, OP_IB, &ib, sizeof(ib));
         cmd->last_ib = ib;
         cmd->emitted |= 1u << 8;
      }
   }
   record_push(cmd, p);
   return true;
}

static void
draw(struct wg_cmd_buffer *cmd, uint32_t vertices, uint32_t instances, uint32_t first, uint32_t first_instance,
     uint32_t face)
{
   if (!record_draw(cmd, false, face))
      return;
   if (cmd->vk.dynamic_graphics_state.ia.primitive_topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN) {
      /* A fan (WebGPU has none) as a triangle list through the device's fan indices (0, 1, 2, 0, 2, 3, ...), from the
       * first vertex as the base. */
      struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
      if (vertices < 3 || vertices > WG_FAN_VERTICES)
         return;
      struct op_ib ib = { .buffer = wg_fan_indices(dev), .wide = 1, .offset = 0, .size = (vertices - 2) * 12.0 };
      emit(cmd, OP_IB, &ib, sizeof(ib));
      cmd->emitted &= ~(1u << 8);
      emit(cmd, OP_DRAW_INDEXED, &(struct op_draw_indexed){ (vertices - 2) * 3, instances, 0, (int32_t)first, first_instance },
           sizeof(struct op_draw_indexed));
      return;
   }
   emit(cmd, OP_DRAW, (uint32_t[]){ vertices, instances, first, first_instance }, 16);
}

/* The faces a draw is recorded with, as record_draw's `face`, for i < draw_faces(cmd). */
static uint32_t
face_of(uint32_t faces, uint32_t i)
{
   return faces == 2 ? i + 1 : 0;
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDraw(VkCommandBuffer commandBuffer, uint32_t vertices, uint32_t instances, uint32_t first,
           uint32_t first_instance)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (!vertices || !instances)
      return;
   const uint32_t faces = draw_faces(cmd);
   for (uint32_t i = 0; i < faces; i++)
      draw(cmd, vertices, instances, first, first_instance, face_of(faces, i));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndexed(VkCommandBuffer commandBuffer, uint32_t indices, uint32_t instances, uint32_t first, int32_t base,
                  uint32_t first_instance)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (!indices || !instances)
      return;
   const uint32_t faces = draw_faces(cmd);
   for (uint32_t i = 0; i < faces; i++) {
      if (!record_draw(cmd, true, face_of(faces, i)))
         return;
      emit(cmd, OP_DRAW_INDEXED, &(struct op_draw_indexed){ indices, instances, first, base, first_instance },
           sizeof(struct op_draw_indexed));
   }
}

static void
draw_indirect(VkCommandBuffer commandBuffer, VkBuffer _buffer, VkDeviceSize offset, uint32_t count, uint32_t stride,
              bool indexed)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, buffer, _buffer);
   if (!count)
      return;
   const uint32_t faces = draw_faces(cmd);
   for (uint32_t i = 0; i < faces; i++) {
      if (!record_draw(cmd, indexed, face_of(faces, i)))
         return;
      emit(cmd, OP_DRAW_INDIRECT,
           &(struct op_indirect){ .buffer = buffer_gpu(buffer), .indexed = indexed, .count = count,
                                  .stride = stride ? stride : (indexed ? 20 : 16), .offset = buffer->offset + offset },
           sizeof(struct op_indirect));
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndirect(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, uint32_t count,
                   uint32_t stride)
{
   draw_indirect(commandBuffer, buffer, offset, count, stride, false);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndexedIndirect(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, uint32_t count,
                          uint32_t stride)
{
   draw_indirect(commandBuffer, buffer, offset, count, stride, true);
}

/* Compute. */

static bool
record_dispatch(struct wg_cmd_buffer *cmd)
{
   struct wg_shader *cs = cmd->shaders[MESA_SHADER_COMPUTE];
   if (!cs || !cs->program || !cs->program->compute)
      return false;
   struct wg_program *p = program_for(cmd, 1, cs->program);
   if (cmd->last_compute != cs || cmd->last_program[1] != p) {
      emit(cmd, OP_COMPUTE, &p, sizeof(p));
      cmd->last_compute = cs;
      cmd->last_program[1] = p;
   }
   record_sets(cmd, 1, p);
   record_push(cmd, p);
   return true;
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDispatchBase(VkCommandBuffer commandBuffer, uint32_t bx, uint32_t by, uint32_t bz, uint32_t x, uint32_t y,
                   uint32_t z)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (!x || !y || !z || !record_dispatch(cmd))
      return;
   /* WebGPU's dispatches start at workgroup 0: a base would need a pipeline made with it (docs/backlog.md). */
   if (bx || by || bz) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: vkCmdDispatchBase's base (%u, %u, %u) ignored: workgroup ids start at 0\n", bx, by, bz);
      warned = true;
   }
   emit(cmd, OP_DISPATCH, (uint32_t[]){ x, y, z }, 12);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDispatch(VkCommandBuffer commandBuffer, uint32_t x, uint32_t y, uint32_t z)
{
   wg_CmdDispatchBase(commandBuffer, 0, 0, 0, x, y, z);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDispatchIndirect(VkCommandBuffer commandBuffer, VkBuffer _buffer, VkDeviceSize offset)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, buffer, _buffer);
   if (!record_dispatch(cmd))
      return;
   emit(cmd, OP_DISPATCH_INDIRECT,
        &(struct op_indirect){ .buffer = buffer_gpu(buffer), .offset = buffer->offset + offset },
        sizeof(struct op_indirect));
}

/* Transfers. */

static struct wg_device_memory *
host_mem(struct wg_buffer *b)
{
   return b->mem && b->mem->host ? b->mem : NULL;
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdCopyBuffer2(VkCommandBuffer commandBuffer, const VkCopyBufferInfo2 *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, src, info->srcBuffer);
   VK_FROM_HANDLE(wg_buffer, dst, info->dstBuffer);
   for (uint32_t i = 0; i < info->regionCount; i++) {
      const VkBufferCopy2 *r = &info->pRegions[i];
      emit(cmd, OP_COPY_BB,
           &(struct op_copy_bb){ .src = buffer_gpu(src), .dst = buffer_gpu(dst), .src_offset = src->offset + r->srcOffset,
                                 .dst_offset = dst->offset + r->dstOffset, .size = r->size, .dst_mem = host_mem(dst),
                                 .dst_mem_offset = dst->offset + r->dstOffset },
           sizeof(struct op_copy_bb));
   }
}

/* A buffer ↔ image region's copies, one per layer (2D arrays) or one for a 3D extent. */
static void
copy_bt(struct wg_cmd_buffer *cmd, enum op op, struct wg_buffer *buffer, struct wg_image *image,
        const VkBufferImageCopy2 *r)
{
   const struct wg_texture_format *f = image->fmt;
   const VkImageAspectFlags aspect = r->imageSubresource.aspectMask;
   uint32_t bytes = f->bytes;
   uint32_t a = 0;
   if ((f->flags & WG_FMT_DEPTH) && (f->flags & WG_FMT_STENCIL)) {
      a = aspect == VK_IMAGE_ASPECT_STENCIL_BIT ? 2 : 1;
      bytes = a == 2 ? 1 : 4;
   } else if (aspect == VK_IMAGE_ASPECT_STENCIL_BIT) {
      a = 2;
   } else if (aspect == VK_IMAGE_ASPECT_DEPTH_BIT) {
      a = 1;
   }
   const VkExtent3D e = r->imageExtent;
   const uint32_t row_texels = r->bufferRowLength ? r->bufferRowLength : e.width;
   const uint32_t rows_image = r->bufferImageHeight ? r->bufferImageHeight : e.height;
   const uint32_t bpr = DIV_ROUND_UP(row_texels, f->bw) * bytes;
   const uint32_t rows = DIV_ROUND_UP(rows_image, f->bh);
   const bool is3d = image->vk.image_type == VK_IMAGE_TYPE_3D;
   const uint32_t layers = is3d ? 1 : vk_image_subresource_layer_count(&image->vk, &r->imageSubresource);
   const uint32_t depth = is3d ? e.depth : 1;
   for (uint32_t l = 0; l < layers; l++) {
      const VkDeviceSize offset = buffer->offset + r->bufferOffset + (VkDeviceSize)l * bpr * rows;
      struct op_copy_bt c = {
         .buffer = buffer_gpu(buffer), .bpr = bpr, .rows = rows, .tex = image->tex, .mip = r->imageSubresource.mipLevel,
         .x = r->imageOffset.x, .y = r->imageOffset.y, .z = is3d ? r->imageOffset.z : r->imageSubresource.baseArrayLayer + l,
         .w = DIV_ROUND_UP(e.width, f->bw) * f->bw, .h = DIV_ROUND_UP(e.height, f->bh) * f->bh, .d = depth, .aspect = a, .block_h = f->bh, .offset = offset,
      };
      if (op == OP_COPY_TB && host_mem(buffer)) {
         c.mem = buffer->mem;
         c.mem_offset = offset;
         c.mem_size = (VkDeviceSize)bpr * rows * (depth - 1) + (VkDeviceSize)bpr * (DIV_ROUND_UP(e.height, f->bh) - 1) +
                      DIV_ROUND_UP(e.width, f->bw) * bytes;
      }
      emit(cmd, op, &c, sizeof(c));
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdCopyBufferToImage2(VkCommandBuffer commandBuffer, const VkCopyBufferToImageInfo2 *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, buffer, info->srcBuffer);
   VK_FROM_HANDLE(wg_image, image, info->dstImage);
   for (uint32_t i = 0; i < info->regionCount; i++)
      copy_bt(cmd, OP_COPY_BT, buffer, image, &info->pRegions[i]);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdCopyImageToBuffer2(VkCommandBuffer commandBuffer, const VkCopyImageToBufferInfo2 *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, buffer, info->dstBuffer);
   VK_FROM_HANDLE(wg_image, image, info->srcImage);
   for (uint32_t i = 0; i < info->regionCount; i++)
      copy_bt(cmd, OP_COPY_TB, buffer, image, &info->pRegions[i]);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdCopyImage2(VkCommandBuffer commandBuffer, const VkCopyImageInfo2 *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_image, src, info->srcImage);
   VK_FROM_HANDLE(wg_image, dst, info->dstImage);
   for (uint32_t i = 0; i < info->regionCount; i++) {
      const VkImageCopy2 *r = &info->pRegions[i];
      const bool s3 = src->vk.image_type == VK_IMAGE_TYPE_3D, d3 = dst->vk.image_type == VK_IMAGE_TYPE_3D;
      const uint32_t layers = s3 ? r->extent.depth : vk_image_subresource_layer_count(&src->vk, &r->srcSubresource);
      const VkImageAspectFlags aspect = r->srcSubresource.aspectMask;
      emit(cmd, OP_COPY_TT,
           &(struct op_copy_tt){ .src = src->tex, .src_mip = r->srcSubresource.mipLevel, .sx = r->srcOffset.x,
                                 .sy = r->srcOffset.y, .sz = s3 ? r->srcOffset.z : r->srcSubresource.baseArrayLayer,
                                 .dst = dst->tex, .dst_mip = r->dstSubresource.mipLevel, .dx = r->dstOffset.x,
                                 .dy = r->dstOffset.y, .dz = d3 ? r->dstOffset.z : r->dstSubresource.baseArrayLayer,
                                 .w = DIV_ROUND_UP(r->extent.width, src->fmt->bw) * src->fmt->bw,
                                 .h = DIV_ROUND_UP(r->extent.height, src->fmt->bh) * src->fmt->bh,
                                 .d = layers,
                                 .aspect = (src->fmt->flags & WG_FMT_DEPTH) && (src->fmt->flags & WG_FMT_STENCIL)
                                              ? (aspect == VK_IMAGE_ASPECT_STENCIL_BIT ? 2 : aspect == VK_IMAGE_ASPECT_DEPTH_BIT ? 1 : 0)
                                              : 0 },
           sizeof(struct op_copy_tt));
   }
}

/* Blits, resolves and clears of images: the worker's draws (gpu_blit). */
static void
meta(struct wg_cmd_buffer *cmd, struct wg_json *j)
{
   emit_json(cmd, OP_META, j);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBlitImage2(VkCommandBuffer commandBuffer, const VkBlitImageInfo2 *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_image, src, info->srcImage);
   VK_FROM_HANDLE(wg_image, dst, info->dstImage);
   if ((src->fmt->flags | dst->fmt->flags) & (WG_FMT_DEPTH | WG_FMT_STENCIL))
      return; /* depth blits: not yet (docs/backlog.md) */
   for (uint32_t i = 0; i < info->regionCount; i++) {
      const VkImageBlit2 *r = &info->pRegions[i];
      const uint32_t layers = vk_image_subresource_layer_count(&src->vk, &r->srcSubresource);
      const VkExtent3D se = vk_image_mip_level_extent(&src->vk, r->srcSubresource.mipLevel);
      for (uint32_t l = 0; l < layers; l++) {
         struct wg_json j = { 0 };
         wg_json_printf(&j, "{\"op\":\"blit\",\"src\":%u,\"srcMip\":%u,\"srcLayer\":%u,\"srcFormat\":\"%s\",\"dst\":%u,"
                        "\"dstMip\":%u,\"dstLayer\":%u,\"format\":\"%s\",\"filter\":\"%s\",\"srcSize\":[%u,%u],"
                        "\"from\":[%d,%d,%d,%d],\"to\":[%d,%d,%d,%d],\"srcZ\":[%d,%d],\"dstZ\":[%d,%d],\"srcDepth\":%u}",
                        src->tex, r->srcSubresource.mipLevel, r->srcSubresource.baseArrayLayer + l, src->fmt->name,
                        dst->tex, r->dstSubresource.mipLevel, r->dstSubresource.baseArrayLayer + l, dst->fmt->name,
                        info->filter == VK_FILTER_LINEAR ? "linear" : "nearest", se.width, se.height,
                        r->srcOffsets[0].x, r->srcOffsets[0].y, r->srcOffsets[1].x, r->srcOffsets[1].y,
                        r->dstOffsets[0].x, r->dstOffsets[0].y, r->dstOffsets[1].x, r->dstOffsets[1].y,
                        r->srcOffsets[0].z, r->srcOffsets[1].z, r->dstOffsets[0].z, r->dstOffsets[1].z, se.depth);
         meta(cmd, &j);
      }
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdResolveImage2(VkCommandBuffer commandBuffer, const VkResolveImageInfo2 *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_image, src, info->srcImage);
   VK_FROM_HANDLE(wg_image, dst, info->dstImage);
   for (uint32_t i = 0; i < info->regionCount; i++) {
      const VkImageResolve2 *r = &info->pRegions[i];
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"op\":\"resolve\",\"src\":%u,\"srcMip\":%u,\"srcLayer\":%u,\"dst\":%u,\"dstMip\":%u,"
                     "\"dstLayer\":%u,\"format\":\"%s\"}",
                     src->tex, r->srcSubresource.mipLevel, r->srcSubresource.baseArrayLayer, dst->tex,
                     r->dstSubresource.mipLevel, r->dstSubresource.baseArrayLayer, dst->fmt->name);
      meta(cmd, &j);
   }
}

static void
clear_image(struct wg_cmd_buffer *cmd, struct wg_image *image, const VkClearColorValue *color,
            const VkClearDepthStencilValue *ds, uint32_t count, const VkImageSubresourceRange *ranges)
{
   const struct wg_texture_format *f = image->fmt;
   for (uint32_t i = 0; i < count; i++) {
      const uint32_t levels = vk_image_subresource_level_count(&image->vk, &ranges[i]);
      const uint32_t layers = image->vk.image_type == VK_IMAGE_TYPE_3D
                                 ? 1 : vk_image_subresource_layer_count(&image->vk, &ranges[i]);
      for (uint32_t m = 0; m < levels; m++)
         for (uint32_t l = 0; l < layers; l++) {
            struct wg_json j = { 0 };
            wg_json_printf(&j, "{\"op\":\"clear\",\"dst\":%u,\"dstMip\":%u,\"dstLayer\":%u,\"format\":\"%s\"",
                           image->tex, ranges[i].baseMipLevel + m, ranges[i].baseArrayLayer + l, f->name);
            if (color && (f->flags & WG_FMT_UINT))
               wg_json_printf(&j, ",\"color\":[%u,%u,%u,%u]", color->uint32[0], color->uint32[1], color->uint32[2],
                              color->uint32[3]);
            else if (color && (f->flags & WG_FMT_SINT))
               wg_json_printf(&j, ",\"color\":[%d,%d,%d,%d]", color->int32[0], color->int32[1], color->int32[2],
                              color->int32[3]);
            else if (color)
               wg_json_printf(&j, ",\"color\":[%.9g,%.9g,%.9g,%.9g]", color->float32[0], color->float32[1],
                              color->float32[2], color->float32[3]);
            if (ds && (ranges[i].aspectMask & VK_IMAGE_ASPECT_DEPTH_BIT) && (f->flags & WG_FMT_DEPTH))
               wg_json_printf(&j, ",\"depth\":%.9g", CLAMP(ds->depth, 0, 1));
            if (ds && (ranges[i].aspectMask & VK_IMAGE_ASPECT_STENCIL_BIT) && (f->flags & WG_FMT_STENCIL))
               wg_json_printf(&j, ",\"stencil\":%u", ds->stencil);
            wg_json_printf(&j, "}");
            meta(cmd, &j);
         }
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdClearColorImage(VkCommandBuffer commandBuffer, VkImage _image, VkImageLayout layout,
                      const VkClearColorValue *color, uint32_t count, const VkImageSubresourceRange *ranges)
{
   clear_image(wg_cmd_buffer_from_handle(commandBuffer), wg_image_from_handle(_image), color, NULL, count, ranges);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdClearDepthStencilImage(VkCommandBuffer commandBuffer, VkImage _image, VkImageLayout layout,
                             const VkClearDepthStencilValue *ds, uint32_t count, const VkImageSubresourceRange *ranges)
{
   clear_image(wg_cmd_buffer_from_handle(commandBuffer), wg_image_from_handle(_image), NULL, ds, count, ranges);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdFillBuffer(VkCommandBuffer commandBuffer, VkBuffer _buffer, VkDeviceSize offset, VkDeviceSize size,
                 uint32_t data)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, b, _buffer);
   size = vk_buffer_range(&b->vk, offset, size) & ~3ull;
   if (!size)
      return;
   emit(cmd, OP_FILL,
        &(struct op_fill){ .buffer = buffer_gpu(b), .value = data, .size = size, .offset = b->offset + offset,
                           .mem = host_mem(b), .mem_offset = b->offset + offset },
        sizeof(struct op_fill));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdUpdateBuffer(VkCommandBuffer commandBuffer, VkBuffer _buffer, VkDeviceSize offset, VkDeviceSize size,
                   const void *data)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, b, _buffer);
   struct op_fill *op = emit(cmd, OP_UPDATE, NULL, sizeof(struct op_fill) + size);
   *op = (struct op_fill){ .buffer = buffer_gpu(b), .size = size, .offset = b->offset + offset, .mem = host_mem(b),
                           .mem_offset = b->offset + offset };
   memcpy(op + 1, data, size);
}

/* Queries, events and barriers. */

VKAPI_ATTR void VKAPI_CALL
wg_CmdResetQueryPool(VkCommandBuffer commandBuffer, VkQueryPool pool, uint32_t first, uint32_t count)
{
   emit(wg_cmd_buffer_from_handle(commandBuffer), OP_QUERY,
        &(struct op_query){ .pool = wg_query_pool_from_handle(pool), .first = first, .count = count, .kind = 0 },
        sizeof(struct op_query));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdWriteTimestamp2(VkCommandBuffer commandBuffer, VkPipelineStageFlags2 stage, VkQueryPool pool, uint32_t query)
{
   emit(wg_cmd_buffer_from_handle(commandBuffer), OP_QUERY,
        &(struct op_query){ .pool = wg_query_pool_from_handle(pool), .first = query, .count = 1, .kind = 1 },
        sizeof(struct op_query));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBeginQuery(VkCommandBuffer commandBuffer, VkQueryPool pool, uint32_t query, VkQueryControlFlags flags)
{
   emit(wg_cmd_buffer_from_handle(commandBuffer), OP_QUERY,
        &(struct op_query){ .pool = wg_query_pool_from_handle(pool), .first = query, .count = 1, .kind = 2 },
        sizeof(struct op_query));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdEndQuery(VkCommandBuffer commandBuffer, VkQueryPool pool, uint32_t query)
{
   emit(wg_cmd_buffer_from_handle(commandBuffer), OP_QUERY,
        &(struct op_query){ .pool = wg_query_pool_from_handle(pool), .first = query, .count = 1, .kind = 3 },
        sizeof(struct op_query));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBeginQueryIndexedEXT(VkCommandBuffer commandBuffer, VkQueryPool pool, uint32_t query,
                           VkQueryControlFlags flags, uint32_t index)
{
   wg_CmdBeginQuery(commandBuffer, pool, query, flags);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdEndQueryIndexedEXT(VkCommandBuffer commandBuffer, VkQueryPool pool, uint32_t query, uint32_t index)
{
   wg_CmdEndQuery(commandBuffer, pool, query);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdCopyQueryPoolResults(VkCommandBuffer commandBuffer, VkQueryPool pool, uint32_t first, uint32_t count,
                           VkBuffer dst, VkDeviceSize offset, VkDeviceSize stride, VkQueryResultFlags flags)
{
   emit(wg_cmd_buffer_from_handle(commandBuffer), OP_COPY_QUERY,
        &(struct op_copy_query){ .pool = wg_query_pool_from_handle(pool), .first = first, .count = count,
                                 .flags = flags, .stride = stride, .dst = wg_buffer_from_handle(dst), .offset = offset },
        sizeof(struct op_copy_query));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdSetEvent2(VkCommandBuffer commandBuffer, VkEvent event, const VkDependencyInfo *info)
{
   emit(wg_cmd_buffer_from_handle(commandBuffer), OP_EVENT,
        &(struct op_event){ .event = wg_event_from_handle(event), .set = true }, sizeof(struct op_event));
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdResetEvent2(VkCommandBuffer commandBuffer, VkEvent event, VkPipelineStageFlags2 stage)
{
   emit(wg_cmd_buffer_from_handle(commandBuffer), OP_EVENT,
        &(struct op_event){ .event = wg_event_from_handle(event), .set = false }, sizeof(struct op_event));
}

/* WebGPU orders a queue's work and tracks hazards itself; layouts are the runtime's. */
VKAPI_ATTR void VKAPI_CALL
wg_CmdWaitEvents2(VkCommandBuffer commandBuffer, uint32_t count, const VkEvent *events, const VkDependencyInfo *infos)
{
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdPipelineBarrier2(VkCommandBuffer commandBuffer, const VkDependencyInfo *info)
{
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdExecuteCommands(VkCommandBuffer commandBuffer, uint32_t count, const VkCommandBuffer *buffers)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   for (uint32_t i = 0; i < count; i++) {
      struct wg_cmd_buffer *secondary = wg_cmd_buffer_from_handle(buffers[i]);
      emit(cmd, OP_EXEC, &secondary, sizeof(secondary));
      cmd->draws += secondary->draws;
   }
   forget(cmd);
}

/* Submits. */

/*
 * A submit's writes to host-visible memory (readbacks: what the GPU wrote, read back whole ranges; cpu_writes: bytes the
 * driver knows) land in the CPU's copy at its completion. Until then the GPU's buffer has them and the CPU's copy
 * doesn't, so each range keeps `base`, the CPU's bytes when it was submitted (before that submit's look at the
 * write-watch), and a byte the CPU has changed since then is the guest's write (VK3 L4c-B; the review's finding 2):
 * - an upload leaves out the words of an in-flight range that the guest hasn't written since (they'd put the CPU's
 *   stale bytes over the GPU's), so a later submit reads what the earlier one wrote;
 * - a completion lands only the bytes the guest hasn't written since: a range read back is wider than what the GPU
 *   wrote (a copy's row gaps, a whole storage binding, 4-byte rounding), and the guest may write the rest meanwhile;
 * - a completion that changes a byte a later in-flight range covers moves that range's base along, as that is what the
 *   GPU had when the later one ran.
 */
struct readback {
   struct wg_device_memory *mem;
   VkDeviceSize offset, size;
   uint32_t slot;
   uint32_t base; /* index into the submit's `bases` (UINT32_MAX: none) */
};

struct query_readback {
   struct wg_query_pool *pool;
   uint32_t lo, hi; /* queries [lo, hi) */
   uint32_t slot;
};

/* An occlusion query of the current render pass (resolved at its end); `passing`: one WebGPU couldn't count (begun
 * outside the pass or beside another pool's queries, or cut by the pass's end), reported as passing. */
struct pass_query {
   struct wg_query_pool *pool;
   uint32_t index;
   bool passing;
};

struct cpu_write {
   struct wg_device_memory *mem;
   VkDeviceSize offset;
   uint32_t size, value;
   bool fill;
   uint32_t data; /* index into `bytes` */
   uint32_t base;
};

struct wg_submit {
   struct list_head link;
   uint32_t serial;
   struct util_dynarray readbacks;  /* struct readback: GPU writes to host-visible memory */
   struct util_dynarray writes;     /* struct cpu_write */
   struct util_dynarray bytes;
   struct util_dynarray bases;      /* the ranges' bases */
   struct util_dynarray signals;    /* struct vk_sync_signal */
   struct util_dynarray queries;    /* struct query_readback: occlusion queries it ended, read back into `values` */
   bool shadowed;                   /* an upload left out some of its ranges' words: their pages go up again at its end */
};

/* The replay's state: what the current pass has been given, applied at its draws and dispatches. */
struct replay {
   struct wg_device *dev;
   struct wg_submit *submit;
   enum { NONE, RENDER, COMPUTE } pass;
   uint32_t width, height;
   uint32_t pipeline, compute;
   struct wg_program *program[2];
   struct op_dyn dyn;
   struct {
      uint32_t group, n;
      uint32_t offsets[32];
   } groups[2][WGSL_MAX_GROUPS];
   uint32_t group_count[2];
   struct op_vb vb[8];
   uint32_t vb_mask;
   struct op_ib ib;
   bool have_ib;
   uint8_t push[256];
   uint32_t push_size;
   uint32_t push_offset; /* where in the device's push buffer the current push constants are (UINT32_MAX: none yet) */
   uint32_t dirty; /* RD_* */
   /* Occlusion queries: the pool whose set the render pass counts into, the query counting (none: `qactive_pool`
    * NULL), the pass's queries (struct pass_query). */
   struct wg_query_pool *qpool, *qactive_pool;
   uint32_t qactive;
   struct util_dynarray pass_queries;
};

enum { RD_PIPELINE = 1, RD_DYN = 2, RD_GROUPS = 4, RD_VB = 8, RD_IB = 16, RD_PUSH = 32, RD_ALL = 63 };

static void
readback(struct replay *r, struct wg_device_memory *mem, VkDeviceSize offset, VkDeviceSize size)
{
   if (!mem || !size)
      return;
   const VkDeviceSize start = offset & ~3ull, end = MIN2(align64(offset + size, 4), mem->size);
   /* Joined with the last range of the same memory where they touch. */
   util_dynarray_foreach (&r->submit->readbacks, struct readback, b) {
      if (b->mem == mem && start <= b->offset + b->size && end >= b->offset) {
         const VkDeviceSize s = MIN2(b->offset, start), e = MAX2(b->offset + b->size, end);
         b->offset = s, b->size = e - s;
         return;
      }
   }
   util_dynarray_append_typed(&r->submit->readbacks, struct readback,
                              ((struct readback){ mem, start, end - start, 0, UINT32_MAX }));
}

#define WG_QUERY_SET_MAX 4096 /* WebGPU's largest query set */

static void end_pass(struct replay *r);

/* A query reported as passing: its value 1 in the pool's buffer (outside a render pass, a compute pass ended first: the
 * encoder takes no write while one is open; in a render pass, at its end). */
static void
query_passing(struct replay *r, struct wg_query_pool *pool, uint32_t index)
{
   if (r->pass == RENDER) {
      util_dynarray_append_typed(&r->pass_queries, struct pass_query, ((struct pass_query){ pool, index, true }));
      return;
   }
   if (r->pass != NONE)
      end_pass(r);
   static const uint64_t one = 1;
   gpu_update(pool->buf, index * 8.0, &one, 8);
}

static int
cmp_u32(const void *a, const void *b)
{
   const uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
   return x < y ? -1 : x > y;
}

/* The pass's occlusion queries resolved into their pool's buffer: a run of consecutive queries at a time, through the
 * device's scratch buffer (a resolve's destination offset must be 256-aligned). */
static void
resolve_queries(struct replay *r)
{
   struct wg_device *dev = r->dev;
   const uint32_t n = util_dynarray_num_elements(&r->pass_queries, struct pass_query);
   if (!n)
      return;
   if (!dev->query_scratch) {
      struct wg_json j = { 0 };
      dev->query_scratch_size = WG_QUERY_SET_MAX * 8;
      wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", dev->query_scratch_size, 0x200 | 4); /* QUERY_RESOLVE | COPY_SRC */
      dev->query_scratch = wg_create_json(WG_KIND_BUFFER, &j);
   }
   uint32_t *idx = malloc(n * sizeof(uint32_t)), k = 0;
   util_dynarray_foreach (&r->pass_queries, struct pass_query, q) {
      if (q->passing)
         query_passing(r, q->pool, q->index);
      else if (idx)
         idx[k++] = q->index;
   }
   if (idx && k) {
      qsort(idx, k, sizeof(uint32_t), cmp_u32);
      for (uint32_t a = 0, b; a < k; a = b) {
         for (b = a + 1; b < k && idx[b] == idx[b - 1] + 1; b++)
            ;
         gpu_resolve_queries(r->qpool->set, idx[a], b - a, dev->query_scratch, 0);
         gpu_copy_bb(dev->query_scratch, 0, r->qpool->buf, idx[a] * 8.0, (b - a) * 8.0);
      }
   }
   free(idx);
   util_dynarray_clear(&r->pass_queries);
}

static void
end_pass(struct replay *r)
{
   if (r->pass == RENDER && r->qactive_pool) {
      /* A query the pass's end cuts (WebGPU's pass ends inside Vulkan's): passing. */
      gpu_end_occlusion();
      util_dynarray_foreach (&r->pass_queries, struct pass_query, q)
         if (q->pool == r->qactive_pool && q->index == r->qactive)
            q->passing = true;
      r->qactive_pool = NULL;
   }
   if (r->pass != NONE)
      gpu_pass_end();
   const bool render = r->pass == RENDER;
   r->pass = NONE;
   if (render)
      resolve_queries(r);
   r->qpool = NULL;
}

/* The pool whose occlusion queries the render pass starting at `p` begins (the first), NULL for none. */
static struct wg_query_pool *
pass_query_pool(const uint8_t *p, const uint8_t *end, bool *stop)
{
   while (p < end) {
      const struct op_head *h = (const void *)p;
      const void *d = h + 1;
      p += sizeof(*h) + h->size;
      if (h->op == OP_PASS || h->op == OP_PASS_END) {
         *stop = true;
         return NULL;
      }
      if (h->op == OP_QUERY) {
         const struct op_query *q = d;
         if (q->kind == 2 && q->pool->set && q->first < WG_QUERY_SET_MAX)
            return q->pool;
      } else if (h->op == OP_EXEC) {
         const struct wg_cmd_buffer *sec = *(struct wg_cmd_buffer *const *)d;
         struct wg_query_pool *pool =
            pass_query_pool(sec->cmds.data, (const uint8_t *)sec->cmds.data + sec->cmds.size, stop);
         if (pool || *stop)
            return pool;
      }
   }
   return NULL;
}

/* A query ended at this point of the queue: available to later copies, and to the host once its submit completes
 * (an occlusion query's value read back then). */
static void
query_ended(struct replay *r, struct wg_query_pool *pool, uint32_t index)
{
   pool->avail[index] = 1;
   pool->ended[index] = r->submit->serial;
   if (!pool->buf)
      return;
   util_dynarray_foreach (&r->submit->queries, struct query_readback, q) {
      if (q->pool == pool) {
         q->lo = MIN2(q->lo, index), q->hi = MAX2(q->hi, index + 1);
         return;
      }
   }
   util_dynarray_append_typed(&r->submit->queries, struct query_readback,
                              ((struct query_readback){ pool, index, index + 1, 0 }));
}

/* Bind groups released once the submit is encoded: empty groups (a set index no resource uses) are made per use, and
 * a group a set no longer keeps may still be the replay's current one (its id mustn't be reused before then). */
static struct util_dynarray released_groups;

/* The device's fan indices: (0, i, i + 1) for each triangle of a fan of up to WG_FAN_VERTICES vertices. */
uint32_t
wg_fan_indices(struct wg_device *dev)
{
   if (!dev->fan_indices) {
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", (WG_FAN_VERTICES - 2) * 12, 0x10 | 0x8); /* INDEX | COPY_DST */
      dev->fan_indices = wg_create_json(WG_KIND_BUFFER, &j);
      uint32_t *idx = malloc((WG_FAN_VERTICES - 2) * 12);
      for (uint32_t i = 0; i < WG_FAN_VERTICES - 2; i++)
         idx[3 * i] = 0, idx[3 * i + 1] = i + 1, idx[3 * i + 2] = i + 2;
      gpu_write(dev->fan_indices, 0, idx, (WG_FAN_VERTICES - 2) * 12);
      free(idx);
   }
   return dev->fan_indices;
}

/* The device's push buffer (uniform, written before each submit), made at its first use. */
static uint32_t
push_buffer(struct wg_device *dev)
{
   if (!dev->push_buffer) {
      static uint32_t gens;
      if (!dev->push_size)
         dev->push_size = WG_PUSH_BUFFER_SIZE;
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", dev->push_size, 0x40 | 0x8); /* UNIFORM | COPY_DST */
      dev->push_buffer = wg_create_json(WG_KIND_BUFFER, &j);
      dev->push_data = malloc(dev->push_size);
      dev->push_gen = ++gens;
   }
   return dev->push_buffer;
}

/* Room for `bytes` of push constants in one submit: the buffer is written once before the submit, so a submit's
 * places can't be reused within it (VK3 L4c-F). A larger buffer replaces it at once, with a new `push_gen` (bind
 * groups of the old one, kept by theirs, aren't found again, though the submit's first binds come before its first
 * use); the old one is destroyed after the work already queued. */
static void
push_reserve(struct wg_device *dev, uint64_t bytes)
{
   const uint64_t most = MIN2(wg_limits.max_buffer_size, 1u << 28) & ~255ull;
   const uint32_t size = dev->push_size ? dev->push_size : WG_PUSH_BUFFER_SIZE;
   if (bytes <= size || size >= most)
      return;
   uint64_t grown = size;
   while (grown < bytes && grown < most)
      grown *= 2;
   dev->push_size = (uint32_t)MIN2(grown, most);
   if (dev->push_buffer) {
      wg_id_release(dev->push_buffer);
      free(dev->push_data);
      dev->push_buffer = 0;
      dev->push_data = NULL;
      push_buffer(dev);
   }
}

/* A resource's descriptor in an op_bind's sets, or NULL. */
static const struct wg_descriptor *
bound_descriptor(const struct op_bind *b, const struct wg_program *p, uint32_t k)
{
   const int s = p->res_set[k];
   if (s < 0 || s < b->group || s - b->group >= WG_GROUP_SETS)
      return NULL;
   const struct wg_descriptor_set *set = b->sets[s - b->group];
   const uint32_t slot = p->resources[k].binding / 2 - p->set_base[s];
   return set && slot < set->layout->slot_count ? &set->slots[slot] : NULL;
}

static uint32_t
bind_group(struct replay *r, const struct op_bind *b, bool *transient)
{
   struct wg_program *p = b->program;
   const uint32_t bgl = p->bgl[b->group], bgl_uid = p->bgl_uid[b->group];
   *transient = false;
   /* Kept on the group's first set, for its version (or, with more sets, for all of theirs hashed). */
   struct wg_descriptor_set *holder = NULL;
   uint32_t version = 0, sets = 0;
   for (uint32_t i = 0; i < WG_GROUP_SETS; i++) {
      if (!b->sets[i])
         continue;
      holder = holder ? holder : b->sets[i];
      sets++;
   }
   if (sets == 1) {
      version = holder->version;
   } else if (sets > 1) {
      uint32_t words[2 * WG_GROUP_SETS] = { 0 };
      for (uint32_t i = 0; i < WG_GROUP_SETS; i++)
         if (b->sets[i])
            words[2 * i] = b->sets[i]->uid, words[2 * i + 1] = b->sets[i]->version;
      version = _mesa_hash_data(words, sizeof(words)) | 1u << 31;
   } else if (p->push_ubo_size && b->group == WGSL_MAX_GROUPS - 1 && p->push_group &&
              p->push_group_gen == r->dev->push_gen) {
      return p->push_group;
   }
   /* Group 3 holds the push buffer's binding too: a group is of one push buffer. */
   if (holder && p->push_ubo_size && b->group == WGSL_MAX_GROUPS - 1) {
      const uint32_t words[2] = { version, r->dev->push_gen };
      version = _mesa_hash_data(words, sizeof(words)) | 1u << 31;
   }
   uint32_t group = 0;
   if (holder)
      for (uint32_t i = 0; i < WG_SET_GROUPS; i++)
         if (holder->groups[i].group && holder->groups[i].bgl == bgl_uid && holder->groups[i].version == version) {
            group = holder->groups[i].group;
            goto found;
         }
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"layout\":%u,\"entries\":[", bgl);
   bool first = true, push_only = b->group == WGSL_MAX_GROUPS - 1 && p->push_ubo_size;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      if (res->group != b->group)
         continue;
      const char *sep = first ? "" : ",";
      if (p->dynamic[k] == WG_DYNAMIC_PUSH) {
         wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":0,\"size\":%u}", sep, res->binding,
                        push_buffer(r->dev), align(p->push_ubo_size, 16));
         first = false;
         continue;
      }
      push_only = false;
      const struct wg_descriptor *d = bound_descriptor(b, p, k);
      if (!d)
         continue;
      switch (res->kind) {
      case WGSL_UNIFORM:
      case WGSL_STORAGE:
      case WGSL_STORAGE_READ: {
         if (d->type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) {
            /* A texel buffer: its words, and at the next binding its view's parameters (wgsl_print.c). */
            const struct wg_buffer_view *v = d->texel;
            if (!v || !v->mem || !v->params)
               continue;
            if (res->binding & 1)
               wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":0,\"size\":32}", sep, res->binding,
                              v->params);
            else
               wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":%llu,\"size\":%llu}", sep,
                              res->binding, wg_memory_buffer(v->mem), (unsigned long long)v->at,
                              (unsigned long long)MAX2(v->size, 4));
            break;
         }
         if (!d->buffer || !d->buffer->mem)
            continue;
         const VkDeviceSize at = d->buffer->offset + d->offset;
         VkDeviceSize size = vk_buffer_range(&d->buffer->vk, d->offset, d->range);
         /* A uniform block the shader declares larger than the range bound (std140 rounds up): within the memory. */
         if (res->kind == WGSL_UNIFORM)
            size = MIN2(MAX2(size, res->size), d->buffer->mem->size - at);
         /* WebGPU binds storage in whole words; a buffer of an odd size bound whole loses its last bytes' word. */
         else if (size > 4)
            size &= ~3ull;
         wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":%llu,\"size\":%llu}", sep, res->binding,
                        wg_memory_buffer(d->buffer->mem), (unsigned long long)at, (unsigned long long)size);
         break;
      }
      case WGSL_SAMPLER:
      case WGSL_SAMPLER_COMPARE:
         if (!d->sampler)
            continue;
         wg_json_printf(&j, "%s{\"binding\":%u,\"sampler\":%u}", sep, res->binding,
                        res->nonfiltering && d->sampler->nearest ? d->sampler->nearest : d->sampler->id);
         break;
      default:
         if (!d->view)
            continue;
         wg_json_printf(&j, "%s{\"binding\":%u,\"view\":%u}", sep, res->binding,
                        res->kind == WGSL_STORAGE_TEXTURE && d->view->storage ? d->view->storage : d->view->view);
         break;
      }
      first = false;
   }
   wg_json_printf(&j, "]}");
   group = wg_create_json(WG_KIND_BIND_GROUP, &j);
   if (!holder) {
      if (push_only) {
         if (p->push_group)
            util_dynarray_append_typed(&released_groups, uint32_t, p->push_group);
         p->push_group = group;
         p->push_group_gen = r->dev->push_gen;
         return group;
      }
      *transient = true; /* an empty group: released once the submit is encoded */
      return group;
   }
   {
      const uint32_t i = holder->next_group++ % WG_SET_GROUPS;
      if (holder->groups[i].group)
         util_dynarray_append_typed(&released_groups, uint32_t, holder->groups[i].group);
      holder->groups[i].group = group;
      holder->groups[i].bgl = bgl_uid;
      holder->groups[i].version = version;
   }
found:
   /* What shaders may write in host-visible memory is read back after the submit, at its dynamic offset if it has one
    * (the group's offsets go by resource, as record_sets puts them). */
   uint32_t n = 0;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      if (res->group != b->group)
         continue;
      const uint32_t dynamic = p->dynamic[k] >= 0 && n < b->offset_count ? b->offsets[n] : 0;
      n += p->dynamic[k] != -1;
      if (res->kind != WGSL_STORAGE || !res->written)
         continue;
      const struct wg_descriptor *d = bound_descriptor(b, p, k);
      if (d && d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) {
         if (d->texel && d->texel->mem && d->texel->mem->host)
            readback(r, d->texel->mem, d->texel->at, d->texel->size);
         continue;
      }
      if (d && d->buffer && d->buffer->mem && d->buffer->mem->host)
         readback(r, d->buffer->mem, d->buffer->offset + d->offset + dynamic,
                  vk_buffer_range(&d->buffer->vk, d->offset, d->range));
   }
   return group;
}


static void
apply(struct replay *r, uint32_t point)
{
   if (point == 0) {
      if (r->dirty & RD_PIPELINE)
         gpu_set_pipeline(r->pipeline);
      if (r->dirty & RD_DYN) {
         const struct op_dyn *d = &r->dyn;
         /* WebGPU wants a viewport inside [-2·max, 2·max] with positive size, and a scissor inside the attachments. */
         gpu_set_viewport(d->viewport[0], d->viewport[1], MAX2(d->viewport[2], 1), MAX2(d->viewport[3], 1),
                          CLAMP(MIN2(d->viewport[4], d->viewport[5]), 0, 1), CLAMP(MAX2(d->viewport[4], d->viewport[5]), 0, 1));
         const int64_t x0 = CLAMP((int64_t)d->scissor[0], 0, r->width), y0 = CLAMP((int64_t)d->scissor[1], 0, r->height);
         const int64_t x1 = CLAMP((int64_t)d->scissor[0] + d->scissor[2], x0, r->width);
         const int64_t y1 = CLAMP((int64_t)d->scissor[1] + d->scissor[3], y0, r->height);
         gpu_set_scissor(x0, y0, x1 - x0, y1 - y0);
         gpu_set_blend_constant(d->blend[0], d->blend[1], d->blend[2], d->blend[3]);
         gpu_set_stencil_reference(d->stencil_ref);
      }
      if (r->dirty & RD_VB)
         u_foreach_bit(b, r->vb_mask)
            if (r->vb[b].buffer)
               gpu_set_vertex_buffer(b, r->vb[b].buffer, r->vb[b].offset, r->vb[b].size);
      if ((r->dirty & RD_IB) && r->have_ib)
         gpu_set_index_buffer(r->ib.buffer, r->ib.wide, r->ib.offset, r->ib.size);
   } else if (r->dirty & RD_PIPELINE) {
      gpu_set_pipeline(r->compute);
   }
   /* Push constants past the immediates: this draw's in a new place of the push buffer, its group's last dynamic
    * offset (the push buffer's binding is group 3's last). */
   const struct wg_program *p = r->program[point];
   if (p && p->push_ubo_size && p->group_count == WGSL_MAX_GROUPS) {
      if ((r->dirty & (RD_PUSH | RD_PIPELINE)) || r->push_offset == UINT32_MAX) {
         struct wg_device *dev = r->dev;
         push_buffer(dev);
         const uint32_t size = align(p->push_ubo_size, 16);
         if (dev->push_used + size > dev->push_size) {
            static bool told;
            if (!told)
               fprintf(stderr, "wg: a submit's push constants overflow the push buffer\n");
            told = true;
            dev->push_used = 0;
         }
         r->push_offset = dev->push_used;
         memcpy(dev->push_data + r->push_offset, r->push, MIN2(size, sizeof(r->push)));
         dev->push_used = align(dev->push_used + size, 256);
         r->dirty |= RD_GROUPS;
      }
      const uint32_t n = r->groups[point][WGSL_MAX_GROUPS - 1].n;
      if (n)
         r->groups[point][WGSL_MAX_GROUPS - 1].offsets[n - 1] = r->push_offset;
   }
   if (r->dirty & RD_GROUPS)
      for (uint32_t g = 0; g < r->group_count[point]; g++)
         gpu_set_bind_group(g, r->groups[point][g].group, r->groups[point][g].offsets, r->groups[point][g].n);
   const uint32_t immediates = p ? MIN2(r->push_size, p->immediate_size) : r->push_size;
   if ((r->dirty & (RD_PUSH | RD_PIPELINE)) && immediates)
      gpu_set_immediates(0, r->push, immediates);
   r->dirty = 0;
}

static void
cpu_write(struct replay *r, struct wg_device_memory *mem, VkDeviceSize offset, const void *data, uint32_t size,
          bool fill, uint32_t value)
{
   struct cpu_write w = { .mem = mem, .offset = offset, .size = size, .fill = fill, .value = value,
                          .data = util_dynarray_num_elements(&r->submit->bytes, uint8_t), .base = UINT32_MAX };
   if (!fill)
      util_dynarray_append_array(&r->submit->bytes, uint8_t, data, size);
   util_dynarray_append_typed(&r->submit->writes, struct cpu_write, w);
}

/* vkCmdCopyQueryPoolResults: each query's value (an occlusion query's from its pool's buffer, on the GPU; a
 * timestamp's from the CPU) and availability where Vulkan puts them, the bytes between them untouched. An unavailable
 * query's value isn't written, unless PARTIAL_BIT asks for one (0). */
static void
copy_queries(struct replay *r, const struct op_copy_query *q)
{
   struct wg_query_pool *pool = q->pool;
   const bool wide = q->flags & VK_QUERY_RESULT_64_BIT, with_avail = q->flags & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT;
   const bool partial = q->flags & VK_QUERY_RESULT_PARTIAL_BIT, gpu = pool->buf;
   const uint32_t size = wide ? 8 : 4, each = size * (with_avail ? 2 : 1);
   const uint32_t buf = buffer_gpu(q->dst);
   const VkDeviceSize base = q->dst->offset + q->offset;
   if (!q->count)
      return;
   for (uint32_t i = 0; i < q->count; i++) {
      const uint32_t index = q->first + i;
      const VkDeviceSize at = base + i * q->stride;
      const bool avail = pool->avail[index];
      uint8_t bytes[16] = { 0 };
      uint32_t from = 0, to = 0; /* the CPU's bytes: [from, to) of the query's */
      if (avail && gpu) {
         if (buf)
            gpu_copy_bb(pool->buf, index * 8.0, buf, at, size);
         from = to = size;
      } else if (avail || partial) {
         const uint64_t v = avail ? pool->values[index] : 0;
         memcpy(bytes, &v, size); /* little-endian: a 32-bit result is the value's low word */
         to = size;
      } else {
         from = to = size;
      }
      if (with_avail) {
         memcpy(bytes + size, &(uint64_t){ avail }, size);
         to = each;
      }
      if (to > from) {
         if (buf)
            gpu_update(buf, at + from, bytes + from, to - from);
         if (!gpu && host_mem(q->dst))
            cpu_write(r, q->dst->mem, at + from, bytes + from, to - from, false, 0);
      }
   }
   /* An occlusion query's value is the GPU's: read back what the copy wrote to host-visible memory. */
   if (gpu && host_mem(q->dst))
      readback(r, q->dst->mem, base, (q->count - 1) * q->stride + each);
}

static void
copy_bt_replay(const struct op_copy_bt *c, bool to_texture)
{
   void (*copy)(uint32_t, double, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                uint32_t, uint32_t, uint32_t) = to_texture ? gpu_copy_bt : gpu_copy_tb;
   const uint32_t block_rows = DIV_ROUND_UP(c->h, c->block_h);
   /* Depth and stencil copies go whole: WebGPU copies only whole subresources of them (the worker realigns rows). */
   if (c->bpr % 256 == 0 || (block_rows <= 1 && c->d == 1) || c->aspect) {
      copy(c->buffer, c->offset, c->bpr, c->rows, c->tex, c->mip, c->x, c->y, c->z, c->w, c->h, c->d, c->aspect);
      return;
   }
   /* WebGPU's rows are 256 bytes apart: one copy a row of blocks otherwise. */
   for (uint32_t z = 0; z < c->d; z++)
      for (uint32_t row = 0; row < block_rows; row++)
         copy(c->buffer, c->offset + ((double)z * c->rows + row) * c->bpr, c->bpr, 1, c->tex, c->mip, c->x,
              c->y + row * c->block_h, c->z + z, c->w, MIN2(c->block_h, c->h - row * c->block_h), 1, c->aspect);
}

static void
replay(struct replay *r, struct wg_cmd_buffer *cmd)
{
   const uint8_t *p = cmd->cmds.data, *end = p + cmd->cmds.size;
   while (p < end) {
      const struct op_head *h = (const void *)p;
      const void *d = h + 1;
      p += sizeof(*h) + h->size;
      switch ((enum op)h->op) {
      case OP_PASS: {
         end_pass(r);
         const char *json = d;
         /* Its occlusion queries' set (WebGPU's pass takes one, at its start). */
         bool stop = false;
         r->qpool = pass_query_pool(p, end, &stop);
         if (r->qpool) {
            struct wg_json j = { 0 };
            wg_json_printf(&j, "{\"occlusionQuerySet\":%u,%s", r->qpool->set, json + 1);
            gpu_render_pass(j.data, j.len);
            wg_json_free(&j);
         } else {
            gpu_render_pass(json, strlen(json));
         }
         r->pass = RENDER;
         /* The attachments' size, for scissors (in the JSON's tail). */
         const char *w = strstr(json, "\"width\":");
         r->width = w ? strtoul(w + 8, NULL, 10) : 0;
         const char *hh = strstr(json, "\"height\":");
         r->height = hh ? strtoul(hh + 9, NULL, 10) : 0;
         r->dirty = RD_ALL;
         break;
      }
      case OP_PASS_END:
         end_pass(r);
         break;
      case OP_CLEAR_RECTS:
         if (r->pass == RENDER) {
            gpu_clear_rects(d, strlen(d));
            r->dirty = RD_ALL;
         }
         break;
      case OP_PIPELINE: {
         const struct op_pipeline *op = d;
         r->pipeline = wg_render_pipeline(op->program, &op->key);
         r->program[0] = op->program;
         r->dirty |= RD_PIPELINE;
         r->group_count[0] = op->program->group_count;
         break;
      }
      case OP_COMPUTE: {
         struct wg_program *prog = *(struct wg_program *const *)d;
         r->compute = prog->compute;
         r->program[1] = prog;
         r->group_count[1] = prog->group_count;
         r->dirty |= RD_PIPELINE;
         break;
      }
      case OP_DYN:
         memcpy(&r->dyn, d, sizeof(r->dyn));
         r->dirty |= RD_DYN;
         break;
      case OP_BIND: {
         const struct op_bind *b = d;
         bool transient;
         uint32_t group = bind_group(r, b, &transient);
         if (transient)
            util_dynarray_append_typed(&released_groups, uint32_t, group);
         r->groups[b->compute][b->group].group = group;
         r->groups[b->compute][b->group].n = b->offset_count;
         memcpy(r->groups[b->compute][b->group].offsets, b->offsets, b->offset_count * 4);
         r->dirty |= RD_GROUPS;
         break;
      }
      case OP_VB: {
         const struct op_vb *v = d;
         r->vb[v->slot] = *v;
         r->vb_mask |= 1u << v->slot;
         r->dirty |= RD_VB;
         break;
      }
      case OP_IB:
         memcpy(&r->ib, d, sizeof(r->ib));
         r->have_ib = true;
         r->dirty |= RD_IB;
         break;
      case OP_PUSH: {
         uint32_t size;
         memcpy(&size, d, 4);
         memcpy(r->push, (const uint8_t *)d + 4, size);
         r->push_size = size;
         r->dirty |= RD_PUSH;
         break;
      }
      case OP_DRAW: {
         const uint32_t *a = d;
         if (r->pass != RENDER)
            break;
         apply(r, 0);
         gpu_draw(a[0], a[1], a[2], a[3]);
         break;
      }
      case OP_DRAW_INDEXED: {
         const struct op_draw_indexed *a = d;
         if (r->pass != RENDER)
            break;
         apply(r, 0);
         gpu_draw_indexed(a->count, a->instances, a->first, a->base, a->first_instance);
         break;
      }
      case OP_DRAW_INDIRECT: {
         const struct op_indirect *a = d;
         if (r->pass != RENDER)
            break;
         apply(r, 0);
         for (uint32_t i = 0; i < a->count; i++)
            gpu_draw_indirect(a->buffer, a->offset + (double)i * a->stride, a->indexed);
         break;
      }
      case OP_DISPATCH:
      case OP_DISPATCH_INDIRECT:
         if (r->pass == RENDER)
            break;
         if (r->pass == NONE) {
            gpu_compute_pass();
            r->pass = COMPUTE;
            r->dirty = RD_ALL;
         }
         apply(r, 1);
         if (h->op == OP_DISPATCH) {
            const uint32_t *a = d;
            gpu_dispatch(a[0], a[1], a[2]);
         } else {
            const struct op_indirect *a = d;
            gpu_dispatch_indirect(a->buffer, a->offset);
         }
         break;
      case OP_COPY_BB: {
         const struct op_copy_bb *c = d;
         end_pass(r);
         /* On the GPU whatever the alignment: the worker copies unaligned offsets and sizes with a compute pass
          * (WebGPU's copies want 4), so the source's bytes are the GPU's, written by this submit or earlier ones. */
         if (c->src && c->dst)
            gpu_copy_bb(c->src, c->src_offset, c->dst, c->dst_offset, c->size);
         readback(r, c->dst_mem, c->dst_mem_offset, c->size);
         break;
      }
      case OP_COPY_BT:
      case OP_COPY_TB: {
         const struct op_copy_bt *c = d;
         end_pass(r);
         copy_bt_replay(c, h->op == OP_COPY_BT);
         if (h->op == OP_COPY_TB)
            readback(r, c->mem, c->mem_offset, c->mem_size);
         break;
      }
      case OP_COPY_TT: {
         const struct op_copy_tt *c = d;
         end_pass(r);
         gpu_copy_tt(c->src, c->src_mip, c->sx, c->sy, c->sz, c->dst, c->dst_mip, c->dx, c->dy, c->dz, c->w, c->h, c->d,
                     c->aspect);
         break;
      }
      case OP_FILL:
      case OP_UPDATE: {
         const struct op_fill *f = d;
         end_pass(r);
         if (h->op == OP_FILL)
            gpu_fill(f->buffer, f->offset, f->size, f->value);
         else
            gpu_update(f->buffer, f->offset, f + 1, f->size);
         if (f->mem)
            cpu_write(r, f->mem, f->mem_offset, f + 1, f->size, h->op == OP_FILL, f->value);
         break;
      }
      case OP_META:
         end_pass(r);
         gpu_blit(d, strlen(d));
         break;
      case OP_QUERY: {
         const struct op_query *q = d;
         struct wg_query_pool *pool = q->pool;
         const bool occlusion = pool->vk.query_type == VK_QUERY_TYPE_OCCLUSION;
         if (q->kind == 0) {
            memset(&pool->values[q->first], 0, q->count * sizeof(uint64_t));
            memset(&pool->avail[q->first], 0, q->count);
            memset(&pool->ended[q->first], 0, q->count * sizeof(uint32_t));
         } else if (q->kind == 1) {
            pool->values[q->first] = os_time_get_nano();
            query_ended(r, pool, q->first);
         } else if (q->kind == 2 && occlusion) {
            if (r->pass == RENDER && pool == r->qpool && !r->qactive_pool && q->first < WG_QUERY_SET_MAX) {
               gpu_begin_occlusion(q->first);
               r->qactive_pool = pool;
               r->qactive = q->first;
               util_dynarray_append_typed(&r->pass_queries, struct pass_query,
                                          ((struct pass_query){ pool, q->first, false }));
            } else {
               static bool warned;
               if (!warned)
                  fprintf(stderr, "wg: an occlusion query begun outside a render pass or beside another pool's: "
                                  "reported as passing\n");
               warned = true;
            }
         } else if (q->kind == 3) {
            if (occlusion) {
               if (r->pass == RENDER && r->qactive_pool == pool && r->qactive == q->first) {
                  gpu_end_occlusion();
                  r->qactive_pool = NULL;
               } else {
                  query_passing(r, pool, q->first);
               }
            }
            query_ended(r, pool, q->first);
         }
         break;
      }
      case OP_COPY_QUERY:
         end_pass(r);
         copy_queries(r, d);
         break;
      case OP_EVENT: {
         const struct op_event *e = d;
         e->event->set = e->set;
         break;
      }
      case OP_EXEC: {
         struct wg_cmd_buffer *secondary = *(struct wg_cmd_buffer *const *)d;
         replay(r, secondary);
         r->dirty = RD_ALL;
         break;
      }
      }
   }
}

/* The devices whose submits complete and whose memories the window's written pages are for. */
static struct wg_device *devices[16];

/* Submits are numbered across devices: wg_complete finds a submit by its number alone. */
static uint32_t submit_serial;
uint32_t wg_completed_serial;

/* Marks a page of the window for a device's next upload. */
static void
mark_page(struct wg_device *d, uint32_t p)
{
   const uint32_t npages = (uint32_t)(wg_window_bytes / 4096);
   if (p >= npages)
      return;
   if (!d->pages)
      d->pages = calloc(DIV_ROUND_UP(npages, 32), 4);
   if (!d->pages) {
      d->pages_all = true;
      return;
   }
   d->pages[p / 32] |= 1u << (p % 32);
   d->pages_lo = d->pages_hi > d->pages_lo ? MIN2(d->pages_lo, p / 32) : p / 32;
   d->pages_hi = MAX2(d->pages_hi, p / 32 + 1);
}

/* Looks at the window's write-watch: the pages written since the last look go to every device (each uploads those over
 * its own memories at its next submit), since the watch is one for the whole window and every device's memories are
 * in it (VK3 L4c-A: a look by one device's submit used to drop the pages of the others'). */
static void
take_pages(void)
{
   static uint32_t pages[16384];
   const int32_t n = gpu_dirty(pages, sizeof(pages) / sizeof(pages[0]));
   for (uint32_t i = 0; i < 16; i++) {
      struct wg_device *d = devices[i];
      if (!d || !n)
         continue;
      if (n < 0) {
         d->pages_all = true;
         continue;
      }
      for (int32_t k = 0; k < n; k++)
         mark_page(d, pages[k]);
   }
}

/* The in-flight ranges (the comment at struct readback) of `mem` over [lo, hi) in `dev`'s pending submits after
 * `after` (all: NULL), oldest first. */
struct span {
   struct wg_submit *s;
   VkDeviceSize offset, size;
   uint8_t *base;
};

static struct util_dynarray span_list, scratch;

static uint32_t
spans(struct wg_device *dev, struct wg_submit *after, struct wg_device_memory *mem, VkDeviceSize lo, VkDeviceSize hi)
{
   util_dynarray_clear(&span_list);
   struct list_head *from = after ? &after->link : &dev->pending;
   for (struct list_head *l = from->next; l != &dev->pending; l = l->next) {
      struct wg_submit *s = list_entry(l, struct wg_submit, link);
      util_dynarray_foreach (&s->readbacks, struct readback, b)
         if (b->mem == mem && b->base != UINT32_MAX && b->offset < hi && b->offset + b->size > lo)
            util_dynarray_append_typed(&span_list, struct span,
                                       ((struct span){ s, b->offset, b->size, (uint8_t *)s->bases.data + b->base }));
      util_dynarray_foreach (&s->writes, struct cpu_write, w)
         if (w->mem == mem && w->base != UINT32_MAX && w->offset < hi && w->offset + w->size > lo)
            util_dynarray_append_typed(&span_list, struct span,
                                       ((struct span){ s, w->offset, w->size, (uint8_t *)s->bases.data + w->base }));
   }
   return util_dynarray_num_elements(&span_list, struct span);
}

/* Uploads [off, off + len) of a memory (4-aligned), but not the words an in-flight submit writes on the GPU that the
 * guest hasn't written since (a word with both goes up: the guest's bytes are the newer). */
static void
upload_range(struct wg_device *dev, struct wg_device_memory *mem, VkDeviceSize off, VkDeviceSize len)
{
   const VkDeviceSize end = off + len;
   const uint32_t n = spans(dev, NULL, mem, off, end);
   if (!n) {
      gpu_write(mem->gpu, off, mem->data + off, len);
      return;
   }
   const struct span *sp = span_list.data;
   VkDeviceSize run = off;
   for (VkDeviceSize w = off; w < end; w += 4) {
      bool keep = false, wrote = false;
      for (VkDeviceSize b = w; b < MIN2(w + 4, end); b++) {
         /* The newest range over the byte: its base is what the GPU has, unless the guest wrote it since. */
         for (uint32_t k = n; k-- > 0;) {
            if (b < sp[k].offset || b >= sp[k].offset + sp[k].size)
               continue;
            if (mem->data[b] == sp[k].base[b - sp[k].offset]) {
               keep = true;
               sp[k].s->shadowed = true;
            } else {
               wrote = true;
            }
            break;
         }
      }
      if (keep && !wrote) {
         if (w > run)
            gpu_write(mem->gpu, run, mem->data + run, w - run);
         run = w + 4;
      }
   }
   if (end > run)
      gpu_write(mem->gpu, run, mem->data + run, end - run);
}

/* A submit's ranges' bases: the CPU's bytes before its look at the write-watch. */
static void
snapshot(struct wg_submit *s)
{
   util_dynarray_foreach (&s->readbacks, struct readback, b) {
      if (!b->mem || !b->mem->data)
         continue;
      b->base = util_dynarray_num_elements(&s->bases, uint8_t);
      util_dynarray_append_array(&s->bases, uint8_t, b->mem->data + b->offset, b->size);
   }
   util_dynarray_foreach (&s->writes, struct cpu_write, w) {
      if (!w->mem || !w->mem->data)
         continue;
      w->base = util_dynarray_num_elements(&s->bases, uint8_t);
      util_dynarray_append_array(&s->bases, uint8_t, w->mem->data + w->offset, w->size);
   }
}

/* What the guest wrote to host-visible memory since this device's last submit: the window's written pages of its
 * memories mapped there, and the whole of those that moved or are new. A memory's bytes are uploaded to its 4-aligned
 * size (wg_AllocateMemory's `size`: its storage is whole pages, so the bytes past its end are there to read). */
static void
upload(struct wg_device *dev)
{
   take_pages();
   const bool any = dev->pages_all || dev->pages_hi > dev->pages_lo;
   list_for_each_entry (struct wg_device_memory, mem, &dev->host_memories, link) {
      if (!mem->gpu || !mem->data)
         continue;
      const uintptr_t at = (uintptr_t)mem->data;
      const bool in_window = at >= wg_window_at && at < wg_window_at + wg_window_bytes;
      if (mem->dirty || (in_window && dev->pages_all)) {
         upload_range(dev, mem, 0, mem->size);
         mem->dirty = false;
         continue;
      }
      if (!in_window || !any)
         continue;
      /* Runs of written pages inside this memory. */
      const uintptr_t lo = at - wg_window_at, hi = MIN2(lo + mem->size, (uintptr_t)wg_window_bytes);
      const uint32_t last = (uint32_t)((hi - 1) / 4096);
      for (uint32_t p = (uint32_t)(lo / 4096); p <= last;) {
         if (!(dev->pages[p / 32] >> (p % 32) & 1)) {
            p = dev->pages[p / 32] >> (p % 32) ? p + 1 : (p | 31) + 1;
            continue;
         }
         uint32_t q = p + 1;
         while (q <= last && dev->pages[q / 32] >> (q % 32) & 1)
            q++;
         const uintptr_t s = MAX2((uintptr_t)p * 4096, lo), e = MIN2((uintptr_t)q * 4096, hi);
         const uintptr_t off = (s - lo) & ~3ull, len = align64(e - lo, 4) - off;
         upload_range(dev, mem, off, MIN2(len, mem->size - off));
         p = q;
      }
   }
   /* Every page is now this device's no more: those over its memories went up, the rest are other devices'. */
   if (dev->pages_hi > dev->pages_lo)
      memset(dev->pages + dev->pages_lo, 0, (dev->pages_hi - dev->pages_lo) * 4);
   dev->pages_lo = dev->pages_hi = 0;
   dev->pages_all = false;
}

/* Linear images in host-visible memory, whose bytes the guest maps: each level and layer loaded from the memory into
 * the texture before a submit's commands (`load`) and stored back after them, read back with the submit. Every such
 * image each submit: a guest rarely keeps many (dEQP's readbacks through a linear image, a texture written on the CPU). */
static void
linear_images(struct wg_device *dev, bool load, struct replay *r)
{
   list_for_each_entry (struct wg_image, image, &dev->linear_images, linear_link) {
      const struct vk_image *vi = &image->vk;
      const bool is3d = vi->image_type == VK_IMAGE_TYPE_3D;
      for (uint32_t level = 0; level < vi->mip_levels; level++) {
         const VkExtent3D e = vk_image_mip_level_extent(vi, level);
         for (uint32_t layer = 0; layer < (is3d ? 1 : vi->array_layers); layer++) {
            VkSubresourceLayout l;
            wg_image_subresource(vi, level, layer, &l);
            const VkDeviceSize at = image->offset + l.offset;
            if (at + l.size > image->mem->size)
               continue;
            const uint32_t rows = DIV_ROUND_UP(e.height, image->fmt->bh);
            (load ? gpu_copy_bt : gpu_copy_tb)(image->mem->gpu, (double)at, (uint32_t)l.rowPitch, rows, image->tex,
                                               level, 0, 0, is3d ? 0 : layer, e.width, e.height, is3d ? e.depth : 1, 0);
            if (!load)
               readback(r, image->mem, at, l.size);
         }
      }
   }
}

/* A sync of either kind on the CPU (below). */
struct wg_sync {
   struct vk_sync base;
   uint64_t value;
   uint64_t pending; /* a timeline's: the largest value a submit already replayed signals once it completes */
};

static bool
is_wg_timeline(const struct vk_sync *sync)
{
   return sync->type == &wg_sync_type && (sync->flags & VK_SYNC_IS_TIMELINE);
}

/* A queue's wait on a timeline value is met once the value is reached or a submit already replayed will signal it
 * (the queue runs in order); a binary one's signal always comes first (Vulkan's rule). */
static bool
wait_met(const struct vk_sync_wait *w)
{
   if (!is_wg_timeline(w->sync))
      return true;
   const struct wg_sync *s = (const struct wg_sync *)w->sync;
   return s->value >= w->wait_value || s->pending >= w->wait_value;
}

/* A submit held for its waits (Vulkan's wait before signal: the host, or another queue, signals the value later). The
 * runtime frees its vk_queue_submit when driver_submit returns: its command buffers and signals are copied (they stay
 * the application's while the submit is pending), and its timeline waits. */
struct held {
   struct list_head link;
   uint32_t cmd_count, signal_count, wait_count;
   struct vk_command_buffer **cmds;
   struct vk_sync_signal *signals;
   struct vk_sync_wait *waits;
};

static bool completing;   /* inside wg_complete: held submits are replayed at its end */

static VkResult submit_now(struct wg_device *dev, uint32_t cmd_count, struct vk_command_buffer *const *cmds,
                           uint32_t signal_count, const struct vk_sync_signal *signals);

static void
held_free(struct held *h)
{
   list_del(&h->link);
   free(h->cmds), free(h->signals), free(h->waits);
   free(h);
}

/* Replays every device's held submits whose waits are met, oldest first (one not met holds those after it). */
static void
flush_held(void)
{
   for (bool progress = true; progress;) {
      progress = false;
      for (uint32_t i = 0; i < 16; i++) {
         struct wg_device *dev = devices[i];
         while (dev && !list_is_empty(&dev->held)) {
            struct held *h = list_first_entry(&dev->held, struct held, link);
            bool met = true;
            for (uint32_t k = 0; k < h->wait_count; k++)
               met &= wait_met(&h->waits[k]);
            if (!met)
               break;
            list_del(&h->link);
            submit_now(dev, h->cmd_count, h->cmds, h->signal_count, h->signals);
            list_inithead(&h->link);
            held_free(h);
            progress = true;
         }
      }
   }
}

/* Set by vkr around the submit that retires a guest's virtio-gpu fence (vk/patches/vkr-wasm.patch,
 * `vkr_queue_sync_submit`). */
bool wg_ring_fence;

VkResult
wg_queue_submit(struct vk_queue *queue, struct vk_queue_submit *submit)
{
   struct wg_device *dev = container_of(queue->base.device, struct wg_device, vk);
   /* Behind a held submit every submit is held, in order: a fence or semaphore a later submit signals says the earlier
    * ones are done (Mesa's vkQueueWaitIdle and vkDeviceWaitIdle are such submits of a sync alone), and the application
    * may then free what they replay. But vkr's own submit of a fence alone, which retires the guest's virtio-gpu fence,
    * goes at once: the guest's kernel waits for that fence before it reuses the command stream's memory, so holding it
    * held the guest before it could send the host's signal the held submit waits for (VK3 L6a,
    * `timeline_semaphore.wait.host_wait_before_signal`). It signals early, which only frees that memory, whose commands
    * vkr has already decoded; what the held submits replay stays the guest's until its own fences and semaphores, which
    * are held with them (the L5-L6a review's finding 1, VK3 L6c). */
   bool met = list_is_empty(&dev->held) || (wg_ring_fence && !submit->command_buffer_count && !submit->wait_count);
   for (uint32_t i = 0; i < submit->wait_count && met; i++)
      met = wait_met(&submit->waits[i]);
   if (met)
      return submit_now(dev, submit->command_buffer_count, submit->command_buffers, submit->signal_count,
                        submit->signals);
   struct held *h = calloc(1, sizeof(*h));
   if (!h)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   h->cmds = malloc(MAX2(submit->command_buffer_count, 1) * sizeof(*h->cmds));
   h->signals = malloc(MAX2(submit->signal_count, 1) * sizeof(*h->signals));
   h->waits = malloc(MAX2(submit->wait_count, 1) * sizeof(*h->waits));
   if (!h->cmds || !h->signals || !h->waits) {
      list_inithead(&h->link);
      held_free(h);
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   }
   h->cmd_count = submit->command_buffer_count;
   memcpy(h->cmds, submit->command_buffers, h->cmd_count * sizeof(*h->cmds));
   h->signal_count = submit->signal_count;
   memcpy(h->signals, submit->signals, h->signal_count * sizeof(*h->signals));
   for (uint32_t i = 0; i < submit->wait_count; i++)
      if (is_wg_timeline(submit->waits[i].sync))
         h->waits[h->wait_count++] = submit->waits[i];
   list_addtail(&h->link, &dev->held);
   return VK_SUCCESS;
}

static VkResult
submit_now(struct wg_device *dev, uint32_t cmd_count, struct vk_command_buffer *const *cmds, uint32_t signal_count,
           const struct vk_sync_signal *signals)
{
   struct wg_submit *s = calloc(1, sizeof(*s));
   if (!s)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   s->serial = ++submit_serial;
   util_dynarray_init(&s->readbacks, NULL);
   util_dynarray_init(&s->writes, NULL);
   util_dynarray_init(&s->bytes, NULL);
   util_dynarray_init(&s->bases, NULL);
   util_dynarray_init(&s->signals, NULL);
   util_dynarray_init(&s->queries, NULL);
   for (uint32_t i = 0; i < signal_count; i++) {
      util_dynarray_append_typed(&s->signals, struct vk_sync_signal, signals[i]);
      if (is_wg_timeline(signals[i].sync)) {
         struct wg_sync *sync = (struct wg_sync *)signals[i].sync;
         sync->pending = MAX2(sync->pending, signals[i].signal_value);
      }
   }

   /* Linear images in host-visible memory: their memory's buffer made first, so that upload() fills it. */
   list_for_each_entry (struct wg_image, image, &dev->linear_images, linear_link)
      wg_memory_buffer(image->mem);
   gpu_encoder();
   linear_images(dev, true, NULL);
   struct replay r = { .dev = dev, .submit = s, .push_offset = UINT32_MAX };
   uint64_t draws = 0;
   for (uint32_t i = 0; i < cmd_count; i++)
      draws += container_of(cmds[i], struct wg_cmd_buffer, vk)->draws;
   push_reserve(dev, draws * 256);
   dev->push_used = 0;
   for (uint32_t i = 0; i < cmd_count; i++) {
      struct wg_cmd_buffer *cmd = container_of(cmds[i], struct wg_cmd_buffer, vk);
      replay(&r, cmd);
      end_pass(&r);
      r.dirty = RD_ALL;
   }
   linear_images(dev, false, &r);
   /* The bases, then the look at the write-watch and the uploads: queue.writeBuffer, so ahead of the commands. */
   snapshot(s);
   upload(dev);
   util_dynarray_foreach (&s->readbacks, struct readback, b)
      b->slot = gpu_readback(b->mem->gpu, b->offset, b->size);
   util_dynarray_foreach (&s->queries, struct query_readback, q)
      q->slot = gpu_readback(q->pool->buf, q->lo * 8.0, (q->hi - q->lo) * 8);
   util_dynarray_fini(&r.pass_queries);
   /* Ordered after the earlier submits' work and before this one's (queue.writeBuffer). */
   if (dev->push_used)
      gpu_write(dev->push_buffer, 0, dev->push_data, dev->push_used);
   gpu_submit(s->serial);
   util_dynarray_foreach (&released_groups, uint32_t, g)
      wg_id_release(*g);
   util_dynarray_clear(&released_groups);
   list_addtail(&s->link, &dev->pending);
   return VK_SUCCESS;
}

static void
submit_free(struct wg_submit *s)
{
   list_del(&s->link);
   util_dynarray_fini(&s->readbacks);
   util_dynarray_fini(&s->writes);
   util_dynarray_fini(&s->bytes);
   util_dynarray_fini(&s->bases);
   util_dynarray_fini(&s->signals);
   util_dynarray_fini(&s->queries);
   free(s);
}

void
wg_submits_forget(struct wg_device *dev, struct wg_device_memory *mem)
{
   list_for_each_entry (struct wg_submit, s, &dev->pending, link) {
      util_dynarray_foreach (&s->readbacks, struct readback, b)
         if (b->mem == mem)
            b->mem = NULL;
      util_dynarray_foreach (&s->writes, struct cpu_write, w)
         if (w->mem == mem)
            w->mem = NULL;
   }
}

bool
wg_device_register(struct wg_device *dev, bool add)
{
   for (uint32_t i = 0; i < 16; i++) {
      if (add && !devices[i]) {
         devices[i] = dev;
         return true;
      }
      if (!add && devices[i] == dev) {
         devices[i] = NULL;
         return true;
      }
   }
   if (add)
      fprintf(stderr, "wg: more than 16 devices at once: device creation fails\n");
   return false;
}

/* Whether [p, p + size) is memory the renderer may write: the host-visible window or its own arena (memory 0's top
 * 256 MiB). Anything else would be guest RAM. */
static bool
writable(const uint8_t *p, uint64_t size)
{
   const uintptr_t a = (uintptr_t)p;
   const bool ok = (a >= wg_window_at && a + size <= wg_window_at + wg_window_bytes) ||
                   (a >= 0xf0000000u && a + size <= 0x100000000ull);
   if (!ok)
      fprintf(stderr, "wg: a completion's write to %#lx (+%llu) is outside the window and the arena: dropped\n",
              (unsigned long)a, (unsigned long long)size);
   return ok;
}

/* Lands bytes a completed submit wrote into the CPU's copy of a memory: those the guest hasn't written since the submit
 * (the CPU still has `base`); `outside` (a cpu_write): only where none of the submit's readbacks covers, as the
 * readback has the GPU's last word. A later in-flight range, or another write of this submit's, over a changed byte
 * gets it as its base (Venus's query feedback fills a slot, then copies results into it, in one submit). */
static void
land(struct wg_device *dev, struct wg_submit *s, struct wg_device_memory *mem, VkDeviceSize offset,
     const uint8_t *src, uint32_t n, const uint8_t *base, bool outside)
{
   uint8_t *cpu = mem->data + offset;
   bool covered = false;
   if (outside)
      util_dynarray_foreach (&s->readbacks, struct readback, b)
         covered |= b->mem == mem && b->offset < offset + n && b->offset + b->size > offset;
   uint32_t later = spans(dev, s, mem, offset, offset + n);
   /* The submit's own writes too: one landed before another over the same bytes isn't the guest's. */
   util_dynarray_foreach (&s->writes, struct cpu_write, w)
      if (w->mem == mem && w->base != UINT32_MAX && w->offset < offset + n && w->offset + w->size > offset &&
          (uint8_t *)s->bases.data + w->base != base) {
         util_dynarray_append_typed(&span_list, struct span,
                                    ((struct span){ s, w->offset, w->size, (uint8_t *)s->bases.data + w->base }));
         later++;
      }
   if (!later && !covered && !memcmp(cpu, base, n)) {
      memcpy(cpu, src, n);
      return;
   }
   const struct span *sp = span_list.data;
   for (uint32_t i = 0; i < n; i++) {
      if (cpu[i] != base[i] || cpu[i] == src[i])
         continue;
      const VkDeviceSize at = offset + i;
      bool skip = false;
      if (covered)
         util_dynarray_foreach (&s->readbacks, struct readback, b)
            skip |= b->mem == mem && at >= b->offset && at < b->offset + b->size;
      if (skip)
         continue;
      for (uint32_t k = 0; k < later; k++)
         if (at >= sp[k].offset && at < sp[k].offset + sp[k].size && sp[k].base[at - sp[k].offset] == cpu[i])
            sp[k].base[at - sp[k].offset] = src[i];
      cpu[i] = src[i];
   }
}

/* Marks the window's pages under [offset, offset + size) of a memory for this device's next upload. */
static void
mark_range(struct wg_device *dev, struct wg_device_memory *mem, VkDeviceSize offset, VkDeviceSize size)
{
   if (!mem || !mem->data || !size)
      return;
   const uintptr_t at = (uintptr_t)mem->data + offset;
   if (at < wg_window_at || at >= wg_window_at + wg_window_bytes)
      return;
   for (uintptr_t p = (at - wg_window_at) / 4096; p <= (at + size - 1 - wg_window_at) / 4096; p++)
      mark_page(dev, (uint32_t)p);
}

static void complete(uint32_t serial);

__attribute__((visibility("default"))) void
wg_complete(uint32_t serial)
{
   completing = true;
   complete(serial);
   completing = false;
   /* Its signals may meet a held submit's waits. */
   flush_held();
}

static void
complete(uint32_t serial)
{
   for (uint32_t i = 0; i < 16; i++) {
      struct wg_device *dev = devices[i];
      if (!dev)
         continue;
      list_for_each_entry_safe (struct wg_submit, s, &dev->pending, link) {
         if (s->serial != serial)
            continue;
         /* What the GPU read back is its last word on its range: first, then the writes outside it. */
         util_dynarray_foreach (&s->readbacks, struct readback, b) {
            if (!b->mem || !b->mem->data || b->base == UINT32_MAX)
               continue;
            const uint32_t n = (uint32_t)MIN2(b->size, b->mem->vk.size - b->offset);
            if (!writable(b->mem->data + b->offset, n))
               continue;
            util_dynarray_clear(&scratch);
            uint8_t *bytes = util_dynarray_grow_bytes(&scratch, 1, b->size);
            if (!bytes)
               continue;
            /* The base first: a readback that copies nothing (no device, a lost slot) changes nothing. */
            memcpy(bytes, (uint8_t *)s->bases.data + b->base, b->size);
            gpu_readback_copy(b->slot, bytes, (uint32_t)b->size);
            land(dev, s, b->mem, b->offset, bytes, n, (uint8_t *)s->bases.data + b->base, false);
         }
         util_dynarray_foreach (&s->writes, struct cpu_write, w) {
            if (!w->mem || !w->mem->data || w->base == UINT32_MAX || !writable(w->mem->data + w->offset, w->size))
               continue;
            const uint8_t *bytes = (uint8_t *)s->bytes.data + w->data;
            if (w->fill) {
               util_dynarray_clear(&scratch);
               uint8_t *f = util_dynarray_grow_bytes(&scratch, 1, w->size);
               if (!f)
                  continue;
               for (uint32_t k = 0; k < w->size; k++)
                  f[k] = (uint8_t)(w->value >> (k % 4 * 8));
               bytes = f;
            }
            land(dev, s, w->mem, w->offset, bytes, w->size, (uint8_t *)s->bases.data + w->base, true);
         }
         /* Words an upload left out (the GPU had them): their pages go up again with what the CPU has now. */
         if (s->shadowed) {
            util_dynarray_foreach (&s->readbacks, struct readback, b)
               mark_range(dev, b->mem, b->offset, b->size);
            util_dynarray_foreach (&s->writes, struct cpu_write, w)
               mark_range(dev, w->mem, w->offset, w->size);
         }
         util_dynarray_foreach (&s->queries, struct query_readback, q)
            gpu_readback_copy(q->slot, &q->pool->values[q->lo], (q->hi - q->lo) * 8);
         wg_completed_serial = serial;
         util_dynarray_foreach (&s->signals, struct vk_sync_signal, sig)
            vk_sync_signal(&dev->vk, sig->sync, sig->signal_value);
         submit_free(s);
         if (wg_submitted)
            wg_submitted();
         return;
      }
   }
}

void
wg_device_drain(struct wg_device *dev)
{
   list_for_each_entry_safe (struct wg_submit, s, &dev->pending, link)
      submit_free(s);
   list_for_each_entry_safe (struct held, h, &dev->held, link)
      held_free(h);
}

/* A sync of either kind on the CPU (struct wg_sync, above): a binary one is 0 or 1, a timeline one its value. A wait
 * for a value nothing reached yet times out rather than block: the GPU's work completes in a later task of the
 * worker's (wg_complete). Advertised as waiting before its signal (VK_SYNC_FEATURE_WAIT_BEFORE_SIGNAL: the runtime then
 * submits at once, with no thread of its own): a submit whose timeline wait isn't met is held (wg_queue_submit). */

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
   /* The host's signal (vkSignalSemaphore) may meet a held submit's waits; a completion's replays them at its end. */
   if (!completing)
      flush_held();
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
   ((struct wg_sync *)sync)->pending = 0;
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
      const bool timeline = waits[i].sync->flags & VK_SYNC_IS_TIMELINE;
      const uint64_t want = timeline ? waits[i].wait_value : 1;
      /* A pending wait counts as met (the queue runs in order): a timeline's value a replayed submit will signal, any
       * binary one (its signal is submitted first). */
      if (s->value >= want || ((flags & VK_SYNC_WAIT_PENDING) && (!timeline || s->pending >= want)))
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
               VK_SYNC_FEATURE_CPU_SIGNAL | VK_SYNC_FEATURE_WAIT_ANY | VK_SYNC_FEATURE_WAIT_PENDING |
               VK_SYNC_FEATURE_WAIT_BEFORE_SIGNAL,
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
