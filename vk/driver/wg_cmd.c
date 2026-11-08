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
#include "vk_command_pool.h"
#include "vk_descriptor_update_template.h"
#include "vk_format.h"
#include "vk_graphics_state.h"
#include "vk_pipeline.h"
#include "vk_pipeline_layout.h"
#include "vk_render_pass.h"
#include "vk_util.h"

#include "wg_private.h"

void (*wg_submitted)(void);
double wg_emul[WG_EMUL_COUNT];
uint32_t wg_emul_skip;

/* glue.c's `venus_emul_counts`: the counts, and how many in `*n`. */
const double *
wg_emul_counts(uint32_t *n)
{
   *n = WG_EMUL_COUNT;
   return wg_emul;
}


/* The ops. */
enum op {
   OP_VIEWS,           /* uint32_t[2]: the next pass's view mask (multiview: it replays once a view), and whether its
                        * views are a layered pass's layers (draws in the first alone) */
   OP_PASS,            /* JSON of the render pass (with OP_VIEWS, one after another, a view's each; fewer: the last serves) */
   OP_PASS_END,
   OP_CLEAR_RECTS,     /* JSON */
   OP_CLEAR_LAYERS,    /* uint32_t[2]: the next OP_CLEAR_RECTS's first layer and count, in a layered pass */
   OP_PASS_ATTS,       /* struct op_pass_atts: the next pass's attachments, where one can be read as an input attachment */
   OP_PASS_READ,       /* nothing: a barrier inside a pass, or its clear: what reads an attachment reads it anew */
   OP_PIPELINE,        /* struct op_pipeline */
   OP_COMPUTE,         /* struct wg_program * */
   OP_COMPUTE_BASED,   /* uint32_t: the compute pipeline of a dispatch's base */
   OP_DYN,             /* struct op_dyn */
   OP_BIND,            /* struct op_bind */
   OP_VB,              /* struct op_vb */
   OP_IB,              /* struct op_ib */
   OP_PUSH,            /* size, bytes */
   OP_DRAW,            /* uint32_t[5]: vkCmdDraw's, the draw index (VK_EXT_multi_draw's element) */
   OP_DRAW_INDEXED,    /* struct op_draw_indexed */
   OP_DRAW_INDIRECT,   /* struct op_indirect */
   OP_DISPATCH,        /* uint32_t[3] */
   OP_DISPATCH_INDIRECT,
   OP_COPY_BB,         /* struct op_copy_bb */
   OP_COPY_BT,         /* struct op_copy_bt */
   OP_COPY_TB,
   OP_COPY_TT,         /* struct op_copy_tt */
   OP_IMAGE_USE,       /* struct op_image_use */
   OP_FILL,            /* struct op_fill */
   OP_UPDATE,          /* struct op_fill, then the bytes */
   OP_META,            /* JSON (gpu_blit) */
   OP_QUERY,           /* struct op_query */
   OP_COPY_QUERY,      /* struct op_copy_query */
   OP_EVENT,           /* struct op_event */
   OP_EXEC,            /* struct wg_cmd_buffer * */
   OP_PROVOKE,         /* struct op_provoke */
   OP_XFB,             /* struct op_xfb, then gpu_xfb's JSON */
   /* The next draw's vertex stage writes storage (VK4 T33, `vs_prepass`): ONLY, it runs but rasterizes nothing
    * (rasterizer discard, both faces culled); AGAIN, it draws the outputs the last one's pre-pass left (a draw split by
    * face, `draw_faces`: the stage runs once). */
   OP_VS_ONLY,
   OP_VS_AGAIN,
};

struct op_pass_atts {
   struct wg_image_view *views[10]; /* colour, then depth, stencil */
   VkImageAspectFlags written[10];  /* what the pass may write of each */
   uint32_t count;
   /* Every attachment, for the draws that read them (VK4 T32, `dst_copies`): by colour index, and depth. */
   struct wg_image_view *colors[8], *depth;
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
   uint32_t draw_index; /* VK_EXT_multi_draw's element (VK4 T26) */
};

struct op_indirect {
   uint32_t buffer, indexed, count, stride;
   double offset;
   /* A fan (WebGPU has none, and its indices depend on the arguments): each draw's a ticket (gpu_fan_indirect), its
    * indices from `ib` (the device's fan indices without an index buffer: `wide` 2). */
   bool fan, restart;
   uint8_t wide;
   uint32_t ib;
   double ib_offset, ib_size;
   /* vkCmdDraw*IndirectCount (VK4 T26): the count's buffer (0: none) and place; `count` is then the most drawn, and
    * the records come packed from a ticket of their own (gpu_indirect_count). */
   uint32_t count_buffer;
   double count_offset;
};

/* Transform feedback's begin, draw or end (gpu_xfb): its JSON follows; a begin's host-visible buffers are read back. */
struct op_xfb {
   uint32_t kind; /* 0 begin, 1 draw, 2 end */
   struct {
      struct wg_device_memory *mem;
      VkDeviceSize offset, size;
   } readback[8];
};

/* A draw through indices of its own, made before its render pass (gpu_provoke: the provoking vertex, indexed fans). */
struct op_provoke {
   uint32_t buffer;              /* the index buffer (0 for a draw without one) */
   uint8_t wide, mode, restart;  /* gpu_provoke's */
   uint32_t first, count, prims, instances;
   int32_t base;
   uint32_t first_instance, draw_index;
   double offset, size;
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
   uint32_t dst_w, dst_h, cols, rows, bytes; /* the region at the destination, in its blocks; a block's bytes */
};

/* A mutable image's subresources about to be used in its own texture or an alias (`image_use`). */
struct op_image_use {
   struct wg_image *image;
   uint32_t plane, alias, level, levels, layer, layers;
   bool write;
   bool discard; /* written whole: what it held needn't come first */
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

/* How many times a draw of the pass is replayed: a pass a view with multiview, a pass a layer in a layered pass (VK4
 * T43: a draw writing gl_Layer is drawn in each), each taking its own places of the push buffer. */
static uint32_t
pass_replays(const struct wg_cmd_buffer *cmd)
{
   if (cmd->pass.view_mask)
      return util_bitcount(cmd->pass.view_mask);
   return cmd->pass.active ? MAX2(cmd->pass.layer_count, 1) : 1;
}

static void *
emit(struct wg_cmd_buffer *cmd, enum op op, const void *data, uint32_t size)
{
   const uint32_t padded = align(size, 8);
   struct op_head *h = util_dynarray_grow_bytes(&cmd->cmds, 1, sizeof(*h) + padded);
   /* An indirect draw may take two places of the push buffer: its render pass's for its draw parameters (`prepasses`)
    * and one of its own. */
   if ((op >= OP_DRAW && op <= OP_DISPATCH_INDIRECT) || op == OP_PROVOKE || op == OP_XFB)
      cmd->draws += (op == OP_DRAW_INDIRECT ? 2 : 1) * pass_replays(cmd);
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
   memset(cmd->last_aliased, 0, sizeof(cmd->last_aliased));
   cmd->last_push_size = ~0u;
   cmd->last_compute = NULL;
   memset(cmd->last_program, 0, sizeof(cmd->last_program));
   cmd->emitted = 0;
}

/* Before a command that reaches a mutable image's own texture or, an attachment, a view's. */
static void
record_image_use(struct wg_cmd_buffer *cmd, struct wg_image *image, uint32_t plane, uint32_t alias, uint32_t level,
                 uint32_t levels, uint32_t layer, uint32_t layers, bool write)
{
   if (!(image->vk.create_flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) && !image->valid)
      return;
   const bool is3d = image->vk.image_type == VK_IMAGE_TYPE_3D;
   struct op_image_use u = { image, plane, alias, level, levels, is3d ? 0 : layer, is3d ? 1 : layers, write, false };
   emit(cmd, OP_IMAGE_USE, &u, sizeof(u));
}

static void
record_layers_use(struct wg_cmd_buffer *cmd, struct wg_image *image, const VkImageSubresourceLayers *r, bool write)
{
   record_image_use(cmd, image, wg_image_plane(image, r->aspectMask), 0, r->mipLevel, 1, r->baseArrayLayer,
                    vk_image_subresource_layer_count(&image->vk, r), write);
}

/* An attachment, whose old bytes the pass may not read (`discard`). */
static void
record_attachment_use(struct wg_cmd_buffer *cmd, const struct wg_image_view *v, bool discard)
{
   struct wg_image *image = container_of(v->vk.image, struct wg_image, vk);
   if (!(image->vk.create_flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) && !image->valid)
      return;
   const bool is3d = image->vk.image_type == VK_IMAGE_TYPE_3D;
   struct op_image_use u = { image, 0, v->alias, v->vk.base_mip_level, 1, is3d ? 0 : v->vk.base_array_layer,
                             is3d ? 1 : v->vk.layer_count, true, discard };
   emit(cmd, OP_IMAGE_USE, &u, sizeof(u));
}

/* The texture a view is of. */
static uint32_t
view_texture(const struct wg_image_view *v)
{
   const struct wg_image *image = container_of(v->vk.image, struct wg_image, vk);
   return v->alias ? image->aliases[v->alias - 1].tex : image->tex;
}

/* Command buffers. */

struct push_set {
   struct wg_descriptor_set *set;
};

void
wg_dummy_unref(struct wg_dummy *d)
{
   if (!d || --d->refs)
      return;
   wg_id_release(d->view);
   wg_id_release(d->texture);
   free(d);
}

static void
free_dummies(struct wg_cmd_buffer *cmd)
{
   util_dynarray_foreach (&cmd->dummies, struct wg_dummy *, d)
      wg_dummy_unref(*d);
   util_dynarray_clear(&cmd->dummies);
}

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
   free_dummies(cmd);
   util_dynarray_fini(&cmd->push_sets);
   util_dynarray_fini(&cmd->dummies);
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
   util_dynarray_init(&cmd->dummies, NULL);
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
   free_dummies(cmd);
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
      cmd->pass.view_mask = inh->viewMask;
      /* A pass without attachments: the device's in the place wg_CmdBeginRendering gives it (VK3 L8a). */
      bool any = inh->depthAttachmentFormat || inh->stencilAttachmentFormat;
      for (uint32_t i = 0; i < cmd->pass.color_count; i++)
         any |= cmd->pass.colors[i] != VK_FORMAT_UNDEFINED;
      if (!any) {
         if (cmd->pass.color_count == 8)
            cmd->pass.color_count = 7;
         cmd->pass.colors[cmd->pass.color_count] = VK_FORMAT_R8_UNORM;
         cmd->pass.dummy = ++cmd->pass.color_count;
      }
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
   for (uint32_t i = 0; i < count && first + i < WG_VERTEX_BINDINGS; i++) {
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

/* An attachment for a pass that has none (Vulkan's attachment-less passes; WebGPU's need one): an R8 texture of the
 * render area's size and the pipelines' samples, the device's, kept by both (VK3 L7.4: transform feedback's passes have
 * none). Its pipelines write nothing to it (record_draw). The command buffer keeps a reference to it while its passes
 * name it (VK3 L7b, the review of L7.4-L7.5's finding 4: one the device let go of was released under a recorded pass,
 * its id another's). */
static uint32_t
dummy_attachment(struct wg_cmd_buffer *cmd, uint32_t width, uint32_t height, uint32_t samples)
{
   struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
   struct wg_dummy *d = NULL;
   uint32_t free_slot = 0;
   for (uint32_t i = 0; i < 16 && !d; i++) {
      if (dev->dummies[i] && dev->dummies[i]->width == width && dev->dummies[i]->height == height &&
          dev->dummies[i]->samples == samples)
         d = dev->dummies[i];
      else if (!dev->dummies[i] && !free_slot)
         free_slot = i + 1;
   }
   if (!d) {
      const uint32_t i = free_slot ? free_slot - 1 : 15;
      wg_dummy_unref(dev->dummies[i]);
      d = calloc(1, sizeof(*d));
      d->refs = 1;
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":[%u,%u],\"format\":\"r8unorm\",\"sampleCount\":%u,\"usage\":16}", width, height,
                     samples); /* RENDER_ATTACHMENT */
      d->texture = wg_create_json(WG_KIND_TEXTURE, &j);
      wg_json_printf(&j, "{\"texture\":%u}", d->texture);
      d->view = wg_create_json(WG_KIND_VIEW, &j);
      d->width = width, d->height = height, d->samples = samples;
      dev->dummies[i] = d;
   }
   bool held = false;
   util_dynarray_foreach (&cmd->dummies, struct wg_dummy *, h)
      held |= *h == d;
   if (!held) {
      d->refs++;
      util_dynarray_append_typed(&cmd->dummies, struct wg_dummy *, d);
   }
   return d->view;
}

/* A pass without attachments rasterizes at its pipelines' rasterizationSamples (Vulkan: all its pipelines' alike, without
 * variableMultisampleRate), known at its first draw (or a secondary's, by its inheritance): the recorded pass's dummy
 * attachment replaced by one of that many samples (VK3 L8a, the track-end review's finding 3: it stayed at 1 with 4
 * advertised in framebufferNoAttachmentsSampleCounts). */
static void
dummy_samples(struct wg_cmd_buffer *cmd, uint32_t samples)
{
   if (!cmd->pass.dummy_at)
      return;
   const size_t at = cmd->pass.dummy_at;
   cmd->pass.dummy_at = 0;
   if (samples <= 1)
      return;
   char digits[11];
   snprintf(digits, sizeof(digits), "%10u", dummy_attachment(cmd, cmd->pass.width, cmd->pass.height, samples));
   memcpy((char *)cmd->cmds.data + at, digits, 10);
   cmd->pass.samples = samples;
}

/* Whether a view's extent at its level is other than the pass's. */
static bool
other_size(const struct wg_image_view *v, uint32_t width, uint32_t height)
{
   const VkExtent3D e = vk_image_mip_level_extent(v->vk.image, v->vk.base_mip_level);
   return e.width != width || e.height != height;
}

/* An attachment's texture and its crop (wg_view_crop), one way or the other, at the render pass's size: a copy per
 * aspect, of the view's layers (a 3D image's view: its slices). */
static void
crop_copies(struct wg_cmd_buffer *cmd, bool back)
{
   for (uint32_t i = 0; i < cmd->pass.crop_count; i++) {
      const struct wg_image_view *v = cmd->pass.crops[i].view;
      const struct wg_view_crop *c = cmd->pass.crops[i].crop;
      const uint32_t tex = view_texture(v), layer = v->slice >= 0 ? v->slice : v->vk.base_array_layer;
      const uint32_t layers = v->vk.layer_count, mip = v->vk.base_mip_level;
      const bool both = (v->fmt->flags & WG_FMT_DEPTH) && (v->fmt->flags & WG_FMT_STENCIL);
      for (uint32_t a = both ? 1 : 0; a <= (both ? 2u : 0u); a++) {
         struct op_copy_tt op = { .src = back ? c->texture : tex, .src_mip = back ? 0 : mip, .sz = back ? 0 : layer,
                                  .dst = back ? tex : c->texture, .dst_mip = back ? mip : 0, .dz = back ? layer : 0,
                                  .w = c->width, .h = c->height, .d = layers, .aspect = a, .dst_w = c->width,
                                  .dst_h = c->height, .cols = c->width, .rows = c->height, .bytes = v->fmt->bytes };
         emit(cmd, OP_COPY_TT, &op, sizeof(op));
      }
   }
}

/* The pass of `view` (0 without multiview): a pass per view, each view's bit of `mask` (a layered pass's, its index) a
 * layer of each attachment. `views`, with multiview or a layered pass, gathers each view's JSON; the `last_view` call
 * emits them. */
static void
begin_rendering(struct wg_cmd_buffer *cmd, const VkRenderingInfo *info, uint32_t view, struct util_dynarray *views,
                uint32_t mask, bool last_view)
{
   memset(&cmd->pass, 0, sizeof(cmd->pass));
   cmd->pass.active = true;
   /* A pass's colour attachments take their own locations until vkCmdSetRenderingAttachmentLocationsKHR says otherwise. */
   const VkRenderingAttachmentLocationInfoKHR identity = { .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_LOCATION_INFO_KHR,
                                                          .colorAttachmentCount = MESA_VK_MAX_COLOR_ATTACHMENTS };
   if (!(info->flags & VK_RENDERING_RESUMING_BIT))
      vk_cmd_set_rendering_attachment_locations(&cmd->vk, &identity);
   cmd->pass.samples = 1;
   cmd->pass.view_mask = info->viewMask;
   cmd->pass.layer_mask = info->viewMask;
   cmd->pass.layer_count = info->viewMask ? 0 : MIN2(info->layerCount, WG_MAX_LAYERS);
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
   const VkRenderingAttachmentInfo *atts_info[10];
   uint32_t n = 0;
   for (uint32_t i = 0; i < cmd->pass.color_count; i++)
      atts_info[n++] = &info->pColorAttachments[i];
   if (info->pDepthAttachment)
      atts_info[n++] = info->pDepthAttachment;
   if (info->pStencilAttachment)
      atts_info[n++] = info->pStencilAttachment;
   /* The pass's size: the smallest of each; the render area fits every attachment, so it fits that. */
   for (uint32_t i = 0; i < n; i++) {
      VK_FROM_HANDLE(wg_image_view, v, atts_info[i]->imageView);
      if (v) {
         const VkExtent3D e = vk_image_mip_level_extent(v->vk.image, v->vk.base_mip_level);
         width = width ? MIN2(width, e.width) : e.width;
         height = height ? MIN2(height, e.height) : e.height;
         cmd->pass.samples = v->vk.image->samples;
      }
   }
   /* An attachment of another size is drawn in a crop. */
   struct wg_view_crop *crops[10] = { 0 };
   for (uint32_t i = 0; i < n; i++) {
      VK_FROM_HANDLE(wg_image_view, v, atts_info[i]->imageView);
      if (!v || !v->att || !other_size(v, width, height))
         continue;
      crops[i] = wg_view_crop(v, width, height);
      bool known = false;
      for (uint32_t c = 0; c < cmd->pass.crop_count; c++)
         known |= cmd->pass.crops[c].view == v;
      if (!known) {
         cmd->pass.crops[cmd->pass.crop_count].view = v;
         cmd->pass.crops[cmd->pass.crop_count++].crop = crops[i];
      }
   }
#define ATT(i, v) (crops[i] ? wg_crop_att(v, crops[i], view) : wg_view_att(v, view))
   /* No attachments: one of the device's, the render area's size, written by no draw. */
   bool dummy = false;
   if (!width && !height) {
      bool any = false;
      for (uint32_t i = 0; i < n; i++)
         any |= atts_info[i]->imageView != VK_NULL_HANDLE;
      if (!any && area.extent.width && area.extent.height) {
         width = area.offset.x + area.extent.width, height = area.offset.y + area.extent.height;
         dummy = true;
      }
   }
   /* Eight colour attachments, all null: the device's in the last's place (WebGPU's at most 8; VK3 L7b, the review of
    * L7.4-L7.5's finding 6: a ninth overran pass.colors). */
   if (dummy && cmd->pass.color_count == 8)
      cmd->pass.color_count = 7;
   partial = area.offset.x || area.offset.y || area.extent.width < width || area.extent.height < height;
   cmd->pass.area = area;
   /* A pass that suspends or resumes (VK_RENDERING_SUSPENDING_BIT, RESUMING_BIT) is part of one render pass instance
    * with its neighbours: only its first part loads or clears, only its last part stores or discards. */
   const bool resumed = info->flags & VK_RENDERING_RESUMING_BIT, suspending = info->flags & VK_RENDERING_SUSPENDING_BIT;
   cmd->pass.suspending = suspending;
   bool first_clear = true;
   for (uint32_t i = 0; i < cmd->pass.color_count; i++) {
      const VkRenderingAttachmentInfo *a = &info->pColorAttachments[i];
      VK_FROM_HANDLE(wg_image_view, v, a->imageView);
      if (!v || !v->att) {
         wg_json_printf(&j, "%snull", i ? "," : "");
         continue;
      }
      /* NONE keeps the contents as LOAD does (the review's R6: stale bytes stored over a mutable image's). */
      record_attachment_use(cmd, v, (a->loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR || a->loadOp == VK_ATTACHMENT_LOAD_OP_DONT_CARE) &&
                                       !partial && !resumed && !crops[i]);
      cmd->pass.colors[i] = v->vk.format;
      const bool clear = !resumed && a->loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR;
      VkClearColorValue cv;
      wg_clear_color(v->fmt, &a->clearValue.color, &cv);
      const VkClearColorValue *c = &cv;
      char value[160];
      /* The four numbers alone: a clear value's as an array, a clear rect's after the attachment's index. */
      if (v->fmt->flags & WG_FMT_UINT)
         snprintf(value, sizeof(value), "%u,%u,%u,%u", c->uint32[0], c->uint32[1], c->uint32[2], c->uint32[3]);
      else if (v->fmt->flags & WG_FMT_SINT)
         snprintf(value, sizeof(value), "%d,%d,%d,%d", c->int32[0], c->int32[1], c->int32[2], c->int32[3]);
      else
         snprintf(value, sizeof(value), "%.9g,%.9g,%.9g,%.9g", c->float32[0], c->float32[1], c->float32[2],
                  c->float32[3]);
      VK_FROM_HANDLE(wg_image_view, r, a->resolveImageView);
      const bool resolves = r && r->att && a->resolveMode != VK_RESOLVE_MODE_NONE;
      if (resolves)
         record_attachment_use(cmd, r, !partial && !crops[i] && !other_size(r, width, height));
      /* What WebGPU's resolve can't make (a format it doesn't resolve, part of the attachment, a 3D image) is the worker's draw
       * at the pass's end, which reads the attachment: stored. texture-formats-tier1's 16-bit normalized formats render,
       * blend and multisample but don't resolve (VK4 T21: the M4's self_dep_*_ms submits were invalid). */
      const bool drawn = resolves && (!(v->fmt->flags & WG_FMT_BLEND) || (v->fmt->flags & (WG_FMT_FLOAT32 | WG_FMT_TIER1)) || partial ||
                                      r->slice >= 0 || crops[i] || other_size(r, width, height));
      if (drawn) {
         cmd->pass.resolve_color_src[i] = v;
         cmd->pass.resolve_color_dst[i] = r;
      }
      wg_json_printf(&j, "%s{\"view\":%u,\"loadOp\":\"%s\",\"storeOp\":\"%s\",\"clearValue\":[%s]", i ? "," : "",
                     ATT(i, v), load_op(a->loadOp, partial, resumed),
                     drawn || crops[i] ? "store" : store_op(a->storeOp, suspending, partial), value);
      if (v->slice >= 0 && !crops[i])
         wg_json_printf(&j, ",\"depthSlice\":%d", v->slice + (int)view);
      if (resolves && !drawn)
         wg_json_printf(&j, ",\"resolveTarget\":%u", wg_view_att(r, view));
      wg_json_printf(&j, "}");
      /* Dawn cuts a clear value of rgb10a2uint to 8 bits a channel: a draw after it (A2R10G10B10's texture too). */
      const bool wide_clear = !strcmp(v->fmt->name, "rgb10a2uint") &&
                              (c->uint32[0] > 255 || c->uint32[1] > 255 || c->uint32[2] > 255);
      if ((partial || wide_clear) && clear) {
         wg_json_printf(&clears, "%s[%u,%s]", first_clear ? "" : ",", i, value);
         first_clear = false;
         any_clear = true;
      }
   }
   size_t dummy_at = 0;
   if (dummy) {
      /* Its view's id in ten digits (JSON's spaces before a short one), replaced at the first draw (dummy_samples). */
      dummy_at = j.len + (cmd->pass.color_count ? 1 : 0) + strlen("{\"view\":");
      wg_json_printf(&j, "%s{\"view\":%10u,\"loadOp\":\"clear\",\"storeOp\":\"discard\",\"clearValue\":[0,0,0,0]}",
                     cmd->pass.color_count ? "," : "", dummy_attachment(cmd, width, height, 1));
      cmd->pass.colors[cmd->pass.color_count] = VK_FORMAT_R8_UNORM;
      cmd->pass.dummy = cmd->pass.color_count++;
      cmd->pass.dummy++;
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
      uint32_t ds_at = 0;
      while (ds_at < n && atts_info[ds_at]->imageView != wg_image_view_to_handle(ds))
         ds_at++;
      ds_at = MIN2(ds_at, ARRAY_SIZE(crops) - 1);
      wg_json_printf(&j, ",\"depthStencilAttachment\":{\"view\":%u", ATT(ds_at, ds));
      /* Resolves of a multisampled depth or stencil (SAMPLE_ZERO, AVERAGE for depth, MIN, MAX), done at the pass's end. */
      for (uint32_t a = 0; a < 2; a++) {
         const VkRenderingAttachmentInfo *at = a ? s : d;
         VK_FROM_HANDLE(wg_image_view, src, at ? at->imageView : VK_NULL_HANDLE);
         VK_FROM_HANDLE(wg_image_view, dst, at ? at->resolveImageView : VK_NULL_HANDLE);
         if (src && dst && at->resolveMode != VK_RESOLVE_MODE_NONE && src->vk.image->samples > 1 &&
             (flags & (a ? WG_FMT_STENCIL : WG_FMT_DEPTH))) {
            cmd->pass.resolve_src[a] = src;
            cmd->pass.resolve_dst[a] = dst;
            cmd->pass.resolve_mode[a] = at->resolveMode;
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
   /* A draw may read an attachment as an input attachment (`feedback_copies`), or for its depth bounds, logic op or
    * advanced blend (`dst_copies`). */
   struct op_pass_atts atts = { 0 };
   bool any_view = false;
   for (uint32_t i = 0; i < n; i++) {
      VK_FROM_HANDLE(wg_image_view, v, atts_info[i]->imageView);
      if (v && v->slice < 0 && !crops[i]) {
         if (i < cmd->pass.color_count)
            atts.colors[i] = cmd->pass.color_views[i] = v;
         else if (v->vk.aspects & VK_IMAGE_ASPECT_DEPTH_BIT)
            atts.depth = cmd->pass.depth_view = v;
         any_view = true;
      }
      if (!v || !(v->vk.image->usage & (VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT | VK_IMAGE_USAGE_ATTACHMENT_FEEDBACK_LOOP_BIT_EXT)) ||
          v->slice >= 0 || atts.count == 10)
         continue;
      VkImageAspectFlags written = v->vk.aspects;
      if (v->vk.aspects & (VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT)) {
         /* Depth and stencil share a view here: what isn't read-only. */
         written = 0;
         if (cmd->pass.depth && !cmd->pass.depth_ro)
            written |= VK_IMAGE_ASPECT_DEPTH_BIT;
         if (cmd->pass.stencil && !cmd->pass.stencil_ro)
            written |= VK_IMAGE_ASPECT_STENCIL_BIT;
      }
      atts.views[atts.count] = v;
      atts.written[atts.count++] = written;
   }
#undef ATT
   if ((atts.count || any_view) && (!views || last_view))
      emit(cmd, OP_PASS_ATTS, &atts, sizeof(atts));
   if (!views || last_view)
      crop_copies(cmd, false);
   /* Every view's the same without attachments, which the last's stands for (dummy_samples replaces its id). */
   if (views) {
      const bool last = last_view;
      if (dummy && !last) {
         wg_json_free(&j);
         wg_json_free(&clears);
         return;
      }
      if (last)
         emit(cmd, OP_VIEWS, (uint32_t[]){ mask, !info->viewMask, info->viewMask ? util_bitcount(mask) : cmd->pass.layer_count }, 12);
      const size_t at = views->size;
      memcpy(util_dynarray_grow_bytes(views, 1, j.len + 1), j.data, j.len);
      ((char *)views->data)[at + j.len] = 0;
      wg_json_free(&j);
      if (!last) {
         wg_json_free(&clears);
         return;
      }
      char *p = emit(cmd, OP_PASS, NULL, views->size);
      memcpy(p, views->data, views->size);
      if (dummy)
         cmd->pass.dummy_at = (size_t)((uint8_t *)p - (uint8_t *)cmd->cmds.data) + dummy_at;
   } else {
      if (dummy)
         cmd->pass.dummy_at = cmd->cmds.size + sizeof(struct op_head) + dummy_at;
      emit_json(cmd, OP_PASS, &j);
   }
   if (any_clear)
      emit_json(cmd, OP_CLEAR_RECTS, &clears);
   else
      wg_json_free(&clears);
}

/* VK_EXT_multisampled_render_to_single_sampled: a single-sampled attachment of a pass rendering at `samples` is drawn
 * in a multisampled image of its own (wg_view_ms), loaded from it where the load op is LOAD (a draw a sample: the
 * worker's copy into a multisampled texture) and resolved into it at the pass's end, its resolve mode the pass's (the
 * runtime's for a subpass: average, or sample zero for integers), colour by WebGPU's resolve target, depth and stencil
 * by the drawn resolves. The multisampled image is stored, so a suspended pass's parts carry it. */
static void
ms_attachment(struct wg_cmd_buffer *cmd, VkRenderingAttachmentInfo *a, uint32_t samples, bool resuming,
              VkImageView *filled, uint32_t *filled_count, const VkRect2D *area)
{
   VK_FROM_HANDLE(wg_image_view, v, a->imageView);
   if (!v || v->vk.image->samples != 1 || v->slice >= 0 || v->vk.layer_count != 1)
      return;
   struct wg_image_view *ms = wg_view_ms(v, samples);
   /* A format WebGPU can't multisample: no draw of the pass may write it (its formats' sample counts say so), so the
    * pass goes without it, which keeps what it holds (a pass may name attachments only another pass draws). */
   if (!ms) {
      /* Its clear, outside the pass: of the whole subresource, where the render area covers it. */
      const VkExtent3D e = vk_image_mip_level_extent(v->vk.image, v->vk.base_mip_level);
      if (a->loadOp == VK_ATTACHMENT_LOAD_OP_CLEAR && !resuming && !area->offset.x && !area->offset.y &&
          area->extent.width >= e.width && area->extent.height >= e.height) {
         const VkImageSubresourceRange range = { VK_IMAGE_ASPECT_COLOR_BIT, v->vk.base_mip_level, 1,
                                                 v->vk.base_array_layer, v->vk.layer_count };
         wg_CmdClearColorImage(wg_cmd_buffer_to_handle(cmd), vk_image_to_handle(v->vk.image), VK_IMAGE_LAYOUT_GENERAL,
                               &a->clearValue.color, 1, &range);
      }
      a->imageView = VK_NULL_HANDLE;
      a->resolveImageView = VK_NULL_HANDLE;
      a->resolveMode = VK_RESOLVE_MODE_NONE;
      return;
   }
   bool done = false;
   for (uint32_t i = 0; i < *filled_count; i++)
      done |= filled[i] == a->imageView;
   if (a->loadOp == VK_ATTACHMENT_LOAD_OP_LOAD && !resuming && !done) {
      const VkExtent3D e = vk_image_mip_level_extent(v->vk.image, v->vk.base_mip_level);
      const struct op_copy_tt op = { .src = view_texture(v), .src_mip = v->vk.base_mip_level, .sz = v->vk.base_array_layer,
                                     .dst = view_texture(ms), .w = e.width, .h = e.height, .d = 1, .dst_w = e.width,
                                     .dst_h = e.height, .cols = e.width, .rows = e.height, .bytes = v->fmt->bytes };
      emit(cmd, OP_COPY_TT, &op, sizeof(op));
      filled[(*filled_count)++] = a->imageView;
   }
   if (a->resolveMode == VK_RESOLVE_MODE_NONE)
      a->resolveMode = vk_format_is_int(v->vk.format) || vk_format_is_depth_or_stencil(v->vk.format)
                          ? VK_RESOLVE_MODE_SAMPLE_ZERO_BIT : VK_RESOLVE_MODE_AVERAGE_BIT;
   a->resolveImageView = a->imageView;
   a->resolveImageLayout = a->imageLayout;
   a->imageView = wg_image_view_to_handle(ms);
   a->storeOp = VK_ATTACHMENT_STORE_OP_STORE;
}

static void begin_rendering_views(struct wg_cmd_buffer *cmd, const VkRenderingInfo *info);
VKAPI_ATTR void VKAPI_CALL wg_CmdClearColorImage(VkCommandBuffer commandBuffer, VkImage _image, VkImageLayout layout,
                                                 const VkClearColorValue *color, uint32_t count,
                                                 const VkImageSubresourceRange *ranges);

VKAPI_ATTR void VKAPI_CALL
wg_CmdBeginRendering(VkCommandBuffer commandBuffer, const VkRenderingInfo *info)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   const VkMultisampledRenderToSingleSampledInfoEXT *ms =
      vk_find_struct_const(info->pNext, MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_INFO_EXT);
   if (!ms || !ms->multisampledRenderToSingleSampledEnable || ms->rasterizationSamples <= 1) {
      begin_rendering_views(cmd, info);
      return;
   }
   VkRenderingInfo r = *info;
   VkRenderingAttachmentInfo colors[MESA_VK_MAX_COLOR_ATTACHMENTS], depth, stencil;
   VkImageView filled[MESA_VK_MAX_COLOR_ATTACHMENTS + 2];
   uint32_t filled_count = 0;
   const bool resuming = info->flags & VK_RENDERING_RESUMING_BIT;
   r.colorAttachmentCount = MIN2(info->colorAttachmentCount, MESA_VK_MAX_COLOR_ATTACHMENTS);
   for (uint32_t i = 0; i < r.colorAttachmentCount; i++) {
      colors[i] = info->pColorAttachments[i];
      ms_attachment(cmd, &colors[i], ms->rasterizationSamples, resuming, filled, &filled_count, &info->renderArea);
   }
   r.pColorAttachments = colors;
   if (info->pDepthAttachment) {
      depth = *info->pDepthAttachment;
      ms_attachment(cmd, &depth, ms->rasterizationSamples, resuming, filled, &filled_count, &info->renderArea);
      r.pDepthAttachment = &depth;
   }
   if (info->pStencilAttachment) {
      stencil = *info->pStencilAttachment;
      ms_attachment(cmd, &stencil, ms->rasterizationSamples, resuming, filled, &filled_count, &info->renderArea);
      r.pStencilAttachment = &stencil;
   }
   begin_rendering_views(cmd, &r);
}

static void
begin_rendering_views(struct wg_cmd_buffer *cmd, const VkRenderingInfo *info)
{
   /* Layers without multiview: no draw reaches past the first (nothing writes gl_Layer), but load ops, store ops and
    * vkCmdClearAttachments do, so the pass replays a layer at a time, as multiview's does. */
   const uint32_t layers = MIN2(info->layerCount, WG_MAX_LAYERS);
   const uint32_t mask = info->viewMask ? info->viewMask : layers > 1 ? BITFIELD_MASK(MIN2(layers, 32)) : 0;
   if (!mask) {
      begin_rendering(cmd, info, 0, NULL, 0, true);
      return;
   }
   struct util_dynarray views;
   util_dynarray_init(&views, NULL);
   if (info->viewMask) {
      u_foreach_bit(view, mask)
         begin_rendering(cmd, info, view, &views, mask, view == (uint32_t)util_last_bit(mask) - 1);
   } else {
      for (uint32_t layer = 0; layer < layers; layer++)
         begin_rendering(cmd, info, layer, &views, mask, layer == layers - 1);
   }
   util_dynarray_fini(&views);
}

static void meta(struct wg_cmd_buffer *cmd, struct wg_json *j);

static void
end_rendering(struct wg_cmd_buffer *cmd)
{
   if (!cmd->pass.active)
      return;
   emit(cmd, OP_PASS_END, NULL, 0);
   cmd->pass.active = false;
   crop_copies(cmd, true);
   forget(cmd);
   /* A suspended pass's resolves are its last part's, each layer's. */
   uint32_t layer_list[WG_MAX_LAYERS], layer_total = 0;
   if (cmd->pass.layer_mask) {
      u_foreach_bit(l, cmd->pass.layer_mask)
         layer_list[layer_total++] = l;
   } else {
      for (; layer_total < MAX2(cmd->pass.layer_count, 1); layer_total++)
         layer_list[layer_total] = layer_total;
   }
   for (uint32_t a = 0; a < 8 && !cmd->pass.suspending; a++) {
      const struct wg_image_view *src = cmd->pass.resolve_color_src[a], *dst = cmd->pass.resolve_color_dst[a];
      if (!src)
         continue;
      const VkRect2D *ra = &cmd->pass.area;
      for (uint32_t k = 0; k < layer_total; k++) {
         const uint32_t l = layer_list[k];
         struct wg_json j = { 0 };
         wg_json_printf(&j, "{\"op\":\"resolve\",\"src\":%u,\"srcMip\":%u,\"srcLayer\":%u,\"dst\":%u,\"dstMip\":%u,"
                        "\"dstLayer\":%u,\"format\":\"%s\",\"srcFormat\":\"%s\",\"from\":[%d,%d],\"to\":[%d,%d],\"size\":[%u,%u]}",
                        view_texture(src), src->vk.base_mip_level, src->vk.base_array_layer + l, view_texture(dst),
                        dst->vk.base_mip_level,
                        (dst->slice >= 0 ? dst->slice : dst->vk.base_array_layer) + l, dst->fmt->name, src->fmt->name, ra->offset.x,
                        ra->offset.y, ra->offset.x, ra->offset.y, ra->extent.width, ra->extent.height);
         meta(cmd, &j);
      }
   }
   for (uint32_t a = 0; a < 2 && !cmd->pass.suspending; a++) {
      const struct wg_image_view *src = cmd->pass.resolve_src[a], *dst = cmd->pass.resolve_dst[a];
      if (!src)
         continue;
      const struct wg_image *si = container_of(src->vk.image, struct wg_image, vk);
      const struct wg_image *di = container_of(dst->vk.image, struct wg_image, vk);
      const VkRect2D *ra = &cmd->pass.area;
      for (uint32_t k = 0; k < layer_total; k++) {
         const uint32_t l = layer_list[k];
         struct wg_json j = { 0 };
         /* Within the render area only. */
         const VkResolveModeFlagBits m = cmd->pass.resolve_mode[a];
         wg_json_printf(&j, "{\"op\":\"resolveDepth\",\"aspect\":\"%s\",\"mode\":\"%s\",\"format\":\"%s\",\"src\":%u,\"srcMip\":%u,"
                        "\"srcLayer\":%u,\"dst\":%u,\"dstMip\":%u,\"dstLayer\":%u,\"area\":[%d,%d,%u,%u]}",
                        a ? "stencil" : "depth",
                        m == VK_RESOLVE_MODE_MIN_BIT       ? "min"
                        : m == VK_RESOLVE_MODE_MAX_BIT     ? "max"
                        : m == VK_RESOLVE_MODE_AVERAGE_BIT ? "average"
                                                           : "zero",
                        di->fmt->name, si->tex, src->vk.base_mip_level,
                        src->vk.base_array_layer + l, di->tex, dst->vk.base_mip_level, dst->vk.base_array_layer + l,
                        ra->offset.x, ra->offset.y, ra->extent.width, ra->extent.height);
         meta(cmd, &j);
      }
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

static void
clear_rects(struct wg_cmd_buffer *cmd, uint32_t count, const VkClearAttachment *atts, uint32_t rect_count,
            const VkClearRect *rects)
{
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
      VkClearColorValue cv = atts[i].clearValue.color;
      if (f)
         wg_clear_color(f, &atts[i].clearValue.color, &cv);
      const VkClearColorValue *c = &cv;
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
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdClearAttachments(VkCommandBuffer commandBuffer, uint32_t count, const VkClearAttachment *atts,
                       uint32_t rect_count, const VkClearRect *rects)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   /* Rects of one range of layers together (each OP_CLEAR_RECTS cuts an occlusion query); a secondary doesn't know
    * the pass's layers, so the range always goes with them. */
   for (uint32_t r = 0, n; r < rect_count; r += n) {
      for (n = 1; r + n < rect_count && rects[r + n].baseArrayLayer == rects[r].baseArrayLayer &&
                  rects[r + n].layerCount == rects[r].layerCount; n++)
         ;
      emit(cmd, OP_CLEAR_LAYERS, (uint32_t[]){ rects[r].baseArrayLayer, rects[r].layerCount }, 8);
      clear_rects(cmd, count, atts, n, &rects[r]);
   }
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
      /* A variant with storage aliases binds what a group holds otherwise: its layout's uid doesn't say so. */
      const struct wg_program *aliased = p->alias_count ? p : NULL;
      if (!memcmp(cmd->last_sets[point][g], b.sets, sizeof(b.sets)) && cmd->last_bgl[point][g] == p->bgl_uid[g] &&
          cmd->last_aliased[point][g] == aliased && !memcmp(cmd->last_dynamic[point][g], b.offsets, b.offset_count * 4))
         continue;
      cmd->last_aliased[point][g] = aliased;
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

/* The bytes [lo, hi) of its memory a buffer resource of a program is bound to at `point`, at the dynamic offset bound
 * now. */
static void
resource_range(const struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, uint32_t k,
               VkDeviceSize *lo, VkDeviceSize *hi)
{
   const int s = p->res_set[k];
   const struct wg_descriptor *d = &cmd->sets[point][s].set->slots[p->resources[k].binding / 2 - p->set_base[s]];
   if (d->type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) {
      *lo = d->texel->at;
      *hi = *lo + d->texel->size;
      return;
   }
   *lo = d->buffer->offset + d->offset + (p->dynamic[k] >= 0 ? cmd->sets[point][s].dynamic[p->dynamic[k]] : 0);
   *hi = *lo + vk_buffer_range(&d->buffer->vk, d->offset, d->range);
}

/* The program to draw or dispatch with: a variant where a texture the shader declared filterable float is bound to a
 * view WebGPU can't filter (a depth view, r32float without float32-filterable), or where a dispatch's read-only
 * storage buffer is bound from a memory one of its writable storage buffers is bound from too, apart from it. Each
 * VkDeviceMemory is one GPUBuffer, and WebGPU's usage scope (a dispatch's) lets writable storage share a buffer only
 * with more writable storage: such a binding is "storage" in the variant's layout (WebGPU takes it for the shader's
 * `read`), which costs nothing, where the replay would copy it (`scope_dispatch`). Not where their ranges overlap:
 * WebGPU refuses two writable bindings of one range ("Writable storage buffer binding aliasing"), so that one stays
 * read-only and is copied. */

/* The descriptor at a program's (group, binding) index, among the sets bound. */
static const struct wg_descriptor *
pair_descriptor(struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, uint32_t index)
{
   const uint32_t group = index >> 16, at = (index & 0xffff) / 2;
   const struct wg_descriptor *d = NULL;
   for (uint32_t s = 0; s < p->set_count; s++) {
      const struct wg_descriptor_set *set = cmd->sets[point][s].set;
      if (p->set_group[s] == group && p->set_base[s] <= at && set && at - p->set_base[s] < set->layout->slot_count)
         d = &set->slots[at - p->set_base[s]];
   }
   return d;
}

/* The border as the shader reads it: Vulkan's colour, what the format lacks as "Conversion to RGBA" says, through the
 * view's mapping (WebGPU's view applies it to the texels; the border is mixed in after, so it takes it here). */
static void
sampler_border(const struct wg_image_view *view, const struct wg_sampler *sampler, bool integer, uint32_t *out)
{
   static const uint8_t colours[][4] = {
      [VK_BORDER_COLOR_FLOAT_TRANSPARENT_BLACK] = { 0, 0, 0, 0 }, [VK_BORDER_COLOR_INT_TRANSPARENT_BLACK] = { 0, 0, 0, 0 },
      [VK_BORDER_COLOR_FLOAT_OPAQUE_BLACK] = { 0, 0, 0, 1 },      [VK_BORDER_COLOR_INT_OPAQUE_BLACK] = { 0, 0, 0, 1 },
      [VK_BORDER_COLOR_FLOAT_OPAQUE_WHITE] = { 1, 1, 1, 1 },      [VK_BORDER_COLOR_INT_OPAQUE_WHITE] = { 1, 1, 1, 1 },
   };
   const uint32_t one = integer ? 1 : 0x3f800000u;
   const bool custom = vk_border_color_is_custom(sampler->vk.border_color);
   const uint8_t *c = colours[custom ? 0 : sampler->vk.border_color];
   /* Mesa has no pipe format of R4G4: R8G8's channels are its. */
   const VkFormat vf = view->vk.view_format == VK_FORMAT_R4G4_UNORM_PACK8 ? VK_FORMAT_R8G8_UNORM : view->vk.view_format;
   const struct util_format_description *d = vk_format_description(vf);
   const bool zs = view->vk.aspects & (VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT);
   uint32_t have[6];
   for (uint32_t i = 0; i < 4; i++) {
      const uint32_t s = zs ? (i == 0 ? PIPE_SWIZZLE_X : i == 3 ? PIPE_SWIZZLE_1 : PIPE_SWIZZLE_0) : d->swizzle[i];
      have[i] = s > PIPE_SWIZZLE_W ? (s == PIPE_SWIZZLE_1 ? one : 0)
                : custom           ? sampler->vk.border_color_value.uint32[i]
                                   : c[i] * one;
   }
   have[4] = 0, have[5] = one;
   const VkComponentSwizzle mapping[4] = { view->vk.swizzle.r, view->vk.swizzle.g, view->vk.swizzle.b, view->vk.swizzle.a };
   for (uint32_t i = 0; i < 4; i++)
      out[i] = have[mapping[i] == VK_COMPONENT_SWIZZLE_ZERO  ? 4
                    : mapping[i] == VK_COMPONENT_SWIZZLE_ONE ? 5
                    : mapping[i] >= VK_COMPONENT_SWIZZLE_R   ? mapping[i] - VK_COMPONENT_SWIZZLE_R
                                                             : i];
}

static void
padded_key_fill(const struct wg_image_view *view, struct wgsl_sampler_key *key)
{
   key->padded = 1;
   key->faces = view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE || view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY;
   key->size[0] = view->vk.extent.width;
   key->size[1] = view->vk.extent.height;
   key->size[2] = view->vk.extent.depth;
   key->levels = MIN2(view->vk.level_count, 255);
}

/* What the sampler needs of the shader for a (texture, sampler) pair (false: nothing). An integer texture is fetched at
 * clamp-to-edge from the level its LOD selects unless a key says otherwise. */
static bool
pair_key(struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, const uint32_t *pair, bool integer,
         bool must, struct wgsl_sampler_key *key)
{
   const struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
   const struct wg_descriptor *s = pair_descriptor(cmd, point, p, pair[1]);
   const struct wg_sampler *sampler = s ? s->sampler : NULL;
   const struct wg_descriptor *t = pair_descriptor(cmd, point, p, pair[0]);
   const struct wg_image_view *view = t ? t->view : NULL;
   /* An op that needs a key whatever the sampler (wgsl_info.key_pairs). */
   bool forced = must, faces = false;
   for (uint32_t i = 0; view && i < p->key_pair_count; i++)
      if (p->key_pairs[i][0] == pair[0] && p->key_pairs[i][1] == pair[1]) {
         forced |= (p->key_pairs[i][2] & WGSL_KEY_ALWAYS) || view->vk.level_count > 1;
         faces = p->key_pairs[i][2] & WGSL_KEY_FACES;
      }
   /* An E5B9G9R9 view of words (VK4 T23) is sampled from fetches, as a padded one is. */
   const bool padded = view && view->padded, words = view && view->rgb9e5;
   const bool cube = view && (view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE || view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY);
   /* A non-seamless cube's linear filter (VK4 T28): from its faces' fetches; a comparing one's too, each texel compared
    * (VK4 T38: the shadow cases, open since depth formats report comparison). */
   const bool non_seamless = sampler && cube && !integer && sampler->key.non_seamless;
   /* A depth view's linear filter without a comparison (VK4 T42): from fetches (WebGPU filters depth only by comparing;
    * its binding takes the sampler's nearest twin), a cube's of its faces. */
   const bool fetched = sampler && view && !integer && !sampler->compare && (view->vk.aspects & VK_IMAGE_ASPECT_DEPTH_BIT) &&
                        (sampler->key.mag_linear || sampler->key.min_linear || sampler->key.mip_linear) && !sampler->key.reduction;
   if (!sampler || !view || (!integer && !sampler->emulated && !padded && !words && !forced && !non_seamless && !fetched))
      return false;
   const struct wgsl_sampler_key *k = &sampler->key;
   if (integer && !sampler->emulated && !padded && !forced && k->address[0] == WGSL_ADDRESS_EDGE && k->address[1] == WGSL_ADDRESS_EDGE &&
       k->address[2] == WGSL_ADDRESS_EDGE && k->min_lod <= 0.0f && k->max_lod >= view->vk.level_count - 1.0f)
      return false;
   *key = *k;
   key->texture = pair[0];
   key->sampler = pair[1];
   key->levels = MIN2(view->vk.level_count, 255);
   /* A depth view filters what a comparison gives; a reduction is the shader's filter, from fetches, which any format
    * takes, integers too (VK4 T25: Vulkan's linear filter of one is min/max only). An integer texture's is otherwise
    * nearest. */
   if ((!wg_format_filterable(view->fmt) && !sampler->compare && !k->reduction && !fetched) || (integer && !k->reduction))
      key->mag_linear = key->min_linear = key->mip_linear = 0;
   key->fetched = fetched;
   key->faces |= fetched && cube;
   /* WGSL can't fetch from a cube: a reduced one is sampled from its faces. */
   key->faces |= key->reduction && (view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE ||
                                    view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY);
   sampler_border(view, sampler, integer, key->border);
   if (padded)
      padded_key_fill(view, key);
   key->rgb9e5 = words;
   /* `must`: a pair of a cube another pair binds as its faces. */
   key->faces |= faces || must;
   key->non_seamless = non_seamless;
   key->faces |= non_seamless;
   if (sampler->compare) {
      key->clamp_dref = view->vk.view_format != VK_FORMAT_D32_SFLOAT && view->vk.view_format != VK_FORMAT_D32_SFLOAT_S8_UINT;
      /* WGSL can't fetch from a cube: past level 0 one is sampled from its faces. */
      key->faces |= view->vk.level_count > 1 && (view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE ||
                                                 view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY);
   }
   return true;
}

static bool
dev_padded(const struct wg_cmd_buffer *cmd)
{
   return container_of(cmd->vk.base.device, struct wg_device, vk)->padded_views;
}

/* The keys of a program's pairs at this draw or dispatch (`keys` has room for all of them). */
static uint32_t
program_keys(struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, struct wgsl_sampler_key *keys)
{
   uint32_t n = 0;
   for (uint32_t i = 0; i < p->pair_count; i++) {
      /* A gathered integer texture is in both lists, as the integer it is. */
      bool integer = false;
      for (uint32_t k = 0; k < p->int_pair_count; k++)
         integer |= p->int_pairs[k][0] == p->pairs[i][0] && p->int_pairs[k][1] == p->pairs[i][1];
      if (!integer)
         n += pair_key(cmd, point, p, p->pairs[i], false, false, &keys[n]);
   }
   for (uint32_t i = 0; i < p->int_pair_count; i++)
      n += pair_key(cmd, point, p, p->int_pairs[i], true, false, &keys[n]);
   /* Pairs no sampler is declared for but an op's: a LOD query's. */
   for (uint32_t i = 0; i < p->key_pair_count; i++) {
      bool keyed = false;
      for (uint32_t k = 0; k < n; k++)
         keyed |= keys[k].texture == p->key_pairs[i][0] && keys[k].sampler == p->key_pairs[i][1];
      const struct wg_descriptor *t = pair_descriptor(cmd, point, p, p->key_pairs[i][0]);
      if (!keyed && t && t->view)
         n += pair_key(cmd, point, p, p->key_pairs[i], vk_format_is_int(t->view->vk.view_format), false, &keys[n]);
   }
   /* A cube bound as its faces is fetched by every pair of it, each with its own sampler's state. */
   for (uint32_t i = 0; i < p->pair_count; i++) {
      bool bound = false, keyed = false;
      for (uint32_t k = 0; k < n; k++) {
         bound |= keys[k].texture == p->pairs[i][0] && keys[k].faces;
         keyed |= keys[k].texture == p->pairs[i][0] && keys[k].sampler == p->pairs[i][1];
      }
      if (bound && !keyed)
         n += pair_key(cmd, point, p, p->pairs[i], false, true, &keys[n]);
   }
   /* A padded texture only asked its size: what it answers is the image's. An E5B9G9R9 view of words only fetched or
    * asked its size: its fetches decoded, its binding the words'. */
   const struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
   for (uint32_t k = 0; dev->padded_views && k < p->resource_count; k++) {
      const uint32_t index = (uint32_t)p->resources[k].group << 16 | p->resources[k].binding;
      if (p->resources[k].kind != WGSL_TEXTURE)
         continue;
      const struct wg_descriptor *t = pair_descriptor(cmd, point, p, index);
      if (!t || !t->view || (!t->view->padded && !t->view->rgb9e5))
         continue;
      bool keyed = false;
      for (uint32_t i = 0; i < n; i++)
         keyed |= keys[i].texture == index;
      if (keyed)
         continue;
      memset(&keys[n], 0, sizeof(keys[n]));
      keys[n].texture = index;
      keys[n].sampler = WGSL_NO_SAMPLER;
      if (t->view->padded)
         padded_key_fill(t->view, &keys[n]);
      keys[n++].rgb9e5 = t->view->rgb9e5;
   }
   /* A storage image declared without a format: the bound view's (GD G5, wgsl_print.c `image_format`). And one with a
    * declared format bound to a view of another (sRGB aside: no storage image is), the view's too (GD G7: Godot's
    * screen-space effects write r8 views of images their stages declare rgba8; VK4 T37: read ones, dEQP-VK's
    * image.mismatched_formats; WebGPU refuses the bind group). */
   for (uint32_t k = 0; k < p->resource_count; k++) {
      if (!wgsl_image_keyed(&p->resources[k]))
         continue;
      const uint32_t index = (uint32_t)p->resources[k].group << 16 | p->resources[k].binding;
      const struct wg_descriptor *t = pair_descriptor(cmd, point, p, index);
      if (!t || !t->view)
         continue;
      if (!p->resources[k].formatless &&
          util_format_linear(vk_format_to_pipe_format(t->view->vk.view_format)) == util_format_linear(p->resources[k].format))
         continue;
      memset(&keys[n], 0, sizeof(keys[n]));
      keys[n].texture = index;
      keys[n].sampler = WGSL_IMAGE_KEY;
      keys[n++].format = (uint16_t)vk_format_to_pipe_format(t->view->vk.view_format);
   }
   /* A 2D view of a 3D image, sampled or storage (VK_EXT_image_2d_view_of_3d): its binding the level's 3D view, the
    * slice the shader's (wgsl_sampler.c `lower_slice`). */
   for (uint32_t k = 0; dev->slice_views && k < p->resource_count; k++) {
      const struct wgsl_resource *r = &p->resources[k];
      if ((r->kind != WGSL_TEXTURE && r->kind != WGSL_STORAGE_TEXTURE && !r->image_words) || r->dim != WGSL_DIM_2D)
         continue;
      const uint32_t index = (uint32_t)r->group << 16 | r->binding;
      const struct wg_descriptor *t = pair_descriptor(cmd, point, p, index);
      if (!t || !t->view || t->view->vk.image->image_type != VK_IMAGE_TYPE_3D ||
          t->view->vk.view_type == VK_IMAGE_VIEW_TYPE_3D)
         continue;
      memset(&keys[n], 0, sizeof(keys[n]));
      keys[n].texture = index;
      keys[n].sampler = WGSL_SLICE_KEY;
      keys[n].size[0] = u_minify(t->view->vk.image->extent.depth, t->view->vk.base_mip_level);
      keys[n++].size[2] = t->view->vk.base_array_layer;
   }
   return n;
}

/*
 * Writable storage buffers of one draw or dispatch whose ranges overlap, which WebGPU refuses ("Writable storage buffer
 * binding aliasing"), the two of them being one memory's GPUBuffer. Vulkan lets them: a shader that views one range
 * through two blocks. Each run of overlapping ranges becomes one binding, the lowest's widened over all of them, and
 * the others' accesses go through it (`wg_storage_alias`, wg_shader.c `aliased_text`). A shader's atomics are of its
 * array's type, so a run of atomic and plain arrays, or of signed and unsigned ones, or one past
 * maxStorageBufferBindingSize, can't be one: its draw or dispatch is refused, said once (`aliases_refused`; WebGPU refused
 * it, the submit lost, before VK4 T37).
 */
static uint32_t
storage_aliases(struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, struct wg_storage_alias *out,
                const uint64_t *skip)
{
   struct run { uint32_t k; VkDeviceSize lo, hi; const struct wg_device_memory *mem; } runs[8];
   uint32_t n = 0, count = 0;
   cmd->aliases_refused = false;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *r = &p->resources[k];
      if (r->kind != WGSL_STORAGE || r->image_words || wgsl_address_region(r->group, r->binding) >= 0 ||
          (skip[k / 64] & (1ull << (k % 64))))
         continue;
      const struct wg_device_memory *mem = resource_memory(cmd, point, p, k);
      const int s = p->res_set[k];
      if (!mem || n == ARRAY_SIZE(runs) || s < 0)
         continue;
      const VkDescriptorType type = cmd->sets[point][s].set->slots[r->binding / 2 - p->set_base[s]].type;
      if (type != VK_DESCRIPTOR_TYPE_STORAGE_BUFFER && type != VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC)
         continue;
      /* In order of memory and start. */
      VkDeviceSize lo, hi;
      resource_range(cmd, point, p, k, &lo, &hi);
      uint32_t at = n++;
      for (; at && (runs[at - 1].mem > mem || (runs[at - 1].mem == mem && runs[at - 1].lo > lo)); at--)
         runs[at] = runs[at - 1];
      runs[at] = (struct run){ k, lo, hi, mem };
   }
   for (uint32_t i = 0; i < n;) {
      const struct wgsl_resource *first = &p->resources[runs[i].k];
      VkDeviceSize reach = runs[i].hi;
      uint32_t last = i + 1;
      bool mixed = false;
      for (; last < n && runs[last].mem == runs[i].mem && runs[last].lo < reach; last++) {
         reach = MAX2(reach, runs[last].hi);
         mixed |= p->resources[runs[last].k].atomic != first->atomic ||
                  p->resources[runs[last].k].signed_atomic != first->signed_atomic;
      }
      const bool wide = align64(reach - runs[i].lo, 4) > wg_limits.max_storage_buffer_binding_size;
      if (last > i + 1 && (mixed || wide)) {
         static bool warned;
         if (!warned)
            fprintf(stderr, "wg: a draw or dispatch refused: writable storage bindings of one range that can't be one "
                            "binding (%s)\n", mixed ? "an array of atomics and one not" : "past maxStorageBufferBindingSize");
         warned = true;
         cmd->aliases_refused = true;
      } else if (last > i + 1) {
         for (uint32_t j = i; j < last; j++)
            out[count++] = (struct wg_storage_alias){ (uint32_t)p->resources[runs[j].k].group << 16 | p->resources[runs[j].k].binding,
                                                      (uint32_t)first->group << 16 | first->binding,
                                                      (uint32_t)(runs[j].lo - runs[i].lo), (uint32_t)(runs[j].hi - runs[j].lo),
                                                      j == i ? align((uint32_t)(reach - runs[i].lo), 4) : 0 };
      }
      i = last;
   }
   return count;
}

static bool buffer_binding(const struct wg_program *p, uint32_t k, const struct wg_descriptor *d, uint32_t *buffer,
                           VkDeviceSize *at, VkDeviceSize *size);

/* The memory a shareable descriptor's words are of (NULL: none, as an inline uniform block's), if the whole of it is a
 * binding WebGPU takes (`wg_share.whole`). */
static const struct wg_device_memory *
whole_memory(const struct wg_descriptor *d)
{
   const struct wg_device_memory *mem =
      d->type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER
         ? (d->texel ? d->texel->mem : NULL)
      : d->type == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER ? (d->buffer ? d->buffer->mem : NULL)
                                                     : NULL;
   return mem && align64(mem->size, 4) <= wg_limits.max_storage_buffer_binding_size &&
                !(mem->gpu_at % wg_limits.min_storage_buffer_offset_alignment)
             ? mem
             : NULL;
}

/*
 * A program whose words fit only shared (wg_caps.c `wg_bindings_fit`'s `shares`, VK4 T40: dEQP-VK's descriptorset_random
 * binds a stage's texel buffers and uniform buffers from one buffer): the words a stage reads of texel buffers and of
 * uniform buffers read as storage (`wg_shareable`) read through one binding a memory, the whole of it (`whole`), in every
 * group; or, where the memory is past what a binding takes (or isn't one: inline uniform blocks), those of a GPUBuffer
 * in a group, in runs of their places that a binding reaches (maxStorageBufferBindingSize). Each run reads through its
 * first resource's binding (`wg_share`). The variant is keyed by who shares with whom, not by the places, which the
 * parameter table carries (`param_table`). The resources in `out`, by resource index; `shared` their bits.
 */
static uint32_t
shared_words(struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, struct wg_share *out, uint64_t *shared)
{
   struct word { uint32_t k, buffer, group; VkDeviceSize lo, hi; const struct wg_device_memory *mem; } words[WGSL_MAX_RESOURCES];
   uint32_t n = 0, count = 0;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const int s = p->res_set[k];
      const struct wg_descriptor_set *set = s >= 0 ? cmd->sets[point][s].set : NULL;
      const uint32_t slot = p->resources[k].binding / 2 - (s >= 0 ? p->set_base[s] : 0);
      if (!set || slot >= set->layout->slot_count || !wg_shareable(p, k, set->slots[slot].type))
         continue;
      uint32_t buffer;
      VkDeviceSize at, size;
      if (!buffer_binding(p, k, &set->slots[slot], &buffer, &at, &size) || !buffer)
         continue;
      const struct wg_device_memory *mem = whole_memory(&set->slots[slot]);
      /* By memory (the whole ones across groups) or group and buffer, then place. */
      const struct word w = { k, buffer, mem ? 0 : p->resources[k].group + 1u, at, at + size, mem };
#define BEFORE(x, y) ((x).group != (y).group ? (x).group < (y).group : (x).mem != (y).mem ? (uintptr_t)(x).mem < (uintptr_t)(y).mem \
                      : (x).buffer != (y).buffer ? (x).buffer < (y).buffer : (x).lo < (y).lo)
      uint32_t i = n++;
      for (; i && BEFORE(w, words[i - 1]); i--)
         words[i] = words[i - 1];
#undef BEFORE
      words[i] = w;
   }
   for (uint32_t i = 0; i < n;) {
      uint32_t last = i + 1, to = words[i].k;
      VkDeviceSize hi = words[i].hi;
      const bool whole = words[i].mem;
      for (; last < n && words[last].group == words[i].group && words[last].mem == words[i].mem &&
             words[last].buffer == words[i].buffer &&
             (whole || MAX2(hi, words[last].hi) - words[i].lo <= (wg_limits.max_storage_buffer_binding_size & ~3ull));
           last++)
         hi = MAX2(hi, words[last].hi), to = MIN2(to, words[last].k);
      for (uint32_t j = i; last > i + 1 && j < last; j++) {
         const uint32_t k = words[j].k;
         out[count++] = (struct wg_share){ (uint32_t)p->resources[k].group << 16 | p->resources[k].binding,
                                           (uint32_t)p->resources[to].group << 16 | p->resources[to].binding,
                                           p->res_set[k], whole, { 0, 0 } };
         shared[k / 64] |= 1ull << (k % 64);
      }
      i = last;
   }
   /* In resource order: the variant's key. */
   for (uint32_t i = 1; i < count; i++)
      for (uint32_t j = i; j && out[j - 1].res > out[j].res; j--) {
         const struct wg_share t = out[j];
         out[j] = out[j - 1];
         out[j - 1] = t;
      }
   return count;
}

/*
 * Storage buffers of address memory beside the pointers' binding of their region (VK4 T41's follow-up, the review of R1
 * to R4's W2). The pointers' binding is the region's whole GPUBuffer, and WebGPU refuses a writable binding overlapping
 * another of its buffer in one draw or dispatch, so such a descriptor went to a shadow copied back at the scope's end:
 * neither saw what the other wrote, and the copy back undid what the pointers wrote in its range. Each reads and writes
 * through the pointers' binding instead (`wg_share`, WG_SHARE_ADDRESS: its place and length in its group's parameter
 * table, so the variant is keyed by who, not where): a writable one, or a read one beside pointers that write; of the
 * fragment stage or a dispatch, which declares the pointers' binding, of the same atomics (a read-only one widened where
 * a writable descriptor needs it, if no vertex stage sees it). Not a dynamic one, whose place would change under its
 * bind group. The others go to shadows as before. The resources in `out`, by resource index; `shared` their bits.
 */
static uint32_t
address_shares(struct wg_cmd_buffer *cmd, uint32_t point, const struct wg_program *p, struct wg_share *out,
               uint64_t *shared)
{
   const struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
   const uint8_t stage = point ? 4 : 2; /* GPUShaderStage: compute, fragment */
   uint32_t count = 0;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *r = &p->resources[k];
      const int s = p->res_set[k];
      if ((r->kind != WGSL_STORAGE && r->kind != WGSL_STORAGE_READ) || r->image_words || s < 0 || p->dynamic[k] != -1 ||
          p->vis[k] != stage || (shared[k / 64] & (1ull << (k % 64))))
         continue;
      const struct wg_descriptor_set *set = cmd->sets[point][s].set;
      const uint32_t slot = r->binding / 2 - p->set_base[s];
      if (!set || slot >= set->layout->slot_count || set->slots[slot].type != VK_DESCRIPTOR_TYPE_STORAGE_BUFFER)
         continue;
      uint32_t buffer;
      VkDeviceSize at, size;
      if (!buffer_binding(p, k, &set->slots[slot], &buffer, &at, &size))
         continue;
      const int region = wg_address_region_of(dev, buffer);
      uint32_t j = 0;
      while (region >= 0 && j < p->resource_count &&
             (p->resources[j].group != WGSL_MAX_GROUPS - 1 || p->resources[j].binding != wgsl_address_binding(region)))
         j++;
      if (region < 0 || j == p->resource_count)
         continue;
      const struct wgsl_resource *a = &p->resources[j];
      if (!(p->vis[j] & stage) || a->atomic != r->atomic || a->signed_atomic != r->signed_atomic ||
          (r->kind == WGSL_STORAGE_READ && a->kind != WGSL_STORAGE) ||
          (r->kind == WGSL_STORAGE && a->kind != WGSL_STORAGE && (p->vis[j] & ~stage)))
         continue;
      out[count++] = (struct wg_share){ (uint32_t)r->group << 16 | r->binding, (uint32_t)a->group << 16 | a->binding,
                                        (int8_t)s, WG_SHARE_ADDRESS, { 0, 0 } };
      shared[k / 64] |= 1ull << (k % 64);
   }
   return count;
}

static struct wg_program *
program_for(struct wg_cmd_buffer *cmd, uint32_t point, struct wg_program *p)
{
   /* By resource index, every one of a program's (VK3 L7a, the binding review's finding 4: the first 64 were). */
   uint64_t mask[2] = { 0 };
   const uint32_t n = p->resource_count;
   for (uint32_t k = 0; k < n; k++) {
      const struct wgsl_resource *r = &p->resources[k];
      const int s = p->res_set[k];
      if (r->kind == WGSL_STORAGE_READ && point == 1) {
         const struct wg_device_memory *mem = resource_memory(cmd, point, p, k);
         bool shared = false, overlap = false;
         VkDeviceSize lo, hi, jlo, jhi;
         if (mem)
            resource_range(cmd, point, p, k, &lo, &hi);
         for (uint32_t j = 0; mem && j < n; j++) {
            /* Another of those made writable counts as writable (a read that stays read-only is copied). */
            const bool promoted = j < k && (mask[j / 64] & (1ull << (j % 64))) && p->resources[j].kind == WGSL_STORAGE_READ;
            if ((p->resources[j].kind == WGSL_STORAGE || promoted) && resource_memory(cmd, point, p, j) == mem) {
               shared |= !promoted;
               resource_range(cmd, point, p, j, &jlo, &jhi);
               overlap |= jlo < hi && lo < jhi;
            }
         }
         if (shared && !overlap)
            mask[k / 64] |= 1ull << (k % 64);
         continue;
      }
      if (r->kind != WGSL_TEXTURE || r->sample != WGSL_SAMPLE_FLOAT || r->multisampled || s < 0)
         continue;
      const struct wg_descriptor_set *set = cmd->sets[point][s].set;
      const uint32_t slot = r->binding / 2 - p->set_base[s];
      const struct wg_image_view *view = set && slot < set->layout->slot_count ? set->slots[slot].view : NULL;
      if (view && !wg_format_filterable(view->fmt))
         mask[k / 64] |= 1ull << (k % 64);
   }
   if (!p->mixed_known)
      wg_program_mixed(p);
   mask[0] |= p->mixed[0], mask[1] |= p->mixed[1];
   struct wgsl_sampler_key keys[3 * WGSL_MAX_PAIRS + 2 * WGSL_MAX_RESOURCES];
   bool formatless = false; /* or a written storage texture, whose view may be of another format */
   for (uint32_t k = 0; k < p->resource_count; k++)
      formatless |= wgsl_image_keyed(&p->resources[k]);
   const bool slices = container_of(cmd->vk.base.device, struct wg_device, vk)->slice_views;
   const uint32_t key_count = p->pair_count || p->int_pair_count || p->key_pair_count || dev_padded(cmd) || formatless || slices
                                 ? program_keys(cmd, point, p, keys) : 0;
   /* Shared words stay read-only: a scope that writes their buffer reads them from its shadows. */
   struct wg_share share[WGSL_MAX_RESOURCES];
   uint64_t shared[2] = { 0 };
   uint32_t share_count = p->shares ? shared_words(cmd, point, p, share, shared) : 0;
   share_count += address_shares(cmd, point, p, share + share_count, shared);
   struct wg_storage_alias aliases[8];
   const uint32_t alias_count = storage_aliases(cmd, point, p, aliases, shared);
   mask[0] &= ~shared[0], mask[1] &= ~shared[1];
   return mask[0] | mask[1] || key_count || alias_count || share_count || p->shares
             ? wg_program_variant(p, mask, keys, key_count, aliases, alias_count, share, share_count)
             : p;
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

/* What a face's stencil state uses of its reference and masks: the reference where it compares or replaces, the
 * compare mask where it compares, the write mask where an op writes. */
static bool
uses_reference(const struct vk_stencil_test_face_state *f)
{
   return (f->op.compare != VK_COMPARE_OP_NEVER && f->op.compare != VK_COMPARE_OP_ALWAYS) ||
          f->op.fail == VK_STENCIL_OP_REPLACE || f->op.pass == VK_STENCIL_OP_REPLACE ||
          f->op.depth_fail == VK_STENCIL_OP_REPLACE;
}

static bool
uses_compare_mask(const struct vk_stencil_test_face_state *f)
{
   return f->op.compare != VK_COMPARE_OP_NEVER && f->op.compare != VK_COMPARE_OP_ALWAYS;
}

static bool
uses_write_mask(const struct vk_stencil_test_face_state *f)
{
   return f->op.fail != VK_STENCIL_OP_KEEP || f->op.pass != VK_STENCIL_OP_KEEP || f->op.depth_fail != VK_STENCIL_OP_KEEP;
}

/* The one reference and pair of masks (WebGPU's) a draw of both faces takes: each from a face that uses it, the front
 * where both do. */
static void
stencil_values(const struct vk_dynamic_graphics_state *dyn, uint32_t *ref, uint32_t *read, uint32_t *write)
{
   const struct vk_stencil_test_face_state *f = &dyn->ds.stencil.front, *b = &dyn->ds.stencil.back;
   *ref = !uses_reference(f) && uses_reference(b) ? b->reference : f->reference;
   *read = !uses_compare_mask(f) && uses_compare_mask(b) ? b->compare_mask : f->compare_mask;
   *write = !uses_write_mask(f) && uses_write_mask(b) ? b->write_mask : f->write_mask;
}

/* How many draws a draw takes: WebGPU has one stencil reference and one pair of masks, Vulkan a set a face. A draw
 * whose faces both use one of them with different values, with both faces drawn, is two: its front faces with the
 * front's (the back culled), then its back faces with the back's. That reorders its primitives where front and back
 * ones overlap: the later face's stencil ops run last, its colour blends over the other's, its depth wins ties under
 * LESS_OR_EQUAL or EQUAL; and the vertex stage runs twice, but one that writes storage once (VK4 T33: the later face
 * draws the first's outputs, `vs_again`). Faces that differ only in what they don't use (a reference or compare
 * mask under ALWAYS or NEVER, a write mask with every op KEEP) draw once (VK3 L6c, the L5-L6a review's finding 7). */
static uint32_t
draw_faces(struct wg_cmd_buffer *cmd)
{
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   const struct vk_stencil_test_face_state *f = &dyn->ds.stencil.front, *b = &dyn->ds.stencil.back;
   if (!cmd->pass.stencil || !dyn->ds.stencil.test_enable || dyn->rs.cull_mode || !has_faces(dyn->ia.primitive_topology))
      return 1;
   return (f->reference != b->reference && uses_reference(f) && uses_reference(b)) ||
                (f->compare_mask != b->compare_mask && uses_compare_mask(f) && uses_compare_mask(b)) ||
                (!cmd->pass.stencil_ro && f->write_mask != b->write_mask && uses_write_mask(f) && uses_write_mask(b))
             ? 2
             : 1;
}

/* A variant that can't be printed: said once, its draws and dispatches dropped, not an invalid pipeline. */
static bool
draw_refused(const struct wg_program *p)
{
   if (!p->refused)
      return false;
   static bool warned;
   if (!warned)
      fprintf(stderr, "wg: a draw or dispatch refused: %s\n", p->refused);
   warned = true;
   return true;
}

/* A stage that reads the view, or writes or reads gl_Layer (VK4 T43): a pipeline for each view, or each layer of a
 * layered pass (its `view`, the stages' `wg_view` and `wg_layer`). */
static bool
per_view(const struct wg_shader *vs, const struct wg_shader *fs)
{
   return vs->info.uses_view || vs->info.writes_layer || (fs && (fs->info.uses_view || fs->info.uses_layer));
}

/* A draw's render pipeline key from the command buffer's state (`vs` and `fs` its stages, `fs` NULL without a program;
 * `face` and `provoke` as record_draw's), and the stencil reference it draws with: record_draw's, and
 * wg_pipeline_premake's at a pipeline's creation. */
static void
draw_key(struct wg_cmd_buffer *cmd, struct wg_shader *vs, struct wg_shader *fs, bool indexed, uint32_t face, int provoke,
         struct wg_pipeline_key *out, uint32_t *s_ref_out)
{
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   struct wg_pipeline_key k;
   memset(&k, 0, sizeof(k));
   k.vs = vs;
   k.fs = fs;
   k.topology = dyn->ia.primitive_topology;
   if (provoke >= 0) {
      k.topology = provoke >= WG_PROVOKE_LINE_LIST ? VK_PRIMITIVE_TOPOLOGY_LINE_LIST : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
      indexed = false;
   }
   /* WebGPU takes no indexed strip without its index format, and always restarts it at the format's largest index:
    * with restart off in Vulkan, that index is a vertex (rare: it is the largest possible). */
   if (indexed && (k.topology == VK_PRIMITIVE_TOPOLOGY_LINE_STRIP || k.topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP))
      k.strip_index = cmd->ib_type == VK_INDEX_TYPE_UINT32 ? 2 : 1;
   k.front_face = dyn->rs.front_face == VK_FRONT_FACE_CLOCKWISE;
   k.cull = face == 1 ? VK_CULL_MODE_BACK_BIT : face == 2 ? VK_CULL_MODE_FRONT_BIT : dyn->rs.cull_mode & 3;
   /* The stencil's reference and masks: the back's for back faces alone (a split draw's, or front faces culled), the
    * front's for front faces alone, and for both those of the face that uses each (stencil_values). */
   const bool back_only = face == 2 || (k.cull == VK_CULL_MODE_FRONT_BIT && has_faces(k.topology));
   const bool front_only = face == 1 || (k.cull == VK_CULL_MODE_BACK_BIT && has_faces(k.topology));
   const struct vk_stencil_test_face_state *sface = back_only ? &dyn->ds.stencil.back : &dyn->ds.stencil.front;
   uint32_t s_ref = sface->reference, s_read = sface->compare_mask, s_write = sface->write_mask;
   if (!back_only && !front_only)
      stencil_values(dyn, &s_ref, &s_read, &s_write);
   /* Depth clamped, or not clipped (VK_EXT_depth_clip_enable): WebGPU's unclippedDepth (which clamps to the viewport's
    * range, as the attachment would anyway). */
   const bool clip = dyn->rs.depth_clip_enable == VK_MESA_DEPTH_CLIP_ENABLE_TRUE ||
                     (dyn->rs.depth_clip_enable == VK_MESA_DEPTH_CLIP_ENABLE_NOT_CLAMP && !dyn->rs.depth_clamp_enable);
   k.unclipped = !clip && (wg_features & WG_FEATURE_DEPTH_CLIP);
   k.flip = dyn->vp.viewport_count && dyn->vp.viewports[0].height < 0;
   /* WebGPU wants minDepth <= maxDepth: an inverted range (reverse-Z) is the range the right way round and the vertex
    * shader's z mirrored (w - z), which lands each depth where the inverted range would. */
   k.flip_z = dyn->vp.viewport_count && dyn->vp.viewports[0].minDepth > dyn->vp.viewports[0].maxDepth;
   k.samples = cmd->pass.samples;
   k.sample_mask = dyn->ms.sample_mask == 0xffff ? 0xffffffffu : dyn->ms.sample_mask;
   /* At one sample, the fragment stage's (`wg_a2c`, wgsl_print.c): WebGPU's needs several. */
   k.alpha_to_coverage = dyn->ms.alpha_to_coverage_enable;
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
         /* The bias's representation (VK_EXT_depth_bias_control, VK4 T43): WebGPU's `depthBias` is a whole number of
          * its texture's least step, which is Vulkan's only where the texture is the format (depth16unorm, depth32float:
          * Dawn may back depth24plus by a float format) and where it needn't be exact (SwiftShader's isn't). The rest,
          * another representation's r (FLOAT's 1, FORCE_UNORM's 2^-24 on a float format), a fraction of a step or a
          * constant past an int32, is the fragment stage's (`bias_frag`, wg_shader.c `post_text`): r the format's least
          * step, so exact. */
         const VkFormat df = cmd->pass.depth;
         const bool fdepth = df == VK_FORMAT_D32_SFLOAT || df == VK_FORMAT_D32_SFLOAT_S8_UINT;
         const uint32_t bits = df == VK_FORMAT_D16_UNORM || df == VK_FORMAT_D16_UNORM_S8_UINT ? 16 : 24;
         VkDepthBiasRepresentationEXT repr = dyn->rs.depth_bias.representation;
         if (repr == VK_DEPTH_BIAS_REPRESENTATION_LEAST_REPRESENTABLE_VALUE_FORCE_UNORM_EXT && !fdepth)
            repr = VK_DEPTH_BIAS_REPRESENTATION_LEAST_REPRESENTABLE_VALUE_FORMAT_EXT;
         const bool whole = k.bias_constant == floorf(k.bias_constant) && fabsf(k.bias_constant) < 8388608.0f;
         const bool native = df == VK_FORMAT_D16_UNORM || fdepth;
         if (k.depth_test && (repr != VK_DEPTH_BIAS_REPRESENTATION_LEAST_REPRESENTABLE_VALUE_FORMAT_EXT || !whole ||
                              !native || dyn->rs.depth_bias.exact)) {
            k.bias_frag = 1;
            k.bias_bits = fdepth ? 0 : bits;
            k.bias_r = repr == VK_DEPTH_BIAS_REPRESENTATION_FLOAT_EXT ? 1.0f
                       : repr == VK_DEPTH_BIAS_REPRESENTATION_LEAST_REPRESENTABLE_VALUE_FORCE_UNORM_EXT ? ldexpf(1.0f, -24)
                       : fdepth ? 0.0f : ldexpf(1.0f, -(int)bits);
         }
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
      k.stencil_read = s_read;
      k.stencil_write = cmd->pass.stencil_ro ? 0 : s_write;
   }
   for (uint32_t i = 0; i < k.color_count; i++) {
      const struct vk_color_blend_attachment_state *a = &dyn->cb.attachments[i];
      if (cmd->pass.dummy == i + 1)
         continue; /* the device's attachment for a pass without any: unwritten */
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
   /* What the fragment stage reads of its attachments (VK4 T32, wg_shader.c `fragment_dst`). The depth bounds test where
    * it can fail: a range short of [0, 1], or a float format's depth outside it. */
   if (cmd->pass.depth && cmd->pass.depth_view && dyn->ds.depth.bounds_test.enable &&
       (dyn->ds.depth.bounds_test.min > 0 || dyn->ds.depth.bounds_test.max < 1 || vk_format_is_float(cmd->pass.depth))) {
      k.depth_bounds = 1;
      k.bounds_min = dyn->ds.depth.bounds_test.min;
      k.bounds_max = dyn->ds.depth.bounds_test.max;
   }
   /* Each attachment's location (VK_KHR_dynamic_rendering_local_read's map). */
   if (!vk_color_attachment_location_state_is_identity(&dyn->cal)) {
      k.mapped = 1;
      memset(k.color_map, 0xff, sizeof(k.color_map));
      for (uint32_t i = 0; i < k.color_count; i++)
         k.color_map[i] = dyn->cal.color_map[i];
   }
   for (uint32_t i = 0; fs && i < k.color_count; i++) {
      const struct vk_color_blend_attachment_state *a = &dyn->cb.attachments[i];
      const VkFormat f = k.colors[i];
      const uint8_t loc = wg_key_location(&k, i);
      /* A logic op turns blending off on every attachment; it applies to integer and normalized ones, not sRGB (the
       * others are written as they are). */
      if (dyn->cb.logic_op_enable)
         memset(&k.blend[i], 0, offsetof(__typeof__(k.blend[i]), mask));
      if (!cmd->pass.color_views[i] || !f || !k.blend[i].mask || loc >= 8 || !(fs->info.outputs & (1u << loc)))
         continue;
      if (dyn->cb.logic_op_enable) {
         if (!vk_format_is_float(f) && !vk_format_is_srgb(f)) {
            k.logic_op = dyn->cb.logic_op + 1;
            k.logic_mask |= 1u << i;
         }
      } else if (a->blend_enable && a->color_blend_op >= VK_BLEND_OP_ZERO_EXT && a->color_blend_op <= VK_BLEND_OP_BLUE_EXT) {
         k.adv[i].op = a->color_blend_op - VK_BLEND_OP_ZERO_EXT + 1;
         k.adv[i].flags = (a->src_premultiplied ? 1 : 0) | (a->dst_premultiplied ? 2 : 0) | (a->clamp_results ? 4 : 0);
         k.adv[i].overlap = a->blend_overlap;
         memset(&k.blend[i], 0, offsetof(__typeof__(k.blend[i]), mask));
      }
   }
   const struct vk_vertex_input_state *vi = dyn->vi;
   if (vi) {
      u_foreach_bit(b, vi->bindings_valid & BITFIELD_MASK(WG_VERTEX_BINDINGS)) {
         k.vb[b].stride = dyn->vi_binding_strides[b];
         k.vb[b].instance = vi->bindings[b].input_rate == VK_VERTEX_INPUT_RATE_INSTANCE;
         k.vb[b].divisor = k.vb[b].instance ? vi->bindings[b].divisor : 0;
      }
      u_foreach_bit(a, vi->attributes_valid & vs->info.inputs) {
         if (vi->attributes[a].binding >= WG_VERTEX_BINDINGS)
            continue;
         k.attr[a].binding = vi->attributes[a].binding;
         k.attr[a].format = vi->attributes[a].format;
         k.attr[a].offset = vi->attributes[a].offset;
      }
      uint64_t bound[WG_VERTEX_BINDINGS] = { 0 };
      for (uint32_t b = 0; b < WG_VERTEX_BINDINGS; b++)
         if (cmd->vbs[b].buffer)
            bound[b] = cmd->vbs[b].buffer->offset + cmd->vbs[b].offset;
      wg_vertex_pull(&k, vs->info.inputs, bound);
      /* A binding the draw reads past its end (Vulkan's robust buffer access reads in range or 0; WebGPU refuses the
       * draw, VK4 T37): pulled, its loads past the range 0 (venus-gpu.ts `pulledCode`). */
      for (uint32_t b = 0; b < WG_VERTEX_BINDINGS; b++) {
         uint32_t last = 0;
         bool used = false;
         u_foreach_bit(loc, vs->info.inputs)
            if (k.attr[loc].format && k.attr[loc].binding == b) {
               used = true;
               last = MAX2(last, k.attr[loc].offset + vk_format_get_blocksize(k.attr[loc].format));
            }
         const uint64_t n = k.vb[b].instance ? (uint64_t)cmd->reach.first_instance + cmd->reach.instances
                                             : cmd->reach.vertices ? (uint64_t)cmd->reach.first + cmd->reach.vertices : 0;
         if (!used || k.vb[b].pull || !n || !cmd->vbs[b].buffer)
            continue;
         if ((n - 1) * k.vb[b].stride + last > cmd->vbs[b].size)
            k.vb[b].pull = 1;
      }
   }
   /* Alpha to one, and alpha to coverage where WebGPU's can't take it (VK4 T43, wg_shader.c `post_text`): no colour
    * target at location 0 (WebGPU's takes target 0's alpha, Vulkan's location 0's, which the key's map may move), a
    * stage writing `sample_mask`, or alpha to one (WebGPU's coverage would see its alpha 1). */
   k.alpha_to_one = fs && dyn->ms.alpha_to_one_enable;
   if (fs && k.alpha_to_coverage && k.samples > 1 && (fs->info.outputs & 1u) && fs->info.output_base[0] == WGSL_F32 &&
       !fs->info.dual_source) {
      const bool target0 = k.color_count && k.colors[0] && wg_texture_format(k.colors[0]) && wg_key_location(&k, 0) == 0 &&
                           !fs->info.writes_sample_mask;
      k.a2c_mask = !target0 || k.alpha_to_one;
   }
   *out = k;
   *s_ref_out = s_ref;
}

/* `face`: 0 the whole draw, 1 its front faces, 2 its back faces (draw_faces); `provoke`: a WG_PROVOKE_* mode for a draw
 * through indices of its own (a list then, its index buffer the replay's), or -1. */
static bool
record_draw(struct wg_cmd_buffer *cmd, bool indexed, uint32_t face, int provoke)
{
   struct wg_shader *vs = cmd->shaders[MESA_SHADER_VERTEX], *fs = cmd->shaders[MESA_SHADER_FRAGMENT];
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   if (!vs || !vs->program || !cmd->pass.active)
      return false;
   /* What rasterizes nothing isn't drawn, but a vertex stage that stores still runs (VK4 T33). */
   const bool unseen = dyn->rs.rasterizer_discard_enable ||
                       (dyn->rs.cull_mode == VK_CULL_MODE_FRONT_AND_BACK && dyn->ia.primitive_topology >= 3);
   if (!cmd->xfb_record && unseen && !vs->program->vs_stores)
      return false;
   /* Its stages on one program; if they came with different ones (wg_program_merge), a program of both's. */
   struct wg_program *base = vs->program;
   if (fs && fs->program && fs->program != base)
      base = wg_program_merge(base, fs->program, &vs->info, &fs->info);
   struct wg_program *p = program_for(cmd, 0, base);
   wg_variant_modules(p, vs, fs && fs->program ? fs : NULL);
   if (draw_refused(base) || draw_refused(p) || cmd->aliases_refused)
      return false;

   dummy_samples(cmd, dyn->ms.rasterization_samples);
   struct wg_pipeline_key k;
   uint32_t s_ref;
   if (provoke >= 0)
      indexed = false;
   draw_key(cmd, vs, fs && fs->program ? fs : NULL, indexed, face, provoke, &k, &s_ref);
   /* What wg_pipeline_premake guesses of a dynamic viewport: the last draw's. */
   struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
   dev->premake_flip = k.flip, dev->premake_flip_z = k.flip_z;
   /* A vertex stage that can't pull what it must: dropped, said once, not an invalid pipeline. */
   static bool unpulled;
   if (!wg_pipeline_pull_ok(p, &k)) {
      if (!unpulled)
         fprintf(stderr, "wg: a draw refused: its pulled vertex bindings don't fit (no bind group left, or past the vertex stage's storage buffers)\n");
      unpulled = true;
      return false;
   }
   /* One reading its attachments with no group left for them: likewise. */
   if (wg_key_reads_dst(&k) && !wg_pipeline_dst(p, &k))
      return false;
   if (!cmd->have_key || memcmp(&k, &cmd->last_key, sizeof(k)) || cmd->last_program[0] != p) {
      /* Made now, while the command buffer is recorded (WebGPU makes it asynchronously: web/venus-gpu.ts), so that it
       * is likely ready by the submit, which otherwise waits for it; the replay finds it by its key. One that can't be
       * made as its key asks (wg_shader.c `refused_pipeline`): the draw dropped. */
      if (!wg_render_pipeline(p, &k))
         return false;
      struct op_pipeline *op = emit(cmd, OP_PIPELINE, NULL, sizeof(*op));
      op->program = p;
      op->key = k;
      /* A stage that reads the view: a pipeline per view (`wg_view`, an override); one writing gl_Layer, per layer of a
       * layered pass (the layers past the first draw it alone). */
      const uint32_t views = cmd->pass.view_mask ? cmd->pass.view_mask
                             : cmd->pass.layer_count > 1 ? BITFIELD_MASK(MIN2(cmd->pass.layer_count, 32)) : 0;
      if (views && (cmd->pass.view_mask ? per_view(vs, fs) : vs->info.writes_layer))
         u_foreach_bit(view, views) {
            struct wg_pipeline_key per_view = k;
            per_view.view = view;
            wg_render_pipeline(p, &per_view);
         }
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
   d.stencil_ref = s_ref;
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
      if (!(cmd->emitted & (1u << 16)) || memcmp(&cmd->last_ib, &ib, sizeof(ib))) {
         emit(cmd, OP_IB, &ib, sizeof(ib));
         cmd->last_ib = ib;
         cmd->emitted |= 1u << 16;
      }
   }
   record_push(cmd, p);
   if (unseen && !cmd->xfb_record)
      emit(cmd, OP_VS_ONLY, NULL, 0);
   /* Its state is applied twice, before its pre-pass and in the pass's next part: a place of the push buffer more. */
   if (p->vs_stores)
      cmd->draws += pass_replays(cmd);
   /* A pull with a divisor: a place for its first instance (VK4 T44). */
   if (!p->vs_stores && wg_key_divisors(&k))
      cmd->draws += pass_replays(cmd);
   return true;
}

/* Whether the fragment shader reads a flat input (the provoking vertex's value). */
static bool
reads_flat(const struct wg_cmd_buffer *cmd)
{
   const struct wg_shader *fs = cmd->shaders[MESA_SHADER_FRAGMENT];
   if (!fs || !fs->program)
      return false;
   u_foreach_bit(l, fs->info.varyings.mask)
      if (fs->info.varyings.interp[l] == WGSL_INTERP_FLAT)
         return true;
   return false;
}

/* The WG_PROVOKE_* mode a draw takes indices of its own in (-1: none): its provoking vertex the last
 * (VK_EXT_provoking_vertex, VK3 L7.4) where its fragment shader reads a flat input (WebGPU's flat interpolation takes
 * the first vertex), and indexed fans (WebGPU has no fans). */
static int
provoke_mode(const struct wg_cmd_buffer *cmd, bool indexed)
{
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   const bool last = dyn->rs.provoking_vertex == VK_PROVOKING_VERTEX_MODE_LAST_VERTEX_EXT && reads_flat(cmd);
   switch (dyn->ia.primitive_topology) {
   case VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN:
      return last ? WG_PROVOKE_FAN_LAST : indexed ? WG_PROVOKE_FAN_FIRST : -1;
   case VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST: return last ? WG_PROVOKE_TRI_LIST : -1;
   case VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP: return last ? WG_PROVOKE_TRI_STRIP : -1;
   case VK_PRIMITIVE_TOPOLOGY_LINE_LIST: return last ? WG_PROVOKE_LINE_LIST : -1;
   case VK_PRIMITIVE_TOPOLOGY_LINE_STRIP: return last ? WG_PROVOKE_LINE_STRIP : -1;
   default: return -1;
   }
}

static uint32_t face_of(uint32_t faces, uint32_t i);

/* The states a draw's key reads (draw_key) that a pipeline made at its creation must hold itself: by what they are
 * for (a depth or stencil attachment, colour attachments), the rest always. */
static const enum mesa_vk_dynamic_graphics_state premake_states[] = {
   MESA_VK_DYNAMIC_IA_PRIMITIVE_TOPOLOGY, MESA_VK_DYNAMIC_RS_RASTERIZER_DISCARD_ENABLE, MESA_VK_DYNAMIC_RS_CULL_MODE,
   MESA_VK_DYNAMIC_RS_FRONT_FACE, MESA_VK_DYNAMIC_RS_DEPTH_CLAMP_ENABLE, MESA_VK_DYNAMIC_RS_DEPTH_CLIP_ENABLE,
   MESA_VK_DYNAMIC_RS_PROVOKING_VERTEX, MESA_VK_DYNAMIC_MS_SAMPLE_MASK, MESA_VK_DYNAMIC_MS_ALPHA_TO_COVERAGE_ENABLE,
   MESA_VK_DYNAMIC_MS_ALPHA_TO_ONE_ENABLE, MESA_VK_DYNAMIC_VI, MESA_VK_DYNAMIC_VI_BINDING_STRIDES,
};
static const enum mesa_vk_dynamic_graphics_state premake_depth[] = {
   MESA_VK_DYNAMIC_DS_DEPTH_TEST_ENABLE, MESA_VK_DYNAMIC_DS_DEPTH_WRITE_ENABLE, MESA_VK_DYNAMIC_DS_DEPTH_COMPARE_OP,
   MESA_VK_DYNAMIC_RS_DEPTH_BIAS_ENABLE,
};
static const enum mesa_vk_dynamic_graphics_state premake_stencil[] = {
   MESA_VK_DYNAMIC_DS_STENCIL_TEST_ENABLE, MESA_VK_DYNAMIC_DS_STENCIL_OP, MESA_VK_DYNAMIC_DS_STENCIL_COMPARE_MASK,
   MESA_VK_DYNAMIC_DS_STENCIL_WRITE_MASK,
};
static const enum mesa_vk_dynamic_graphics_state premake_colors[] = {
   MESA_VK_DYNAMIC_CB_BLEND_ENABLES, MESA_VK_DYNAMIC_CB_BLEND_EQUATIONS, MESA_VK_DYNAMIC_CB_WRITE_MASKS,
   MESA_VK_DYNAMIC_CB_COLOR_WRITE_ENABLES,
};

static bool
premake_static(const struct vk_dynamic_graphics_state *dyn, const enum mesa_vk_dynamic_graphics_state *states, uint32_t n)
{
   for (uint32_t i = 0; i < n; i++)
      if (!BITSET_TEST(dyn->set, states[i]))
         return false;
   return true;
}

void
wg_pipeline_premake(struct wg_device *dev, VkPipeline handle, const VkGraphicsPipelineCreateInfo *info)
{
   VK_FROM_HANDLE(vk_pipeline, pipeline, handle);
   if (!pipeline || pipeline->bind_point != VK_PIPELINE_BIND_POINT_GRAPHICS ||
       (pipeline->flags & VK_PIPELINE_CREATE_2_LIBRARY_BIT_KHR))
      return;
   /* The render pass the pipeline is for: its attachments' formats, samples and views. */
   struct vk_graphics_pipeline_all_state all;
   struct vk_graphics_pipeline_state state;
   memset(&state, 0, sizeof(state));
   if (vk_graphics_pipeline_state_fill(&dev->vk, &state, info, NULL, NULL, 0, &all, NULL,
                                       VK_SYSTEM_ALLOCATION_SCOPE_OBJECT, NULL) != VK_SUCCESS ||
       !state.rp || !vk_render_pass_state_has_attachment_info(state.rp))
      return;
   if (!dev->premake_cmd) {
      const VkCommandPoolCreateInfo pi = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
      struct vk_command_pool *pool = calloc(1, sizeof(*pool));
      struct vk_command_buffer *vk = NULL;
      if (!pool || vk_command_pool_init(&dev->vk, pool, &pi, NULL) != VK_SUCCESS) {
         free(pool);
         return;
      }
      if (wg_cmd_buffer_create(pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, &vk) != VK_SUCCESS) {
         vk_command_pool_finish(pool);
         free(pool);
         return;
      }
      dev->premake_pool = pool;
      dev->premake_cmd = container_of(vk, struct wg_cmd_buffer, vk);
   }
   struct wg_cmd_buffer *cmd = dev->premake_cmd;
   wg_cmd_buffer_reset(&cmd->vk, 0);
   pipeline->ops->cmd_bind(&cmd->vk, pipeline);
   struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   struct wg_shader *vs = cmd->shaders[MESA_SHADER_VERTEX], *fs = cmd->shaders[MESA_SHADER_FRAGMENT];
   const struct vk_render_pass_state *rp = state.rp;
   const bool depth = rp->depth_attachment_format != VK_FORMAT_UNDEFINED;
   const bool stencil = rp->stencil_attachment_format != VK_FORMAT_UNDEFINED;
   bool colors = false;
   for (uint32_t i = 0; i < rp->color_attachment_count; i++)
      colors |= rp->color_attachment_formats[i] != VK_FORMAT_UNDEFINED;
   /* A pipeline whose key a draw's dynamic state decides (extended dynamic state: DXVK's, Zink's) is made at its draw,
    * as are those of stages that draw_key can't take without a draw (none: a mesh pipeline, tessellation). */
   if (!vs || !vs->program || cmd->shaders[MESA_SHADER_TESS_CTRL] || cmd->shaders[MESA_SHADER_GEOMETRY] ||
       !premake_static(dyn, premake_states, ARRAY_SIZE(premake_states)) ||
       (depth && !premake_static(dyn, premake_depth, ARRAY_SIZE(premake_depth))) ||
       (stencil && !premake_static(dyn, premake_stencil, ARRAY_SIZE(premake_stencil))) ||
       (colors && !premake_static(dyn, premake_colors, ARRAY_SIZE(premake_colors))) ||
       ((depth && dyn->rs.depth_bias.enable) && !BITSET_TEST(dyn->set, MESA_VK_DYNAMIC_RS_DEPTH_BIAS_FACTORS)) ||
       dyn->rs.rasterizer_discard_enable)
      return;
   /* The pass as wg_CmdBeginRendering would have it with views of those formats (layouts that aren't read-only). */
   cmd->pass.active = true;
   cmd->pass.color_count = MIN2(rp->color_attachment_count, 8);
   for (uint32_t i = 0; i < cmd->pass.color_count; i++)
      cmd->pass.colors[i] = rp->color_attachment_formats[i];
   cmd->pass.depth = rp->depth_attachment_format;
   cmd->pass.stencil = rp->stencil_attachment_format;
   cmd->pass.samples = state.ms && state.ms->rasterization_samples ? state.ms->rasterization_samples : 1;
   cmd->pass.view_mask = state.mv ? state.mv->view_mask : 0;
   if (!colors && !depth && !stencil) {
      if (cmd->pass.color_count == 8)
         cmd->pass.color_count = 7;
      cmd->pass.colors[cmd->pass.color_count] = VK_FORMAT_R8_UNORM;
      cmd->pass.dummy = ++cmd->pass.color_count;
   }
   /* A dynamic viewport: the last draw's flips (a program keeps one convention). */
   if (!BITSET_TEST(dyn->set, MESA_VK_DYNAMIC_VP_VIEWPORTS) || !dyn->vp.viewport_count) {
      dyn->vp.viewport_count = 1;
      dyn->vp.viewports[0] = (VkViewport){ .width = 1, .height = dev->premake_flip ? -1 : 1,
                                           .minDepth = dev->premake_flip_z ? 1 : 0, .maxDepth = dev->premake_flip_z ? 0 : 1 };
   }
   struct wg_program *base = vs->program;
   if (fs && fs->program && fs->program != base)
      base = wg_program_merge(base, fs->program, &vs->info, &fs->info);
   struct wg_program *p = program_for(cmd, 0, base);
   wg_variant_modules(p, vs, fs && fs->program ? fs : NULL);
   if (base->refused || p->refused || cmd->aliases_refused)
      return;
   /* Not indexed (a strip's index format is the draw's), vertices from the bindings' start (none pulled for offsets). */
   struct wg_pipeline_key k;
   uint32_t s_ref;
   const int provoke = provoke_mode(cmd, false);
   const uint32_t faces = draw_faces(cmd);
   for (uint32_t i = 0; i < faces; i++) {
      draw_key(cmd, vs, fs && fs->program ? fs : NULL, false, face_of(faces, i), provoke, &k, &s_ref);
      if (!wg_pipeline_pull_ok(p, &k))
         return;
      wg_render_pipeline_premade(p, &k);
      if (cmd->pass.view_mask && per_view(vs, fs))
         u_foreach_bit(view, cmd->pass.view_mask) {
            struct wg_pipeline_key per_view = k;
            per_view.view = view;
            wg_render_pipeline_premade(p, &per_view);
         }
   }
}

void
wg_pipeline_premake_finish(struct wg_device *dev)
{
   if (!dev->premake_pool)
      return;
   vk_command_pool_finish(dev->premake_pool);
   free(dev->premake_pool);
   dev->premake_pool = NULL;
   dev->premake_cmd = NULL;
}

/* A draw of `count` vertices or indices through indices of its own (OP_PROVOKE), in `mode`. */
static void
provoke(struct wg_cmd_buffer *cmd, int mode, bool indexed, uint32_t face, uint32_t count, uint32_t instances,
        uint32_t first, int32_t base, uint32_t first_instance)
{
   const uint32_t per = mode >= WG_PROVOKE_LINE_LIST ? 2 : 3;
   const uint32_t prims = mode == WG_PROVOKE_TRI_LIST || mode == WG_PROVOKE_LINE_LIST ? count / per
                          : count >= per - 1 ? count - (per - 1) : 0;
   if (!prims || !record_draw(cmd, indexed, face, mode))
      return;
   struct op_provoke o = { .wide = 2, .mode = mode, .first = indexed ? first : 0, .count = count, .prims = prims,
                           .instances = instances, .base = indexed ? base : (int32_t)first,
                           .first_instance = first_instance, .draw_index = cmd->draw_index };
   if (indexed) {
      o.buffer = buffer_gpu(cmd->ib);
      if (!o.buffer)
         return;
      o.wide = cmd->ib_type == VK_INDEX_TYPE_UINT32;
      o.restart = cmd->vk.dynamic_graphics_state.ia.primitive_restart_enable && mode != WG_PROVOKE_TRI_LIST &&
                  mode != WG_PROVOKE_LINE_LIST;
      o.offset = cmd->ib->offset + cmd->ib_offset;
      o.size = cmd->ib_size;
   }
   emit(cmd, OP_PROVOKE, &o, sizeof(o));
}

static void
draw(struct wg_cmd_buffer *cmd, uint32_t vertices, uint32_t instances, uint32_t first, uint32_t first_instance,
     uint32_t face)
{
   const int mode = provoke_mode(cmd, false);
   if (mode >= 0) {
      provoke(cmd, mode, false, face, vertices, instances, first, 0, first_instance);
      return;
   }
   if (!record_draw(cmd, false, face, -1))
      return;
   if (cmd->vk.dynamic_graphics_state.ia.primitive_topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN) {
      /* A fan (WebGPU has none) as a triangle list through the device's fan indices (1, 2, 0, 2, 3, 0, ...: each
       * triangle's first vertex Vulkan's provoking one), from the first vertex as the base. */
      struct wg_device *dev = container_of(cmd->vk.base.device, struct wg_device, vk);
      if (vertices > WG_FAN_VERTICES) {
         static bool warned;
         if (!warned)
            fprintf(stderr, "wg: a triangle fan of %u vertices isn't drawn (past %u)\n", vertices, WG_FAN_VERTICES);
         warned = true;
      }
      if (vertices < 3 || vertices > WG_FAN_VERTICES)
         return;
      struct op_ib ib = { .buffer = wg_fan_indices(dev), .wide = 1, .offset = 0, .size = (vertices - 2) * 12.0 };
      emit(cmd, OP_IB, &ib, sizeof(ib));
      cmd->emitted &= ~(1u << 16);
      emit(cmd, OP_DRAW_INDEXED,
           &(struct op_draw_indexed){ (vertices - 2) * 3, instances, 0, (int32_t)first, first_instance, cmd->draw_index },
           sizeof(struct op_draw_indexed));
      return;
   }
   emit(cmd, OP_DRAW, (uint32_t[]){ vertices, instances, first, first_instance, cmd->draw_index }, 20);
}

/* Transform feedback: a draw's vertices captured (gpu_xfb's "draw"), after the draw is recorded, or, where it
 * rasterizes nothing (rasterizer discard, both faces culled), its state recorded for it (VK3 L7.4). */
static void
xfb_draw(struct wg_cmd_buffer *cmd, bool indexed, uint32_t count, uint32_t instances, uint32_t first, int32_t base,
         uint32_t first_instance, struct wg_buffer *indirect, VkDeviceSize indirect_offset)
{
   struct wg_shader *vs = cmd->shaders[MESA_SHADER_VERTEX];
   if (!cmd->xfb_active || !vs || !vs->program || !wg_shader_xfb(vs))
      return;
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   if (dyn->rs.rasterizer_discard_enable ||
       (dyn->rs.cull_mode == VK_CULL_MODE_FRONT_AND_BACK && dyn->ia.primitive_topology >= 3)) {
      cmd->xfb_record = true;
      const bool ok = record_draw(cmd, indexed, 0, -1);
      cmd->xfb_record = false;
      if (!ok)
         return;
   }
   uint32_t ib = 0;
   double ib_offset = 0, ib_size = 0;
   if (indexed) {
      ib = buffer_gpu(cmd->ib);
      if (!ib)
         return;
      ib_offset = cmd->ib->offset + cmd->ib_offset;
      ib_size = cmd->ib_size;
      if (dyn->ia.primitive_restart_enable) {
         static bool warned;
         if (!warned)
            fprintf(stderr, "wg: transform feedback of a draw with primitive restart: captured without restarts\n");
         warned = true;
      }
   }
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"op\":\"draw\",\"topology\":%u,\"wide\":%u,\"ib\":%u,\"offset\":%.0f,\"size\":%.0f,"
                  "\"count\":%u,\"instances\":%u,\"first\":%u,\"base\":%d,\"firstInstance\":%u",
                  dyn->ia.primitive_topology, indexed ? cmd->ib_type == VK_INDEX_TYPE_UINT32 : 2, ib, ib_offset,
                  ib_size, count, instances, first, base, first_instance);
   /* An indirect draw's (VK3 L7b, the review of L7.4-L7.5's finding 2): its arguments copied over the parameters. */
   if (indirect && buffer_gpu(indirect))
      wg_json_printf(&j, ",\"indirect\":[%u,%.0f]}", buffer_gpu(indirect), (double)(indirect->offset + indirect_offset));
   else
      wg_json_printf(&j, "}");
   struct op_xfb *o = emit(cmd, OP_XFB, NULL, sizeof(struct op_xfb) + j.len + 1);
   memset(o, 0, sizeof(*o));
   o->kind = 1;
   memcpy(o + 1, j.data, j.len + 1);
   wg_json_free(&j);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBindTransformFeedbackBuffersEXT(VkCommandBuffer commandBuffer, uint32_t first, uint32_t count,
                                      const VkBuffer *buffers, const VkDeviceSize *offsets, const VkDeviceSize *sizes)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   for (uint32_t i = 0; i < count && first + i < 4; i++) {
      VK_FROM_HANDLE(wg_buffer, b, buffers[i]);
      cmd->xfb[first + i].buffer = b;
      cmd->xfb[first + i].offset = offsets[i];
      cmd->xfb[first + i].size =
         b ? vk_buffer_range(&b->vk, offsets[i], sizes && sizes[i] ? sizes[i] : VK_WHOLE_SIZE) : 0;
   }
}

/* A begin or end: its counter buffers (`first` to `first + count`), each [buffer, offset] or null. */
static void
xfb_mark(struct wg_cmd_buffer *cmd, uint32_t kind, uint32_t first, uint32_t count, const VkBuffer *counters,
         const VkDeviceSize *offsets)
{
   struct op_xfb o = { .kind = kind };
   uint32_t n = 0;
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"op\":\"%s\",\"counters\":[", kind ? "end" : "begin");
   for (uint32_t b = 0; b < 4; b++) {
      struct wg_buffer *c = NULL;
      if (counters && b >= first && b < first + count)
         c = wg_buffer_from_handle(counters[b - first]);
      if (c && buffer_gpu(c)) {
         const VkDeviceSize at = c->offset + (offsets ? offsets[b - first] : 0);
         wg_json_printf(&j, "%s[%u,%llu]", b ? "," : "", buffer_gpu(c), (unsigned long long)at);
         if (kind && c->mem->host)
            o.readback[n].mem = c->mem, o.readback[n].offset = at - c->mem->gpu_at, o.readback[n++].size = 4;
      } else {
         wg_json_printf(&j, "%snull", b ? "," : "");
      }
   }
   wg_json_printf(&j, "]");
   if (!kind) {
      wg_json_printf(&j, ",\"buffers\":[");
      for (uint32_t b = 0; b < 4; b++) {
         struct wg_buffer *x = cmd->xfb[b].buffer;
         if (x && buffer_gpu(x) && cmd->xfb[b].size) {
            const VkDeviceSize at = x->offset + cmd->xfb[b].offset;
            wg_json_printf(&j, "%s[%u,%llu,%llu]", b ? "," : "", buffer_gpu(x), (unsigned long long)at,
                           (unsigned long long)cmd->xfb[b].size);
            if (x->mem->host)
               o.readback[n].mem = x->mem, o.readback[n].offset = at - x->mem->gpu_at, o.readback[n++].size = cmd->xfb[b].size;
         } else {
            wg_json_printf(&j, "%snull", b ? "," : "");
         }
      }
      wg_json_printf(&j, "]");
   }
   wg_json_printf(&j, "}");
   struct op_xfb *p = emit(cmd, OP_XFB, NULL, sizeof(o) + j.len + 1);
   *p = o;
   memcpy(p + 1, j.data, j.len + 1);
   wg_json_free(&j);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdBeginTransformFeedbackEXT(VkCommandBuffer commandBuffer, uint32_t first, uint32_t count,
                                const VkBuffer *counters, const VkDeviceSize *offsets)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   xfb_mark(cmd, 0, first, count, counters, offsets);
   cmd->xfb_active = true;
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdEndTransformFeedbackEXT(VkCommandBuffer commandBuffer, uint32_t first, uint32_t count,
                              const VkBuffer *counters, const VkDeviceSize *offsets)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   xfb_mark(cmd, 2, first, count, counters, offsets);
   cmd->xfb_active = false;
}

/* The faces a draw is recorded with, as record_draw's `face`, for i < draw_faces(cmd). */
static uint32_t
face_of(uint32_t faces, uint32_t i)
{
   return faces == 2 ? i + 1 : 0;
}

/* A draw split by face (`draw_faces`) whose vertex stage writes storage: its later faces draw the first's outputs. */
static void
vs_again(struct wg_cmd_buffer *cmd, uint32_t face)
{
   struct wg_shader *vs = cmd->shaders[MESA_SHADER_VERTEX];
   if (face && vs && vs->program && vs->program->vs_stores)
      emit(cmd, OP_VS_AGAIN, NULL, 0);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDraw(VkCommandBuffer commandBuffer, uint32_t vertices, uint32_t instances, uint32_t first,
           uint32_t first_instance)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (!vertices || !instances)
      return;
   const uint32_t faces = draw_faces(cmd);
   cmd->reach = (__typeof__(cmd->reach)){ vertices, first, instances, first_instance };
   for (uint32_t i = 0; i < faces; i++) {
      vs_again(cmd, i);
      draw(cmd, vertices, instances, first, first_instance, face_of(faces, i));
   }
   memset(&cmd->reach, 0, sizeof(cmd->reach));
   xfb_draw(cmd, false, vertices, instances, first, 0, first_instance, NULL, 0);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndexed(VkCommandBuffer commandBuffer, uint32_t indices, uint32_t instances, uint32_t first, int32_t base,
                  uint32_t first_instance)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (!indices || !instances)
      return;
   const uint32_t faces = draw_faces(cmd);
   const int mode = provoke_mode(cmd, true);
   cmd->reach = (__typeof__(cmd->reach)){ 0, 0, instances, first_instance };
   for (uint32_t i = 0; i < faces; i++) {
      vs_again(cmd, i);
      if (mode >= 0) {
         provoke(cmd, mode, true, face_of(faces, i), indices, instances, first, base, first_instance);
         continue;
      }
      if (!record_draw(cmd, true, face_of(faces, i), -1))
         break;
      emit(cmd, OP_DRAW_INDEXED, &(struct op_draw_indexed){ indices, instances, first, base, first_instance, cmd->draw_index },
           sizeof(struct op_draw_indexed));
   }
   memset(&cmd->reach, 0, sizeof(cmd->reach));
   xfb_draw(cmd, true, indices, instances, first, base, first_instance, NULL, 0);
}

static bool draw_params(const struct wg_program *p);

/* VK_EXT_multi_draw (VK4 T26): a draw per element, each with its draw index (gl_DrawID), captured as its own. */
VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawMultiEXT(VkCommandBuffer commandBuffer, uint32_t count, const VkMultiDrawInfoEXT *info, uint32_t instances,
                   uint32_t first_instance, uint32_t stride)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   for (uint32_t i = 0; i < count; i++) {
      const VkMultiDrawInfoEXT *d = (const void *)((const uint8_t *)info + (size_t)i * stride);
      cmd->draw_index = i;
      wg_CmdDraw(commandBuffer, d->vertexCount, instances, d->firstVertex, first_instance);
   }
   cmd->draw_index = 0;
}

/* With `vertex_offset`, every element's vertex offset is it. */
VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawMultiIndexedEXT(VkCommandBuffer commandBuffer, uint32_t count, const VkMultiDrawIndexedInfoEXT *info,
                          uint32_t instances, uint32_t first_instance, uint32_t stride, const int32_t *vertex_offset)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   for (uint32_t i = 0; i < count; i++) {
      const VkMultiDrawIndexedInfoEXT *d = (const void *)((const uint8_t *)info + (size_t)i * stride);
      cmd->draw_index = i;
      wg_CmdDrawIndexed(commandBuffer, d->indexCount, instances, d->firstIndex,
                        vertex_offset ? *vertex_offset : d->vertexOffset, first_instance);
   }
   cmd->draw_index = 0;
}

static void
draw_indirect(VkCommandBuffer commandBuffer, VkBuffer _buffer, VkDeviceSize offset, uint32_t count, uint32_t stride,
              bool indexed, struct wg_buffer *count_buffer, VkDeviceSize count_offset)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(wg_buffer, buffer, _buffer);
   if (!count)
      return;
   const uint32_t faces = draw_faces(cmd);
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   const bool fan = dyn->ia.primitive_topology == VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN;
   /* A fan's draws are worked out from their own records (`fanIndirect`), which a count would have to gate too, and a
    * capture reads each record as it is: neither seen with a count. */
   if (count_buffer && (fan || cmd->xfb_active)) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: a draw-indirect-count of a triangle fan or under transform feedback isn't drawn\n");
      warned = true;
      return;
   }
   if (provoke_mode(cmd, indexed) >= 0 && (!fan || dyn->rs.provoking_vertex == VK_PROVOKING_VERTEX_MODE_LAST_VERTEX_EXT)) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: an indirect draw whose provoking vertex is the last: drawn as is\n");
      warned = true;
   }
   stride = stride ? stride : (indexed ? 20 : 16);
   struct op_indirect op = { .buffer = buffer_gpu(buffer), .indexed = indexed, .count = count, .stride = stride,
                             .offset = buffer->offset + offset, .fan = fan, .wide = 2 };
   if (count_buffer) {
      op.count_buffer = buffer_gpu(count_buffer);
      op.count_offset = count_buffer->offset + count_offset;
      if (!op.buffer || !op.count_buffer)
         return;
   }
   if (fan && indexed) {
      op.ib = buffer_gpu(cmd->ib);
      if (!op.ib)
         return;
      op.wide = cmd->ib_type == VK_INDEX_TYPE_UINT32;
      op.restart = dyn->ia.primitive_restart_enable;
      op.ib_offset = cmd->ib->offset + cmd->ib_offset;
      op.ib_size = cmd->ib_size;
   } else if (fan) {
      op.ib = wg_fan_indices(container_of(cmd->vk.base.device, struct wg_device, vk));
      op.ib_size = (WG_FAN_VERTICES - 2) * 12.0;
   }
   /* A multi-draw indirect whose vertex stage reads its draw parameters takes a place a draw (`prepasses`), past the
    * two emit counts. */
   const struct wg_shader *vs = cmd->shaders[MESA_SHADER_VERTEX];
   const bool params = vs && vs->program && draw_params(vs->program);
   for (uint32_t i = 0; i < faces; i++) {
      if (!record_draw(cmd, indexed, face_of(faces, i), -1))
         break;
      emit(cmd, OP_DRAW_INDIRECT, &op, sizeof(op));
      if (params || wg_key_divisors(&cmd->last_key))
         cmd->draws += (count - 1) * pass_replays(cmd);
   }
   /* Captured with its arguments read at the capture (the counts here are only the most it may draw: none). */
   for (uint32_t i = 0; i < count; i++)
      xfb_draw(cmd, indexed, 0, 0, 0, 0, 0, buffer, offset + (VkDeviceSize)i * stride);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndirect(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, uint32_t count,
                   uint32_t stride)
{
   draw_indirect(commandBuffer, buffer, offset, count, stride, false, NULL, 0);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndexedIndirect(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, uint32_t count,
                          uint32_t stride)
{
   draw_indirect(commandBuffer, buffer, offset, count, stride, true, NULL, 0);
}

/* drawIndirectCount (VK4 T26): `most` records, those past the count drawing nothing. */
VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndirectCount(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, VkBuffer count_buffer,
                        VkDeviceSize count_offset, uint32_t most, uint32_t stride)
{
   draw_indirect(commandBuffer, buffer, offset, most, stride, false, wg_buffer_from_handle(count_buffer), count_offset);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDrawIndexedIndirectCount(VkCommandBuffer commandBuffer, VkBuffer buffer, VkDeviceSize offset, VkBuffer count_buffer,
                               VkDeviceSize count_offset, uint32_t most, uint32_t stride)
{
   draw_indirect(commandBuffer, buffer, offset, most, stride, true, wg_buffer_from_handle(count_buffer), count_offset);
}

/* Compute. */

static bool
record_dispatch(struct wg_cmd_buffer *cmd)
{
   struct wg_shader *cs = cmd->shaders[MESA_SHADER_COMPUTE];
   /* A base whose words fit only shared has no pipeline of its own: its variants do. */
   if (!cs || !cs->program || (!cs->program->compute && !cs->program->shares))
      return false;
   struct wg_program *p = program_for(cmd, 1, cs->program);
   if (draw_refused(p) || cmd->aliases_refused)
      return false;
   if (cmd->last_compute != cs || cmd->last_program[1] != p) {
      emit(cmd, OP_COMPUTE, &p, sizeof(p));
      cmd->last_compute = cs;
      cmd->last_program[1] = p;
      cmd->last_based = p->compute;
   }
   record_sets(cmd, 1, p);
   record_push(cmd, p);
   return true;
}

/* The pipeline of a dispatch from a base (wg_compute_based), and back after one. */
static void
dispatch_base(struct wg_cmd_buffer *cmd, uint32_t x, uint32_t y, uint32_t z)
{
   const uint32_t pipeline = wg_compute_based(cmd->last_program[1], x, y, z);
   if (pipeline != cmd->last_based) {
      emit(cmd, OP_COMPUTE_BASED, &pipeline, sizeof(pipeline));
      cmd->last_based = pipeline;
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdDispatchBase(VkCommandBuffer commandBuffer, uint32_t bx, uint32_t by, uint32_t bz, uint32_t x, uint32_t y,
                   uint32_t z)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (!x || !y || !z || !record_dispatch(cmd))
      return;
   dispatch_base(cmd, bx, by, bz);
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
   dispatch_base(cmd, 0, 0, 0);
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
                                 .dst_mem_offset = dst->mem_offset + r->dstOffset },
           sizeof(struct op_copy_bb));
   }
}

/* A buffer ↔ image region's copies, one per layer (2D arrays) or one for a 3D extent. */
static void
copy_bt(struct wg_cmd_buffer *cmd, enum op op, struct wg_buffer *buffer, struct wg_image *image,
        const VkBufferImageCopy2 *r)
{
   const VkImageAspectFlags aspect = r->imageSubresource.aspectMask;
   /* A multi-planar image's plane (VK3 L7.2): its own texture, the region in its texels. */
   const struct wg_image_plane *plane = &image->planes[wg_image_plane(image, aspect)];
   const struct wg_texture_format *f = plane->fmt;
   /* The buffer's texels are the format's, a packed one's own (the worker unpacks them). */
   uint32_t bytes = wg_texel_bytes(f);
   uint32_t a = 0;
   if ((f->flags & WG_FMT_DEPTH) && (f->flags & WG_FMT_STENCIL)) {
      a = aspect == VK_IMAGE_ASPECT_STENCIL_BIT ? 2 : 1;
      bytes = a == 2 ? 1 : (f->flags & WG_FMT_D16) ? 2 : 4;
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
   record_layers_use(cmd, image, &r->imageSubresource, op == OP_COPY_BT);
   for (uint32_t l = 0; l < layers; l++) {
      const VkDeviceSize offset = buffer->offset + r->bufferOffset + (VkDeviceSize)l * bpr * rows;
      struct op_copy_bt c = {
         .buffer = buffer_gpu(buffer), .bpr = bpr, .rows = rows, .tex = plane->tex, .mip = r->imageSubresource.mipLevel,
         .x = r->imageOffset.x, .y = r->imageOffset.y, .z = is3d ? r->imageOffset.z : r->imageSubresource.baseArrayLayer + l,
         .w = DIV_ROUND_UP(e.width, f->bw) * f->bw, .h = DIV_ROUND_UP(e.height, f->bh) * f->bh, .d = depth, .aspect = a, .block_h = f->bh, .offset = offset,
      };
      if (op == OP_COPY_TB && host_mem(buffer)) {
         c.mem = buffer->mem;
         c.mem_offset = offset - buffer->mem->gpu_at;
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

/* A copy's aspect for the worker: of a depth-stencil texture, the one copied (1 depth, 2 stencil; 0 both); between a
 * depth or stencil image and a colour one (maintenance8: R32_SFLOAT and D32_SFLOAT, R8_UINT and S8_UINT, ...), the
 * depth or stencil side's, which the worker's copy through a buffer goes by (VK4 T24). */
static uint32_t
copy_aspect(const struct wg_image *src, VkImageAspectFlags src_aspect, const struct wg_image *dst,
            VkImageAspectFlags dst_aspect)
{
   const uint32_t ds = WG_FMT_DEPTH | WG_FMT_STENCIL;
   const bool sds = src->fmt->flags & ds, dds = dst->fmt->flags & ds;
   if (sds != dds) {
      const VkImageAspectFlags a = sds ? src_aspect : dst_aspect;
      return a == VK_IMAGE_ASPECT_STENCIL_BIT ? 2 : 1;
   }
   if ((src->fmt->flags & ds) == ds)
      return src_aspect == VK_IMAGE_ASPECT_STENCIL_BIT ? 2 : src_aspect == VK_IMAGE_ASPECT_DEPTH_BIT ? 1 : 0;
   return 0;
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
      /* Planes of multi-planar images (VK3 L7.2): their own textures. */
      const struct wg_image_plane *sp = &src->planes[wg_image_plane(src, aspect)];
      const struct wg_image_plane *dp = &dst->planes[wg_image_plane(dst, r->dstSubresource.aspectMask)];
      /* Size-compatible formats copy block for block: a compressed block is one texel of an uncompressed format. */
      const uint32_t cols = DIV_ROUND_UP(r->extent.width, sp->fmt->bw), rows = DIV_ROUND_UP(r->extent.height, sp->fmt->bh);
      record_layers_use(cmd, src, &r->srcSubresource, false);
      record_layers_use(cmd, dst, &r->dstSubresource, true);
      emit(cmd, OP_COPY_TT,
           &(struct op_copy_tt){ .src = sp->tex, .src_mip = r->srcSubresource.mipLevel, .sx = r->srcOffset.x,
                                 .sy = r->srcOffset.y, .sz = s3 ? r->srcOffset.z : r->srcSubresource.baseArrayLayer,
                                 .dst = dp->tex, .dst_mip = r->dstSubresource.mipLevel, .dx = r->dstOffset.x,
                                 .dy = r->dstOffset.y, .dz = d3 ? r->dstOffset.z : r->dstSubresource.baseArrayLayer,
                                 .w = cols * sp->fmt->bw, .h = rows * sp->fmt->bh, .d = layers,
                                 .dst_w = cols * dp->fmt->bw, .dst_h = rows * dp->fmt->bh, .cols = cols, .rows = rows,
                                 .bytes = sp->fmt->bytes,
                                 .aspect = copy_aspect(src, aspect, dst, r->dstSubresource.aspectMask) },
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
   const bool s3 = src->vk.image_type == VK_IMAGE_TYPE_3D, d3 = dst->vk.image_type == VK_IMAGE_TYPE_3D;
   for (uint32_t i = 0; i < info->regionCount; i++) {
      const VkImageBlit2 *r = &info->pRegions[i];
      const uint32_t src_layers = vk_image_subresource_layer_count(&src->vk, &r->srcSubresource);
      const uint32_t dst_layers = vk_image_subresource_layer_count(&dst->vk, &r->dstSubresource);
      const VkExtent3D se = vk_image_mip_level_extent(&src->vk, r->srcSubresource.mipLevel);
      record_layers_use(cmd, src, &r->srcSubresource, false);
      record_layers_use(cmd, dst, &r->dstSubresource, true);
      /* maintenance8 (VK4 T24): a 2D array's layers into a 3D image's slices, one each (the slices' span is the layer
       * count), and a 3D image's slices into an array's layers; otherwise layer for layer. */
      const bool to_slices = !s3 && d3 && src_layers > 1, to_layers = s3 && !d3 && dst_layers > 1;
      const uint32_t layers = to_layers ? dst_layers : src_layers;
      for (uint32_t l = 0; l < layers; l++) {
         int32_t sz[2] = { r->srcOffsets[0].z, r->srcOffsets[1].z }, dz[2] = { r->dstOffsets[0].z, r->dstOffsets[1].z };
         if (to_slices) {
            const int32_t span = dz[1] - dz[0];
            dz[0] = r->dstOffsets[0].z + (int32_t)(l * span) / (int32_t)layers;
            dz[1] = r->dstOffsets[0].z + (int32_t)((l + 1) * span) / (int32_t)layers;
         } else if (to_layers) {
            const int32_t span = sz[1] - sz[0];
            sz[0] = r->srcOffsets[0].z + (int32_t)(l * span) / (int32_t)layers;
            sz[1] = r->srcOffsets[0].z + (int32_t)((l + 1) * span) / (int32_t)layers;
         }
         const uint32_t src_layer = r->srcSubresource.baseArrayLayer + (to_layers ? 0 : l);
         const uint32_t dst_layer = r->dstSubresource.baseArrayLayer + (to_slices ? 0 : l);
         struct wg_json j = { 0 };
         wg_json_printf(&j, "{\"op\":\"blit\",%s\"src\":%u,\"srcMip\":%u,\"srcLayer\":%u,\"srcFormat\":\"%s\",\"dst\":%u,"
                        "\"dstMip\":%u,\"dstLayer\":%u,\"format\":\"%s\",\"filter\":\"%s\",\"srcSize\":[%u,%u],"
                        "\"from\":[%d,%d,%d,%d],\"to\":[%d,%d,%d,%d],\"srcZ\":[%d,%d],\"dstZ\":[%d,%d],\"srcDepth\":%u}",
                        (src->fmt->flags & WG_FMT_OPAQUE) && (src->fmt->flags & WG_FMT_BC) ? "\"srcOpaque\":true," : "",
                        src->tex, r->srcSubresource.mipLevel, src_layer, src->fmt->name,
                        dst->tex, r->dstSubresource.mipLevel, dst_layer, dst->fmt->name,
                        info->filter == VK_FILTER_LINEAR ? "linear" : "nearest", se.width, se.height,
                        r->srcOffsets[0].x, r->srcOffsets[0].y, r->srcOffsets[1].x, r->srcOffsets[1].y,
                        r->dstOffsets[0].x, r->dstOffsets[0].y, r->dstOffsets[1].x, r->dstOffsets[1].y,
                        sz[0], sz[1], dz[0], dz[1], se.depth);
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
      const bool d3 = dst->vk.image_type == VK_IMAGE_TYPE_3D;
      const uint32_t layers = vk_image_subresource_layer_count(&src->vk, &r->srcSubresource);
      record_layers_use(cmd, src, &r->srcSubresource, false);
      record_layers_use(cmd, dst, &r->dstSubresource, true);
      for (uint32_t l = 0; l < layers; l++) {
         struct wg_json j = { 0 };
         wg_json_printf(&j, "{\"op\":\"resolve\",\"src\":%u,\"srcMip\":%u,\"srcLayer\":%u,\"dst\":%u,\"dstMip\":%u,"
                        "\"dstLayer\":%u,\"format\":\"%s\",\"from\":[%d,%d],\"to\":[%d,%d],\"size\":[%u,%u]}",
                        src->tex, r->srcSubresource.mipLevel, r->srcSubresource.baseArrayLayer + l, dst->tex,
                        r->dstSubresource.mipLevel, d3 ? r->dstOffset.z + l : r->dstSubresource.baseArrayLayer + l,
                        dst->fmt->name, r->srcOffset.x, r->srcOffset.y, r->dstOffset.x, r->dstOffset.y, r->extent.width,
                        r->extent.height);
         meta(cmd, &j);
      }
   }
}

static void
clear_image(struct wg_cmd_buffer *cmd, struct wg_image *image, const VkClearColorValue *color,
            const VkClearDepthStencilValue *ds, uint32_t count, const VkImageSubresourceRange *ranges)
{
   const struct wg_texture_format *f = image->fmt;
   VkClearColorValue cv;
   if (color) {
      wg_clear_color(f, color, &cv);
      color = &cv;
   }
   for (uint32_t i = 0; i < count; i++) {
      const uint32_t levels = vk_image_subresource_level_count(&image->vk, &ranges[i]);
      const uint32_t layers = image->vk.image_type == VK_IMAGE_TYPE_3D
                                 ? 1 : vk_image_subresource_layer_count(&image->vk, &ranges[i]);
      record_image_use(cmd, image, 0, 0, ranges[i].baseMipLevel, levels, ranges[i].baseArrayLayer, layers, true);
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
                           .mem = host_mem(b), .mem_offset = b->mem_offset + offset },
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
                           .mem_offset = b->mem_offset + offset };
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
   /* WebGPU orders a queue; inside a pass, a read of an attachment afterwards reads what's there now. */
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   if (cmd->pass.active)
      emit(cmd, OP_PASS_READ, NULL, 0);
}

VKAPI_ATTR void VKAPI_CALL
wg_CmdExecuteCommands(VkCommandBuffer commandBuffer, uint32_t count, const VkCommandBuffer *buffers)
{
   VK_FROM_HANDLE(wg_cmd_buffer, cmd, commandBuffer);
   for (uint32_t i = 0; i < count; i++) {
      struct wg_cmd_buffer *secondary = wg_cmd_buffer_from_handle(buffers[i]);
      if (secondary->pass.active)
         dummy_samples(cmd, secondary->pass.samples);
      emit(cmd, OP_EXEC, &secondary, sizeof(secondary));
      /* A secondary's draws, counted for one layer (its inheritance has no layer count): each of a layered pass's. */
      cmd->draws += secondary->draws * (cmd->pass.view_mask ? 1 : pass_replays(cmd));
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
   uint32_t of; /* a spare slot's: the query it carries on (its value added to that one's), else UINT32_MAX */
   uint32_t mux; /* in a pass of several pools: its slot of the device's set, whose value goes to `index`; else UINT32_MAX */
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
   bool vs_resumed; /* the part of the pass after a vertex stage's pre-pass (`vs_prepass`): its draw's copies made */
   bool vs_only, vs_again; /* OP_VS_ONLY's and OP_VS_AGAIN's, for the next draw */
   bool layer_draws;       /* the pipeline's vertex stage writes gl_Layer: drawn in each layer of a layered pass */
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
   struct op_vb vb[WG_VERTEX_BINDINGS];
   uint32_t vb_mask;
   const struct wg_pull *pull; /* the render pipeline's */
   const struct wg_dst *dst;   /* likewise: the attachments its fragment stage reads (`dst_copies`) */
   uint32_t dst_group;         /* their copies' bind group for the next draw */
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
   uint32_t qspares; /* the pass's spare slots taken */
   /* A query begun outside a render pass: it counts the passes it spans, each one's count added to it. */
   struct wg_query_pool *qouter;
   uint32_t qouter_index;
   bool qouter_counted;
   bool qmux;        /* the pass's queries are of several pools: all in the device's set (`qslot`), `qmux_next` taken */
   uint32_t qmux_next;
   struct util_dynarray pass_queries;
   uint32_t tickets; /* the render pass's draws through indices of their own so far (OP_PROVOKE: `prepasses`) */
   /* Multiview: the pass's mask, how many of its views have been replayed, this one, and where the pass starts again. */
   uint32_t view_mask, view_order, view, view_count;
   bool layered;                      /* the views are a layered pass's layers: draws in the first alone */
   uint32_t clear_first, clear_count; /* OP_CLEAR_LAYERS, for the next OP_CLEAR_RECTS (count 0: every layer) */
   const uint8_t *pass_op;
   /* The pass's attachments that can be read as input attachments (none: `atts.count` 0), its view's JSON, and the
    * mark of what a read of them finds: a copy (wg_image_view.twin) older than it is stale (`feedback_copies`). */
   struct op_pass_atts atts;
   const char *pass_json;
   uint32_t twin_mark;
   uint32_t address_use; /* the scope's pointers' binding: 0 none, 1 read, 2 written */
   uint32_t depth;       /* secondary command buffers the replay is inside */
   bool cuts;            /* the render pass stores its parts, to be cut at its barriers (`scope_cut`) */
   /* Draw parameters (VK3 L7.5): the next draw's (base vertex, base instance, draw index) and, for an indirect draw,
    * the place `prepasses` copied its arguments' into (UINT32_MAX: none); those the current place holds, where
    * `dp_valid`; the render pass's indirect draws' places, in their order (uint32_t), the next one `dp_next`. */
   uint32_t draw_dp[3], draw_place;
   uint32_t dp[3];
   bool dp_valid;
   struct util_dynarray dp_places;
   uint32_t dp_next;
   /* A pull with a divisor's first instance (VK4 T44): the place a direct draw's was written at and its value, and the
    * place the pull's group was last bound with (UINT32_MAX: none). */
   uint32_t fi_place, fi_value, fi_bound;
   /* Usage scopes (VK4 T3, `bind_group`): each group's op_bind and whether its group reads a shadow; the scope's uses
    * (struct scope_use) and shadows (struct shadow); `no_readback` while the scope's end binds groups again. */
   const struct op_bind *binds[2][WGSL_MAX_GROUPS];
   bool shadowed[2][WGSL_MAX_GROUPS];
   /* Each group binds a storage image as words whose view is past maxStorageBufferBindingSize (`words_past`). */
   bool past[2][WGSL_MAX_GROUPS];
   bool no_readback;
   struct util_dynarray uses, written, shadows; /* `written`: the GPUBuffers among `uses` bound writable (uint32_t) */
   struct util_dynarray images;                 /* struct op_image_use: what the scope binds of aliased images */
   /* The scope's op_binds (for `scope_reads`), and the views it reads as textures where it writes the same
    * subresources through storage bindings, which read a copy of the image (wg_view_loop) taken at its start (VK4 T37). */
   struct util_dynarray scope_binds, read_copies;
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
static void scope_end(struct replay *r, uint32_t point);

/* A query reported as passing: its value 1 in the pool's buffer (outside a render pass, a compute pass ended first: the
 * encoder takes no write while one is open; in a render pass, at its end). */
static void
query_passing(struct replay *r, struct wg_query_pool *pool, uint32_t index)
{
   if (r->pass == RENDER) {
      util_dynarray_append_typed(&r->pass_queries, struct pass_query,
                                 ((struct pass_query){ pool, index, true, UINT32_MAX, UINT32_MAX }));
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
      if (q->passing) {
         query_passing(r, q->pool, q->index);
      } else if (q->mux != UINT32_MAX) {
         gpu_resolve_queries(dev->query_mux, q->mux, 1, dev->query_scratch, 0);
         gpu_copy_bb(dev->query_scratch, 0, q->pool->buf, q->index * 8.0, 8);
      } else if (idx) {
         idx[k++] = q->index;
      }
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
   /* What clears cut a query into: each spare's count added to its query's. */
   util_dynarray_foreach (&r->pass_queries, struct pass_query, q)
      if (q->of != UINT32_MAX && !q->passing)
         gpu_query_add(q->pool->buf, q->of * 8.0, q->index * 8.0);
   util_dynarray_clear(&r->pass_queries);
}

static void
end_pass(struct replay *r)
{
   if (r->pass == RENDER && r->qactive_pool) {
      /* A query the pass's end cuts (WebGPU's pass ends inside Vulkan's): passing, unless it was begun outside. */
      gpu_end_occlusion();
      util_dynarray_foreach (&r->pass_queries, struct pass_query, q)
         if (q->pool == r->qactive_pool && q->index == r->qactive && r->qactive_pool != r->qouter)
            q->passing = true;
      r->qactive_pool = NULL;
   }
   if (r->pass != NONE)
      gpu_pass_end();
   const bool render = r->pass == RENDER;
   r->pass = NONE;
   if (render) {
      resolve_queries(r);
      scope_end(r, 0);
   }
   r->qpool = NULL;
}

/* The pool whose occlusion queries the render pass starting at `p` begins (the first), NULL for none; `*several`: it
 * begins queries of another too. */
static struct wg_query_pool *
pass_query_pool(const uint8_t *p, const uint8_t *end, bool *stop, struct wg_query_pool *pool, bool *several)
{
   while (p < end) {
      const struct op_head *h = (const void *)p;
      const void *d = h + 1;
      p += sizeof(*h) + h->size;
      if (h->op == OP_PASS || h->op == OP_PASS_END) {
         *stop = true;
         return pool;
      }
      if (h->op == OP_QUERY) {
         const struct op_query *q = d;
         if (q->kind == 2 && q->pool->set && q->first < WG_QUERY_SET_MAX) {
            *several |= pool && pool != q->pool;
            pool = pool ? pool : q->pool;
         }
      } else if (h->op == OP_EXEC) {
         const struct wg_cmd_buffer *sec = *(struct wg_cmd_buffer *const *)d;
         pool = pass_query_pool(sec->cmds.data, (const uint8_t *)sec->cmds.data + sec->cmds.size, stop, pool, several);
         if (*stop)
            return pool;
      }
   }
   return pool;
}

/* An occlusion query begins counting, in its slot of its pool's set or, in a pass of several pools, the device's
 * (WebGPU's pass takes one set). False past that set's slots. */
static bool
query_count(struct replay *r, struct wg_query_pool *pool, uint32_t index, uint32_t of)
{
   uint32_t mux = UINT32_MAX;
   if (r->qmux) {
      if (r->qmux_next >= WG_QUERY_SET_MAX)
         return false;
      mux = r->qmux_next++;
   }
   gpu_begin_occlusion(r->qmux ? mux : index);
   util_dynarray_append_typed(&r->pass_queries, struct pass_query, ((struct pass_query){ pool, index, false, of, mux }));
   return true;
}

/* The compute passes a render pass's draws need, made before it begins (the render-pass rule, docs/graphics.md:
 * WebGPU runs no compute inside a render pass, and a break per draw costs a frame its attachments' store and load):
 * each OP_PROVOKE's indices, numbered in the pass's order, which its replay draws by the same numbers. Vulkan's
 * barriers inside a render pass reach no index buffer, so what a draw reads is what the commands before the pass left
 * (VK3 L7.4). Returns how many. */
static uint32_t push_buffer(struct wg_device *dev);
static uint32_t push_place(struct wg_device *dev);
static bool draw_params(const struct wg_program *p);

static uint32_t
prepasses(struct replay *r, const struct wg_program **prog, bool *divisors, const uint8_t *p, const uint8_t *end,
          uint32_t ticket, bool top)
{
   while (p < end) {
      const struct op_head *h = (const void *)p;
      const void *d = h + 1;
      p += sizeof(*h) + h->size;
      if (top && (h->op == OP_PASS || h->op == OP_PASS_END))
         break;
      if (h->op == OP_PROVOKE) {
         const struct op_provoke *o = d;
         wg_emul[WG_EMUL_PREPASSES]++;
         gpu_provoke(ticket++, o->buffer, o->offset, o->size, o->wide, o->mode, o->restart, o->first, o->count,
                     o->prims);
      } else if (h->op == OP_PIPELINE) {
         *prog = ((const struct op_pipeline *)d)->program;
         *divisors = !(*prog)->vs_stores && wg_key_divisors(&((const struct op_pipeline *)d)->key);
      } else if (h->op == OP_DRAW_INDIRECT) {
         /* An indirect draw whose vertex stage reads its draw parameters, or that pulls a binding with a divisor (its
          * first instance: VK4 T44): a place of the push buffer of its own, its arguments' base vertex and first
          * instance copied there (the push buffer is written before the submit's commands), its draw index written with
          * the place. */
         const struct op_indirect *a = d;
         if (a->count_buffer) {
            wg_emul[WG_EMUL_PREPASSES]++;
            gpu_indirect_count(ticket++, a->buffer, a->offset, a->stride, a->count_buffer, a->count_offset, a->count,
                               a->indexed);
         }
         for (uint32_t i = 0; i < a->count; i++) {
            uint32_t at = UINT32_MAX;
            if (*prog && (draw_params(*prog) || *divisors) && a->buffer) {
               at = push_place(r->dev);
               gpu_copy_bb(a->buffer, a->offset + (double)i * a->stride + (a->indexed ? 12 : 8), push_buffer(r->dev),
                           at + WGSL_DRAW_PARAMS, 8);
               memcpy(r->dev->push_data + at + WGSL_DRAW_PARAMS + 8, (uint32_t[2]){ i, 0 }, 8);
            }
            util_dynarray_append_typed(&r->dp_places, uint32_t, at);
            if (a->fan) {
               wg_emul[WG_EMUL_PREPASSES]++;
               gpu_fan_indirect(ticket++, a->buffer, a->offset + (double)i * a->stride, a->ib, a->ib_offset, a->ib_size,
                                a->wide, a->restart);
            }
         }
      } else if (h->op == OP_EXEC) {
         const struct wg_cmd_buffer *sec = *(struct wg_cmd_buffer *const *)d;
         ticket = prepasses(r, prog, divisors, sec->cmds.data, (const uint8_t *)sec->cmds.data + sec->cmds.size, ticket,
                            false);
      }
   }
   return ticket;
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
   /* Runs of queries ended: one between them, reset and not ended here, keeps the value it has. */
   util_dynarray_foreach (&r->submit->queries, struct query_readback, q) {
      if (q->pool == pool && index + 1 >= q->lo && index <= q->hi) {
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

/* The device's fan indices: (i + 1, i + 2, 0) for each triangle i of a fan of up to WG_FAN_VERTICES vertices (Vulkan's
 * order, its provoking vertex first). */
uint32_t
wg_fan_indices(struct wg_device *dev)
{
   if (!dev->fan_indices) {
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", (WG_FAN_VERTICES - 2) * 12, 0x10 | 0x8); /* INDEX | COPY_DST */
      dev->fan_indices = wg_create_json(WG_KIND_BUFFER, &j);
      uint32_t *idx = malloc((WG_FAN_VERTICES - 2) * 12);
      for (uint32_t i = 0; i < WG_FAN_VERTICES - 2; i++)
         idx[3 * i] = i + 1, idx[3 * i + 1] = i + 2, idx[3 * i + 2] = 0;
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
      wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", dev->push_size, 0x40 | 0x80 | 0x8); /* UNIFORM | STORAGE | COPY_DST */
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

/* A place of the push buffer for one draw's or dispatch's push constants (and draw parameters): WebGPU's dynamic
 * uniform offsets are 256 bytes apart, and a place holds at most 144 bytes. */
static uint32_t
push_place(struct wg_device *dev)
{
   push_buffer(dev);
   if (dev->push_used + 256 > dev->push_size) {
      static bool told;
      if (!told)
         fprintf(stderr, "wg: a submit's push constants overflow the push buffer\n");
      told = true;
      dev->push_used = 0;
   }
   const uint32_t at = dev->push_used;
   dev->push_used += 256;
   return at;
}

/* Whether a program's vertex stage reads its draw parameters (the push buffer's words at WGSL_DRAW_PARAMS). */
static bool
draw_params(const struct wg_program *p)
{
   return p->push_ubo_size > WGSL_DRAW_PARAMS;
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

/* Whether a descriptor samples an image that is an attachment of its pass (VK_EXT_attachment_feedback_loop_layout): its
 * view covers the attachment's level and layer. Not a view of another texture (an alias, the words of RGB9E5). */
static bool
sampled_loop(const struct wg_image_view *v, const struct wg_image_view *a, uint32_t layer)
{
   return a->vk.image == v->vk.image && !v->alias && !v->rgb9e5 && !v->plane_count &&
          a->vk.base_mip_level >= v->vk.base_mip_level &&
          a->vk.base_mip_level < v->vk.base_mip_level + v->vk.level_count &&
          (v->vk.image->image_type == VK_IMAGE_TYPE_3D ||
           (layer >= v->vk.base_array_layer && layer < v->vk.base_array_layer + v->vk.layer_count));
}

/* The attachment of the pass an input attachment's descriptor reads, or a sampled one's view covers, written by the
 * pass, or -1. In a multiview pass both are of the view's layer, in a layered one of the layer being replayed (VK4 T43:
 * its draws writing gl_Layer drawn in each). */
static int
feedback_att(const struct replay *r, const struct wg_descriptor *d)
{
   if (!r->atts.count || !d->view)
      return -1;
   const struct wg_image_view *v = d->view;
   if (d->type == VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE || d->type == VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER) {
      if (!(v->vk.image->usage & VK_IMAGE_USAGE_ATTACHMENT_FEEDBACK_LOOP_BIT_EXT))
         return -1;
      for (uint32_t i = 0; i < r->atts.count; i++) {
         const struct wg_image_view *a = r->atts.views[i];
         const uint32_t layer = a->vk.base_array_layer + r->view;
         if ((r->atts.written[i] & v->vk.aspects) && sampled_loop(v, a, layer))
            return i;
      }
      return -1;
   }
   if (d->type != VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT)
      return -1;
   /* A WebGPU pass attaches one layer: the view's, or the layer of a layered pass being replayed. What an input
    * attachment reads is its view's (gl_Layer's), of its own base: the same layer only from the same base. */
   for (uint32_t i = 0; i < r->atts.count; i++) {
      const struct wg_image_view *a = r->atts.views[i];
      if (a->vk.image == v->vk.image && a->vk.base_mip_level == v->vk.base_mip_level &&
          a->vk.base_array_layer == v->vk.base_array_layer && (r->atts.written[i] & v->vk.aspects))
         return i;
   }
   return -1;
}

/*
 * Usage scopes (VK4 T3). Each VkDeviceMemory is one GPUBuffer, and WebGPU's usage scope (a dispatch; a whole render
 * pass) refuses a buffer bound as writable storage beside any other usage of it ("includes writable usage and another
 * usage in the same synchronization scope"): the pass or dispatch, and its submit, were dropped. Sub-allocating
 * programs (VMA: most engines, DXVK, vkd3d) meet it once a shader writes storage. Before such a scope, each read of a
 * buffer it also binds writable (a uniform or read-only storage binding, a texel buffer's words, a vertex or index
 * buffer, indirect arguments) is copied into the device's shadow buffer and bound from there, so what the scope reads
 * is what the buffer held at its start: a draw doesn't see what an earlier draw of its pass wrote to such a range,
 * until a barrier inside the pass, which ends the scope there (`scope_cut`). Nothing is copied back, but from the
 * shadows of writable descriptors beside a pointers' binding (`conflicts`), which are in a GPUBuffer of their own. A
 * dispatch's read-only storage buffer beside storage it writes elsewhere in its memory is bound writable instead,
 * which costs nothing (`program_for`).
 */
struct scope_use {
   uint32_t buffer;
   bool writable;
   double at, size;
   bool address; /* the pointers' binding, of the whole address buffer */
   /* A uniform block declared past its range and what its GPUBuffer has past it (WG_MEMORY_PAD): the block's bytes, read
    * from a shadow of that size (`scope_shadows`; VK4 T37: a binding smaller than the block lost its submit). */
   double need;
};

struct shadow {
   uint32_t buffer, to; /* the GPUBuffer read, and the shadow buffer its copy is in */
   double at, size, place;
   bool written;        /* copied back at the scope's end */
};

/* What the render pass a scan starts at uses: the bindings in force at each of its draws (`scan_pass`). */
struct scan {
   const struct op_bind *binds[WGSL_MAX_GROUPS];
   bool added[WGSL_MAX_GROUPS]; /* its uses taken since it was bound */
   uint32_t group_count;
   struct op_vb vb[WG_VERTEX_BINDINGS];
   uint32_t vb_mask, vb_added;
   struct op_ib ib;
   bool have_ib, ib_added;
};

/* Whether a group holds the pointers' binding, written. */
static bool
res_written(const struct wg_program *p, uint32_t group)
{
   for (uint32_t k = 0; k < p->resource_count; k++)
      if (p->resources[k].group == group && wgsl_address_region(group, p->resources[k].binding) >= 0 &&
          p->resources[k].kind == WGSL_STORAGE)
         return true;
   return false;
}

/* A view atomics reach as words: where they are bound from, and its parameters (wgsl_print.c `image_words`). */
static void
view_words(const struct wg_image_view *v, uint32_t *buffer, VkDeviceSize *at, VkDeviceSize *size, uint32_t *params)
{
   struct wg_image *image = container_of(v->vk.image, struct wg_image, vk);
   *buffer = wg_image_words(image);
   const uint32_t m = v->vk.base_mip_level, row = wg_image_row_bytes(image, m);
   const uint32_t h = DIV_ROUND_UP(u_minify(image->vk.extent.height, m), image->fmt->bh);
   /* A 2D view of a 3D image too: the shader's third coordinate is its slice (WGSL_SLICE_KEY). */
   const bool is3d = image->vk.image_type == VK_IMAGE_TYPE_3D;
   const uint32_t n = is3d ? u_minify(image->vk.extent.depth, m) : v->vk.layer_count;
   *at = image->words_at[m] + (VkDeviceSize)row * h * (is3d ? 0 : v->vk.base_array_layer);
   *size = (VkDeviceSize)row * h * n;
   params[0] = DIV_ROUND_UP(u_minify(image->vk.extent.width, m), image->fmt->bw), params[1] = h, params[2] = n;
   params[3] = row / 4, params[4] = row / 4 * h;
}

/* A buffer resource's binding: its GPUBuffer, its offset (before any dynamic offset) and size; false for none. */
static bool
buffer_binding(const struct wg_program *p, uint32_t k, const struct wg_descriptor *d, uint32_t *buffer,
               VkDeviceSize *at, VkDeviceSize *size)
{
   const struct wgsl_resource *res = &p->resources[k];
   if (d->type == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) {
      *buffer = d->inline_buffer;
      *at = d->offset;
      *size = MIN2(align64(MAX3(d->range, 16, res->kind == WGSL_UNIFORM ? res->size : 0), 16), d->inline_room);
      return true;
   }
   if (d->type == VK_DESCRIPTOR_TYPE_STORAGE_IMAGE) {
      if (!res->image_words || !d->view)
         return false;
      uint32_t words[5];
      view_words(d->view, buffer, at, size, words);
      /* A view past what a binding takes: bound to that (a valid bind group), its draws and dispatches refused
       * (`words_past`). */
      *size = MIN2(*size, wg_limits.max_storage_buffer_binding_size & ~3ull);
      return true;
   }
   if (d->type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) {
      const struct wg_buffer_view *v = d->texel;
      if (!v || !v->mem || !v->offered)
         return false;
      *buffer = wg_memory_buffer(v->mem);
      *at = v->at;
      *size = MAX2(v->size, 4);
      return true;
   }
   if (!d->buffer || !d->buffer->mem)
      return false;
   *buffer = wg_memory_buffer(d->buffer->mem);
   *at = d->buffer->offset + d->offset;
   *size = vk_buffer_range(&d->buffer->vk, d->offset, d->range);
   /* A uniform block the shader declares larger than the range bound (std140 rounds up, or a block declared past
    * it): the memory's GPUBuffer has WG_MEMORY_PAD bytes past its end for it, the block at most that. */
   if (res->kind == WGSL_UNIFORM)
      *size = MIN2(MAX2(*size, res->size), d->buffer->mem->gpu_at + d->buffer->mem->size + wg_memory_pad(d->buffer->mem) - *at);
   /* WebGPU binds storage in whole words; a memory is whole words, so a range of an odd size has room for its last. */
   else
      *size = align64(*size, 4);
   return true;
}

/* The descriptor of a variant's shared words (`wg_share`) among an op_bind's sets. */
static const struct wg_descriptor *
share_descriptor(const struct op_bind *b, const struct wg_program *p, const struct wg_share *sh)
{
   const int s = sh->set;
   if (s < 0 || s < b->group || s - b->group >= WG_GROUP_SETS || (sh->res >> 16) != b->group)
      return NULL;
   const struct wg_descriptor_set *set = b->sets[s - b->group];
   const uint32_t slot = (sh->res & 0xffff) / 2 - p->set_base[s];
   return set && slot < set->layout->slot_count ? &set->slots[slot] : NULL;
}

/* The bytes resource `k` of an op_bind's program binds (buffer_binding's), or, where others' words share its binding
 * (`wg_share`), all of theirs in its buffer: from the first's place to the last's end, within what a binding takes. */
static bool
binding_range(const struct op_bind *b, const struct wg_program *p, uint32_t k, const struct wg_descriptor *d,
              uint32_t *buffer, VkDeviceSize *at, VkDeviceSize *size)
{
   if (!buffer_binding(p, k, d, buffer, at, size))
      return false;
   const uint32_t res = (uint32_t)p->resources[k].group << 16 | p->resources[k].binding;
   VkDeviceSize lo = *at, hi = *at + *size;
   bool shared = false;
   for (uint32_t i = 0; i < p->share_count; i++)
      if (p->share[i].to == res && p->share[i].whole) {
         /* Its memory's whole (`whole_memory`). */
         const struct wg_device_memory *mem = whole_memory(d);
         if (mem) {
            *at = mem->gpu_at;
            *size = align64(mem->size, 4);
         }
         return true;
      }
   for (uint32_t i = 0; i < p->share_count; i++) {
      const struct wg_descriptor *m = p->share[i].to == res ? share_descriptor(b, p, &p->share[i]) : NULL;
      uint32_t mb;
      VkDeviceSize ma, ms;
      if (!m || !buffer_binding(p, k, m, &mb, &ma, &ms) || mb != *buffer)
         continue;
      lo = MIN2(lo, ma), hi = MAX2(hi, ma + ms);
      shared = true;
   }
   if (shared) {
      *at = lo;
      *size = MIN2(align64(hi - lo, 4), wg_limits.max_storage_buffer_binding_size & ~3ull);
   }
   return true;
}

static void
use(struct replay *r, uint32_t buffer, double at, double size, bool writable)
{
   if (buffer)
      util_dynarray_append_typed(&r->uses, struct scope_use, ((struct scope_use){ buffer, writable, at, size, false }));
}

/* A tracked image's subresources used in its texture `alias` (0 its own) or words (WG_IMAGE_WORDS): their bytes copied
 * there from a place that holds them where this one doesn't (the encoder's order, so outside a pass; bytes for bytes,
 * as views see them); written, only this one holds them after. */
static void
image_use(struct replay *r, const struct op_image_use *u)
{
   struct wg_image *image = u->image;
   if (!image->valid)
      return;
   const struct wg_image_plane *plane = &image->planes[u->plane];
   const uint32_t bit = 1u << u->alias;
   for (uint32_t m = u->level; m < u->level + u->levels; m++)
      for (uint32_t l = u->layer; l < u->layer + u->layers; l++) {
         uint16_t *v = wg_image_valid(image, u->plane, m, l);
         if (!(*v & bit) && !u->discard) {
            const uint32_t from = ffs(*v) - 1;
            const bool to_words = u->alias == WG_IMAGE_WORDS, from_words = from == WG_IMAGE_WORDS;
            const struct wg_texture_format *f = from && !from_words ? image->aliases[from - 1].fmt : plane->fmt;
            const uint32_t src = from && !from_words ? image->aliases[from - 1].tex : plane->tex;
            const uint32_t dst = u->alias && !to_words ? image->aliases[u->alias - 1].tex : plane->tex;
            const uint32_t w = u_minify(image->plane_count > 1 ? plane->extent.width : image->vk.extent.width, m);
            const uint32_t h = u_minify(image->plane_count > 1 ? plane->extent.height : image->vk.extent.height, m);
            const uint32_t d = image->vk.image_type == VK_IMAGE_TYPE_3D ? u_minify(image->vk.extent.depth, m) : 1;
            const uint32_t cols = DIV_ROUND_UP(w, f->bw), rows = DIV_ROUND_UP(h, f->bh);
            const double bytes = (double)cols * rows * d * f->bytes;
            if (wg_emul_skip & (to_words || from_words ? WG_SKIP_WORDS : WG_SKIP_VIEWS)) {
               /* A/B (`?gpu=vkskip=`): its bytes left as they are, the place counted up to date. */
            } else if (to_words || from_words) {
               end_pass(r);
               wg_emul[WG_EMUL_WORDS_COPIES]++;
               wg_emul[WG_EMUL_WORDS_BYTES] += bytes;
               const uint32_t words = wg_image_words(image), row = wg_image_row_bytes(image, m);
               const double at = image->words_at[m] + (double)row * rows * l;
               if (to_words)
                  gpu_copy_tb(words, at, row, rows, src, m, 0, 0, l, cols * f->bw, rows * f->bh, d, 0);
               else
                  gpu_copy_bt(words, at, row, rows, dst, m, 0, 0, l, cols * f->bw, rows * f->bh, d, 0);
            } else {
               end_pass(r);
               wg_emul[WG_EMUL_VIEW_COPIES]++;
               wg_emul[WG_EMUL_VIEW_BYTES] += bytes;
               gpu_copy_tt(src, m, 0, 0, l, dst, m, 0, 0, l, cols * f->bw, rows * f->bh, d, 0, cols * f->bw,
                           rows * f->bh, cols, rows, f->bytes);
            }
            *v |= bit;
         }
         if (u->write)
            *v = bit;
      }
}

/* The images a bind group binds, for `scope_images`. */
static void
bind_images(struct replay *r, const struct op_bind *b)
{
   const struct wg_program *p = b->program;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      if (res->group != b->group ||
          (res->kind != WGSL_TEXTURE && res->kind != WGSL_STORAGE_TEXTURE && !res->image_words))
         continue;
      const struct wg_descriptor *d = bound_descriptor(b, p, k);
      const struct wg_image_view *v = d ? d->view : NULL;
      struct wg_image *image = v ? container_of(v->vk.image, struct wg_image, vk) : NULL;
      if (!image || !image->valid)
         continue;
      const bool is3d = image->vk.image_type == VK_IMAGE_TYPE_3D;
      const bool write = res->image_words ? res->written : res->kind == WGSL_STORAGE_TEXTURE && res->access != WGSL_ACCESS_READ;
      for (uint32_t i = 0; i < MAX2(v->plane_count, 1); i++)
         util_dynarray_append_typed(&r->images, struct op_image_use,
                                    ((struct op_image_use){ image, v->first_plane + i,
                                                            res->image_words ? WG_IMAGE_WORDS : v->alias, v->vk.base_mip_level,
                                                            v->vk.level_count, is3d ? 0 : v->vk.base_array_layer,
                                                            is3d ? 1 : v->vk.layer_count, write }));
   }
}

/* A scope's images: all of them brought up to date first, then what it writes held by its texture alone (a scope may
 * read a subresource in one texture and write another's). */
static void
scope_images(struct replay *r)
{
   util_dynarray_foreach (&r->images, struct op_image_use, u) {
      struct op_image_use read = *u;
      read.write = false;
      image_use(r, &read);
   }
   util_dynarray_foreach (&r->images, struct op_image_use, u)
      if (u->write)
         image_use(r, u);
   util_dynarray_clear(&r->images);
}

/* The binding of a program's storage resource in a run of `wg_storage_alias`, if it is in one. */
static const struct wg_storage_alias *
storage_alias(const struct wg_program *p, uint32_t k)
{
   const uint32_t res = (uint32_t)p->resources[k].group << 16 | p->resources[k].binding;
   for (uint32_t i = 0; i < p->alias_count; i++)
      if (p->aliases[i].res == res)
         return &p->aliases[i];
   return NULL;
}

/* The buffers a bind group binds, at its dynamic offsets (which go by resource, as record_sets puts them). */
static void
bind_uses(struct replay *r, const struct op_bind *b)
{
   const struct wg_program *p = b->program;
   uint32_t n = 0;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      if (res->group != b->group)
         continue;
      const uint32_t dynamic = p->dynamic[k] >= 0 && n < b->offset_count ? b->offsets[n] : 0;
      n += p->dynamic[k] != -1;
      if ((res->kind != WGSL_UNIFORM && res->kind != WGSL_STORAGE && res->kind != WGSL_STORAGE_READ) ||
          p->dynamic[k] == WG_DYNAMIC_PUSH)
         continue;
      const int region = wgsl_address_region(res->group, res->binding);
      if (region >= 0) {
         util_dynarray_append_typed(&r->uses, struct scope_use,
                                    ((struct scope_use){ wg_address_buffer(r->dev, region), res->kind == WGSL_STORAGE, 0,
                                                         r->dev->address_size[region], true }));
         continue;
      }
      const struct wg_descriptor *d = bound_descriptor(b, p, k);
      uint32_t buffer;
      VkDeviceSize at, size;
      if (!d || !binding_range(b, p, k, d, &buffer, &at, &size))
         continue;
      const struct wg_storage_alias *a = storage_alias(p, k);
      if (res->kind == WGSL_UNIFORM && size < res->size && d->type != VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK)
         util_dynarray_append_typed(&r->uses, struct scope_use,
                                    ((struct scope_use){ buffer, false, (double)at + dynamic, size, false, res->size }));
      else if (!a || a->res == a->to)
         use(r, buffer, (double)at + dynamic, a ? a->reach : size, res->kind == WGSL_STORAGE);
   }
}

/* Whether a program declares a uniform block larger than what a memory's GPUBuffer has past its end (`scope_use.need`). */
static bool
has_big_uniform(const struct wg_program *p)
{
   for (uint32_t k = 0; p && k < p->resource_count; k++)
      if (p->resources[k].kind == WGSL_UNIFORM && p->dynamic[k] != WG_DYNAMIC_PUSH && p->resources[k].size > WG_MEMORY_PAD)
         return true;
   return false;
}

static bool
has_writable(const struct wg_program *p)
{
   for (uint32_t k = 0; p && k < p->resource_count; k++)
      if (p->resources[k].kind == WGSL_STORAGE)
         return true;
   return false;
}

/* The render pass's uses (from `p` on, the pass's commands): every draw's bind groups, vertex and index buffers and
 * indirect arguments, each binding once. */
static void
scan_pass(struct replay *r, struct scan *s, const uint8_t *p, const uint8_t *end, bool top)
{
   while (p < end) {
      const struct op_head *h = (const void *)p;
      const void *d = h + 1;
      p += sizeof(*h) + h->size;
      if (top && (h->op == OP_PASS || h->op == OP_PASS_END))
         break;
      switch ((enum op)h->op) {
      case OP_PIPELINE:
         s->group_count = ((const struct op_pipeline *)d)->program->group_count;
         break;
      case OP_BIND: {
         const struct op_bind *b = d;
         if (!b->compute)
            s->binds[b->group] = b, s->added[b->group] = false;
         break;
      }
      case OP_VB: {
         const struct op_vb *v = d;
         s->vb[v->slot] = *v;
         s->vb_mask |= 1u << v->slot;
         s->vb_added &= ~(1u << v->slot);
         break;
      }
      case OP_IB:
         memcpy(&s->ib, d, sizeof(s->ib));
         s->have_ib = true;
         s->ib_added = false;
         break;
      case OP_XFB:
         if (((const struct op_xfb *)d)->kind != 1)
            break;
         FALLTHROUGH;
      case OP_DRAW:
      case OP_DRAW_INDEXED:
      case OP_PROVOKE:
      case OP_DRAW_INDIRECT:
         for (uint32_t g = 0; g < s->group_count; g++)
            if (s->binds[g] && !s->added[g]) {
               bind_uses(r, s->binds[g]);
               util_dynarray_append_typed(&r->scope_binds, const struct op_bind *, s->binds[g]);
               if (r->dev->aliased)
                  bind_images(r, s->binds[g]);
               s->added[g] = true;
            }
         u_foreach_bit (v, s->vb_mask & ~s->vb_added)
            use(r, s->vb[v].buffer, s->vb[v].offset, s->vb[v].size, false);
         s->vb_added = s->vb_mask;
         if (s->have_ib && !s->ib_added)
            use(r, s->ib.buffer, s->ib.offset, s->ib.size, false);
         s->ib_added = true;
         if (h->op == OP_DRAW_INDIRECT) {
            const struct op_indirect *a = d;
            use(r, a->buffer, a->offset, (a->count - 1) * (double)a->stride + (a->indexed ? 20 : 16), false);
            if (a->count_buffer)
               use(r, a->count_buffer, a->count_offset, 4, false);
         }
         break;
      case OP_EXEC: {
         const struct wg_cmd_buffer *sec = *(struct wg_cmd_buffer *const *)d;
         scan_pass(r, s, sec->cmds.data, (const uint8_t *)sec->cmds.data + sec->cmds.size, false);
         break;
      }
      default:
         break;
      }
   }
}

/* The shadow of a range: the one read, or with `written` the one a writable binding of it writes. */
static const struct shadow *
find_shadow(const struct replay *r, uint32_t buffer, double at, double size, bool written)
{
   util_dynarray_foreach (&r->shadows, struct shadow, s)
      if (s->buffer == buffer && s->at == at && s->size == size && s->written == written)
         return s;
   return NULL;
}

/* Whether a use reads a buffer the scope binds writable too. */
static bool
conflicts(const struct replay *r, const struct scope_use *u)
{
   if (u->need > u->size)
      return true;
   /* The pointers' binding is the whole address buffer, so a writable descriptor of it would alias it, which WebGPU
    * refuses: that one goes to a shadow and comes back at the scope's end (bytes reached both ways in one scope don't
    * see each other), and reads conflict only with pointers that write. */
   if (r->address_use && wg_address_region_of(r->dev, u->buffer) >= 0)
      return !u->address && (u->writable || r->address_use == 2);
   if (u->writable)
      return false;
   util_dynarray_foreach (&r->written, uint32_t, w)
      if (*w == u->buffer)
         return true;
   return false;
}

/* Whether the scope's uses read a buffer they bind writable too (`written` made). */
static bool
scope_conflicts(struct replay *r)
{
   util_dynarray_clear(&r->written);
   r->address_use = 0;
   util_dynarray_foreach (&r->uses, struct scope_use, u) {
      if (u->address)
         r->address_use = MAX2(r->address_use, u->writable ? 2 : 1);
      bool known = !u->writable;
      util_dynarray_foreach (&r->written, uint32_t, w)
         known |= *w == u->buffer;
      if (!known)
         util_dynarray_append_typed(&r->written, uint32_t, u->buffer);
   }
   bool tails = false;
   util_dynarray_foreach (&r->uses, struct scope_use, u)
      tails |= u->need > u->size;
   if (!util_dynarray_num_elements(&r->written, uint32_t) && !tails)
      return false;
   util_dynarray_foreach (&r->uses, struct scope_use, u)
      if (conflicts(r, u))
         return true;
   return false;
}

/* Binds the groups bound at `point` again, with the scope's shadows (their readbacks taken at their own binds). */
static void bind(struct replay *r, const struct op_bind *b);
static void
rebind(struct replay *r, uint32_t point, uint32_t count)
{
   r->no_readback = true;
   for (uint32_t g = 0; g < count; g++)
      if (r->binds[point][g])
         bind(r, r->binds[point][g]);
   r->no_readback = false;
}

/* A place of `size` bytes in a shadow buffer (`written`: the one for shadows a scope writes), 256-aligned (WebGPU's
 * binding offsets). Places are taken in order within a submit, so none is written again before the scope that reads
 * it; a buffer too small is replaced by one twice as large (or large enough), the old one destroyed once this submit is
 * encoded. */
static bool
shadow_place(struct wg_device *dev, bool written, double size, uint32_t *to, double *place)
{
   const uint64_t bytes = align64((uint64_t)size, 256), most = wg_limits.max_buffer_size & ~255ull;
   if (bytes > most)
      return false;
   if (!dev->shadow[written] || dev->shadow_used[written] + bytes > dev->shadow_size[written]) {
      if (dev->shadow[written])
         util_dynarray_append_typed(&released_groups, uint32_t, dev->shadow[written]);
      uint64_t grown = MAX2(dev->shadow_size[written] * 2, 1u << 20);
      while (grown < bytes)
         grown *= 2;
      dev->shadow_size[written] = MIN2(grown, most);
      struct wg_json j = { 0 };
      /* COPY_DST | INDEX | VERTEX | UNIFORM | STORAGE | INDIRECT */
      wg_json_printf(&j, "{\"size\":%llu,\"usage\":%u}", (unsigned long long)dev->shadow_size[written], 0x1fc);
      dev->shadow[written] = wg_create_json(WG_KIND_BUFFER, &j);
      dev->shadow_used[written] = 0;
   }
   *to = dev->shadow[written];
   *place = (double)dev->shadow_used[written];
   dev->shadow_used[written] += bytes;
   return true;
}

static int
cmp_span(const void *a, const void *b)
{
   const double *x = a, *y = b;
   for (uint32_t i = 0; i < 4; i++)
      if (x[i] != y[i])
         return x[i] < y[i] ? -1 : 1;
   return 0;
}

/* Copies the scope's reads of buffers it binds writable too into shadows (outside any pass); whether there are any.
 * Each buffer's read ranges are merged where they overlap (draws reading a big buffer at many offsets, each to its
 * end, copy it once), each span from 256 bytes below its first range, so a binding's offset keeps its alignment. The
 * shadows a scope writes are apart from those it reads, by span and by GPUBuffer. */
static bool
scope_shadows(struct replay *r)
{
   util_dynarray_clear(&r->shadows);
   struct util_dynarray spans; /* (buffer, written, lo, hi) */
   util_dynarray_init(&spans, NULL);
   util_dynarray_foreach (&r->uses, struct scope_use, u)
      if (conflicts(r, u) && u->need <= u->size) {
         const double span[4] = { u->buffer, u->writable, floor(u->at / 256) * 256, u->at + u->size };
         util_dynarray_append_array(&spans, double, span, 4);
      }
   const uint32_t n = util_dynarray_num_elements(&spans, double) / 4;
   double *v = spans.data;
   qsort(v, n, 4 * sizeof(double), cmp_span);
   for (uint32_t i = 0; i < n;) {
      double lo = v[4 * i + 2], hi = v[4 * i + 3];
      const uint32_t first = i;
      for (i++; i < n && v[4 * i] == v[4 * first] && v[4 * i + 1] == v[4 * first + 1] && v[4 * i + 2] <= hi; i++)
         hi = MAX2(hi, v[4 * i + 3]);
      const bool written = v[4 * first + 1] != 0;
      uint32_t to;
      double place;
      if (!shadow_place(r->dev, written, hi - lo, &to, &place)) {
         static bool warned;
         if (!warned)
            fprintf(stderr, "wg: a range read beside storage written in one usage scope is too large to copy\n");
         warned = true;
         continue;
      }
      const uint32_t buffer = (uint32_t)v[4 * first];
      gpu_copy_bb(buffer, lo, to, place, hi - lo);
      wg_emul[WG_EMUL_SHADOW_COPIES]++;
      wg_emul[WG_EMUL_SHADOW_BYTES] += hi - lo;
      util_dynarray_foreach (&r->uses, struct scope_use, u)
         if (u->buffer == buffer && u->writable == written && u->at >= lo && u->at + u->size <= hi && conflicts(r, u) &&
             u->need <= u->size && !find_shadow(r, u->buffer, u->at, u->size, written))
            util_dynarray_append_typed(&r->shadows, struct shadow,
                                       ((struct shadow){ buffer, to, u->at, u->size, place + (u->at - lo), written }));
   }
   util_dynarray_fini(&spans);
   /* Uniform blocks past what their GPUBuffer has: a place of the block's size, the range's bytes copied in (what's
    * past the range is out of bounds: Vulkan reads it as anything in range, or 0). */
   util_dynarray_foreach (&r->uses, struct scope_use, u) {
      if (u->need <= u->size || find_shadow(r, u->buffer, u->at, u->size, false))
         continue;
      uint32_t to;
      double place;
      if (!shadow_place(r->dev, false, u->need, &to, &place)) {
         static bool warned;
         if (!warned)
            fprintf(stderr, "wg: a uniform block declared past its memory is too large to copy\n");
         warned = true;
         continue;
      }
      const double bytes = floor(u->size / 4) * 4;
      if (bytes)
         gpu_copy_bb(u->buffer, u->at, to, place, bytes);
      wg_emul[WG_EMUL_SHADOW_COPIES]++;
      wg_emul[WG_EMUL_SHADOW_BYTES] += bytes;
      util_dynarray_append_typed(&r->shadows, struct shadow, ((struct shadow){ u->buffer, to, u->at, u->size, place, false }));
   }
   return util_dynarray_num_elements(&r->shadows, struct shadow) != 0;
}

/* A group's parameter table (WGSL_TABLE_BINDING, resource `t` of `p`): two vec4s at each texel buffer's and storage
 * image as words' binding, from the descriptors `b` binds (a texel buffer view's, wg_CreateBufferView; a view's words'
 * place, `view_words`). A buffer of its own, written now: the descriptors don't change under a bind group of them. */
static uint32_t
param_table(const struct op_bind *b, const struct wg_program *p, uint32_t t)
{
   const uint32_t size = p->resources[t].size;
   uint32_t *words = calloc(1, size);
   for (uint32_t k = 0; words && k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      if (res->group != b->group || WGSL_TABLE_SIZE(res->binding) > size)
         continue;
      const struct wg_descriptor *d = bound_descriptor(b, p, k);
      if (!d)
         continue;
      uint32_t *at = words + 4 * res->binding;
      if ((d->type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) &&
          d->texel && d->texel->offered) {
         memcpy(at, d->texel->params, sizeof(d->texel->params));
      } else if (d->type == VK_DESCRIPTOR_TYPE_STORAGE_IMAGE && res->image_words && d->view) {
         uint32_t buffer;
         VkDeviceSize place, bytes;
         view_words(d->view, &buffer, &place, &bytes, at);
      }
   }
   /* Shared words (`wg_share`): each one's parameters (a texel buffer's) at its binding, and its first word in the binding
    * it reads through at their vec4's w. */
   for (uint32_t i = 0; words && i < p->share_count; i++) {
      const struct wg_share *sh = &p->share[i];
      const struct wg_descriptor *d = share_descriptor(b, p, sh);
      uint32_t to = 0;
      while (to < p->resource_count && ((uint32_t)p->resources[to].group << 16 | p->resources[to].binding) != sh->to)
         to++;
      if (sh->whole == WG_SHARE_ADDRESS) {
         /* Through the pointers' binding, the region's whole (`address_shares`): its place there and its length. */
         uint32_t buffer;
         VkDeviceSize place, bytes;
         if (d && to < p->resource_count && WGSL_TABLE_SIZE(sh->res & 0xffff) <= size &&
             buffer_binding(p, to, d, &buffer, &place, &bytes)) {
            uint32_t *at = words + 4 * (sh->res & 0xffff);
            at[2] = (uint32_t)(bytes / 4);
            at[3] = (uint32_t)(place / 4);
         }
         continue;
      }
      /* A whole memory's place is from its start; a run's, from its first byte (its group's: this one's). */
      const struct wg_descriptor *dt = to < p->resource_count && !sh->whole ? bound_descriptor(b, p, to) : NULL;
      if (!d || (!dt && !sh->whole) || to == p->resource_count || WGSL_TABLE_SIZE(sh->res & 0xffff) > size)
         continue;
      uint32_t *at = words + 4 * (sh->res & 0xffff);
      if ((d->type == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) &&
          d->texel && d->texel->offered)
         memcpy(at, d->texel->params, sizeof(d->texel->params));
      uint32_t buffer, run;
      VkDeviceSize place, bytes, lo, reach;
      const struct wg_device_memory *mem = sh->whole ? whole_memory(d) : NULL;
      if (!buffer_binding(p, to, d, &buffer, &place, &bytes))
         continue;
      if (mem && place >= mem->gpu_at)
         at[3] = (uint32_t)((place - mem->gpu_at) / 4);
      else if (dt && binding_range(b, p, to, dt, &run, &lo, &reach) && buffer == run && place >= lo)
         at[3] = (uint32_t)((place - lo) / 4);
   }
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", size, 0x40 | 0x8); /* UNIFORM | COPY_DST */
   const uint32_t table = wg_create_json(WG_KIND_BUFFER, &j);
   if (words)
      gpu_write(table, 0, words, size);
   free(words);
   return table;
}

/* A bind group for an op_bind, with `offsets` (the op_bind's) patched where a binding reads a shadow (its dynamic
 * offset is the shadow's place's, so 0). `transient`: released once the submit is encoded; `shadowed`: it reads a
 * shadow (a group of the scope's own). */
static bool read_copied(const struct replay *r, const struct wg_image_view *v);
static uint32_t
bind_group(struct replay *r, const struct op_bind *b, uint32_t *offsets, bool *transient, bool *shadowed)
{
   struct wg_program *p = b->program;
   const uint32_t bgl = p->bgl[b->group], bgl_uid = p->bgl_uid[b->group];
   *transient = *shadowed = false;
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
   /* The address buffer grown: groups of it are of the old buffer. */
   if (holder && r->dev->address_gen) {
      const uint32_t words[2] = { version, r->dev->address_gen };
      version = _mesa_hash_data(words, sizeof(words)) | 1u << 31;
   }
   /* A group of dynamic buffers past WebGPU's binds them at their offsets: a group each (`wg_bake_dynamic`). */
   if (holder) {
      uint32_t n = 0, words[1 + 32] = { version };
      bool baked = false;
      for (uint32_t k = 0, i = 0; k < p->resource_count; k++) {
         if (p->resources[k].group != b->group || p->dynamic[k] == -1)
            continue;
         if (p->baked[k] && i < b->offset_count)
            words[1 + n++] = b->offsets[i], baked = true;
         i++;
      }
      if (baked)
         version = _mesa_hash_data(words, 4 * (1 + n)) | 1u << 31;
   }
   /* A group reading a shadow is the scope's own. */
   if (util_dynarray_num_elements(&r->shadows, struct shadow)) {
      uint32_t n = 0;
      for (uint32_t k = 0; k < p->resource_count && !*shadowed; k++) {
         const struct wgsl_resource *res = &p->resources[k];
         if (res->group != b->group)
            continue;
         const uint32_t dynamic = p->dynamic[k] >= 0 && n < b->offset_count ? b->offsets[n] : 0;
         n += p->dynamic[k] != -1;
         if ((res->kind != WGSL_UNIFORM && res->kind != WGSL_STORAGE_READ && res->kind != WGSL_STORAGE) ||
             p->dynamic[k] == WG_DYNAMIC_PUSH)
            continue;
         const struct wg_descriptor *d = bound_descriptor(b, p, k);
         uint32_t buffer;
         VkDeviceSize at, size;
         const bool bound = d && binding_range(b, p, k, d, &buffer, &at, &size);
         const struct wg_storage_alias *a = bound ? storage_alias(p, k) : NULL;
         *shadowed = bound && find_shadow(r, buffer, (double)at + dynamic, a ? a->reach : size, res->kind == WGSL_STORAGE);
      }
   }
   /* Bindings a program's run of storage aliases binds for all of it: not the set's. */
   *shadowed |= p->alias_count != 0;
   /* In a multiview or layered pass an input attachment reads its view's layer (declared 2D, its binding that layer): a
    * group a view, like a scope's own. */
   for (uint32_t k = 0; r->view_mask && k < p->resource_count && !*shadowed; k++) {
      const struct wg_descriptor *d = p->resources[k].group == b->group && p->resources[k].kind == WGSL_TEXTURE
                                         ? bound_descriptor(b, p, k) : NULL;
      *shadowed = d && d->type == VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT;
   }
   /* Likewise one reading a copy of an attachment of its pass (`feedback_copies`). */
   for (uint32_t k = 0; r->atts.count && k < p->resource_count && !*shadowed; k++) {
      const struct wg_descriptor *d = p->resources[k].group == b->group && p->resources[k].kind == WGSL_TEXTURE
                                         ? bound_descriptor(b, p, k) : NULL;
      *shadowed = d && feedback_att(r, d) >= 0;
   }
   /* Or a view a scope's copy stands in for (`scope_reads`). */
   for (uint32_t k = 0; util_dynarray_num_elements(&r->read_copies, struct wg_image_view *) && k < p->resource_count && !*shadowed; k++) {
      const struct wg_descriptor *d = p->resources[k].group == b->group && p->resources[k].kind == WGSL_TEXTURE
                                         ? bound_descriptor(b, p, k) : NULL;
      *shadowed = d && d->view && read_copied(r, d->view);
   }
   uint32_t group = 0;
   if (holder && !*shadowed)
      for (uint32_t i = 0; i < WG_SET_GROUPS; i++)
         if (holder->groups[i].group && holder->groups[i].bgl == bgl_uid && holder->groups[i].version == version) {
            group = holder->groups[i].group;
            goto found;
         }
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"layout\":%u,\"entries\":[", bgl);
   uint32_t table = 0; /* the group's parameter table: released with it */
   bool first = true, push_only = b->group == WGSL_MAX_GROUPS - 1 && p->push_ubo_size;
   uint32_t n = 0;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      if (res->group != b->group)
         continue;
      const uint32_t dyn_index = n;
      const uint32_t dynamic = p->dynamic[k] >= 0 && n < b->offset_count ? b->offsets[n] : 0;
      n += p->dynamic[k] != -1;
      const char *sep = first ? "" : ",";
      if (p->dynamic[k] == WG_DYNAMIC_PUSH) {
         wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":0,\"size\":%u}", sep, res->binding,
                        push_buffer(r->dev), align(p->push_ubo_size, 16));
         first = false;
         continue;
      }
      push_only = false;
      const int region = wgsl_address_region(res->group, res->binding);
      if (region >= 0) {
         wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":0,\"size\":%llu}", sep, res->binding,
                        wg_address_buffer(r->dev, region), (unsigned long long)r->dev->address_size[region]);
         first = false;
         continue;
      }
      if (res->binding == WGSL_TABLE_BINDING && res->kind == WGSL_UNIFORM) {
         table = param_table(b, p, k);
         wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":0,\"size\":%u}", sep, res->binding, table,
                        res->size);
         first = false;
         continue;
      }
      const struct wg_descriptor *d = bound_descriptor(b, p, k);
      if (!d)
         continue;
      switch (res->kind) {
      case WGSL_UNIFORM:
      case WGSL_STORAGE:
      case WGSL_STORAGE_READ: {
         uint32_t buffer;
         VkDeviceSize at, size;
         if (!binding_range(b, p, k, d, &buffer, &at, &size))
            continue;
         const struct wg_storage_alias *a = res->kind == WGSL_STORAGE ? storage_alias(p, k) : NULL;
         if (a && a->res != a->to) {
            /* Unused by the variant's text; a binding must be there, and not of what the run's first writes. */
            if (!r->dev->alias_dummy) {
               struct wg_json dummy = { 0 };
               wg_json_printf(&dummy, "{\"size\":%u,\"usage\":128}", 256 * 8);
               r->dev->alias_dummy = wg_create_json(WG_KIND_BUFFER, &dummy);
            }
            wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":%u,\"size\":256}", sep, res->binding,
                           r->dev->alias_dummy, (uint32_t)(a - p->aliases) * 256);
            if (p->dynamic[k] >= 0 && dyn_index < b->offset_count)
               offsets[dyn_index] = 0;
            break;
         }
         if (a)
            size = a->reach;
         const struct shadow *s = *shadowed ? find_shadow(r, buffer, (double)at + dynamic, size, res->kind == WGSL_STORAGE) : NULL;
         if (s) {
            buffer = s->to;
            at = (VkDeviceSize)s->place;
            /* A uniform block past its memory's GPUBuffer: its shadow has room for the block. */
            if (res->kind == WGSL_UNIFORM)
               size = MAX2(size, res->size);
            if (p->dynamic[k] >= 0 && dyn_index < b->offset_count)
               offsets[dyn_index] = 0;
         } else if (p->baked[k]) {
            /* A dynamic buffer past WebGPU's: at its offset (`wg_bake_dynamic`). */
            at += dynamic;
         }
         wg_json_printf(&j, "%s{\"binding\":%u,\"buffer\":%u,\"offset\":%llu,\"size\":%llu}", sep, res->binding,
                        buffer, (unsigned long long)at, (unsigned long long)size);
         break;
      }
      case WGSL_SAMPLER:
      case WGSL_SAMPLER_COMPARE:
         if (!d->sampler)
            continue;
         wg_json_printf(&j, "%s{\"binding\":%u,\"sampler\":%u}", sep, res->binding,
                        res->nonfiltering && d->sampler->nearest ? d->sampler->nearest : d->sampler->id);
         break;
      default: {
         if (!d->view)
            continue;
         const int fa = res->kind == WGSL_TEXTURE ? feedback_att(r, d) : -1;
         /* A sampled view covering an attachment: the same views, of the image's copy (`feedback_copies`). */
         const struct wg_image_view *v = (fa >= 0 && d->type != VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT) ||
                                               (res->kind == WGSL_TEXTURE && read_copied(r, d->view))
                                            ? wg_view_loop(d->view)
                                            : d->view;
         wg_json_printf(&j, "%s{\"binding\":%u,\"view\":%u}", sep, res->binding,
                        fa >= 0 && v == d->view ? wg_view_twin(d->view)
                        : r->view_mask && d->type == VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT &&
                              r->view < d->view->vk.layer_count ? wg_view_att(d->view, r->view)
                        : (res->kind == WGSL_STORAGE_TEXTURE || res->image_texture) && v->flat_storage &&
                              res->dim == WGSL_DIM_2D                                     ? v->flat_storage
                        : (res->kind == WGSL_STORAGE_TEXTURE || res->image_texture) && v->storage ? v->storage
                        : res->image_texture                                          ? v->view
                        : d->plane && d->plane < v->plane_count                       ? v->planes[d->plane]
                        : res->kind != WGSL_TEXTURE                                   ? v->view
                        : v->flat && res->dim == WGSL_DIM_2D && !res->multisampled    ? v->flat
                        : v->faces && res->dim == WGSL_DIM_2D_ARRAY                   ? v->faces
                        : v->sampled                                                  ? v->sampled
                                                                                      : v->view);
         break;
      }
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
      *transient = true; /* an empty group, or the pointers' alone: released once the submit is encoded */
      if (table)
         util_dynarray_append_typed(&released_groups, uint32_t, table);
      if (res_written(p, b->group))
         goto found;
      return group;
   }
   if (*shadowed) {
      *transient = true;
      if (table)
         util_dynarray_append_typed(&released_groups, uint32_t, table);
   } else {
      const uint32_t i = holder->next_group++ % WG_SET_GROUPS;
      if (holder->groups[i].group)
         util_dynarray_append_typed(&released_groups, uint32_t, holder->groups[i].group);
      if (holder->groups[i].table)
         util_dynarray_append_typed(&released_groups, uint32_t, holder->groups[i].table);
      holder->groups[i].group = group;
      holder->groups[i].table = table;
      holder->groups[i].bgl = bgl_uid;
      holder->groups[i].version = version;
   }
found:
   /* What shaders may write in host-visible memory is read back after the submit, at its dynamic offset if it has one
    * (the group's offsets go by resource, as record_sets puts them). Once a group: not when the scope's end binds it
    * again without its shadows. */
   if (r->no_readback)
      return group;
   n = 0;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      if (res->group != b->group)
         continue;
      const uint32_t dynamic = p->dynamic[k] >= 0 && n < b->offset_count ? b->offsets[n] : 0;
      n += p->dynamic[k] != -1;
      if (res->kind != WGSL_STORAGE || !res->written)
         continue;
      /* Written through pointers, wherever they lead. */
      const int region = wgsl_address_region(res->group, res->binding);
      if (region >= 0) {
         list_for_each_entry (struct wg_device_memory, mem, &r->dev->address_memories, address_link)
            if (mem->host && mem->region == region)
               readback(r, mem, 0, mem->size);
         continue;
      }
      const struct wg_descriptor *d = bound_descriptor(b, p, k);
      if (d && d->type == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER) {
         if (d->texel && d->texel->mem && d->texel->mem->host)
            readback(r, d->texel->mem, d->texel->at - d->texel->mem->gpu_at, d->texel->size);
         continue;
      }
      if (d && d->buffer && d->buffer->mem && d->buffer->mem->host)
         readback(r, d->buffer->mem, d->buffer->mem_offset + d->offset + dynamic,
                  vk_buffer_range(&d->buffer->vk, d->offset, d->range));
   }
   return group;
}

/* The WebGPU render pass of the Vulkan one being replayed. `keep`: 0 as its JSON says, 1 storing every attachment (a
 * later part goes on from them), 2 as a later part: loading and storing. */
static void
begin_pass(struct replay *r, uint32_t keep)
{
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{");
   if (r->qpool)
      wg_json_printf(&j, "\"occlusionQuerySet\":%u,", r->qmux ? r->dev->query_mux : r->qpool->set);
   if (keep)
      wg_json_printf(&j, "\"keep\":%u,", keep);
   wg_json_printf(&j, "%s", r->pass_json + 1);
   gpu_render_pass(j.data, j.len);
   wg_json_free(&j);
   r->dirty = RD_ALL;
}

/* A query cut around something the pass mustn't count (a clear's draw, a part of the pass ended): it carries on in a
 * spare slot of the set (WebGPU can't take a query's index again in one pass), added to it at the resolve. Past the
 * spares, the query is reported as passing. */
static void
query_carry_on(struct replay *r, struct wg_query_pool *qp)
{
   if (r->qspares < qp->spares && query_count(r, qp, qp->vk.query_count + r->qspares, r->qactive)) {
      r->qspares++;
      return;
   }
   util_dynarray_foreach (&r->pass_queries, struct pass_query, q)
      if (q->pool == qp && q->index == r->qactive)
         q->passing = true;
   r->qactive_pool = NULL;
}

/* A feedback loop: WebGPU refuses a texture written and sampled in one render pass, and Vulkan lets an input attachment
 * read an attachment of its own pass. A draw that does reads a copy of the attachment (wg_image_view.twin), made in a
 * break of the WebGPU pass where it's stale: at the pass's first such draw, and after a barrier or clear inside it
 * (without one a draw's read of what its pass wrote is undefined). */
static void
feedback_copies(struct replay *r)
{
   const struct wg_program *p = r->program[0];
   struct wg_query_pool *qp = NULL;
   bool cut = false;
   for (uint32_t k = 0; p && k < p->resource_count; k++) {
      const struct wgsl_resource *res = &p->resources[k];
      const struct op_bind *b = res->kind == WGSL_TEXTURE ? r->binds[0][res->group] : NULL;
      const struct wg_descriptor *d = b ? bound_descriptor(b, p, k) : NULL;
      const int a = d ? feedback_att(r, d) : -1;
      const bool sampled = a >= 0 && d->type != VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT;
      struct wg_image_view *mark = sampled ? wg_view_loop(d->view) : a >= 0 ? d->view : NULL;
      if (!mark || mark->twin_mark == r->twin_mark)
         continue;
      const struct wg_image_view *att = r->atts.views[a];
      const VkExtent3D e = vk_image_mip_level_extent(att->vk.image, att->vk.base_mip_level);
      if (sampled) {
         /* The view's range, all of it: its levels and layers past the attachment's too (the copy is the image's
          * shape: a 3D level's depth whole). */
         const struct wg_image *image = container_of(d->view->vk.image, struct wg_image, vk);
         const struct wg_image_view *v = d->view;
         if (!(wg_emul_skip & WG_SKIP_FEEDBACK) && !cut) {
            qp = r->qactive_pool;
            if (qp)
               gpu_end_occlusion();
            gpu_pass_end();
            cut = true;
         }
         for (uint32_t l = v->vk.base_mip_level; !(wg_emul_skip & WG_SKIP_FEEDBACK) && l < v->vk.base_mip_level + v->vk.level_count; l++) {
            const VkExtent3D le = vk_image_mip_level_extent(&image->vk, l);
            const bool three = image->vk.image_type == VK_IMAGE_TYPE_3D;
            const uint32_t first = three ? 0 : v->vk.base_array_layer, count = three ? 1 : v->vk.layer_count;
            for (uint32_t layer = first; layer < first + count; layer++) {
               wg_emul[WG_EMUL_FEEDBACK_COPIES]++;
               wg_emul[WG_EMUL_FEEDBACK_BYTES] += (double)le.width * le.height * (three ? le.depth : 1) * image->fmt->bytes;
               gpu_copy_tt(image->tex, l, 0, 0, layer, image->loop_tex, l, 0, 0, layer, le.width, le.height,
                           three ? le.depth : 1, 0, le.width, le.height, le.width, le.height, image->fmt->bytes);
            }
         }
         mark->twin_mark = r->twin_mark;
         continue;
      }
      if (wg_emul_skip & WG_SKIP_FEEDBACK) {
         /* A/B (`?gpu=vkskip=`): the twin as it was. */
         wg_view_twin(d->view);
         d->view->twin_mark = r->twin_mark;
         continue;
      }
      wg_emul[WG_EMUL_FEEDBACK_COPIES]++;
      wg_emul[WG_EMUL_FEEDBACK_BYTES] += (double)e.width * e.height * att->fmt->bytes;
      if (!cut) {
         qp = r->qactive_pool;
         if (qp)
            gpu_end_occlusion();
         gpu_pass_end();
         cut = true;
      }
      const uint32_t layer = att->vk.base_array_layer + r->view;
      wg_view_twin(d->view);
      gpu_copy_tt(view_texture(att), att->vk.base_mip_level, 0, 0, layer, d->view->twin_tex, 0, 0, 0, 0, e.width, e.height,
                  1, 0, e.width, e.height, e.width, e.height, att->fmt->bytes);
      d->view->twin_mark = r->twin_mark;
   }
   if (cut) {
      begin_pass(r, 2);
      if (qp)
         query_carry_on(r, qp);
   }
}

/* A draw whose fragment stage reads the attachments it writes (VK4 T32: depth bounds, logic ops, advanced blends; the
 * pipeline's `wg_dst`): each read is of a copy made in a cut of the WebGPU pass before the draw, after every earlier
 * draw's writes (unlike an input attachment's, which a barrier renews). Overlapping primitives of one draw read what was
 * there before it. */
static void
dst_copies(struct replay *r)
{
   const struct wg_dst *dst = r->dst;
   struct wg_query_pool *qp = NULL;
   const bool skip = wg_emul_skip & WG_SKIP_FEEDBACK;
   if (!skip) {
      qp = r->qactive_pool;
      if (qp)
         gpu_end_occlusion();
      gpu_pass_end();
   }
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"layout\":%u,\"entries\":[", dst->bgl);
   const char *sep = "";
   for (uint32_t b = 0; b < 9; b++) {
      if (!dst->types[b])
         continue;
      struct wg_image_view *att = b == WG_DST_DEPTH_BINDING ? r->atts.depth : r->atts.colors[b];
      if (!att)
         continue;
      wg_view_twin(att);
      if (!skip) {
         const VkExtent3D e = vk_image_mip_level_extent(att->vk.image, att->vk.base_mip_level);
         const uint32_t layer = att->vk.base_array_layer + r->view;
         wg_emul[WG_EMUL_FEEDBACK_COPIES]++;
         wg_emul[WG_EMUL_FEEDBACK_BYTES] += (double)e.width * e.height * att->fmt->bytes;
         gpu_copy_tt(view_texture(att), att->vk.base_mip_level, 0, 0, layer, att->twin_tex, 0, 0, 0, 0, e.width, e.height,
                     1, 0, e.width, e.height, e.width, e.height, att->fmt->bytes);
      }
      wg_json_printf(&j, "%s{\"binding\":%u,\"view\":%u}", sep, b,
                     b == WG_DST_DEPTH_BINDING ? wg_view_twin_depth(att) : att->twin);
      sep = ",";
   }
   wg_json_printf(&j, "]}");
   r->dst_group = wg_create_json(WG_KIND_BIND_GROUP, &j);
   util_dynarray_append_typed(&released_groups, uint32_t, r->dst_group);
   if (!skip) {
      begin_pass(r, 2);
      if (qp)
         query_carry_on(r, qp);
   }
}

/* A barrier inside a render pass with shadows: what a draw reads through one is what the scope's start left, so a later
 * draw would miss what an earlier one wrote through storage. The WebGPU pass ends here, what was written in shadows goes
 * back, and the rest of the pass (from `p`) is a scope of its own. A barrier of a secondary command buffer doesn't cut:
 * the replay is inside its commands, and the scan needs the rest of the pass. */
static void scope_pass(struct replay *r, const uint8_t *p, const uint8_t *end);
static void
scope_cut(struct replay *r, const uint8_t *p, const uint8_t *end)
{
   struct wg_query_pool *qp = r->qactive_pool, *pool = r->qpool;
   wg_emul[WG_EMUL_SCOPE_CUTS]++;
   if (qp)
      gpu_end_occlusion();
   gpu_pass_end();
   r->pass = NONE;
   scope_end(r, 0);
   scope_pass(r, p, end);
   r->qpool = pool; /* a copy of the scope's ends what `end_pass` keeps of the pass */
   r->pass = RENDER;
   begin_pass(r, 2);
   if (qp)
      query_carry_on(r, qp);
}

/* Binds an op_bind's group at its point (with the scope's shadows, if it reads any). */
/* Whether the draw or dispatch (`point`) binds a storage image as words whose view's texels pass what a binding takes
 * (maxStorageBufferBindingSize, WebGPU's least 128 MiB: a 4096x4096 rgba16float level): refused, said once, its submit
 * kept (VK4 T37: an invalid bind group lost it). A binding a part would serve. */
static bool
words_past(const struct replay *r, uint32_t point)
{
   for (uint32_t g = 0; g < r->group_count[point]; g++)
      if (r->binds[point][g] && r->past[point][g]) {
         static bool said;
         if (!said)
            fprintf(stderr, "wg: a draw or dispatch refused: a storage image it reaches as words is past "
                            "maxStorageBufferBindingSize\n");
         said = true;
         return true;
      }
   return false;
}

static void
bind(struct replay *r, const struct op_bind *b)
{
   uint32_t offsets[32];
   memcpy(offsets, b->offsets, b->offset_count * 4);
   bool transient, shadowed;
   const uint32_t group = bind_group(r, b, offsets, &transient, &shadowed);
   if (transient)
      util_dynarray_append_typed(&released_groups, uint32_t, group);
   r->groups[b->compute][b->group].group = group;
   /* Without those of baked buffers (in the bind group: `wg_bake_dynamic`). */
   uint32_t n = 0;
   for (uint32_t k = 0, i = 0; k < b->program->resource_count && i < b->offset_count; k++) {
      if (b->program->resources[k].group != b->group || b->program->dynamic[k] == -1)
         continue;
      if (!b->program->baked[k])
         r->groups[b->compute][b->group].offsets[n++] = offsets[i];
      i++;
   }
   r->groups[b->compute][b->group].n = n;
   r->binds[b->compute][b->group] = b;
   r->shadowed[b->compute][b->group] = shadowed;
   r->past[b->compute][b->group] = false;
   for (uint32_t k = 0; k < b->program->resource_count; k++) {
      const struct wgsl_resource *res = &b->program->resources[k];
      const struct wg_descriptor *dk = res->group == b->group && res->image_words ? bound_descriptor(b, b->program, k) : NULL;
      if (dk && dk->type == VK_DESCRIPTOR_TYPE_STORAGE_IMAGE && dk->view) {
         uint32_t buffer, params[5];
         VkDeviceSize at, size;
         view_words(dk->view, &buffer, &at, &size, params);
         r->past[b->compute][b->group] |= size > wg_limits.max_storage_buffer_binding_size;
      }
   }
   r->dirty |= RD_GROUPS;
}

/* Whether a view's copy (wg_view_loop) stands in for it in this scope (`scope_reads`). */
static bool
read_copied(const struct replay *r, const struct wg_image_view *v)
{
   util_dynarray_foreach (&r->read_copies, struct wg_image_view *, c)
      if (*c == v)
         return true;
   return false;
}

/* Whether two views of one texture share a subresource. */
static bool
views_overlap(const struct wg_image_view *a, const struct wg_image_view *b)
{
   if (a->vk.image != b->vk.image || view_texture(a) != view_texture(b))
      return false;
   const bool three = a->vk.image->image_type == VK_IMAGE_TYPE_3D;
   return a->vk.base_mip_level < b->vk.base_mip_level + b->vk.level_count &&
          b->vk.base_mip_level < a->vk.base_mip_level + a->vk.level_count &&
          (three || (a->vk.base_array_layer < b->vk.base_array_layer + b->vk.layer_count &&
                     b->vk.base_array_layer < a->vk.base_array_layer + a->vk.layer_count));
}

/* A scope's reads of subresources as textures that it writes through storage bindings too (`scope_binds`): WebGPU
 * refuses a texture bound so in one usage scope (the dispatch or pass dropped with its submit), and Vulkan reads what
 * they held, or what the scope wrote after a barrier. Each such view's range is copied (outside any pass) into the
 * image's copy, which its binding reads in the scope (VK4 T37); whether there are any. A view of another format than the
 * image's (an alias texture), or of a plane, is left to WebGPU, said once. */
static bool
scope_reads(struct replay *r)
{
   util_dynarray_clear(&r->read_copies);
   struct util_dynarray writes; /* const struct wg_image_view * */
   util_dynarray_init(&writes, NULL);
   util_dynarray_foreach (&r->scope_binds, const struct op_bind *, bp) {
      const struct op_bind *b = *bp;
      for (uint32_t k = 0; k < b->program->resource_count; k++) {
         const struct wgsl_resource *res = &b->program->resources[k];
         if (res->group != b->group || res->kind != WGSL_STORAGE_TEXTURE || !(res->access & WGSL_ACCESS_WRITE))
            continue;
         const struct wg_descriptor *d = bound_descriptor(b, b->program, k);
         if (d && d->view)
            util_dynarray_append_typed(&writes, const struct wg_image_view *, d->view);
      }
   }
   util_dynarray_foreach (&r->scope_binds, const struct op_bind *, bp) {
      const struct op_bind *b = *bp;
      for (uint32_t k = 0; util_dynarray_num_elements(&writes, const struct wg_image_view *) && k < b->program->resource_count; k++) {
         const struct wgsl_resource *res = &b->program->resources[k];
         if (res->group != b->group || res->kind != WGSL_TEXTURE)
            continue;
         const struct wg_descriptor *d = bound_descriptor(b, b->program, k);
         struct wg_image_view *v = d && d->type != VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT ? d->view : NULL;
         bool written = false;
         util_dynarray_foreach (&writes, const struct wg_image_view *, w)
            written |= v && views_overlap(v, *w);
         if (!written || read_copied(r, v))
            continue;
         struct wg_image *image = container_of(v->vk.image, struct wg_image, vk);
         if (v->alias || image->plane_count > 1 || wg_view_loop(v) == v) {
            static bool said;
            if (!said)
               fprintf(stderr, "wg: an image read as a texture and written as storage in one dispatch or pass, through a "
                               "view of another format: left to WebGPU, which refuses it\n");
            said = true;
            continue;
         }
         end_pass(r);
         const bool three = image->vk.image_type == VK_IMAGE_TYPE_3D;
         for (uint32_t l = v->vk.base_mip_level; l < v->vk.base_mip_level + v->vk.level_count; l++) {
            const VkExtent3D e = vk_image_mip_level_extent(&image->vk, l);
            const uint32_t first = three ? 0 : v->vk.base_array_layer, count = three ? 1 : v->vk.layer_count;
            for (uint32_t layer = first; layer < first + count; layer++) {
               wg_emul[WG_EMUL_FEEDBACK_COPIES]++;
               wg_emul[WG_EMUL_FEEDBACK_BYTES] += (double)e.width * e.height * (three ? e.depth : 1) * image->fmt->bytes;
               gpu_copy_tt(image->tex, l, 0, 0, layer, image->loop_tex, l, 0, 0, layer, e.width, e.height,
                           three ? e.depth : 1, 0, e.width, e.height, e.width, e.height, image->fmt->bytes);
            }
         }
         /* What a feedback loop's draw finds there is stale now. */
         v->loop->twin_mark = 0;
         util_dynarray_append_typed(&r->read_copies, struct wg_image_view *, v);
      }
   }
   util_dynarray_fini(&writes);
   return util_dynarray_num_elements(&r->read_copies, struct wg_image_view *) != 0;
}

/* A scope's end: its shadows dropped, the groups that read them bound again without (their readbacks taken already). */
static void
scope_end(struct replay *r, uint32_t point)
{
   if (!util_dynarray_num_elements(&r->shadows, struct shadow) &&
       !util_dynarray_num_elements(&r->read_copies, struct wg_image_view *))
      return;
   util_dynarray_clear(&r->read_copies);
   /* What the scope wrote in a shadow, back where it belongs. */
   util_dynarray_foreach (&r->shadows, struct shadow, s)
      if (s->written) {
         end_pass(r);
         break;
      }
   util_dynarray_foreach (&r->shadows, struct shadow, s)
      if (s->written) {
         gpu_copy_bb(s->to, s->place, s->buffer, s->at, s->size);
         wg_emul[WG_EMUL_SHADOW_BACK_BYTES] += s->size;
      }
   util_dynarray_clear(&r->shadows);
   r->no_readback = true;
   for (uint32_t g = 0; g < WGSL_MAX_GROUPS; g++)
      if (r->shadowed[point][g])
         bind(r, r->binds[point][g]);
   r->no_readback = false;
   r->dirty |= RD_GROUPS | RD_VB | RD_IB;
}

/* A render pass's usage scope, before it begins (at `p`, past its OP_PASS): its reads of buffers it binds writable too
 * copied, and the groups bound now that read them bound again. */
static void
scope_pass(struct replay *r, const uint8_t *p, const uint8_t *end)
{
   util_dynarray_clear(&r->uses);
   util_dynarray_clear(&r->scope_binds);
   struct scan s = { .group_count = r->group_count[0], .vb_mask = r->vb_mask, .have_ib = r->have_ib, .ib = r->ib };
   memcpy(s.binds, r->binds[0], sizeof(s.binds));
   memcpy(s.vb, r->vb, sizeof(s.vb));
   scan_pass(r, &s, p, end, true);
   scope_images(r);
   const bool reads = scope_reads(r);
   if ((scope_conflicts(r) && scope_shadows(r)) || reads)
      rebind(r, 0, WGSL_MAX_GROUPS);
}

/* Whether the render pass from `p` on has a draw reading its attachments (`dst_copies`), which cuts it. */
static bool
pass_reads_dst(const uint8_t *p, const uint8_t *end)
{
   while (p < end) {
      const struct op_head *h = (const void *)p;
      if (h->op == OP_PASS || h->op == OP_PASS_END)
         return false;
      if (h->op == OP_PIPELINE && wg_key_reads_dst(&((const struct op_pipeline *)(h + 1))->key))
         return true;
      p += sizeof(*h) + h->size;
   }
   return false;
}

/* Whether the render pass from `p` on (its secondaries' too) has a draw whose vertex stage writes storage
 * (`vs_prepass`), which cuts it. */
static bool
pass_vs_stores(const uint8_t *p, const uint8_t *end, bool top)
{
   while (p < end) {
      const struct op_head *h = (const void *)p;
      if (top && (h->op == OP_PASS || h->op == OP_PASS_END))
         return false;
      if (h->op == OP_PIPELINE && ((const struct op_pipeline *)(h + 1))->program->vs_stores)
         return true;
      if (h->op == OP_EXEC) {
         const struct wg_cmd_buffer *sec = *(struct wg_cmd_buffer *const *)(h + 1);
         if (pass_vs_stores(sec->cmds.data, (const uint8_t *)sec->cmds.data + sec->cmds.size, false))
            return true;
      }
      p += sizeof(*h) + h->size;
   }
   return false;
}

/* A draw whose vertex stage writes storage (VK4 T33; WebGPU's vertex stage can't), after its state is applied: the
 * WebGPU pass cut, the stage run as compute for the draw's vertices on that state (the worker's `vsPrepass`, its
 * outputs kept), the pass begun again and the state applied there, then the draw of those outputs (gpu_vs_draw).
 * Vulkan orders a draw's vertex stage after the commands before it, so a cut is exact where a pre-pass before the
 * pass isn't (an earlier draw's stores, read by this one's vertex stage after a barrier). */
static void apply(struct replay *r, uint32_t point);
static void
vs_prepass(struct replay *r, uint32_t kind, uint32_t count, uint32_t instances, uint32_t first, int32_t base,
           uint32_t first_instance, uint32_t ticket)
{
   const bool only = r->vs_only, again = r->vs_again;
   r->vs_only = r->vs_again = false;
   /* A later face of a split draw: the first's outputs, drawn with this face's state (applied already). */
   if (again) {
      if (!only) {
         gpu_vs_draw();
         r->dirty |= RD_VB | RD_IB;
      }
      return;
   }
   struct wg_query_pool *qp = r->qactive_pool;
   wg_emul[WG_EMUL_VS_PREPASSES]++;
   if (qp)
      gpu_end_occlusion();
   gpu_pass_end();
   gpu_vs_prepass(kind, count, instances, first, base, first_instance, ticket);
   begin_pass(r, 2);
   if (qp)
      query_carry_on(r, qp);
   if (only)
      return;
   r->vs_resumed = true;
   apply(r, 0);
   r->vs_resumed = false;
   gpu_vs_draw();
   /* Its own vertex and index buffers were set for it. */
   r->dirty |= RD_VB | RD_IB;
}

/* Whether the render pass from `p` on has a barrier in its own commands, where it can be cut (`scope_cut`). */
static bool
pass_has_barrier(const uint8_t *p, const uint8_t *end)
{
   while (p < end) {
      const struct op_head *h = (const void *)p;
      p += sizeof(*h) + h->size;
      if (h->op == OP_PASS || h->op == OP_PASS_END)
         return false;
      if (h->op == OP_PASS_READ)
         return true;
   }
   return false;
}

/* A dispatch's usage scope: whether it reads a buffer it binds writable too, whose reads are then copied (the compute
 * pass ended for the copies) and its groups bound with them; `scope_end` after it. */
static bool
scope_dispatch(struct replay *r, const struct op_indirect *indirect)
{
   if (!has_writable(r->program[1]) && !has_big_uniform(r->program[1]))
      return false;
   util_dynarray_clear(&r->uses);
   for (uint32_t g = 0; g < r->group_count[1]; g++)
      if (r->binds[1][g])
         bind_uses(r, r->binds[1][g]);
   if (indirect)
      use(r, indirect->buffer, indirect->offset, 12, false);
   if (!scope_conflicts(r))
      return false;
   end_pass(r);
   if (!scope_shadows(r))
      return false;
   rebind(r, 1, r->group_count[1]);
   return true;
}


/* The next draw's parameters (apply writes them where its vertex stage reads them). */
static void
set_draw_params(struct replay *r, int32_t base_vertex, uint32_t base_instance, uint32_t draw_index, uint32_t place)
{
   r->draw_dp[0] = (uint32_t)base_vertex;
   r->draw_dp[1] = base_instance;
   r->draw_dp[2] = draw_index;
   r->draw_place = place;
}

static void
apply(struct replay *r, uint32_t point)
{
   if (point == 0) {
      if (r->atts.count)
         feedback_copies(r);
      if (r->dst && !r->vs_resumed)
         dst_copies(r);
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
      /* From their shadows where the pass binds their buffers writable too (VK4 T3). */
      if (r->dirty & RD_VB)
         u_foreach_bit(b, r->vb_mask)
            if (r->vb[b].buffer) {
               const struct shadow *s = find_shadow(r, r->vb[b].buffer, r->vb[b].offset, r->vb[b].size, false);
               const uint32_t to = s ? s->to : r->vb[b].buffer;
               const double place = s ? s->place : r->vb[b].offset;
               /* Offsets WebGPU's vertex buffers refuse: no pipeline but a pulling one reads them. */
               if ((r->pull && (r->pull->slots & (1u << b))) || fmod(place, 4) || b >= MIN2(wg_limits.max_vertex_buffers, 8))
                  gpu_pull_buffer(b, to, place, r->vb[b].size);
               else
                  gpu_set_vertex_buffer(b, to, place, r->vb[b].size);
            }
      if ((r->dirty & RD_IB) && r->have_ib) {
         const struct shadow *s = find_shadow(r, r->ib.buffer, r->ib.offset, r->ib.size, false);
         gpu_set_index_buffer(s ? s->to : r->ib.buffer, r->ib.wide, s ? s->place : r->ib.offset, r->ib.size);
      }
   } else if (r->dirty & RD_PIPELINE) {
      gpu_set_pipeline(r->compute);
   }
   /* Push constants past the immediates: this draw's in a new place of the push buffer, its group's last dynamic
    * offset (the push buffer's binding is group 3's last). With the draw's parameters past them where its vertex
    * stage reads them (VK3 L7.5): a new place where they change, an indirect draw's the one `prepasses` copied its
    * arguments' into. */
   const struct wg_program *p = r->program[point];
   if (p && p->push_ubo_size && p->group_count == WGSL_MAX_GROUPS) {
      const bool params = point == 0 && draw_params(p);
      const bool moved = params && (!r->dp_valid || r->draw_place != UINT32_MAX || memcmp(r->dp, r->draw_dp, sizeof(r->dp)));
      if ((r->dirty & (RD_PUSH | RD_PIPELINE)) || r->push_offset == UINT32_MAX || moved) {
         struct wg_device *dev = r->dev;
         const bool placed = params && r->draw_place != UINT32_MAX;
         r->push_offset = placed ? r->draw_place : push_place(dev);
         memcpy(dev->push_data + r->push_offset, r->push, MIN2(align(p->push_ubo_size, 16), WGSL_DRAW_PARAMS));
         if (params && !placed)
            memcpy(dev->push_data + r->push_offset + WGSL_DRAW_PARAMS, (uint32_t[4]){ r->draw_dp[0], r->draw_dp[1], r->draw_dp[2], 0 }, 16);
         memcpy(r->dp, r->draw_dp, sizeof(r->dp));
         r->dp_valid = params && !placed;
         r->dirty |= RD_GROUPS;
      }
      const uint32_t n = r->groups[point][WGSL_MAX_GROUPS - 1].n;
      if (n)
         r->groups[point][WGSL_MAX_GROUPS - 1].offsets[n - 1] = r->push_offset;
   }
   if (r->dirty & RD_GROUPS)
      for (uint32_t g = 0; g < r->group_count[point]; g++)
         gpu_set_bind_group(g, r->groups[point][g].group, r->groups[point][g].offsets, r->groups[point][g].n);
   /* A pulled binding with a divisor reads the draw's first instance (VK4 T44) where its draw parameters go: an
    * indirect draw's from the place `prepasses` copied its arguments' into, a direct one's from a place written here
    * where it changes. */
   uint32_t fi = UINT32_MAX;
   if (point == 0 && r->pull && r->pull->first_instance) {
      if (r->draw_place != UINT32_MAX) {
         fi = r->draw_place;
      } else {
         if (r->fi_place == UINT32_MAX || r->fi_value != r->draw_dp[1]) {
            r->fi_place = push_place(r->dev);
            r->fi_value = r->draw_dp[1];
            memcpy(r->dev->push_data + r->fi_place + WGSL_DRAW_PARAMS, (uint32_t[4]){ r->draw_dp[0], r->draw_dp[1], 0, 0 }, 16);
         }
         fi = r->fi_place;
      }
   }
   /* After the groups: its group may be an empty one of the program's, set again with them. */
   if (point == 0 && r->pull && ((r->dirty & (RD_PIPELINE | RD_GROUPS | RD_VB)) || fi != r->fi_bound)) {
      gpu_pull_bind(r->pull->group, r->pull->bgl, r->pull->slots, fi != UINT32_MAX ? push_buffer(r->dev) : 0, fi,
                    r->pull->base);
      r->fi_bound = fi;
   }
   if (point == 0 && r->pull)
      wg_emul[WG_EMUL_PULLED_DRAWS]++;
   if (point == 0 && r->dst)
      gpu_set_bind_group(r->dst->group, r->dst_group, NULL, 0);
   if (p && p->key_count)
      wg_emul[WG_EMUL_KEYED_DRAWS]++;
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
            cpu_write(r, q->dst->mem, at - q->dst->mem->gpu_at + from, bytes + from, to - from, false, 0);
      }
   }
   /* An occlusion query's value is the GPU's: read back what the copy wrote to host-visible memory. */
   if (gpu && host_mem(q->dst))
      readback(r, q->dst->mem, base - q->dst->mem->gpu_at, (q->count - 1) * q->stride + each);
}

static void
copy_bt_replay(const struct op_copy_bt *c, bool to_texture)
{
   void (*copy)(uint32_t, double, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                uint32_t, uint32_t, uint32_t) = to_texture ? gpu_copy_bt : gpu_copy_tb;
   const uint32_t block_rows = DIV_ROUND_UP(c->h, c->block_h);
   /* Depth and stencil copies go whole: WebGPU copies only whole subresources of them (the worker realigns rows). */
   if (c->bpr % 256 == 0 || (block_rows <= 1 && c->d == 1) || c->aspect) {
      /* One row of blocks is one row whatever `bufferImageHeight` says (WebGPU takes a pitch only 256-aligned). */
      copy(c->buffer, c->offset, c->bpr, block_rows <= 1 && c->d == 1 ? 1 : c->rows, c->tex, c->mip, c->x, c->y, c->z, c->w, c->h, c->d,
           c->aspect);
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
      /* A layered pass's layers past the first see its clears alone, the draws whose vertex stage writes gl_Layer
       * (VK4 T43: each layer's pipeline keeps that layer's primitives) and its occlusion queries (counting them). */
      if (r->layered && r->view_order &&
          (h->op == OP_DRAW || h->op == OP_DRAW_INDEXED || h->op == OP_DRAW_INDIRECT || h->op == OP_PROVOKE ||
           h->op == OP_XFB || h->op == OP_VS_ONLY || h->op == OP_VS_AGAIN)) {
         bool skip = !r->layer_draws || h->op == OP_XFB || h->op == OP_VS_ONLY || h->op == OP_VS_AGAIN;
         /* An indirect one needs what only the first layer's pass prepares (its count's or a fan's tickets, its draw
          * parameters' places) unless it reads its buffer as it is. */
         const struct op_indirect *a = h->op == OP_DRAW_INDIRECT ? (const void *)(h + 1) : NULL;
         if (!skip && a && (a->fan || a->count_buffer || (r->program[0] && draw_params(r->program[0])))) {
            static bool warned;
            if (!warned)
               fprintf(stderr, "wg: an indirect draw writing gl_Layer drawn in a layered pass's first layer alone\n");
            warned = true;
            skip = true;
         }
         if (skip) {
            /* The first layer's tickets (`prepasses`) are a draw's each: what this one took there, a later one
             * doesn't. */
            if (h->op == OP_PROVOKE)
               r->tickets++;
            else if (a)
               r->tickets += (a->count_buffer ? 1 : 0) + (a->fan ? a->count : 0);
            continue;
         }
      }
      switch ((enum op)h->op) {
      case OP_VIEWS:
         r->view_mask = ((const uint32_t *)d)[0];
         r->layered = ((const uint32_t *)d)[1];
         r->view_count = ((const uint32_t *)d)[2];
         r->view_order = 0;
         break;
      case OP_PASS: {
         end_pass(r);
         r->vs_only = r->vs_again = false;
         r->pass_op = (const uint8_t *)h;
         const char *json = d;
         /* Multiview: this view's JSON, its layers. */
         r->view = 0;
         if (r->view_mask) {
            uint32_t mask = r->view_mask;
            for (uint32_t i = 0; !r->layered && i < r->view_order; i++)
               mask &= mask - 1;
            r->view = r->layered ? r->view_order : (uint32_t)ffs(mask) - 1;
            for (uint32_t i = 0; i < r->view_order; i++) {
               const char *next = json + strlen(json) + 1;
               if (next >= (const char *)d + h->size || !*next)
                  break;
               json = next;
            }
         }
         /* Its occlusion queries' set (WebGPU's pass takes one, at its start): a layered pass's layers past the first
          * count their draws too. */
         bool stop = false;
         const bool draws = !r->layered || !r->view_order;
         bool several = false;
         r->qpool = pass_query_pool(p, end, &stop, r->qouter, &several);
         r->qspares = 0;
         r->qmux = several;
         r->qmux_next = 0;
         if (several && !r->dev->query_mux) {
            struct wg_json j = { 0 };
            wg_json_printf(&j, "{\"type\":\"occlusion\",\"count\":%u}", WG_QUERY_SET_MAX);
            r->dev->query_mux = wg_create_json(WG_KIND_QUERY_SET, &j);
         }
         util_dynarray_clear(&r->dp_places);
         r->dp_next = 0;
         const struct wg_program *prog = r->program[0];
         if (draws) {
            struct wg_query_pool *pool = r->qpool;
            bool divisors = r->pull && r->pull->first_instance;
            prepasses(r, &prog, &divisors, p, end, 0, true);
            scope_pass(r, p, end);
            r->qpool = pool;
         }
         r->tickets = 0;
         r->pass_json = json;
         r->twin_mark = ++r->dev->twin_mark;
         r->cuts = !r->depth &&
                   (util_dynarray_num_elements(&r->shadows, struct shadow) ||
                    util_dynarray_num_elements(&r->read_copies, struct wg_image_view *)) &&
                   pass_has_barrier(p, end);
         const bool reads = pass_reads_dst(p, end) || pass_vs_stores(p, end, true);
         if (r->qpool || r->atts.count || r->cuts || reads)
            begin_pass(r, r->atts.count || r->cuts || reads ? 1 : 0);
         else
            gpu_render_pass(json, strlen(json));
         r->pass = RENDER;
         if (r->qouter && r->qpool) {
            r->qactive_pool = r->qouter;
            r->qactive = r->qouter_index;
            if (r->qouter_counted)
               query_carry_on(r, r->qouter);
            else if (query_count(r, r->qouter, r->qouter_index, UINT32_MAX))
               r->qouter_counted = true;
            else
               r->qactive_pool = NULL;
         }
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
         /* The next view replays the pass, its commands holding all they need since `forget`. */
         if (r->view_mask) {
            if (++r->view_order < r->view_count) {
               p = r->pass_op;
               break;
            }
            r->view_mask = r->view_order = r->view = r->view_count = 0;
            r->layered = false;
         }
         r->atts.count = 0;
         break;
      case OP_PASS_ATTS:
         memcpy(&r->atts, d, sizeof(r->atts));
         break;
      case OP_VS_ONLY:
         r->vs_only = true;
         break;
      case OP_VS_AGAIN:
         r->vs_again = true;
         break;
      case OP_PASS_READ:
         r->twin_mark = ++r->dev->twin_mark;
         if (r->cuts && !r->depth && r->pass == RENDER && util_dynarray_num_elements(&r->shadows, struct shadow))
            scope_cut(r, p, end);
         break;
      case OP_CLEAR_LAYERS:
         r->clear_first = ((const uint32_t *)d)[0];
         r->clear_count = ((const uint32_t *)d)[1];
         break;
      case OP_CLEAR_RECTS: {
         const bool here = !r->layered || !r->clear_count ||
                           (r->view >= r->clear_first && r->view - r->clear_first < r->clear_count);
         r->clear_count = 0;
         if (r->pass == RENDER && here) {
            /* A clear draws (the worker's), and a Vulkan occlusion query doesn't count clears. */
            struct wg_query_pool *qp = r->qactive_pool;
            if (qp)
               gpu_end_occlusion();
            gpu_clear_rects(d, strlen(d));
            r->dirty = RD_ALL;
            r->twin_mark = ++r->dev->twin_mark;
            if (qp)
               query_carry_on(r, qp);
         }
         break;
      }
      case OP_PIPELINE: {
         const struct op_pipeline *op = d;
         r->pipeline = wg_render_pipeline(op->program, &op->key);
         r->layer_draws = op->key.vs->info.writes_layer && !op->program->vs_stores;
         if (r->view && per_view(op->key.vs, op->key.fs)) {
            struct wg_pipeline_key per_view = op->key;
            per_view.view = r->view;
            r->pipeline = wg_render_pipeline(op->program, &per_view);
         }
         r->program[0] = op->program;
         r->dirty |= RD_PIPELINE;
         r->group_count[0] = op->program->group_count;
         /* The group the last one pulled from may be a set's of this one. */
         if (r->pull)
            r->dirty |= RD_GROUPS;
         const struct wg_pull *was = r->pull;
         r->pull = wg_pipeline_pull(op->program, &op->key);
         /* Likewise the group of the attachments the last one read. */
         if (r->dst)
            r->dirty |= RD_GROUPS;
         r->dst = wg_key_reads_dst(&op->key) ? wg_pipeline_dst(op->program, &op->key) : NULL;
         /* A slot it pulled has no vertex buffer set for one that doesn't. */
         if ((was ? was->slots : 0) != (r->pull ? r->pull->slots : 0))
            r->dirty |= RD_VB;
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
      case OP_COMPUTE_BASED:
         r->compute = *(const uint32_t *)d;
         r->dirty |= RD_PIPELINE;
         break;
      case OP_DYN:
         memcpy(&r->dyn, d, sizeof(r->dyn));
         r->dirty |= RD_DYN;
         break;
      case OP_BIND:
         bind(r, d);
         break;
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
         if (r->pass != RENDER || words_past(r, 0))
            break;
         set_draw_params(r, a[2], a[3], a[4], UINT32_MAX);
         apply(r, 0);
         if (r->program[0] && r->program[0]->vs_stores)
            vs_prepass(r, 0, a[0], a[1], a[2], 0, a[3], 0);
         else
            gpu_draw(a[0], a[1], a[2], a[3]);
         break;
      }
      case OP_DRAW_INDEXED: {
         const struct op_draw_indexed *a = d;
         if (r->pass != RENDER || words_past(r, 0))
            break;
         set_draw_params(r, a->base, a->first_instance, a->draw_index, UINT32_MAX);
         apply(r, 0);
         if (r->program[0] && r->program[0]->vs_stores)
            vs_prepass(r, 1, a->count, a->instances, a->first, a->base, a->first_instance, 0);
         else
            gpu_draw_indexed(a->count, a->instances, a->first, a->base, a->first_instance);
         break;
      }
      case OP_XFB: {
         const struct op_xfb *x = d;
         if (r->pass != RENDER)
            break;
         if (x->kind == 1)
            apply(r, 0);
         for (uint32_t i = 0; i < 8 && x->readback[i].mem; i++)
            readback(r, x->readback[i].mem, x->readback[i].offset, x->readback[i].size);
         gpu_xfb((const char *)(x + 1), strlen((const char *)(x + 1)));
         break;
      }
      case OP_PROVOKE: {
         const struct op_provoke *o = d;
         if (r->pass != RENDER)
            break;
         if (words_past(r, 0)) {
            r->tickets++;
            break;
         }
         set_draw_params(r, o->base, o->first_instance, o->draw_index, UINT32_MAX);
         apply(r, 0);
         if (r->program[0] && r->program[0]->vs_stores)
            vs_prepass(r, 2, 0, o->instances, 0, o->base, o->first_instance, r->tickets++);
         else
            gpu_draw_ticket(r->tickets++, o->instances, o->base, o->first_instance);
         r->dirty |= RD_IB;
         break;
      }
      case OP_DRAW_INDIRECT: {
         const struct op_indirect *a = d;
         if (r->pass != RENDER)
            break;
         const uint32_t counted = a->count_buffer ? r->tickets++ : UINT32_MAX;
         /* Refused, it takes what `prepasses` gave its records all the same: their fan tickets and draw parameters'
          * places (a later draw of the pass through indices of its own would take a fan's). */
         if (words_past(r, 0)) {
            r->tickets += a->fan ? a->count : 0;
            r->dp_next += a->count;
            break;
         }
         /* Its counts are on the GPU: a vertex stage that stores needs them for its pre-pass (VK4 T33). */
         if (r->program[0] && r->program[0]->vs_stores) {
            static bool warned;
            if (!warned)
               fprintf(stderr, "wg: an indirect draw whose vertex stage writes storage isn't drawn\n");
            warned = true;
            r->tickets += a->fan ? a->count : 0;
            r->dp_next += a->count;
            r->vs_only = r->vs_again = false;
            break;
         }
         for (uint32_t i = 0; i < a->count; i++) {
            const uint32_t at = r->dp_next < util_dynarray_num_elements(&r->dp_places, uint32_t)
                                   ? *util_dynarray_element(&r->dp_places, uint32_t, r->dp_next++) : UINT32_MAX;
            if (at == UINT32_MAX && r->program[0] && draw_params(r->program[0])) {
               static bool warned;
               if (!warned)
                  fprintf(stderr, "wg: an indirect draw's parameters weren't copied before its pass: drawn with 0\n");
               warned = true;
            }
            set_draw_params(r, 0, 0, i, at);
            apply(r, 0);
            if (a->fan) {
               gpu_draw_ticket_indirect(r->tickets++);
               r->dirty |= RD_IB;
               continue;
            }
            if (counted != UINT32_MAX) {
               gpu_draw_indirect_ticket(counted, i, a->indexed);
               continue;
            }
            const struct shadow *s =
               find_shadow(r, a->buffer, a->offset, (a->count - 1) * (double)a->stride + (a->indexed ? 20 : 16), false);
            gpu_draw_indirect(s ? s->to : a->buffer, (s ? s->place : a->offset) + (double)i * a->stride, a->indexed);
         }
         break;
      }
      case OP_DISPATCH:
      case OP_DISPATCH_INDIRECT: {
         if (r->pass == RENDER || words_past(r, 1))
            break;
         const struct op_indirect *a = h->op == OP_DISPATCH_INDIRECT ? d : NULL;
         if (r->dev->aliased) {
            for (uint32_t g = 0; g < r->group_count[1]; g++)
               if (r->binds[1][g])
                  bind_images(r, r->binds[1][g]);
            scope_images(r);
         }
         util_dynarray_clear(&r->scope_binds);
         for (uint32_t g = 0; g < r->group_count[1]; g++)
            if (r->binds[1][g])
               util_dynarray_append_typed(&r->scope_binds, const struct op_bind *, r->binds[1][g]);
         const bool reads = scope_reads(r);
         if (reads)
            rebind(r, 1, r->group_count[1]);
         const bool scoped = scope_dispatch(r, a) || reads;
         if (r->pass == NONE) {
            gpu_compute_pass();
            r->pass = COMPUTE;
            r->dirty = RD_ALL;
         }
         apply(r, 1);
         if (!a) {
            const uint32_t *n = d;
            gpu_dispatch(n[0], n[1], n[2]);
         } else {
            const struct shadow *s = find_shadow(r, a->buffer, a->offset, 12, false);
            gpu_dispatch_indirect(s ? s->to : a->buffer, s ? s->place : a->offset);
         }
         if (scoped)
            scope_end(r, 1);
         break;
      }
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
      case OP_IMAGE_USE:
         image_use(r, d);
         break;
      case OP_COPY_TT: {
         const struct op_copy_tt *c = d;
         end_pass(r);
         gpu_copy_tt(c->src, c->src_mip, c->sx, c->sy, c->sz, c->dst, c->dst_mip, c->dx, c->dy, c->dz, c->w, c->h, c->d,
                     c->aspect, c->dst_w, c->dst_h, c->cols, c->rows, c->bytes);
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
         /* In a multiview pass a query is one a view, consecutive. */
         const uint32_t first = q->first + (q->kind && !r->layered ? r->view_order : 0);
         if (r->layered && r->view_order) {
            /* A layered pass's layer past the first (VK4 T43): an occlusion query's samples of this layer counted in a
             * spare slot of its pool, added to what the first layer's resolve wrote; nothing else again. */
            if (q->kind == 2 && occlusion && r->pass == RENDER && r->qpool && (pool == r->qpool || r->qmux) &&
                !r->qactive_pool && first < WG_QUERY_SET_MAX && r->qspares < pool->spares &&
                query_count(r, pool, pool->vk.query_count + r->qspares, first)) {
               r->qspares++;
               r->qactive_pool = pool;
               r->qactive = first;
            } else if (q->kind == 3 && occlusion && r->pass == RENDER && r->qactive_pool == pool &&
                       r->qactive == first) {
               gpu_end_occlusion();
               r->qactive_pool = NULL;
            }
            break;
         }
         if (q->kind == 0) {
            memset(&pool->values[q->first], 0, q->count * sizeof(uint64_t));
            memset(&pool->avail[q->first], 0, q->count);
            memset(&pool->ended[q->first], 0, q->count * sizeof(uint32_t));
         } else if (q->kind == 1) {
            pool->values[first] = os_time_get_nano();
            query_ended(r, pool, first);
         } else if (q->kind == 2 && occlusion) {
            if (r->pass == RENDER && r->qpool && (pool == r->qpool || r->qmux) && !r->qactive_pool &&
                first < WG_QUERY_SET_MAX && query_count(r, pool, first, UINT32_MAX)) {
               r->qactive_pool = pool;
               r->qactive = first;
            } else if (r->pass != RENDER && !r->qouter && pool->set && first < WG_QUERY_SET_MAX) {
               r->qouter = pool;
               r->qouter_index = first;
               r->qouter_counted = false;
            } else {
               static bool warned;
               if (!warned)
                  fprintf(stderr, "wg: an occlusion query begun inside another: reported as passing\n");
               warned = true;
            }
         } else if (q->kind == 3) {
            if (occlusion) {
               if (r->qouter == pool && r->qouter_index == first && r->pass != RENDER) {
                  r->qouter = NULL;
                  if (!r->qouter_counted) {
                     /* No pass inside it: nothing counted. */
                     static const uint64_t zero;
                     if (r->pass != NONE)
                        end_pass(r);
                     gpu_update(pool->buf, first * 8.0, &zero, 8);
                  }
               } else if (r->pass == RENDER && r->qactive_pool == pool && r->qactive == first) {
                  gpu_end_occlusion();
                  r->qactive_pool = NULL;
               } else {
                  query_passing(r, pool, first);
               }
            }
            query_ended(r, pool, first);
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
         r->depth++;
         replay(r, secondary);
         r->depth--;
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
      gpu_write(mem->gpu, mem->gpu_at + off, mem->data + off, len);
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
            gpu_write(mem->gpu, mem->gpu_at + run, mem->data + run, w - run);
         run = w + 4;
      }
   }
   if (end > run)
      gpu_write(mem->gpu, mem->gpu_at + run, mem->data + run, end - run);
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
            (load ? gpu_copy_bt : gpu_copy_tb)(image->mem->gpu, (double)(image->mem->gpu_at + at), (uint32_t)l.rowPitch, rows, image->tex,
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
   if (!w->sync || !is_wg_timeline(w->sync))
      return true;
   const struct wg_sync *s = (const struct wg_sync *)w->sync;
   return s->value >= w->wait_value || s->pending >= w->wait_value;
}

/* A submit held for its waits (Vulkan's wait before signal: the host, or another queue, signals the value later), or
 * behind a held submit of its queue. The runtime frees its vk_queue_submit when driver_submit returns: its command
 * buffers and signals are copied (they stay the application's while the submit is pending), and its waits. */
struct held {
   struct list_head link;
   const struct vk_queue *queue;
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

/* Whether a held submit of `dev` before `before` (NULL: any) signals the binary sync `sync`: a wait on it is met only
 * once that submit runs (Vulkan's rule is that a binary semaphore's signal is submitted first, not that it ran: with
 * one queue the order held it; another queue's wait would run ahead, VK4 T22). */
static bool
held_signals(struct wg_device *dev, const struct held *before, const struct vk_sync *sync)
{
   if (!sync || (sync->flags & VK_SYNC_IS_TIMELINE))
      return false;
   list_for_each_entry (struct held, h, &dev->held, link) {
      if (h == before)
         return false;
      for (uint32_t k = 0; k < h->signal_count; k++)
         if (h->signals[k].sync == sync)
            return true;
   }
   return false;
}

/* Whether `queue` has a held submit before `before` (NULL: any). */
static bool
queue_held(struct wg_device *dev, const struct held *before, const struct vk_queue *queue)
{
   list_for_each_entry (struct held, h, &dev->held, link) {
      if (h == before)
         return false;
      if (h->queue == queue)
         return true;
   }
   return false;
}

/* Replays every device's held submits whose waits are met, each queue's oldest first (one not met holds those of its
 * queue after it; the queues are one WebGPU queue, so any order of theirs is a right one). */
static void
flush_held(void)
{
   for (bool progress = true; progress;) {
      progress = false;
      for (uint32_t i = 0; i < 16; i++) {
         struct wg_device *dev = devices[i];
         if (!dev)
            continue;
         list_for_each_entry (struct held, h, &dev->held, link) {
            bool met = !queue_held(dev, h, h->queue);
            for (uint32_t k = 0; k < h->wait_count && met; k++)
               met = wait_met(&h->waits[k]) && !held_signals(dev, h, h->waits[k].sync);
            if (!met)
               continue;
            list_del(&h->link);
            submit_now(dev, h->cmd_count, h->cmds, h->signal_count, h->signals);
            list_inithead(&h->link);
            held_free(h);
            progress = true;
            break; /* the list changed, and what this submit signals may meet the waits before it */
         }
      }
   }
}

VkResult
wg_queue_submit(struct vk_queue *queue, struct vk_queue_submit *submit)
{
   struct wg_device *dev = container_of(queue->base.device, struct wg_device, vk);
   /* Behind a held submit of its queue a submit is held, in order: a fence or semaphore a later submit signals says the
    * queue's earlier ones are done (Mesa's vkQueueWaitIdle and vkDeviceWaitIdle, a queue's at a time, are such submits
    * of a sync alone; vkr's fence that retires a guest's ring fence, a ring a queue, too, and through that fence Venus's
    * guest driver signals its timeline semaphores). Another queue's go on (VK4 T22: one may signal what the held one
    * waits for), but for a wait on a binary semaphore a held submit signals. */
   bool met = !queue_held(dev, NULL, queue);
   for (uint32_t i = 0; i < submit->wait_count && met; i++)
      met = wait_met(&submit->waits[i]) && !held_signals(dev, NULL, submit->waits[i].sync);
   if (met) {
      const VkResult result = submit_now(dev, submit->command_buffer_count, submit->command_buffers,
                                         submit->signal_count, submit->signals);
      /* Its signals, pending now, may meet another queue's held submits' waits. */
      if (!list_is_empty(&dev->held) && !completing)
         flush_held();
      return result;
   }
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
   h->queue = queue;
   h->cmd_count = submit->command_buffer_count;
   memcpy(h->cmds, submit->command_buffers, h->cmd_count * sizeof(*h->cmds));
   h->signal_count = submit->signal_count;
   memcpy(h->signals, submit->signals, h->signal_count * sizeof(*h->signals));
   /* Timeline waits, and binary ones (met once no held submit before it signals them). */
   for (uint32_t i = 0; i < submit->wait_count; i++)
      if (submit->waits[i].sync)
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
      if (!signals[i].sync)
         continue;
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
   struct replay r = { .dev = dev, .submit = s, .push_offset = UINT32_MAX, .draw_place = UINT32_MAX,
                       .fi_place = UINT32_MAX, .fi_bound = UINT32_MAX };
   uint64_t draws = 0;
   for (uint32_t i = 0; i < cmd_count; i++)
      draws += container_of(cmds[i], struct wg_cmd_buffer, vk)->draws;
   push_reserve(dev, draws * 256);
   dev->push_used = 0;
   dev->shadow_used[0] = dev->shadow_used[1] = 0;
   for (uint32_t i = 0; i < cmd_count; i++) {
      struct wg_cmd_buffer *cmd = container_of(cmds[i], struct wg_cmd_buffer, vk);
      replay(&r, cmd);
      end_pass(&r);
      r.dirty = RD_ALL;
   }
   linear_images(dev, false, &r);
   /* What another renderer reads of a shared image is its texture. */
   list_for_each_entry (struct wg_image, image, &dev->shared_words, words_link) {
      const struct op_image_use u = { image, 0, 0, 0, image->vk.mip_levels, 0, wg_image_valid_layers(image), false, false };
      image_use(&r, &u);
   }
   /* The bases, then the look at the write-watch and the uploads: queue.writeBuffer, so ahead of the commands. */
   snapshot(s);
   upload(dev);
   util_dynarray_foreach (&s->readbacks, struct readback, b)
      b->slot = gpu_readback(b->mem->gpu, b->mem->gpu_at + b->offset, b->size);
   util_dynarray_foreach (&s->queries, struct query_readback, q)
      q->slot = gpu_readback(q->pool->buf, q->lo * 8.0, (q->hi - q->lo) * 8);
   util_dynarray_fini(&r.pass_queries);
   util_dynarray_fini(&r.dp_places);
   util_dynarray_fini(&r.uses);
   util_dynarray_fini(&r.written);
   util_dynarray_fini(&r.shadows);
   util_dynarray_fini(&r.images);
   util_dynarray_fini(&r.scope_binds);
   util_dynarray_fini(&r.read_copies);
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

void
wg_submits_forget_pool(struct wg_device *dev, const struct wg_query_pool *pool)
{
   list_for_each_entry (struct wg_submit, s, &dev->pending, link)
      util_dynarray_foreach (&s->queries, struct query_readback, q)
         if (q->pool == pool)
            q->pool = NULL;
}

/* For the driver's tests (wg_test.c): the syncs held submits signal or wait on. */
int wg_held_syncs(void);
int
wg_held_syncs(void)
{
   int n = 0;
   for (uint32_t i = 0; i < 16; i++)
      if (devices[i])
         list_for_each_entry (struct held, h, &devices[i]->held, link) {
            for (uint32_t k = 0; k < h->signal_count; k++)
               n += h->signals[k].sync != NULL;
            for (uint32_t k = 0; k < h->wait_count; k++)
               n += h->waits[k].sync != NULL;
         }
   return n;
}

/* For the driver's tests (wg_test.c). */
int wg_submits_pool_refs(const void *pool);
int
wg_submits_pool_refs(const void *pool)
{
   int n = 0;
   for (uint32_t i = 0; i < 16; i++)
      if (devices[i])
         list_for_each_entry (struct wg_submit, s, &devices[i]->pending, link)
            util_dynarray_foreach (&s->queries, struct query_readback, q)
               n += (const void *)q->pool == pool;
   return n;
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

/* Whether [p, p + size) is memory the renderer may write: the host-visible window or its own arena (from the base the
 * module is linked at, vk/gen.ts, to memory 0's top). Anything else would be guest RAM. */
extern unsigned char __global_base;
static bool
writable(const uint8_t *p, uint64_t size)
{
   const uintptr_t a = (uintptr_t)p;
   const bool ok = (a >= wg_window_at && a + size <= wg_window_at + wg_window_bytes) ||
                   (a >= (uintptr_t)&__global_base && a + size <= 0x100000000ull);
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
            if (q->pool)
               gpu_readback_copy(q->slot, &q->pool->values[q->lo], (q->hi - q->lo) * 8);
         wg_completed_serial = serial;
         util_dynarray_foreach (&s->signals, struct vk_sync_signal, sig)
            if (sig->sync)
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

/* A sync destroyed while a submit still names it (a fence or semaphore freed before its work is done, as a context's
 * teardown does, or a guest that doesn't wait) leaves it: its completion would signal freed memory through its type's
 * functions (NVIDIA's trap in wg_complete, VK3 L9b), and a held submit's wait on it is met. */
static void
wg_sync_finish(struct vk_device *device, struct vk_sync *sync)
{
   for (uint32_t i = 0; i < 16; i++) {
      struct wg_device *dev = devices[i];
      if (!dev)
         continue;
      list_for_each_entry (struct wg_submit, s, &dev->pending, link)
         util_dynarray_foreach (&s->signals, struct vk_sync_signal, sig)
            if (sig->sync == sync)
               sig->sync = NULL;
      list_for_each_entry (struct held, h, &dev->held, link) {
         for (uint32_t k = 0; k < h->signal_count; k++)
            if (h->signals[k].sync == sync)
               h->signals[k].sync = NULL;
         for (uint32_t k = 0; k < h->wait_count; k++)
            if (h->waits[k].sync == sync)
               h->waits[k].sync = NULL;
      }
   }
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
