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
#include "vk_util.h"

#include "wg_private.h"

static bool
is_dynamic(VkDescriptorType t)
{
   return t == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC || t == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC;
}

/* One allocation: the layout, then its tables (the runtime frees it whole when its last reference goes). */
static struct wg_descriptor_set_layout *
layout_create(struct wg_device *dev, const VkDescriptorSetLayoutCreateInfo *info)
{
   uint32_t bindings = 0, slots = 0;
   for (uint32_t i = 0; i < info->bindingCount; i++) {
      bindings = MAX2(bindings, info->pBindings[i].binding + 1);
      slots += info->pBindings[i].descriptorCount;
   }
   const size_t size = sizeof(struct wg_descriptor_set_layout) + bindings * (sizeof(int32_t) + sizeof(uint32_t) +
                       sizeof(VkDescriptorType)) + slots * (sizeof(int16_t) + sizeof(struct wg_sampler *)) + 16;
   struct wg_descriptor_set_layout *l = vk_descriptor_set_layout_zalloc(&dev->vk, size, info);
   if (!l)
      return NULL;
   uint8_t *p = (uint8_t *)(l + 1);
   l->immutable = (struct wg_sampler **)p, p += slots * sizeof(struct wg_sampler *);
   l->first = (int32_t *)p, p += bindings * sizeof(int32_t);
   l->count = (uint32_t *)p, p += bindings * sizeof(uint32_t);
   l->type = (VkDescriptorType *)p, p += bindings * sizeof(VkDescriptorType);
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
   uint32_t slot = 0, dynamic = 0;
   for (uint32_t i = 0; i < info->bindingCount; i++) {
      const VkDescriptorSetLayoutBinding *b = &sorted[i];
      l->first[b->binding] = slot;
      l->count[b->binding] = b->descriptorCount;
      l->type[b->binding] = b->descriptorType;
      for (uint32_t e = 0; e < b->descriptorCount; e++) {
         l->dynamic[slot + e] = is_dynamic(b->descriptorType) ? (int16_t)dynamic++ : -1;
         if (b->pImmutableSamplers && (b->descriptorType == VK_DESCRIPTOR_TYPE_SAMPLER ||
                                       b->descriptorType == VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER))
            l->immutable[slot + e] = wg_sampler_from_handle(b->pImmutableSamplers[e]);
      }
      slot += b->descriptorCount;
      _mesa_blake3_update(&hash, &b->binding, sizeof(b->binding));
      _mesa_blake3_update(&hash, &b->descriptorType, sizeof(b->descriptorType));
      _mesa_blake3_update(&hash, &b->descriptorCount, sizeof(b->descriptorCount));
   }
   free(sorted);
   l->slot_count = slot;
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
   /* What a bind group can hold: no inline uniform blocks, nothing past the compiler's slots. */
   uint32_t slots = 0;
   bool ok = true;
   for (uint32_t i = 0; i < pCreateInfo->bindingCount; i++) {
      slots += pCreateInfo->pBindings[i].descriptorCount;
      if (pCreateInfo->pBindings[i].descriptorType == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK)
         ok = false;
   }
   pSupport->supported = ok && slots <= 1024;
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
   for (uint32_t b = 0; b < layout->binding_count; b++)
      for (uint32_t e = 0; layout->first[b] >= 0 && e < layout->count[b]; e++) {
         struct wg_descriptor *d = &set->slots[layout->first[b] + e];
         d->type = layout->type[b];
         d->sampler = layout->immutable[layout->first[b] + e];
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

static void
write_one(struct wg_descriptor *d, VkDescriptorType type, const VkDescriptorImageInfo *image,
          const VkDescriptorBufferInfo *buffer, const VkBufferView *texel)
{
   d->type = type;
   switch (type) {
   case VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER:
   case VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER:
      d->texel = texel ? wg_buffer_view_from_handle(*texel) : NULL;
      break;
   case VK_DESCRIPTOR_TYPE_SAMPLER:
      if (image->sampler)
         d->sampler = wg_sampler_from_handle(image->sampler);
      break;
   case VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER:
      if (image->sampler)
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
      break; /* inline blocks: not offered */
   }
}

void
wg_descriptor_write(struct wg_descriptor_set *set, const VkWriteDescriptorSet *w)
{
   for (uint32_t i = 0; i < w->descriptorCount; i++) {
      struct wg_descriptor *d = slot(set, w->dstBinding, w->dstArrayElement + i);
      if (d)
         write_one(d, w->descriptorType, w->pImageInfo ? &w->pImageInfo[i] : NULL,
                   w->pBufferInfo ? &w->pBufferInfo[i] : NULL, w->pTexelBufferView ? &w->pTexelBufferView[i] : NULL);
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
      for (uint32_t e = 0; e < copies[i].descriptorCount; e++) {
         const struct wg_descriptor *s = slot(src, copies[i].srcBinding, copies[i].srcArrayElement + e);
         struct wg_descriptor *d = slot(dst, copies[i].dstBinding, copies[i].dstArrayElement + e);
         if (s && d)
            *d = *s;
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
      for (uint32_t k = 0; k < e->array_count; k++) {
         struct wg_descriptor *d = slot(set, e->binding, e->array_element + k);
         const void *p = (const uint8_t *)data + e->offset + k * e->stride;
         if (d)
            write_one(d, e->type, p, p, p);
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
