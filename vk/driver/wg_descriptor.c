/*
 * Descriptor set layouts, pools, sets and their updates (wg_private.h). A set is its slots' descriptors as the guest
 * wrote them (buffers, views and samplers by object); WebGPU's bind groups are made of it only when a draw or dispatch
 * binds it with a pipeline's bind group layout (wg_cmd.c), and kept on the set for its version.
 */
#include <stdlib.h>
#include <string.h>

#include "util/mesa-blake3.h"
#include "vk_descriptor_update_template.h"
#include "vk_descriptors.h"
#include "vk_format.h"
#include "vk_util.h"
#include "vk_ycbcr_conversion.h"

#include "wg_private.h"

static bool
is_dynamic(VkDescriptorType t)
{
   return t == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC || t == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC;
}

/* An immutable sampler's YCbCr conversion of a multi-planar format (VK3 L7.2), or NULL. */
static const struct vk_ycbcr_conversion_state *
sampler_ycbcr(VkSampler handle)
{
   VK_FROM_HANDLE(wg_sampler, sampler, handle);
   if (!sampler || !sampler->vk.ycbcr_conversion)
      return NULL;
   const struct vk_format_ycbcr_info *info = vk_format_get_ycbcr_info(sampler->vk.ycbcr_conversion->state.format);
   return info && info->n_planes > 1 ? &sampler->vk.ycbcr_conversion->state : NULL;
}

/* A binding of combined image-samplers with a YCbCr conversion among its immutable samplers. */
static bool
binding_ycbcr(const VkDescriptorSetLayoutBinding *b)
{
   if (b->descriptorType != VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER || !b->pImmutableSamplers)
      return false;
   for (uint32_t e = 0; e < b->descriptorCount; e++)
      if (sampler_ycbcr(b->pImmutableSamplers[e]))
         return true;
   return false;
}

/* The slots of a binding: an inline uniform block's count is its bytes, and it is one uniform buffer. */
static uint32_t
binding_slots(const VkDescriptorSetLayoutBinding *b)
{
   return b->descriptorType == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK ? 1 : b->descriptorCount;
}

/* One allocation: the layout, then its tables (the runtime frees it whole when its last reference goes). A binding
 * with YCbCr conversions has two slots more an element, after the others: its views' other planes (wgsl.h). */
static struct wg_descriptor_set_layout *
layout_create(struct wg_device *dev, const VkDescriptorSetLayoutCreateInfo *info)
{
   uint32_t bindings = 0, slots = 0, plane_slots = 0;
   for (uint32_t i = 0; i < info->bindingCount; i++) {
      bindings = MAX2(bindings, info->pBindings[i].binding + 1);
      slots += binding_slots(&info->pBindings[i]);
      if (binding_ycbcr(&info->pBindings[i]))
         plane_slots += 2 * info->pBindings[i].descriptorCount;
   }
   const uint32_t all = slots + plane_slots;
   const size_t size = sizeof(struct wg_descriptor_set_layout) + bindings * (sizeof(int32_t) + sizeof(uint32_t) +
                       sizeof(uint32_t) + sizeof(VkDescriptorType) + sizeof(VkShaderStageFlags)) + all * (sizeof(int16_t) + sizeof(struct wg_sampler *)) +
                       (plane_slots ? bindings * sizeof(int32_t) + all * (sizeof(void *) + sizeof(int32_t)) : 0) + 32;
   struct wg_descriptor_set_layout *l = vk_descriptor_set_layout_zalloc(&dev->vk, size, info);
   if (!l)
      return NULL;
   uint8_t *p = (uint8_t *)(l + 1);
   l->immutable = (struct wg_sampler **)p, p += all * sizeof(struct wg_sampler *);
   if (plane_slots) {
      l->ycbcr = (const struct vk_ycbcr_conversion_state **)p, p += all * sizeof(void *);
      l->owner = (int32_t *)p, p += all * sizeof(int32_t);
      l->planes = (int32_t *)p, p += bindings * sizeof(int32_t);
      for (uint32_t k = 0; k < all; k++)
         l->owner[k] = -1;
      for (uint32_t b = 0; b < bindings; b++)
         l->planes[b] = -1;
   }
   l->first = (int32_t *)p, p += bindings * sizeof(int32_t);
   l->count = (uint32_t *)p, p += bindings * sizeof(uint32_t);
   l->type = (VkDescriptorType *)p, p += bindings * sizeof(VkDescriptorType);
   l->stages = (VkShaderStageFlags *)p, p += bindings * sizeof(VkShaderStageFlags);
   l->inline_bytes = (uint32_t *)p, p += bindings * sizeof(uint32_t);
   l->dynamic = (int16_t *)p;
   l->binding_count = bindings;
   for (uint32_t b = 0; b < bindings; b++)
      l->first[b] = -1;

   /* Slots in binding order, an array's elements consecutive (what the compiler assumes: wgsl.h). */
   VkDescriptorSetLayoutBinding *sorted = NULL;
   if (vk_create_sorted_bindings(info->pBindings, info->bindingCount, &sorted, NULL, NULL) != VK_SUCCESS) {
      vk_descriptor_set_layout_unref(&dev->vk, &l->vk);
      return NULL;
   }
   struct mesa_blake3 hash;
   _mesa_blake3_init(&hash);
   uint32_t slot = 0, dynamic = 0, plane_slot = slots;
   for (uint32_t i = 0; i < info->bindingCount; i++) {
      const VkDescriptorSetLayoutBinding *b = &sorted[i];
      l->first[b->binding] = slot;
      l->count[b->binding] = binding_slots(b);
      if (b->descriptorType == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK)
         l->inline_bytes[b->binding] = b->descriptorCount;
      l->type[b->binding] = b->descriptorType;
      l->stages[b->binding] = b->stageFlags;
      /* Its bytes in the set's buffer, each block where a uniform binding can start. */
      if (b->descriptorType == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK)
         l->inline_size += align(MAX2(b->descriptorCount, 16), 256);
      for (uint32_t e = 0; e < binding_slots(b); e++) {
         l->dynamic[slot + e] = is_dynamic(b->descriptorType) ? (int16_t)dynamic++ : -1;
         if (b->pImmutableSamplers && (b->descriptorType == VK_DESCRIPTOR_TYPE_SAMPLER ||
                                       b->descriptorType == VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER))
            l->immutable[slot + e] = wg_sampler_from_handle(b->pImmutableSamplers[e]);
      }
      if (plane_slots && binding_ycbcr(b)) {
         l->planes[b->binding] = plane_slot;
         for (uint32_t e = 0; e < b->descriptorCount; e++) {
            const struct vk_ycbcr_conversion_state *y = sampler_ycbcr(b->pImmutableSamplers[e]);
            l->ycbcr[slot + e] = y;
            l->owner[plane_slot + 2 * e] = l->owner[plane_slot + 2 * e + 1] = slot + e;
            l->dynamic[plane_slot + 2 * e] = l->dynamic[plane_slot + 2 * e + 1] = -1;
            /* The shaders' keys (the runtime hashes set layouts): a conversion is compiled in. */
            const struct vk_ycbcr_conversion_state none = { 0 };
            _mesa_blake3_update(&hash, y ? y : &none, sizeof(none));
         }
         plane_slot += 2 * b->descriptorCount;
      }
      slot += binding_slots(b);
      _mesa_blake3_update(&hash, &b->binding, sizeof(b->binding));
      _mesa_blake3_update(&hash, &b->descriptorType, sizeof(b->descriptorType));
      _mesa_blake3_update(&hash, &b->descriptorCount, sizeof(b->descriptorCount));
      /* Which uniform buffers are read as storage goes by the stages that see them (wg_shader.c `fold_uniforms`). */
      _mesa_blake3_update(&hash, &b->stageFlags, sizeof(b->stageFlags));
   }
   free(sorted);
   l->slot_count = plane_slot;
   l->dynamic_count = dynamic;
   l->vk.dynamic_descriptor_count = dynamic;
   _mesa_blake3_final(&hash, l->vk.blake3);
   return l;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateDescriptorSetLayout(VkDevice _device, const VkDescriptorSetLayoutCreateInfo *pCreateInfo,
                             const VkAllocationCallbacks *pAllocator, VkDescriptorSetLayout *pLayout)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_descriptor_set_layout *layout = layout_create(dev, pCreateInfo);
   if (!layout)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   *pLayout = wg_descriptor_set_layout_to_handle(layout);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDescriptorSetLayoutSupport(VkDevice _device, const VkDescriptorSetLayoutCreateInfo *pCreateInfo,
                                 VkDescriptorSetLayoutSupport *pSupport)
{
   /* What a bind group can hold: nothing past the compiler's slots. */
   uint32_t slots = 0;
   for (uint32_t i = 0; i < pCreateInfo->bindingCount; i++)
      slots += binding_slots(&pCreateInfo->pBindings[i]);
   pSupport->supported = slots <= 1024;
   VkDescriptorSetVariableDescriptorCountLayoutSupport *v =
      vk_find_struct(pSupport->pNext, DESCRIPTOR_SET_VARIABLE_DESCRIPTOR_COUNT_LAYOUT_SUPPORT);
   if (v)
      v->maxVariableDescriptorCount = 0;
}

/* Pools: their sets, freed with them. */

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateDescriptorPool(VkDevice _device, const VkDescriptorPoolCreateInfo *pCreateInfo,
                        const VkAllocationCallbacks *pAllocator, VkDescriptorPool *pPool)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_descriptor_pool *pool =
      vk_object_zalloc(&dev->vk, pAllocator, sizeof(*pool), VK_OBJECT_TYPE_DESCRIPTOR_POOL);
   if (!pool)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   list_inithead(&pool->sets);
   *pPool = wg_descriptor_pool_to_handle(pool);
   return VK_SUCCESS;
}

static void
set_destroy(struct wg_device *dev, struct wg_descriptor_set *set)
{
   for (uint32_t i = 0; i < WG_SET_GROUPS; i++)
      wg_id_release(set->groups[i].group);
   wg_id_release(set->inline_buffer);
   free(set->inline_data);
   list_del(&set->link);
   vk_descriptor_set_layout_unref(&dev->vk, &set->layout->vk);
   vk_object_free(&dev->vk, NULL, set);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_ResetDescriptorPool(VkDevice _device, VkDescriptorPool _pool, VkDescriptorPoolResetFlags flags)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_descriptor_pool, pool, _pool);
   list_for_each_entry_safe (struct wg_descriptor_set, set, &pool->sets, link)
      set_destroy(dev, set);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyDescriptorPool(VkDevice _device, VkDescriptorPool _pool, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_descriptor_pool, pool, _pool);
   if (!pool)
      return;
   wg_ResetDescriptorPool(_device, _pool, 0);
   vk_object_free(&dev->vk, pAllocator, pool);
}

struct wg_descriptor_set *
wg_descriptor_set_create(struct wg_device *dev, struct wg_descriptor_set_layout *layout)
{
   struct wg_descriptor_set *set =
      vk_object_zalloc(&dev->vk, NULL, sizeof(*set) + layout->slot_count * sizeof(struct wg_descriptor),
                       VK_OBJECT_TYPE_DESCRIPTOR_SET);
   if (!set)
      return NULL;
   static uint32_t uids;
   set->layout = layout;
   set->uid = ++uids;
   vk_descriptor_set_layout_ref(&layout->vk);
   list_inithead(&set->link);
   /* Inline uniform blocks: their bytes here and in a uniform buffer of the set's, written as the guest updates them
    * (the queue's order: no pending command buffer may be using a set being updated). */
   if (layout->inline_size) {
      set->inline_data = calloc(1, layout->inline_size);
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", layout->inline_size, 0x40 | 0x80 | 8); /* UNIFORM | STORAGE | COPY_DST */
      set->inline_buffer = wg_create_json(WG_KIND_BUFFER, &j);
   }
   uint32_t inline_at = 0;
   for (uint32_t b = 0; b < layout->binding_count; b++)
      for (uint32_t e = 0; layout->first[b] >= 0 && e < layout->count[b]; e++) {
         struct wg_descriptor *d = &set->slots[layout->first[b] + e];
         d->type = layout->type[b];
         if (d->type == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) {
            d->inline_buffer = set->inline_buffer;
            d->offset = inline_at;
            d->range = layout->inline_bytes[b];
            inline_at += align(MAX2(layout->inline_bytes[b], 16), 256);
         }
         d->sampler = layout->immutable[layout->first[b] + e];
         if (layout->planes && layout->planes[b] >= 0)
            for (uint32_t p = 0; p < 2; p++)
               set->slots[layout->planes[b] + 2 * e + p] =
                  (struct wg_descriptor){ .type = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, .plane = (uint8_t)(p + 1) };
      }
   return set;
}

void
wg_descriptor_set_destroy(struct wg_device *dev, struct wg_descriptor_set *set)
{
   set_destroy(dev, set);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_AllocateDescriptorSets(VkDevice _device, const VkDescriptorSetAllocateInfo *info, VkDescriptorSet *pSets)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_descriptor_pool, pool, info->descriptorPool);
   for (uint32_t i = 0; i < info->descriptorSetCount; i++) {
      VK_FROM_HANDLE(wg_descriptor_set_layout, layout, info->pSetLayouts[i]);
      struct wg_descriptor_set *set = wg_descriptor_set_create(dev, layout);
      if (!set) {
         wg_FreeDescriptorSets(_device, info->descriptorPool, i, pSets);
         for (uint32_t k = 0; k < info->descriptorSetCount; k++)
            pSets[k] = VK_NULL_HANDLE;
         return vk_error(dev, VK_ERROR_OUT_OF_POOL_MEMORY);
      }
      list_addtail(&set->link, &pool->sets);
      pSets[i] = wg_descriptor_set_to_handle(set);
   }
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_FreeDescriptorSets(VkDevice _device, VkDescriptorPool pool, uint32_t count, const VkDescriptorSet *pSets)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   for (uint32_t i = 0; i < count; i++) {
      VK_FROM_HANDLE(wg_descriptor_set, set, pSets[i]);
      if (set)
         set_destroy(dev, set);
   }
   return VK_SUCCESS;
}

/* Updates. */

static struct wg_descriptor *
slot(struct wg_descriptor_set *set, uint32_t binding, uint32_t element)
{
   const struct wg_descriptor_set_layout *l = set->layout;
   /* Writes past a binding's count go on into the next binding's (Vulkan's consecutive binding updates). */
   while (binding < l->binding_count && (l->first[binding] < 0 || element >= l->count[binding])) {
      if (l->first[binding] >= 0)
         element -= l->count[binding];
      binding++;
   }
   return binding < l->binding_count ? &set->slots[l->first[binding] + element] : NULL;
}

/* A YCbCr binding's element written: its planes' slots bind its view's other planes (VK3 L7.2). */
static void
sync_planes(struct wg_descriptor_set *set, const struct wg_descriptor *d)
{
   const struct wg_descriptor_set_layout *l = set->layout;
   if (!l->planes || !d)
      return;
   const uint32_t k = d - set->slots;
   for (uint32_t b = 0; b < l->binding_count; b++) {
      if (l->planes[b] < 0 || k < (uint32_t)l->first[b] || k >= l->first[b] + l->count[b])
         continue;
      for (uint32_t p = 0; p < 2; p++)
         set->slots[l->planes[b] + 2 * (k - l->first[b]) + p].view = d->view;
      return;
   }
}

/* A binding with immutable samplers keeps them whatever a write's `sampler` says (Vulkan ignores it there; VK3 L7a, the
 * binding review's finding 7: a YCbCr binding's conversion is compiled in with its immutable sampler). */
static void
write_one(struct wg_descriptor_set *set, struct wg_descriptor *d, VkDescriptorType type,
          const VkDescriptorImageInfo *image, const VkDescriptorBufferInfo *buffer, const VkBufferView *texel)
{
   const bool immutable = set->layout->immutable[d - set->slots] != NULL;
   d->type = type;
   switch (type) {
   case VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER:
   case VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER:
      d->texel = texel ? wg_buffer_view_from_handle(*texel) : NULL;
      break;
   case VK_DESCRIPTOR_TYPE_SAMPLER:
      if (image->sampler && !immutable)
         d->sampler = wg_sampler_from_handle(image->sampler);
      break;
   case VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER:
      if (image->sampler && !immutable)
         d->sampler = wg_sampler_from_handle(image->sampler);
      FALLTHROUGH;
   case VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE:
   case VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:
   case VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT:
      d->view = wg_image_view_from_handle(image->imageView);
      break;
   case VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER:
   case VK_DESCRIPTOR_TYPE_STORAGE_BUFFER:
   case VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC:
   case VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC:
      d->buffer = wg_buffer_from_handle(buffer->buffer);
      d->offset = buffer->offset;
      d->range = buffer->range;
      break;
   default:
      break; /* inline uniform blocks: below */
   }
}

/* The bytes of a set's inline uniform blocks from `offset` of `binding`, on into the next binding past its end
 * (Vulkan's consecutive binding updates): the run in this block, its bytes at `at`. Binding and offset move past it. */
static uint32_t
inline_run(const struct wg_descriptor_set *set, uint32_t *binding, uint32_t *offset, uint32_t size, uint32_t *at)
{
   const struct wg_descriptor_set_layout *l = set->layout;
   while (*binding < l->binding_count &&
          (l->first[*binding] < 0 || l->type[*binding] != VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK ||
           *offset >= l->inline_bytes[*binding])) {
      if (l->first[*binding] >= 0 && l->type[*binding] == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK)
         *offset -= l->inline_bytes[*binding];
      ++*binding;
   }
   if (*binding >= l->binding_count)
      return 0;
   const uint32_t n = MIN2(size, l->inline_bytes[*binding] - *offset);
   *at = set->slots[l->first[*binding]].offset + *offset;
   *offset += n;
   return n;
}

static void
inline_write(struct wg_descriptor_set *set, uint32_t binding, uint32_t offset, const void *data, uint32_t size)
{
   const uint8_t *p = data;
   for (uint32_t n, at; size && (n = inline_run(set, &binding, &offset, size, &at)); p += n, size -= n) {
      memcpy(set->inline_data + at, p, n);
      gpu_write(set->inline_buffer, at, set->inline_data + at, n);
   }
}

void
wg_descriptor_write(struct wg_descriptor_set *set, const VkWriteDescriptorSet *w)
{
   if (w->descriptorType == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) {
      const VkWriteDescriptorSetInlineUniformBlock *b =
         vk_find_struct_const(w->pNext, WRITE_DESCRIPTOR_SET_INLINE_UNIFORM_BLOCK);
      if (b)
         inline_write(set, w->dstBinding, w->dstArrayElement, b->pData, b->dataSize);
      return;
   }
   for (uint32_t i = 0; i < w->descriptorCount; i++) {
      struct wg_descriptor *d = slot(set, w->dstBinding, w->dstArrayElement + i);
      if (d)
         write_one(set, d, w->descriptorType, w->pImageInfo ? &w->pImageInfo[i] : NULL,
                   w->pBufferInfo ? &w->pBufferInfo[i] : NULL, w->pTexelBufferView ? &w->pTexelBufferView[i] : NULL);
      sync_planes(set, d);
   }
   set->version++;
}

VKAPI_ATTR void VKAPI_CALL
wg_UpdateDescriptorSets(VkDevice _device, uint32_t writeCount, const VkWriteDescriptorSet *writes,
                        uint32_t copyCount, const VkCopyDescriptorSet *copies)
{
   for (uint32_t i = 0; i < writeCount; i++)
      wg_descriptor_write(wg_descriptor_set_from_handle(writes[i].dstSet), &writes[i]);
   for (uint32_t i = 0; i < copyCount; i++) {
      VK_FROM_HANDLE(wg_descriptor_set, src, copies[i].srcSet);
      VK_FROM_HANDLE(wg_descriptor_set, dst, copies[i].dstSet);
      if (src->layout->type[copies[i].srcBinding] == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) {
         uint32_t binding = copies[i].srcBinding, offset = copies[i].srcArrayElement;
         uint32_t to = copies[i].dstArrayElement, size = copies[i].descriptorCount, to_binding = copies[i].dstBinding;
         for (uint32_t n, at; size && (n = inline_run(src, &binding, &offset, size, &at)); size -= n) {
            inline_write(dst, to_binding, to, src->inline_data + at, n);
            to += n;
         }
         continue;
      }
      for (uint32_t e = 0; e < copies[i].descriptorCount; e++) {
         const struct wg_descriptor *s = slot(src, copies[i].srcBinding, copies[i].srcArrayElement + e);
         struct wg_descriptor *d = slot(dst, copies[i].dstBinding, copies[i].dstArrayElement + e);
         if (s && d) {
            /* An immutable sampler stays, as in writes (VK3 L8a, the track-end review's finding 4). */
            struct wg_sampler *keep = dst->layout->immutable[d - dst->slots];
            *d = *s;
            if (keep)
               d->sampler = keep;
         }
         sync_planes(dst, d);
      }
      dst->version++;
   }
}

void
wg_descriptor_write_template(struct wg_descriptor_set *set, const struct vk_descriptor_update_template *t,
                             const void *data)
{
   for (uint32_t i = 0; i < t->entry_count; i++) {
      const struct vk_descriptor_template_entry *e = &t->entries[i];
      if (e->type == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) {
         inline_write(set, e->binding, e->array_element, (const uint8_t *)data + e->offset, e->array_count);
         continue;
      }
      for (uint32_t k = 0; k < e->array_count; k++) {
         struct wg_descriptor *d = slot(set, e->binding, e->array_element + k);
         const void *p = (const uint8_t *)data + e->offset + k * e->stride;
         if (d)
            write_one(set, d, e->type, p, p, p);
         sync_planes(set, d);
      }
   }
   set->version++;
}

VKAPI_ATTR void VKAPI_CALL
wg_UpdateDescriptorSetWithTemplate(VkDevice _device, VkDescriptorSet _set, VkDescriptorUpdateTemplate _tmpl,
                                   const void *pData)
{
   VK_FROM_HANDLE(vk_descriptor_update_template, t, _tmpl);
   wg_descriptor_write_template(wg_descriptor_set_from_handle(_set), t, pData);
}
