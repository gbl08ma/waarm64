/*
 * The driver's instance, physical device, device, memory and objects (wg_private.h). Written on Mesa's Vulkan runtime
 * the way its drivers are (lavapipe's lvp_device.c for the shape); our own code.
 */
/* The disk cache's real entry points (vk/wasi/disk_cache.c), not util/disk_cache.h's stubs. */
#define ENABLE_SHADER_CACHE 1
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "util/disk_cache.h"
#include "util/format/u_format.h"
#include "util/mesa-blake3.h"
#include "util/u_math.h"
#include "vk_common_entrypoints.h"
#include "vk_format.h"
#include "vk_pipeline_cache.h"
#include "vk_util.h"

#include "wg_private.h"

/* The device's two memory types, each on a heap of its own: device-local, and host-visible coherent (a WebGPU device
 * shares the host's memory only through uploads, so "device-local" too: its shadow buffers). Host-visible memory's
 * bytes are in the renderer's arena (web/ram.ts VENUS_ARENA, 1,280 MiB with the module's own heap), which backs its
 * heap's 1 GiB: the least GFXReconstruct, VMA and DXVK take as general memory (a smaller host-visible heap is a discrete
 * GPU's BAR window to them; VK4 T2, T19). The budget (VK_EXT_memory_budget) reports what's allocated from each heap. */
#define WG_HEAP_SIZE (2ull << 30)
#define WG_HOST_HEAP_SIZE (1ull << 30)
#define WG_MEMORY_HOST 1
static uint64_t heap_used[2];
static const uint64_t heap_sizes[2] = { WG_HEAP_SIZE, WG_HOST_HEAP_SIZE };
bool wg_unwaited_allocations;

uint32_t wg_features, wg_max_immediates;
uintptr_t wg_window_at, wg_window_bytes;

/* Ids: a free list over a counter (JS keeps its objects in an array by id). */
static uint32_t next_id = 1;
static struct util_dynarray free_ids;

uint32_t
wg_id(void)
{
   if (util_dynarray_num_elements(&free_ids, uint32_t))
      return util_dynarray_pop(&free_ids, uint32_t);
   return next_id++;
}

void
wg_id_release(uint32_t id)
{
   if (!id)
      return;
   gpu_destroy(id);
   util_dynarray_append_typed(&free_ids, uint32_t, id);
}

void
wg_json_printf(struct wg_json *j, const char *fmt, ...)
{
   for (;;) {
      va_list ap;
      va_start(ap, fmt);
      const int n = vsnprintf(j->data ? j->data + j->len : NULL, j->data ? j->cap - j->len : 0, fmt, ap);
      va_end(ap);
      if (n < 0)
         return;
      if (j->data && j->len + n < j->cap) {
         j->len += n;
         return;
      }
      j->cap = MAX2(j->cap * 2, j->len + n + 256);
      j->data = realloc(j->data, j->cap);
   }
}

void
wg_json_free(struct wg_json *j)
{
   free(j->data);
   *j = (struct wg_json){ 0 };
}

uint32_t
wg_create_json(enum wg_kind kind, struct wg_json *j)
{
   const uint32_t id = wg_id();
   gpu_create(kind, id, j->data, j->len);
   wg_json_free(j);
   return id;
}

static const struct vk_instance_extension_table wg_instance_extensions = {
   .KHR_device_group_creation = true,
   .KHR_external_fence_capabilities = true,
   .KHR_external_memory_capabilities = true,
   .KHR_external_semaphore_capabilities = true,
   .KHR_get_physical_device_properties2 = true,
   .EXT_debug_report = true,
   .EXT_debug_utils = true,
};

/* What makes the driver's shaders (vk/gen.ts: a hash of vk/'s sources): the pipeline caches' and shader binaries'
 * identity, so that a guest program's saved cache, or the worker's store across runs, from another translator misses. */
#ifndef WG_BUILD_ID
#define WG_BUILD_ID "unknown"
#endif
const char *
wg_build_id(void)
{
   return WG_BUILD_ID;
}

/* The device's caps (features and limits: what the translation depends on besides the shaders), for the cache's key. */
static uint64_t
caps_hash(void)
{
   blake3_hash h;
   blake3_hasher b;
   _mesa_blake3_init(&b);
   _mesa_blake3_update(&b, &wg_features, sizeof(wg_features));
   _mesa_blake3_update(&b, &wg_limits, sizeof(wg_limits));
   _mesa_blake3_final(&b, h);
   uint64_t v;
   memcpy(&v, h, sizeof(v));
   return v;
}

static void
build_uuid(uint8_t *out, const char *salt)
{
   blake3_hash h;
   blake3_hasher b;
   _mesa_blake3_init(&b);
   _mesa_blake3_update(&b, WG_BUILD_ID, strlen(WG_BUILD_ID));
   _mesa_blake3_update(&b, salt, strlen(salt));
   /* What the translation depends on besides the shaders: a cache made with other caps is another's (a guest's saved
    * pipeline cache holds WGSL). */
   const uint64_t caps = caps_hash();
   _mesa_blake3_update(&b, &caps, sizeof(caps));
   _mesa_blake3_final(&b, h);
   memcpy(out, h, VK_UUID_SIZE);
}

static void
wg_physical_device_destroy(struct vk_physical_device *vk)
{
   struct wg_physical_device *pdev = container_of(vk, struct wg_physical_device, vk);
   if (pdev->vk.disk_cache)
      disk_cache_destroy(pdev->vk.disk_cache);
   vk_physical_device_finish(&pdev->vk);
   vk_free(&pdev->vk.instance->alloc, pdev);
}

static VkResult
wg_enumerate_physical_devices(struct vk_instance *vk)
{
   struct wg_instance *instance = container_of(vk, struct wg_instance, vk);
   struct wg_physical_device *pdev =
      vk_zalloc(&instance->vk.alloc, sizeof(*pdev), 8, VK_SYSTEM_ALLOCATION_SCOPE_INSTANCE);
   if (!pdev)
      return vk_error(instance, VK_ERROR_OUT_OF_HOST_MEMORY);

   struct vk_physical_device_dispatch_table dispatch;
   vk_physical_device_dispatch_table_from_entrypoints(&dispatch, &wg_physical_device_entrypoints, true);
   vk_physical_device_dispatch_table_from_entrypoints(&dispatch, &vk_common_physical_device_entrypoints, false);

   /* What the device advertises follows the browser's WebGPU device (wg_caps.c). */
   struct vk_features features;
   wg_caps_features(&features);
   struct vk_properties props = {
      .apiVersion = VK_MAKE_API_VERSION(0, 1, 3, 296),
      .driverVersion = 1,
      .driverID = VK_DRIVER_ID_MESA_VENUS,
      .conformanceVersion = { 0, 0, 0, 0 },
   };
   wg_caps_properties(&props);
   snprintf(props.deviceName, sizeof(props.deviceName), "webpc WebGPU");
   snprintf(props.driverName, sizeof(props.driverName), "webpc");
   snprintf(props.driverInfo, sizeof(props.driverInfo), "Vulkan on WebGPU");
   build_uuid(props.pipelineCacheUUID, "pipeline cache");
   build_uuid(props.shaderBinaryUUID, "shader binary");
   props.shaderBinaryVersion = 1;
   memcpy(props.deviceUUID, "webpc-wg-device0", VK_UUID_SIZE);
   memcpy(props.driverUUID, "webpc-wg-driver0", VK_UUID_SIZE);
   struct vk_device_extension_table exts;
   wg_caps_extensions(&exts);

   VkResult result = vk_physical_device_init(&pdev->vk, &instance->vk, &exts, &features, &props,
                                             &dispatch);
   if (result != VK_SUCCESS) {
      vk_free(&instance->vk.alloc, pdev);
      return result;
   }
   /* Shaders across runs: the runtime's caches look up what they miss in the worker's store (vk/wasi/disk_cache.c). */
   pdev->vk.disk_cache = disk_cache_create("webpc WebGPU", WG_BUILD_ID, caps_hash());
   pdev->sync_types[0] = &wg_sync_type;
   pdev->sync_types[1] = NULL;
   pdev->vk.supported_sync_types = pdev->sync_types;
   list_addtail(&pdev->vk.link, &instance->vk.physical_devices.list);
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_EnumerateInstanceExtensionProperties(const char *pLayerName, uint32_t *pPropertyCount,
                                        VkExtensionProperties *pProperties)
{
   if (pLayerName)
      return vk_error(NULL, VK_ERROR_LAYER_NOT_PRESENT);
   return vk_enumerate_instance_extension_properties(&wg_instance_extensions, pPropertyCount, pProperties);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_EnumerateInstanceVersion(uint32_t *pApiVersion)
{
   *pApiVersion = VK_MAKE_API_VERSION(0, 1, 3, 296);
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateInstance(const VkInstanceCreateInfo *pCreateInfo, const VkAllocationCallbacks *pAllocator,
                  VkInstance *pInstance)
{
   if (!pAllocator)
      pAllocator = vk_default_allocator();
   struct wg_instance *instance =
      vk_zalloc(pAllocator, sizeof(*instance), 8, VK_SYSTEM_ALLOCATION_SCOPE_INSTANCE);
   if (!instance)
      return vk_error(NULL, VK_ERROR_OUT_OF_HOST_MEMORY);

   struct vk_instance_dispatch_table dispatch;
   vk_instance_dispatch_table_from_entrypoints(&dispatch, &wg_instance_entrypoints, true);
   vk_instance_dispatch_table_from_entrypoints(&dispatch, &vk_common_instance_entrypoints, false);
   VkResult result = vk_instance_init(&instance->vk, &wg_instance_extensions, &dispatch, pCreateInfo, pAllocator);
   if (result != VK_SUCCESS) {
      vk_free(pAllocator, instance);
      return vk_error(NULL, result);
   }
   instance->vk.physical_devices.enumerate = wg_enumerate_physical_devices;
   instance->vk.physical_devices.destroy = wg_physical_device_destroy;
   *pInstance = wg_instance_to_handle(instance);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyInstance(VkInstance _instance, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_instance, instance, _instance);
   if (!instance)
      return;
   vk_instance_finish(&instance->vk);
   vk_free(&instance->vk.alloc, instance);
}

VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL
wg_GetInstanceProcAddr(VkInstance _instance, const char *pName)
{
   VK_FROM_HANDLE(wg_instance, instance, _instance);
   return vk_instance_get_proc_addr(instance ? &instance->vk : NULL, &wg_instance_entrypoints, pName);
}

/* The symbol vkr links (virglrenderer's vulkan-dload off): the driver is the Vulkan library. */
PFN_vkVoidFunction VKAPI_CALL vkGetInstanceProcAddr(VkInstance instance, const char *pName);
PFN_vkVoidFunction VKAPI_CALL
vkGetInstanceProcAddr(VkInstance instance, const char *pName)
{
   return wg_GetInstanceProcAddr(instance, pName);
}

/* Physical device queries the runtime doesn't answer from its tables. */

uint32_t wg_queue_families = WG_QUEUE_FAMILIES;

VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceQueueFamilyProperties2(VkPhysicalDevice physicalDevice, uint32_t *pCount,
                                           VkQueueFamilyProperties2 *pProps)
{
   /* WG_QUEUE_FAMILIES: a queue each, all of them the WebGPU queue (VK4 T22: dEQP-VK's commonest want, a family with
    * compute and without graphics). */
   static const VkQueueFlags flags[WG_QUEUE_FAMILIES] = {
      VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT | VK_QUEUE_TRANSFER_BIT,
      VK_QUEUE_COMPUTE_BIT | VK_QUEUE_TRANSFER_BIT,
      VK_QUEUE_TRANSFER_BIT,
   };
   VK_OUTARRAY_MAKE_TYPED(VkQueueFamilyProperties2, out, pProps, pCount);
   for (uint32_t f = 0; f < wg_queue_families; f++)
      vk_outarray_append_typed(VkQueueFamilyProperties2, &out, p) {
         p->queueFamilyProperties = (VkQueueFamilyProperties){
            .queueFlags = flags[f],
            .queueCount = 1,
            .timestampValidBits = 64,
            .minImageTransferGranularity = { 1, 1, 1 },
         };
      }
}

VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceMemoryProperties2(VkPhysicalDevice physicalDevice, VkPhysicalDeviceMemoryProperties2 *pProps)
{
   pProps->memoryProperties = (VkPhysicalDeviceMemoryProperties){
      .memoryTypeCount = 2,
      .memoryTypes = {
         { .propertyFlags = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, .heapIndex = 0 },
         { .propertyFlags = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT | VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT | VK_MEMORY_PROPERTY_HOST_CACHED_BIT,
           .heapIndex = WG_MEMORY_HOST },
      },
      .memoryHeapCount = 2,
      .memoryHeaps = { { .size = WG_HEAP_SIZE, .flags = VK_MEMORY_HEAP_DEVICE_LOCAL_BIT },
                       { .size = WG_HOST_HEAP_SIZE, .flags = VK_MEMORY_HEAP_DEVICE_LOCAL_BIT } },
   };
   VkPhysicalDeviceMemoryBudgetPropertiesEXT *budget =
      vk_find_struct(pProps->pNext, PHYSICAL_DEVICE_MEMORY_BUDGET_PROPERTIES_EXT);
   if (budget) {
      memset(budget->heapBudget, 0, sizeof(budget->heapBudget));
      memset(budget->heapUsage, 0, sizeof(budget->heapUsage));
      budget->heapBudget[0] = WG_HEAP_SIZE;
      budget->heapBudget[1] = WG_HOST_HEAP_SIZE;
      budget->heapUsage[0] = heap_used[0];
      budget->heapUsage[1] = heap_used[1];
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceFormatProperties2(VkPhysicalDevice physicalDevice, VkFormat format,
                                      VkFormatProperties2 *pProps)
{
   VkFormatFeatureFlags linear, optimal, buffer;
   wg_format_features(format, &linear, &optimal, &buffer);
   pProps->formatProperties = (VkFormatProperties){
      .linearTilingFeatures = linear,
      .optimalTilingFeatures = optimal,
      .bufferFeatures = buffer,
   };
   vk_foreach_struct(ext, pProps->pNext) {
      switch (ext->sType) {
      case VK_STRUCTURE_TYPE_FORMAT_PROPERTIES_3: {
         VkFormatProperties3 *p = (void *)ext;
         p->linearTilingFeatures = pProps->formatProperties.linearTilingFeatures;
         p->optimalTilingFeatures = pProps->formatProperties.optimalTilingFeatures;
         p->bufferFeatures = pProps->formatProperties.bufferFeatures;
         /* Storage without a format, wherever there is storage (GD G5: `shaderStorageImage*WithoutFormat`). */
         const VkFormatFeatureFlags2 without = VK_FORMAT_FEATURE_2_STORAGE_READ_WITHOUT_FORMAT_BIT |
                                               VK_FORMAT_FEATURE_2_STORAGE_WRITE_WITHOUT_FORMAT_BIT;
         if (linear & VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT)
            p->linearTilingFeatures |= without;
         if (optimal & VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT)
            p->optimalTilingFeatures |= without;
         if (buffer & VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT)
            p->bufferFeatures |= without;
         break;
      }
      case VK_STRUCTURE_TYPE_DRM_FORMAT_MODIFIER_PROPERTIES_LIST_EXT: {
         /* One modifier, LINEAR, with the optimal tiling's features: the renderer owns the image as any other (WebGPU
          * has no tiling to choose), and Venus's WSI renders into images with a modifier. */
         VkDrmFormatModifierPropertiesListEXT *p = (void *)ext;
         VK_OUTARRAY_MAKE_TYPED(VkDrmFormatModifierPropertiesEXT, out, p->pDrmFormatModifierProperties,
                                &p->drmFormatModifierCount);
         if (optimal && !wg_ycbcr_format(format)) {
            vk_outarray_append_typed(VkDrmFormatModifierPropertiesEXT, &out, m) {
               *m = (VkDrmFormatModifierPropertiesEXT){
                  .drmFormatModifier = 0,
                  .drmFormatModifierPlaneCount = 1,
                  .drmFormatModifierTilingFeatures = optimal,
               };
            }
         }
         break;
      }
      case VK_STRUCTURE_TYPE_DRM_FORMAT_MODIFIER_PROPERTIES_LIST_2_EXT: {
         VkDrmFormatModifierPropertiesList2EXT *p = (void *)ext;
         VK_OUTARRAY_MAKE_TYPED(VkDrmFormatModifierProperties2EXT, out, p->pDrmFormatModifierProperties,
                                &p->drmFormatModifierCount);
         if (optimal && !wg_ycbcr_format(format)) {
            vk_outarray_append_typed(VkDrmFormatModifierProperties2EXT, &out, m) {
               *m = (VkDrmFormatModifierProperties2EXT){
                  .drmFormatModifier = 0,
                  .drmFormatModifierPlaneCount = 1,
                  .drmFormatModifierTilingFeatures = optimal,
               };
            }
         }
         break;
      }
      default:
         break;
      }
   }
}

/* A view format WebGPU gives an image of `format`: its own, or its sRGB or linear twin. */
static bool
view_format_ok(VkFormat format, VkFormat view)
{
   if (view == format || view == VK_FORMAT_UNDEFINED)
      return true;
   const VkFormat twin = vk_format_is_srgb(format)
                            ? vk_format_srgb_to_linear(format)
                            : vk_format_from_pipe_format(util_format_srgb(vk_format_to_pipe_format(format)));
   return view == twin;
}

/* A view of `format` of a texture of `f`, which WebGPU refuses, that a texture of its own can back (VK4 T4): bytes for
 * bytes, a block for a block. A packed format's (16 bits a texel in an rgba8unorm texture) and another of 16 bits a
 * texel copy through a buffer, packed and unpacked by the worker (`copyPacked`): Godot's SDFGI writes an R16_UINT image
 * and samples it as R4G4B4A4 (GD G4). */
static bool
view_format_aliasable(const struct wg_texture_format *f, VkFormat view)
{
   const struct wg_texture_format *v = wg_texture_format(view);
   if (v && ((f->flags | v->flags) & WG_FMT_PACKED))
      return !((f->flags | v->flags) & (WG_FMT_DEPTH | WG_FMT_STENCIL)) && f->bw == 1 && v->bw == 1 &&
             vk_format_get_blocksize(f->vk) == 2 && vk_format_get_blocksize(view) == 2;
   return v && !(f->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL | WG_FMT_PACKED)) &&
          !(v->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL | WG_FMT_PACKED)) && v->bytes == f->bytes && v->bw == f->bw &&
          v->bh == f->bh;
}

/* Whether WebGPU multisamples the format: not the 32-bit integer ones nor the float ones of two or four channels. */
static bool
format_multisamples(const struct wg_texture_format *f)
{
   return strncmp(f->name, "rg32", 4) && strncmp(f->name, "rgba32", 6) && strcmp(f->name, "r32uint") &&
          strcmp(f->name, "r32sint");
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_GetPhysicalDeviceImageFormatProperties2(VkPhysicalDevice physicalDevice,
                                           const VkPhysicalDeviceImageFormatInfo2 *info,
                                           VkImageFormatProperties2 *pProps)
{
   VK_FROM_HANDLE(wg_physical_device, pdev, physicalDevice);
   const struct vk_properties *p = &pdev->vk.properties;
   VkFormatFeatureFlags linear, optimal, buffer;
   wg_format_features(info->format, &linear, &optimal, &buffer);
   VkFormatFeatureFlags features =
      info->tiling == VK_IMAGE_TILING_LINEAR ? linear : optimal; /* a modifier's: the optimal's (above) */
   VkFormatFeatureFlags needed = 0;
   if (info->usage & (VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT))
      needed |= VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT;
   if (info->usage & VK_IMAGE_USAGE_TRANSFER_SRC_BIT)
      needed |= VK_FORMAT_FEATURE_TRANSFER_SRC_BIT;
   if (info->usage & VK_IMAGE_USAGE_TRANSFER_DST_BIT)
      needed |= VK_FORMAT_FEATURE_TRANSFER_DST_BIT;
   if (info->usage & VK_IMAGE_USAGE_STORAGE_BIT)
      needed |= VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT;
   if (info->usage & VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT)
      needed |= VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT;
   if (info->usage & VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT)
      needed |= VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT;
   /* A mutable image's views differ from its format only in sRGB-ness in WebGPU (viewFormats); others take a texture
    * of their own (wg_CreateImageView), but for a shared or linear image, whose texture is what others read. */
   const VkImageFormatListCreateInfo *list = vk_find_struct_const(info->pNext, IMAGE_FORMAT_LIST_CREATE_INFO);
   const struct vk_format_ycbcr_info *ycbcr = wg_ycbcr_format(info->format);
   if ((info->flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) && list) {
      for (uint32_t i = 0; i < list->viewFormatCount; i++) {
         /* A multi-planar image's: its planes' formats (a plane's view, each plane a texture of its own: VK3 L7b,
          * the review of L6b-L7.3's finding 3), or their twins. */
         const VkFormat v = list->pViewFormats[i];
         const struct wg_texture_format *own = wg_texture_format(info->format);
         const bool alias = info->tiling == VK_IMAGE_TILING_OPTIMAL;
         bool ok = view_format_ok(info->format, v) || (alias && own && view_format_aliasable(own, v));
         for (uint8_t p = 0; ycbcr && p < ycbcr->n_planes && !ok; p++) {
            const struct wg_texture_format *plane = wg_texture_format(ycbcr->planes[p].format);
            ok = view_format_ok(ycbcr->planes[p].format, v) || (alias && plane && view_format_aliasable(plane, v));
         }
         if (!ok) {
            pProps->imageFormatProperties = (VkImageFormatProperties){ 0 };
            return VK_ERROR_FORMAT_NOT_SUPPORTED;
         }
      }
   }
   /* A multi-planar image on external memory: its planes' textures are neither imported nor exported
    * (wg_BindImageMemory2; the review of L6b-L7.3's finding 4): refused. */
   const VkPhysicalDeviceExternalImageFormatInfo *external =
      vk_find_struct_const(info->pNext, PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO);
   if (ycbcr && external && external->handleType) {
      pProps->imageFormatProperties = (VkImageFormatProperties){ 0 };
      return VK_ERROR_FORMAT_NOT_SUPPORTED;
   }
   /* WebGPU: no 3D depth or compressed 3D textures, no cube arrays of 1D. */
   const bool depth = features & VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT;
   const struct wg_texture_format *tf = wg_texture_format(info->format);
   const bool compressed = tf && (tf->bw > 1 || tf->bh > 1);
   /* EXTENDED_USAGE: usage its format lacks and a view's has. */
   if (features && tf && (info->flags & VK_IMAGE_CREATE_EXTENDED_USAGE_BIT) && info->tiling == VK_IMAGE_TILING_OPTIMAL)
      features |= wg_view_formats_features(tf, list && list->viewFormatCount ? list->pViewFormats : NULL,
                                           list ? list->viewFormatCount : 0);
   if (!features || (features & needed) != needed || info->type > VK_IMAGE_TYPE_3D ||
       (info->type != VK_IMAGE_TYPE_2D && (depth || compressed))) {
      pProps->imageFormatProperties = (VkImageFormatProperties){ 0 };
      return VK_ERROR_FORMAT_NOT_SUPPORTED;
   }
   /* A multi-planar image (VK3 L7.2): 2D, one level, one sample (EXT_ycbcr_image_arrays: layers). */
   if (ycbcr && (info->type != VK_IMAGE_TYPE_2D || info->tiling != VK_IMAGE_TILING_OPTIMAL ||
                 (info->flags & VK_IMAGE_CREATE_CUBE_COMPATIBLE_BIT))) {
      pProps->imageFormatProperties = (VkImageFormatProperties){ 0 };
      return VK_ERROR_FORMAT_NOT_SUPPORTED;
   }
   const uint32_t dim = info->type == VK_IMAGE_TYPE_1D ? p->maxImageDimension1D
                       : info->type == VK_IMAGE_TYPE_2D ? p->maxImageDimension2D
                                                        : p->maxImageDimension3D;
   /* Multisampled textures are attachments in WebGPU, so a sampled image takes samples where its format renders. */
   const bool attachment = (info->usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT |
                                           VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT)) ||
                           ((info->usage & VK_IMAGE_USAGE_SAMPLED_BIT) && tf &&
                            (tf->flags & (WG_FMT_RENDER | WG_FMT_DEPTH | WG_FMT_STENCIL)));
   /* A view's format is a texture of the image's (VK4 T4): it must multisample too. */
   bool views_multisample = true;
   for (uint32_t i = 0; list && (info->flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) && i < list->viewFormatCount; i++) {
      const struct wg_texture_format *v = wg_texture_format(list->pViewFormats[i]);
      views_multisample &= !v || format_multisamples(v);
   }
   pProps->imageFormatProperties = (VkImageFormatProperties){
      .maxExtent = { dim, info->type == VK_IMAGE_TYPE_1D ? 1 : dim, info->type == VK_IMAGE_TYPE_3D ? dim : 1 },
      .maxMipLevels = ycbcr ? 1 : util_logbase2(dim) + 1,
      .maxArrayLayers = info->type == VK_IMAGE_TYPE_3D ? 1 : p->maxImageArrayLayers,
      /* WebGPU's multisampled textures: 4 samples, 2D, one level and layer, never storage, and none of the 32-bit
       * integer formats nor the float ones of two or four channels. */
      .sampleCounts = info->tiling == VK_IMAGE_TILING_OPTIMAL && info->type == VK_IMAGE_TYPE_2D && attachment &&
                            !(info->usage & VK_IMAGE_USAGE_STORAGE_BIT) && tf && format_multisamples(tf) && views_multisample &&
                            !(info->flags & VK_IMAGE_CREATE_CUBE_COMPATIBLE_BIT)
                         ? VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT
                         : VK_SAMPLE_COUNT_1_BIT,
      .maxResourceSize = 1ull << 31,
   };
   vk_foreach_struct(ext, pProps->pNext) {
      if (ext->sType == VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES) {
         /* Venus's guest shares images as blobs: whatever the guest asks for, the renderer's memory is exportable. */
         VkExternalImageFormatProperties *e = (void *)ext;
         e->externalMemoryProperties = (VkExternalMemoryProperties){
            .externalMemoryFeatures = VK_EXTERNAL_MEMORY_FEATURE_EXPORTABLE_BIT | VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT,
            .exportFromImportedHandleTypes = VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT |
                                             VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT,
            .compatibleHandleTypes = VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT |
                                     VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT,
         };
      } else if (ext->sType == VK_STRUCTURE_TYPE_SAMPLER_YCBCR_CONVERSION_IMAGE_FORMAT_PROPERTIES) {
         ((VkSamplerYcbcrConversionImageFormatProperties *)ext)->combinedImageSamplerDescriptorCount =
            ycbcr ? ycbcr->n_planes : 1;
      }
   }
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceSparseImageFormatProperties2(VkPhysicalDevice physicalDevice,
                                                 const VkPhysicalDeviceSparseImageFormatInfo2 *pFormatInfo,
                                                 uint32_t *pCount, VkSparseImageFormatProperties2 *pProps)
{
   *pCount = 0;
}

VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceExternalBufferProperties(VkPhysicalDevice physicalDevice,
                                             const VkPhysicalDeviceExternalBufferInfo *info,
                                             VkExternalBufferProperties *pProps)
{
   const VkExternalMemoryHandleTypeFlags shared =
      VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT | VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT;
   pProps->externalMemoryProperties = (VkExternalMemoryProperties){
      .externalMemoryFeatures = (info->handleType & shared)
         ? VK_EXTERNAL_MEMORY_FEATURE_EXPORTABLE_BIT | VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT : 0,
      .exportFromImportedHandleTypes = (info->handleType & shared) ? shared : 0,
      .compatibleHandleTypes = (info->handleType & shared) ? shared : 0,
   };
}

/* Fences live in the renderer only: nothing to export (semaphores are the runtime's, from wg_sync_type). */
VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceExternalFenceProperties(VkPhysicalDevice physicalDevice,
                                            const VkPhysicalDeviceExternalFenceInfo *info,
                                            VkExternalFenceProperties *pProps)
{
   pProps->exportFromImportedHandleTypes = 0;
   pProps->compatibleHandleTypes = 0;
   pProps->externalFenceFeatures = 0;
}

/* Semaphores are the runtime's (wg_sync_type: binary and timeline, sync files). An export of any other handle type
 * is dropped rather than refused: Venus's guest driver creates its semaphores asynchronously, so a semaphore vkr's
 * vkCreateSemaphore refused would never exist, and the guest's next submit naming it would kill its context ("failed
 * to look up object … of type 5"). Venus offers its programs only sync files (what it backs in the guest), but
 * Chromium's own Vulkan device asks for opaque fds all the same (VK3 L7.1b); none can be exported through Venus anyway. */
VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateSemaphore(VkDevice _device, const VkSemaphoreCreateInfo *pCreateInfo, const VkAllocationCallbacks *pAllocator,
                   VkSemaphore *pSemaphore)
{
   const VkExportSemaphoreCreateInfo *export = vk_find_struct_const(pCreateInfo->pNext, EXPORT_SEMAPHORE_CREATE_INFO);
   const VkExternalSemaphoreHandleTypeFlags ours = VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_SYNC_FD_BIT;
   if (!export || !(export->handleTypes & ~ours))
      return vk_common_CreateSemaphore(_device, pCreateInfo, pAllocator, pSemaphore);
   /* The same chain with the export's other types taken out (what the runtime reads: the type and the export). */
   const VkSemaphoreTypeCreateInfo *type = vk_find_struct_const(pCreateInfo->pNext, SEMAPHORE_TYPE_CREATE_INFO);
   VkSemaphoreTypeCreateInfo type_copy;
   VkExportSemaphoreCreateInfo export_copy = { .sType = VK_STRUCTURE_TYPE_EXPORT_SEMAPHORE_CREATE_INFO,
                                               .handleTypes = export->handleTypes & ours };
   VkSemaphoreCreateInfo info = *pCreateInfo;
   info.pNext = export_copy.handleTypes ? &export_copy : NULL;
   if (type) {
      type_copy = *type;
      type_copy.pNext = info.pNext;
      info.pNext = &type_copy;
   }
   return vk_common_CreateSemaphore(_device, &info, pAllocator, pSemaphore);
}

/* The device. */

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateDevice(VkPhysicalDevice physicalDevice, const VkDeviceCreateInfo *pCreateInfo,
                const VkAllocationCallbacks *pAllocator, VkDevice *pDevice)
{
   VK_FROM_HANDLE(wg_physical_device, pdev, physicalDevice);
   struct wg_device *dev = vk_zalloc2(&pdev->vk.instance->alloc, pAllocator, sizeof(*dev), 8,
                                      VK_SYSTEM_ALLOCATION_SCOPE_DEVICE);
   if (!dev)
      return vk_error(pdev, VK_ERROR_OUT_OF_HOST_MEMORY);

   /* Ours first, then the runtime's own (pipelines, render passes, dynamic state, the forms it forwards to ours). */
   struct vk_device_dispatch_table dispatch;
   vk_device_dispatch_table_from_entrypoints(&dispatch, &wg_device_entrypoints, true);
   vk_device_dispatch_table_from_entrypoints(&dispatch, &vk_common_device_entrypoints, false);
   VkResult result = vk_device_init(&dev->vk, &pdev->vk, &dispatch, pCreateInfo, pAllocator);
   if (result != VK_SUCCESS) {
      vk_free(&dev->vk.alloc, dev);
      return result;
   }
   dev->vk.command_buffer_ops = &wg_cmd_buffer_ops;
   dev->vk.shader_ops = &wg_device_shader_ops;
   list_inithead(&dev->host_memories);
   list_inithead(&dev->address_memories);
   list_inithead(&dev->linear_images);
   list_inithead(&dev->shared_words);
   list_inithead(&dev->shared_memories);
   list_inithead(&dev->pending);
   list_inithead(&dev->held);
   const VkPipelineCacheCreateInfo cache_info = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO };
   const struct vk_pipeline_cache_create_info cache = { .pCreateInfo = &cache_info, .weak_ref = true };
   dev->vk.mem_cache = vk_pipeline_cache_create(&dev->vk, &cache, NULL);

   const float priority = 1.0f;
   const VkDeviceQueueCreateInfo none = {
      .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
      .queueFamilyIndex = 0,
      .queueCount = 1,
      .pQueuePriorities = &priority,
   };
   /* A queue of each family asked for (one each: the families' queueCount). */
   const uint32_t asked = pCreateInfo->queueCreateInfoCount;
   for (uint32_t i = 0; i < MAX2(asked, 1) && result == VK_SUCCESS; i++) {
      const VkDeviceQueueCreateInfo *info = asked ? &pCreateInfo->pQueueCreateInfos[i] : &none;
      if (info->queueFamilyIndex >= wg_queue_families || info->queueCount != 1 ||
          dev->queue_count == WG_QUEUE_FAMILIES) {
         result = vk_error(pdev, VK_ERROR_INITIALIZATION_FAILED);
         break;
      }
      result = vk_queue_init(&dev->queues[dev->queue_count].vk, &dev->vk, info, 0);
      if (result == VK_SUCCESS)
         dev->queues[dev->queue_count++].vk.driver_submit = wg_queue_submit;
   }
   if (result != VK_SUCCESS) {
      for (uint32_t i = 0; i < dev->queue_count; i++)
         vk_queue_finish(&dev->queues[i].vk);
      vk_pipeline_cache_destroy(dev->vk.mem_cache, NULL);
      vk_device_finish(&dev->vk);
      vk_free(&dev->vk.alloc, dev);
      return result;
   }
   if (!wg_device_register(dev, true)) {
      for (uint32_t i = 0; i < dev->queue_count; i++)
         vk_queue_finish(&dev->queues[i].vk);
      vk_pipeline_cache_destroy(dev->vk.mem_cache, NULL);
      vk_device_finish(&dev->vk);
      vk_free(&dev->vk.alloc, dev);
      return vk_error(pdev, VK_ERROR_TOO_MANY_OBJECTS);
   }
   *pDevice = wg_device_to_handle(dev);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyDevice(VkDevice _device, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   if (!dev)
      return;
   wg_device_register(dev, false);
   wg_device_drain(dev);
   wg_pipeline_premake_finish(dev);
   for (uint32_t i = 0; i < dev->queue_count; i++)
      vk_queue_finish(&dev->queues[i].vk);
   wg_id_release(dev->push_buffer);
   wg_id_release(dev->fan_indices);
   for (uint32_t i = 0; i < 16; i++)
      wg_dummy_unref(dev->dummies[i]);
   wg_id_release(dev->query_scratch);
   wg_id_release(dev->query_mux);
   wg_id_release(dev->shadow[0]);
   wg_id_release(dev->shadow[1]);
   wg_id_release(dev->alias_dummy);
   wg_id_release(dev->address_buffer);
   if (dev->address_heap_made)
      util_vma_heap_finish(&dev->address_heap);
   free(dev->push_data);
   free(dev->pages);
   if (dev->vk.mem_cache)
      vk_pipeline_cache_destroy(dev->vk.mem_cache, NULL);
   vk_device_finish(&dev->vk);
   vk_free(&dev->vk.alloc, dev);
}

/* Memory. */

/* Room in the device's address buffer (vk/README.md "Device addresses"), which starts small and grows in place: false
 * past what one storage binding can reach. An address is a byte of it, never 0. */
#define WG_ADDRESS_FIRST (64ull << 20)
#define WG_ADDRESS_PAD (64ull << 10) /* past each memory: a uniform binding widened to its block (wg_memory_pad) */
static uint64_t
address_most(void)
{
   return MIN3((uint64_t)wg_limits.max_storage_buffer_binding_size, (uint64_t)wg_limits.max_buffer_size,
               0xffff0000ull) & ~3ull;
}

static void
address_grow(struct wg_device *dev, uint64_t size)
{
   if (dev->address_buffer) {
      /* Said: a grow needs the old and the new buffer at once, and every memory with an address is in it (VMA with
       * device addresses gives all of a program's memory the flag, its images' too: GD G8). */
      fprintf(stderr, "wg: the device address buffer grows to %llu MiB\n", (unsigned long long)(size >> 20));
      gpu_grow(dev->address_buffer, size);
      dev->address_gen++;
   } else {
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%llu,\"usage\":%u}", (unsigned long long)size, 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512);
      dev->address_buffer = wg_create_json(WG_KIND_BUFFER, &j);
   }
   dev->address_size = size;
}

/* The address buffer for a binding of it, made if no memory has yet (a pipeline may read through pointers of nothing). */
uint32_t
wg_address_buffer(struct wg_device *dev)
{
   if (!dev->address_buffer)
      address_grow(dev, WG_ADDRESS_FIRST);
   return dev->address_buffer;
}

static bool
address_place(struct wg_device *dev, struct wg_device_memory *mem)
{
   const uint64_t most = address_most();
   if (!dev->address_heap_made) {
      util_vma_heap_init(&dev->address_heap, 4096, most - 4096);
      dev->address_heap.alloc_high = false;
      dev->address_heap_made = true;
   }
   const uint64_t at = util_vma_heap_alloc(&dev->address_heap, mem->size + WG_ADDRESS_PAD, 256);
   if (!at)
      return false;
   if (at + mem->size + WG_ADDRESS_PAD > dev->address_size) {
      uint64_t size = MAX2(dev->address_size, WG_ADDRESS_FIRST);
      while (size < at + mem->size + WG_ADDRESS_PAD)
         size *= 2;
      address_grow(dev, MIN2(size, most));
   }
   mem->gpu = dev->address_buffer;
   mem->gpu_at = at;
   mem->address = true;
   list_addtail(&mem->address_link, &dev->address_memories);
   return true;
}

/* A memory that can't be had: past its heap, the largest GPUBuffer, the address buffer or the arena. The error, unless
 * no one waits for it: Venus's guest sends vkAllocateMemory without waiting (vn_device_memory_alloc_simple, imports too),
 * so an object vkr didn't make would end the context at its first use. It gets an empty memory instead: said once, a
 * direct map fails, a blob's maps zeros that go nowhere, and a buffer past its 4 bytes loses its submit (an image's
 * texture is its own, and works). A program that keeps to its budget doesn't meet it. */
static VkResult
memory_refused(struct wg_device *dev, struct wg_device_memory *mem, const VkAllocationCallbacks *pAllocator, VkDeviceMemory *pMem)
{
   if (mem->address) {
      util_vma_heap_free(&dev->address_heap, mem->gpu_at, mem->size + WG_ADDRESS_PAD);
      list_del(&mem->address_link);
      mem->address = false;
      mem->gpu = 0;
      mem->gpu_at = 0;
   }
   if (!wg_unwaited_allocations) {
      vk_device_memory_destroy(&dev->vk, pAllocator, &mem->vk);
      return vk_error(dev, VK_ERROR_OUT_OF_DEVICE_MEMORY);
   }
   static bool warned;
   if (!warned)
      fprintf(stderr, "wg: an allocation of %llu bytes past what there is: an empty memory, as the guest doesn't wait\n",
              (unsigned long long)mem->vk.size);
   warned = true;
   mem->placeholder = true;
   mem->size = 4;
   mem->host = false;
   mem->data = NULL;
   *pMem = wg_device_memory_to_handle(mem);
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_AllocateMemory(VkDevice _device, const VkMemoryAllocateInfo *pAllocateInfo,
                  const VkAllocationCallbacks *pAllocator, VkDeviceMemory *pMem)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   if (pAllocateInfo->memoryTypeIndex > WG_MEMORY_HOST)
      return vk_error(dev, VK_ERROR_OUT_OF_DEVICE_MEMORY);
   const VkImportMemoryFdInfoKHR *fd_info = vk_find_struct_const(pAllocateInfo->pNext, IMPORT_MEMORY_FD_INFO_KHR);
   if (fd_info && fd_info->handleType == VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT) {
      /* A memory of this device that the guest exported and imports again: vkr passes its handle as the fd (its
       * patch). The import is that memory, one more reference to it (wg_FreeMemory). Another device's, or one that
       * doesn't fit, is a memory of its own below (its bytes not shared). */
      struct wg_device_memory *src = (struct wg_device_memory *)(uintptr_t)(uint32_t)fd_info->fd;
      if (src && src->vk.base.type == VK_OBJECT_TYPE_DEVICE_MEMORY && src->vk.base.device == &dev->vk &&
          pAllocateInfo->allocationSize <= src->vk.size) {
         /* An import that wants addresses of a memory that hasn't any: it moves into the address buffer if nothing is
          * bound to it yet. With a GPUBuffer in use there's no address to give: an error, or for a guest that doesn't wait
          * (an import's as any other: memory_refused) the import all the same, its pointers null. */
         const VkMemoryAllocateFlagsInfo *wanted = vk_find_struct_const(pAllocateInfo->pNext, MEMORY_ALLOCATE_FLAGS_INFO);
         if (wanted && (wanted->flags & VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT) && !src->address &&
             (src->gpu || src->placeholder || !address_place(dev, src))) {
            if (!wg_unwaited_allocations)
               return vk_error(dev, VK_ERROR_INVALID_EXTERNAL_HANDLE);
            static bool warned;
            if (!warned)
               fprintf(stderr, "wg: an import wants device addresses of a memory already in use without: it has none\n");
            warned = true;
         }
         src->aliases++;
         *pMem = wg_device_memory_to_handle(src);
         return VK_SUCCESS;
      }
      fprintf(stderr, "wg: an opaque fd that isn't a memory of this device: a memory of its own\n");
   }
   struct wg_device_memory *mem = vk_device_memory_create(&dev->vk, pAllocateInfo, pAllocator, sizeof(*mem));
   if (!mem)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   mem->size = align64(MAX2(pAllocateInfo->allocationSize, 4), 4);
   mem->host = pAllocateInfo->memoryTypeIndex == WG_MEMORY_HOST;
   const uint32_t type = pAllocateInfo->memoryTypeIndex;
   const VkMemoryAllocateFlagsInfo *flags = vk_find_struct_const(pAllocateInfo->pNext, MEMORY_ALLOCATE_FLAGS_INFO);
   const bool dmabuf = fd_info && fd_info->handleType == VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT && fd_info->fd > 0;
   /* vkr's storage already had (mem->vk.host_ptr) is memory all the same, whatever the heap says: the arena was its limit. */
   const bool past_heap = heap_used[type] + pAllocateInfo->allocationSize > heap_sizes[type] && !mem->vk.host_ptr;
   if ((!dmabuf && (past_heap || pAllocateInfo->allocationSize > MIN2((uint64_t)wg_limits.max_buffer_size, 0xffffffffu))) ||
       (flags && (flags->flags & VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT) && !address_place(dev, mem)))
      return memory_refused(dev, mem, pAllocator, pMem);
   if (dmabuf) {
      /* A dma-buf is another renderer's resource, by id (vkr's patch): its bytes are the GPU worker's to write into
       * the textures bound here; it has no storage of ours, even in a host-visible type. */
      mem->import_res = (uint32_t)fd_info->fd;
      mem->host = false;
   } else if (mem->vk.host_ptr) {
      /* vkr's storage (its patch: host-visible memory is the renderer's, then the window's). */
      mem->data = mem->vk.host_ptr;
      mem->host = true;
   } else if (mem->host) {
      mem->data = aligned_alloc(4096, align64(pAllocateInfo->allocationSize, 4096));
      if (!mem->data)
         return memory_refused(dev, mem, pAllocator, pMem);
      memset(mem->data, 0, pAllocateInfo->allocationSize);
      mem->owned = true;
   }
   /* (An address buffer's memory goes up whole at the next submit, as a new one.) */
   if (mem->host) {
      mem->dirty = true;
      list_addtail(&mem->link, &dev->host_memories);
   }
   heap_used[mem->vk.memory_type_index] += mem->vk.size;
   *pMem = wg_device_memory_to_handle(mem);
   return VK_SUCCESS;
}

uint32_t
wg_memory_buffer(struct wg_device_memory *mem)
{
   if (!mem->gpu) {
      /* MAP_READ can't go with other usages: readbacks go through staging buffers (gpu_readback). WG_MEMORY_PAD
       * bytes past the memory's end: a uniform binding is widened to the block its shader declares (std140 rounds up,
       * a block may be declared past the range bound), which may reach past the memory (VK3 L7a). */
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%llu,\"usage\":%u}", (unsigned long long)(mem->size + wg_memory_pad(mem)),
                     4 | 8 | 16 | 32 | 64 | 128 | 256 | 512);
      mem->gpu = wg_create_json(WG_KIND_BUFFER, &j);
      mem->dirty = mem->host;
   }
   return mem->gpu;
}

VKAPI_ATTR void VKAPI_CALL
wg_FreeMemory(VkDevice _device, VkDeviceMemory _mem, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_device_memory, mem, _mem);
   if (!mem)
      return;
   if (mem->aliases) {
      mem->aliases--;
      return;
   }
   wg_submits_forget(dev, mem);
   /* An image may outlive its memory (then only to be destroyed): off the submits' linear images. */
   list_for_each_entry_safe (struct wg_image, image, &dev->linear_images, linear_link) {
      if (image->mem == mem) {
         list_del(&image->linear_link);
         image->linear_host = false;
      }
   }
   if (mem->image)
      list_del(&mem->shared_link);
   if (mem->host)
      list_del(&mem->link);
   if (mem->owned)
      free(mem->data);
   if (!mem->placeholder)
      heap_used[mem->vk.memory_type_index] -= mem->vk.size;
   if (mem->address) {
      util_vma_heap_free(&dev->address_heap, mem->gpu_at, mem->size + WG_ADDRESS_PAD);
      list_del(&mem->address_link);
   } else {
      wg_id_release(mem->gpu);
   }
   vk_device_memory_destroy(&dev->vk, pAllocator, &mem->vk);
}

/* A dma-buf's memory types: device-local (an import is another renderer's resource: vkr's patch, wg_AllocateMemory). */
VKAPI_ATTR VkResult VKAPI_CALL
wg_GetMemoryFdPropertiesKHR(VkDevice _device, VkExternalMemoryHandleTypeFlagBits handleType, int fd,
                            VkMemoryFdPropertiesKHR *pProps)
{
   if (handleType != VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT || fd <= 0)
      return VK_ERROR_INVALID_EXTERNAL_HANDLE;
   pProps->memoryTypeBits = 1u << 0; /* device-local */
   return VK_SUCCESS;
}

/* The texture of the image bound to a memory (a resource's: web/venus-share.ts shares it with the virgl renderer), or 0. */
uint32_t
wg_memory_texture(VkDeviceMemory _mem)
{
   VK_FROM_HANDLE(wg_device_memory, mem, _mem);
   return mem && mem->image ? mem->image->tex : 0;
}

uint32_t
wg_memory_shared_buffer(VkDeviceMemory _mem)
{
   VK_FROM_HANDLE(wg_device_memory, mem, _mem);
   /* Not an image's, nor another renderer's, nor a share of the device's address buffer (its bytes start past 0). */
   if (!mem || mem->image || mem->import_res || mem->placeholder || mem->address)
      return 0;
   return wg_memory_buffer(mem);
}

void
wg_memory_rebind(VkDeviceMemory _mem, void *data)
{
   VK_FROM_HANDLE(wg_device_memory, mem, _mem);
   mem->data = data;
   /* Its bytes moved without the write-watch seeing them (the renderer copied them): uploaded whole. */
   mem->dirty = true;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_MapMemory2(VkDevice _device, const VkMemoryMapInfo *info, void **ppData)
{
   VK_FROM_HANDLE(wg_device_memory, mem, info->memory);
   if (!mem->data)
      return VK_ERROR_MEMORY_MAP_FAILED;
   *ppData = mem->data + info->offset;
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_UnmapMemory2(VkDevice _device, const VkMemoryUnmapInfo *info)
{
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_FlushMappedMemoryRanges(VkDevice _device, uint32_t count, const VkMappedMemoryRange *ranges)
{
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_InvalidateMappedMemoryRanges(VkDevice _device, uint32_t count, const VkMappedMemoryRange *ranges)
{
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceMemoryCommitment(VkDevice _device, VkDeviceMemory memory, VkDeviceSize *pCommitted)
{
   VK_FROM_HANDLE(wg_device_memory, mem, memory);
   *pCommitted = mem->vk.size;
}

/* Buffers and images. */

uint8_t *
wg_buffer_data(struct wg_buffer *buffer, VkDeviceSize offset)
{
   return buffer->mem && buffer->mem->data ? buffer->mem->data + buffer->mem_offset + offset : NULL;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateBuffer(VkDevice _device, const VkBufferCreateInfo *pCreateInfo, const VkAllocationCallbacks *pAllocator,
                VkBuffer *pBuffer)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_buffer *buffer = vk_buffer_create(&dev->vk, pCreateInfo, pAllocator, sizeof(*buffer));
   if (!buffer)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   *pBuffer = wg_buffer_to_handle(buffer);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyBuffer(VkDevice _device, VkBuffer _buffer, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_buffer, buffer, _buffer);
   if (buffer)
      vk_buffer_destroy(&dev->vk, pAllocator, &buffer->vk);
}

static void
wg_requirements(VkMemoryRequirements2 *reqs, VkDeviceSize size, VkDeviceSize alignment)
{
   reqs->memoryRequirements = (VkMemoryRequirements){
      .size = align64(size, alignment),
      .alignment = alignment,
      .memoryTypeBits = 0x3,
   };
   vk_foreach_struct(ext, reqs->pNext) {
      if (ext->sType == VK_STRUCTURE_TYPE_MEMORY_DEDICATED_REQUIREMENTS) {
         VkMemoryDedicatedRequirements *d = (void *)ext;
         d->prefersDedicatedAllocation = false;
         d->requiresDedicatedAllocation = false;
      }
   }
}

VKAPI_ATTR void VKAPI_CALL
wg_GetBufferMemoryRequirements2(VkDevice _device, const VkBufferMemoryRequirementsInfo2 *info,
                                VkMemoryRequirements2 *reqs)
{
   VK_FROM_HANDLE(wg_buffer, buffer, info->buffer);
   wg_requirements(reqs, align64(MAX2(buffer->vk.size, 4), 4), 256);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceBufferMemoryRequirements(VkDevice _device, const VkDeviceBufferMemoryRequirements *info,
                                     VkMemoryRequirements2 *reqs)
{
   wg_requirements(reqs, align64(MAX2(info->pCreateInfo->size, 4), 4), 256);
}

/* An address is a byte of the device's address buffer (wgsl_nir.c `lower_global` reads it there). */
VKAPI_ATTR VkDeviceAddress VKAPI_CALL
wg_GetBufferDeviceAddress(VkDevice _device, const VkBufferDeviceAddressInfo *pInfo)
{
   VK_FROM_HANDLE(wg_buffer, buffer, pInfo->buffer);
   /* A memory without addresses (an import refused them): null, not a byte of another's. */
   return buffer->mem && buffer->mem->address ? buffer->offset : 0;
}

VKAPI_ATTR uint64_t VKAPI_CALL
wg_GetBufferOpaqueCaptureAddress(VkDevice _device, const VkBufferDeviceAddressInfo *pInfo)
{
   return 0;
}

VKAPI_ATTR uint64_t VKAPI_CALL
wg_GetDeviceMemoryOpaqueCaptureAddress(VkDevice _device, const VkDeviceMemoryOpaqueCaptureAddressInfo *pInfo)
{
   return 0;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_BindBufferMemory2(VkDevice _device, uint32_t count, const VkBindBufferMemoryInfo *infos)
{
   for (uint32_t i = 0; i < count; i++) {
      VK_FROM_HANDLE(wg_buffer, buffer, infos[i].buffer);
      VK_FROM_HANDLE(wg_device_memory, mem, infos[i].memory);
      buffer->mem = mem;
      buffer->mem_offset = infos[i].memoryOffset;
      buffer->offset = mem->gpu_at + infos[i].memoryOffset;
      wg_memory_buffer(mem);
      const VkBindMemoryStatus *status = vk_find_struct_const(infos[i].pNext, BIND_MEMORY_STATUS);
      if (status)
         *status->pResult = VK_SUCCESS;
   }
   return VK_SUCCESS;
}

/* An image whose memory may be a dma-buf (shared with or imported from the guest's other users): tight rows. */
static bool
wg_image_dma_buf(const struct vk_image *image)
{
   return image->tiling == VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT || image->external_handle_types;
}

/* An image's bytes, linear and tightly packed by mip then layer, rows 256-byte aligned (WebGPU's copy pitch): the
 * layout GetImageSubresourceLayout reports for linear images, which the guest maps (its WSI's CPU path). */
static VkDeviceSize
wg_image_layout(const struct vk_image *image, uint32_t level, uint32_t layer, VkSubresourceLayout *out)
{
   const struct util_format_description *d = vk_format_description(image->format);
   const uint32_t bytes = d ? MAX2(d->block.bits / 8, 1) : 4;
   const uint32_t bw = d ? d->block.width : 1, bh = d ? d->block.height : 1;
   VkDeviceSize at = 0;
   for (uint32_t l = 0; l < image->mip_levels; l++) {
      const VkExtent3D e = vk_image_mip_level_extent(image, l);
      /* Rows 256 bytes apart (WebGPU's copies), but a dma-buf's (an external image's, or a DRM modifier's: LINEAR),
       * whose rows are tight: an imported dma-buf (a VA-API surface's plane, its rows the plane's width) must be as large
       * as the image says it needs. (A shared image's memory is never copied to or from its texture: wg_image.shared.) */
      const VkDeviceSize tight = (VkDeviceSize)DIV_ROUND_UP(e.width, bw) * bytes;
      const VkDeviceSize row = wg_image_dma_buf(image) ? tight : align64(tight, 256);
      const VkDeviceSize slice = row * DIV_ROUND_UP(e.height, bh);
      const VkDeviceSize level_size = slice * e.depth * image->array_layers * image->samples;
      if (out && l == level) {
         *out = (VkSubresourceLayout){
            .offset = at + slice * e.depth * layer,
            .size = slice * e.depth,
            .rowPitch = row,
            .arrayPitch = slice * e.depth,
            .depthPitch = slice,
         };
      }
      at += level_size;
   }
   return at;
}

/* A multi-planar image's planes (VK3 L7.2): each plane's format and extent (its format's subsampling), and its bytes
 * after the plane before it, laid out as a 2D image of the plane's format (rows 256-byte aligned). Returns the count. */
static uint32_t
wg_image_planes(const struct vk_image *image, struct wg_image_plane *planes)
{
   const struct vk_format_ycbcr_info *info = vk_format_get_ycbcr_info(image->format);
   VkDeviceSize at = 0;
   for (uint32_t p = 0; p < info->n_planes; p++) {
      const struct wg_texture_format *f = wg_texture_format(info->planes[p].format);
      const uint32_t w = DIV_ROUND_UP(image->extent.width, info->planes[p].denominator_scales[0]);
      const uint32_t h = DIV_ROUND_UP(image->extent.height, info->planes[p].denominator_scales[1]);
      const VkDeviceSize size = align64((VkDeviceSize)w * f->bytes, 256) * h * image->array_layers;
      planes[p] = (struct wg_image_plane){ .fmt = f, .extent = { w, h }, .offset = at, .size = size };
      at = align64(at + size, 4096);
   }
   return info->n_planes;
}

uint32_t
wg_image_plane(const struct wg_image *image, VkImageAspectFlags aspect)
{
   if (image->plane_count < 2)
      return 0;
   return (aspect & (VK_IMAGE_ASPECT_PLANE_2_BIT | VK_IMAGE_ASPECT_MEMORY_PLANE_2_BIT_EXT)) ? 2
          : (aspect & (VK_IMAGE_ASPECT_PLANE_1_BIT | VK_IMAGE_ASPECT_MEMORY_PLANE_1_BIT_EXT)) ? 1 : 0;
}

/* The texture an image is: every usage its Vulkan usage needs (transfers as copies, but clears and blits draw into
 * it, and a blit's source is sampled), with its format's sRGB twin as a view format when views may differ. */
static const char *
wg_dimension(const struct vk_image *image)
{
   switch (image->image_type) {
   case VK_IMAGE_TYPE_3D:
      return "3d";
   default:
      return "2d";
   }
}

/* A format's sRGB twin's name, or its linear twin's; NULL for none. */
static const char *
srgb_twin(const struct wg_texture_format *fmt)
{
   const VkFormat twin = vk_format_is_srgb(fmt->vk) ? vk_format_srgb_to_linear(fmt->vk)
                                                    : vk_format_from_pipe_format(util_format_srgb(vk_format_to_pipe_format(fmt->vk)));
   const struct wg_texture_format *t = twin != fmt->vk ? wg_texture_format(twin) : NULL;
   return t ? t->name : NULL;
}

/* What the worker's copies need of a packed format, as a texture's first JSON key: each of R, G, B, A's shift and bits. */
static void
packed_key(struct wg_json *j, const struct wg_texture_format *fmt)
{
   const struct util_format_description *d = vk_format_description(fmt->vk);
   wg_json_printf(j, "\"packed\":[");
   for (uint32_t c = 0; c < 4; c++) {
      const uint32_t k = d->swizzle[c];
      wg_json_printf(j, "%s%u,%u", c ? "," : "", k <= PIPE_SWIZZLE_W ? d->channel[k].shift : 0,
                     k <= PIPE_SWIZZLE_W ? d->channel[k].size : 0);
   }
   wg_json_printf(j, "],");
}

static uint32_t
wg_texture_create(struct wg_image *image, const struct wg_texture_format *fmt, VkExtent3D e)
{
   const struct vk_image *vi = &image->vk;
   const uint32_t flags = fmt->flags;
   const bool one_d = !strcmp(wg_dimension(vi), "1d");
   uint32_t usage = 0;
   if (vi->usage & VK_IMAGE_USAGE_TRANSFER_SRC_BIT)
      usage |= 1 | ((flags & WG_FMT_SAMPLE) && vi->samples == 1 ? 4 : 0);
   if (vi->usage & VK_IMAGE_USAGE_TRANSFER_DST_BIT)
      usage |= 2 | ((flags & (WG_FMT_RENDER | WG_FMT_DEPTH | WG_FMT_STENCIL)) && !one_d ? 16 : 0);
   if (vi->usage & (VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT))
      usage |= 4;
   if ((vi->usage & VK_IMAGE_USAGE_STORAGE_BIT) && (flags & WG_FMT_STORAGE_TEXTURE))
      usage |= 8;
   /* A storage image a stage only reads is bound as a texture (GD G4: wgsl_print.c `texture_images`). */
   if ((vi->usage & VK_IMAGE_USAGE_STORAGE_BIT) && (flags & WG_FMT_SAMPLE))
      usage |= 4;
   if (vi->usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT))
      usage |= 16;
   /* A pass may draw it in a crop, copied from it and back (`crop_copies`), which for depth may be the worker's shader. */
   if (vi->usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT))
      usage |= 1 | 2 | ((flags & WG_FMT_SAMPLE) ? 4 : 0);
   /* A draw may read it as an input attachment while it's an attachment: from a copy (`feedback_copies`). */
   if ((vi->usage & VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT) &&
       (vi->usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT)))
      usage |= 1;
   /* A multisampled image is read by the draws of its resolves and copies (the worker's resolveDepth, resolveByDraw,
    * copyMultisampled). */
   if (vi->samples > 1)
      usage |= 4;
   /* A linear image may be bound to host-visible memory: copied to and from it at each submit. */
   if (vi->tiling == VK_IMAGE_TILING_LINEAR)
      usage |= 1 | 2;
   /* Such an image can go by its words, copied to and from its texture (VK4 T7, T11). */
   if ((vi->usage & VK_IMAGE_USAGE_STORAGE_BIT) && wg_storage_words(fmt->vk))
      usage |= 1 | 2;
   /* A mutable image's textures of different formats copy between them (VK4 T4), and its usage may be its views'. */
   if (vi->create_flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) {
      usage |= 1 | 2;
      if (!(flags & (WG_FMT_RENDER | WG_FMT_DEPTH | WG_FMT_STENCIL)))
         usage &= ~16u;
      if (!(flags & WG_FMT_SAMPLE))
         usage &= ~4u;
   }
   /* depth24plus can't be copied; depth24plus-stencil8's stencil can. */
   if ((flags & WG_FMT_NOCOPY) && !(flags & WG_FMT_STENCIL))
      usage &= ~3u;
   if (vi->samples > 1)
      usage = (usage & ~8u) | 16;
   if (!usage)
      usage = 4;
   /* An image that may be shared (dma-buf memory: a WSI image, which the guest's compositor imports into virgl) is
    * copied and sampled from for the virgl renderer (web/venus-share.ts), through its linear view. */
   const bool shared = image->shared;
   if (shared && vi->samples == 1 && !(flags & WG_FMT_NOCOPY))
      usage |= 1 | ((flags & WG_FMT_SAMPLE) ? 4 : 0);
   /* ... or bound to memory imported from another renderer's resource, whose bytes the worker writes into it. */
   if (shared && vi->samples == 1 && !(flags & WG_FMT_NOCOPY))
      usage |= 2;
   /* WebGPU wants a compressed texture's size in whole blocks (Vulkan doesn't): rounded up, and copies with it. */
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{");
   if (flags & WG_FMT_PACKED)
      packed_key(&j, fmt);
   {
      wg_json_printf(&j, "\"size\":[");
   }
   wg_json_printf(&j, "%u,%u,%u],\"mipLevelCount\":%u,\"sampleCount\":%u,\"dimension\":\"%s\","
                  "\"format\":\"%s\",\"usage\":%u,\"viewFormats\":[",
                  DIV_ROUND_UP(e.width, fmt->bw) * fmt->bw, DIV_ROUND_UP(e.height, fmt->bh) * fmt->bh,
                  vi->image_type == VK_IMAGE_TYPE_3D ? e.depth : vi->array_layers, vi->mip_levels,
                  vi->samples, wg_dimension(vi), fmt->name, usage);
   /* A multisampled image's too: a copy into or out of its sRGB twin is a draw, of raw values. */
   if ((vi->create_flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) || shared || (vi->samples > 1 && !(flags & (WG_FMT_DEPTH | WG_FMT_STENCIL)))) {
      const char *twin = srgb_twin(fmt);
      if (twin)
         wg_json_printf(&j, "\"%s\"", twin);
   }
   wg_json_printf(&j, "]}");
   return wg_create_json(WG_KIND_TEXTURE, &j);
}

/* The replay keeps which of an image's places hold its bytes (`valid`). */
static void
image_track(struct wg_device *dev, struct wg_image *image)
{
   if (!image->valid) {
      const uint32_t n = image->plane_count * image->vk.mip_levels * wg_image_valid_layers(image);
      image->valid = malloc(n * sizeof(*image->valid));
      for (uint32_t i = 0; i < n; i++)
         image->valid[i] = 1;
   }
   dev->aliased = true;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateImage(VkDevice _device, const VkImageCreateInfo *pCreateInfo, const VkAllocationCallbacks *pAllocator,
               VkImage *pImage)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_image *image = vk_image_create(&dev->vk, pCreateInfo, pAllocator, sizeof(*image));
   if (!image)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   /* A modifier's image is LINEAR, the one modifier offered (GetImageDrmFormatModifierPropertiesEXT). */
   image->size = wg_image_layout(&image->vk, 0, 0, NULL);
   image->fmt = wg_texture_format(image->vk.format);
   image->plane_count = 1;
   if (!image->fmt && wg_ycbcr_format(image->vk.format)) {
      image->plane_count = wg_image_planes(&image->vk, image->planes);
      image->fmt = image->planes[0].fmt;
      image->size = image->planes[image->plane_count - 1].offset + image->planes[image->plane_count - 1].size;
   }
   if (!image->fmt) {
      vk_image_destroy(&dev->vk, pAllocator, &image->vk);
      return vk_error(dev, VK_ERROR_FORMAT_NOT_SUPPORTED);
   }
   image->shared = image->vk.external_handle_types || image->vk.tiling == VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT;
   if (image->plane_count > 1) {
      for (uint32_t p = 0; p < image->plane_count; p++)
         image->planes[p].tex = wg_texture_create(image, image->planes[p].fmt,
                                                  (VkExtent3D){ image->planes[p].extent.width,
                                                                image->planes[p].extent.height, 1 });
      image->tex = image->planes[0].tex;
   } else {
      image->tex = wg_texture_create(image, image->fmt, image->vk.extent);
      image->planes[0] = (struct wg_image_plane){ .tex = image->tex, .fmt = image->fmt,
                                                  .extent = { image->vk.extent.width, image->vk.extent.height },
                                                  .size = image->size };
   }
   /* It can go by its words: commands recorded before its view count. */
   if ((image->vk.usage & VK_IMAGE_USAGE_STORAGE_BIT) && wg_storage_words(image->vk.format))
      image_track(dev, image);
   *pImage = wg_image_to_handle(image);
   return VK_SUCCESS;
}

uint32_t
wg_image_words(struct wg_image *image)
{
   if (!image->words) {
      uint64_t at = 0;
      for (uint32_t m = 0; m < image->vk.mip_levels; m++) {
         image->words_at[m] = at;
         const uint32_t layers = image->vk.image_type == VK_IMAGE_TYPE_3D ? u_minify(image->vk.extent.depth, m)
                                                                          : image->vk.array_layers;
         at += (uint64_t)wg_image_row_bytes(image, m) * u_minify(image->vk.extent.height, m) * layers;
      }
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%llu,\"usage\":%u}", (unsigned long long)at, 0x80 | 4 | 8); /* STORAGE | COPY_* */
      image->words = wg_create_json(WG_KIND_BUFFER, &j);
      if (image->shared) {
         struct wg_device *dev = container_of(image->vk.base.device, struct wg_device, vk);
         list_addtail(&image->words_link, &dev->shared_words);
      }
   }
   return image->words;
}

/* The image's texture of plane `plane` for views of `format`, made at the first such view: its index + 1, or 0 where
 * none can be (the view stays on the image's texture, which WebGPU refuses, said once). */
static uint32_t
image_alias(struct wg_device *dev, struct wg_image *image, uint32_t plane, VkFormat format)
{
   const struct wg_texture_format *own = image->planes[plane].fmt, *view = wg_texture_format(format);
   /* A storage view of an sRGB image's linear twin: WebGPU's usage is the texture's, and sRGB formats have no storage. */
   const bool storage = (image->vk.usage & VK_IMAGE_USAGE_STORAGE_BIT) && image->vk.samples == 1 && view &&
                        (view->flags & WG_FMT_STORAGE_TEXTURE) && !(own->flags & WG_FMT_STORAGE_TEXTURE);
   if (view_format_ok(own->vk, format) && !storage)
      return 0;
   for (uint32_t i = 0; i < image->alias_count; i++)
      if (image->aliases[i].plane == plane && view_format_ok(image->aliases[i].fmt->vk, format))
         return i + 1;
   const bool can = (image->vk.create_flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) && !image->shared &&
                    image->vk.tiling == VK_IMAGE_TILING_OPTIMAL && image->alias_count < WG_IMAGE_ALIASES &&
                    view_format_aliasable(own, format);
   if (!can) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: a view of format %d of plane %u of an image of format %d that no texture can back\n", format,
                 plane, image->vk.format);
      warned = true;
      return 0;
   }
   image_track(dev, image);
   const struct wg_texture_format *f = wg_texture_format(format);
   const VkExtent3D e = image->plane_count > 1 ? (VkExtent3D){ image->planes[plane].extent.width,
                                                               image->planes[plane].extent.height, 1 }
                                               : image->vk.extent;
   image->aliases[image->alias_count] = (struct wg_image_alias){ wg_texture_create(image, f, e), f, plane };
   dev->aliased = true;
   return ++image->alias_count;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyImage(VkDevice _device, VkImage _image, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_image, image, _image);
   if (!image)
      return;
   if (image->shared) {
      list_for_each_entry_safe (struct wg_device_memory, mem, &dev->shared_memories, shared_link) {
         if (mem->image == image) {
            mem->image = NULL;
            list_del(&mem->shared_link);
         }
      }
   }
   if (image->linear_host)
      list_del(&image->linear_link);
   if (image->shared && image->words)
      list_del(&image->words_link);
   if (image->imported)
      gpu_texture_import(image->tex, 0);
   wg_id_release(image->tex);
   for (uint32_t p = 1; p < image->plane_count; p++)
      wg_id_release(image->planes[p].tex);
   for (uint32_t i = 0; i < image->alias_count; i++)
      wg_id_release(image->aliases[i].tex);
   wg_id_release(image->words);
   free(image->valid);
   vk_image_destroy(&dev->vk, pAllocator, &image->vk);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetImageMemoryRequirements2(VkDevice _device, const VkImageMemoryRequirementsInfo2 *info,
                               VkMemoryRequirements2 *reqs)
{
   VK_FROM_HANDLE(wg_image, image, info->image);
   /* A disjoint image's plane: its own bytes. */
   const VkImagePlaneMemoryRequirementsInfo *plane = vk_find_struct_const(info->pNext, IMAGE_PLANE_MEMORY_REQUIREMENTS_INFO);
   if (plane && image->plane_count > 1) {
      wg_requirements(reqs, image->planes[wg_image_plane(image, plane->planeAspect)].size, 4096);
      return;
   }
   wg_requirements(reqs, MAX2(image->size, 1), wg_image_dma_buf(&image->vk) ? 1 : 4096);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceImageMemoryRequirements(VkDevice _device, const VkDeviceImageMemoryRequirements *info,
                                    VkMemoryRequirements2 *reqs)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct vk_image image;
   vk_image_init(&dev->vk, &image, info->pCreateInfo);
   if (!wg_texture_format(image.format) && wg_ycbcr_format(image.format)) {
      struct wg_image_plane planes[3];
      const uint32_t n = wg_image_planes(&image, planes);
      const uint32_t p = (image.create_flags & VK_IMAGE_CREATE_DISJOINT_BIT)
                            ? (info->planeAspect & VK_IMAGE_ASPECT_PLANE_2_BIT ? 2 : info->planeAspect & VK_IMAGE_ASPECT_PLANE_1_BIT ? 1 : 0)
                            : UINT32_MAX;
      wg_requirements(reqs, p < n ? planes[p].size : planes[n - 1].offset + planes[n - 1].size, 4096);
      vk_image_finish(&image);
      return;
   }
   wg_requirements(reqs, MAX2(wg_image_layout(&image, 0, 0, NULL), 1),
                   wg_image_dma_buf(&image) ? 1 : 4096);
   vk_image_finish(&image);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetImageSparseMemoryRequirements2(VkDevice _device, const VkImageSparseMemoryRequirementsInfo2 *info,
                                     uint32_t *pCount, VkSparseImageMemoryRequirements2 *reqs)
{
   *pCount = 0;
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceImageSparseMemoryRequirements(VkDevice _device, const VkDeviceImageMemoryRequirements *info,
                                          uint32_t *pCount, VkSparseImageMemoryRequirements2 *reqs)
{
   *pCount = 0;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_BindImageMemory2(VkDevice _device, uint32_t count, const VkBindImageMemoryInfo *infos)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   for (uint32_t i = 0; i < count; i++) {
      VK_FROM_HANDLE(wg_image, image, infos[i].image);
      VK_FROM_HANDLE(wg_device_memory, mem, infos[i].memory);
      /* A disjoint image's plane (VK3 L7.2): only where its bytes are. */
      const VkBindImagePlaneMemoryInfo *plane = vk_find_struct_const(infos[i].pNext, BIND_IMAGE_PLANE_MEMORY_INFO);
      if (image->plane_count > 1) {
         for (uint32_t p = 0; p < image->plane_count; p++) {
            if (plane && p != wg_image_plane(image, plane->planeAspect))
               continue;
            image->planes[p].mem = mem;
            image->planes[p].mem_offset = infos[i].memoryOffset + (plane ? 0 : image->planes[p].offset);
         }
         if (!plane || wg_image_plane(image, plane->planeAspect) == 0) {
            image->mem = mem;
            image->offset = infos[i].memoryOffset;
         }
         const VkBindMemoryStatus *status = vk_find_struct_const(infos[i].pNext, BIND_MEMORY_STATUS);
         if (status)
            *status->pResult = VK_SUCCESS;
         continue;
      }
      image->mem = mem;
      image->offset = infos[i].memoryOffset;
      if (image->vk.tiling == VK_IMAGE_TILING_LINEAR && mem->host && image->vk.samples == 1 && !image->shared &&
          !(image->fmt->flags & WG_FMT_NOCOPY) && !image->linear_host) {
         image->linear_host = true;
         list_addtail(&image->linear_link, &dev->linear_images);
      }
      if (mem->import_res) {
         image->imported = true;
         gpu_texture_import(image->tex, mem->import_res);
      } else if (image->shared) {
         if (!mem->image)
            list_addtail(&mem->shared_link, &dev->shared_memories);
         mem->image = image;
      }
      const VkBindMemoryStatus *status = vk_find_struct_const(infos[i].pNext, BIND_MEMORY_STATUS);
      if (status)
         *status->pResult = VK_SUCCESS;
   }
   return VK_SUCCESS;
}

void
wg_image_subresource(const struct vk_image *image, uint32_t level, uint32_t layer, VkSubresourceLayout *out)
{
   wg_image_layout(image, level, layer, out);
}

/* A multi-planar image's plane's layer, as its bytes are laid out (wg_image_planes). */
static void
plane_layout(const struct wg_image *image, const VkImageSubresource *sub, VkSubresourceLayout *out)
{
   const struct wg_image_plane *plane = &image->planes[wg_image_plane(image, sub->aspectMask)];
   const VkDeviceSize row = align64((VkDeviceSize)plane->extent.width * plane->fmt->bytes, 256);
   const VkDeviceSize slice = row * plane->extent.height;
   const VkDeviceSize base = (image->vk.create_flags & VK_IMAGE_CREATE_DISJOINT_BIT) ? 0 : plane->offset;
   *out = (VkSubresourceLayout){ .offset = base + slice * sub->arrayLayer, .size = slice, .rowPitch = row,
                                 .arrayPitch = slice, .depthPitch = slice };
}

VKAPI_ATTR void VKAPI_CALL
wg_GetImageSubresourceLayout(VkDevice _device, VkImage _image, const VkImageSubresource *sub,
                             VkSubresourceLayout *layout)
{
   VK_FROM_HANDLE(wg_image, image, _image);
   if (image->plane_count > 1)
      plane_layout(image, sub, layout);
   else
      wg_image_layout(&image->vk, sub->mipLevel, sub->arrayLayer, layout);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetImageSubresourceLayout2(VkDevice _device, VkImage _image, const VkImageSubresource2 *sub,
                              VkSubresourceLayout2 *layout)
{
   VK_FROM_HANDLE(wg_image, image, _image);
   if (image->plane_count > 1)
      plane_layout(image, &sub->imageSubresource, &layout->subresourceLayout);
   else
      wg_image_layout(&image->vk, sub->imageSubresource.mipLevel, sub->imageSubresource.arrayLayer,
                      &layout->subresourceLayout);
}

/* maintenance5's: the layout an image of this description would have, as GetImageSubresourceLayout2 says of one. */
VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceImageSubresourceLayout(VkDevice _device, const VkDeviceImageSubresourceInfo *info, VkSubresourceLayout2 *layout)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_image image = { .plane_count = 1 };
   vk_image_init(&dev->vk, &image.vk, info->pCreateInfo);
   if (!wg_texture_format(image.vk.format) && wg_ycbcr_format(image.vk.format))
      image.plane_count = wg_image_planes(&image.vk, image.planes);
   wg_GetImageSubresourceLayout2(_device, wg_image_to_handle(&image), info->pSubresource, layout);
   vk_image_finish(&image.vk);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_GetImageDrmFormatModifierPropertiesEXT(VkDevice _device, VkImage image,
                                          VkImageDrmFormatModifierPropertiesEXT *pProps)
{
   pProps->drmFormatModifier = 0;
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateImageView(VkDevice _device, const VkImageViewCreateInfo *pCreateInfo,
                   const VkAllocationCallbacks *pAllocator, VkImageView *pView)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_image_view *view = vk_image_view_create(&dev->vk, pCreateInfo, pAllocator, sizeof(*view));
   if (!view)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   struct wg_image *image = container_of(view->vk.image, struct wg_image, vk);
   view->fmt = wg_texture_format(view->vk.view_format);
   /* An E5B9G9R9 view of a 32-bit integer image (VK4 T23: Godot's SDFGI writes R32_UINT volumes and samples them so;
    * WebGPU has no view between the two): a view of the image's own texture, which the shader fetches as words and
    * decodes, its filter the shader's (wgsl_sampler.c), so no texture of the format is copied into at each use. Not a
    * cube (WGSL fetches no cube) nor a swizzled view (its swizzle would move the word). */
   const VkComponentSwizzle given[4] = { view->vk.swizzle.r, view->vk.swizzle.g, view->vk.swizzle.b, view->vk.swizzle.a };
   bool unswizzled = true;
   for (uint32_t i = 0; i < 4; i++) {
      const VkComponentSwizzle m = given[i];
      unswizzled &= m == VK_COMPONENT_SWIZZLE_IDENTITY || m == (VkComponentSwizzle)(VK_COMPONENT_SWIZZLE_R + i);
   }
   view->rgb9e5 = view->vk.view_format == VK_FORMAT_E5B9G9R9_UFLOAT_PACK32 && image->plane_count < 2 &&
                  (image->vk.format == VK_FORMAT_R32_UINT || image->vk.format == VK_FORMAT_R32_SINT) &&
                  image->vk.samples == 1 && unswizzled && view->vk.view_type != VK_IMAGE_VIEW_TYPE_CUBE &&
                  view->vk.view_type != VK_IMAGE_VIEW_TYPE_CUBE_ARRAY && !(wg_emul_skip & WG_SKIP_RGB9E5);
   dev->padded_views |= view->rgb9e5;
   if (image->plane_count < 2 && !(image->fmt->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL)) && !view->rgb9e5)
      view->alias = image_alias(dev, image, 0, view->vk.view_format);
   /* A mutable image's view that can go by the words. */
   if ((view->vk.usage & VK_IMAGE_USAGE_STORAGE_BIT) && wg_storage_words(view->vk.view_format))
      image_track(dev, image);
   const uint32_t tex = view->alias ? image->aliases[view->alias - 1].tex : image->tex;
   /* A depth or stencil aspect of a combined format is the image's format with an aspect in WebGPU (the runtime's
    * view format is the aspect's own). */
   if (!view->fmt || (image->fmt->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL)))
      view->fmt = image->fmt;
   const VkImageAspectFlags aspects = view->vk.aspects;
   const char *aspect = (image->fmt->flags & WG_FMT_DEPTH) && (image->fmt->flags & WG_FMT_STENCIL)
                           ? (aspects == VK_IMAGE_ASPECT_DEPTH_BIT     ? "depth-only"
                              : aspects == VK_IMAGE_ASPECT_STENCIL_BIT ? "stencil-only"
                                                                       : "all")
                           : "all";
   static const char *const dims[] = {
      [VK_IMAGE_VIEW_TYPE_1D] = "1d", [VK_IMAGE_VIEW_TYPE_2D] = "2d", [VK_IMAGE_VIEW_TYPE_3D] = "3d",
      [VK_IMAGE_VIEW_TYPE_CUBE] = "cube", [VK_IMAGE_VIEW_TYPE_1D_ARRAY] = "2d-array",
      [VK_IMAGE_VIEW_TYPE_2D_ARRAY] = "2d-array", [VK_IMAGE_VIEW_TYPE_CUBE_ARRAY] = "cube-array",
   };
   const char *dim = view->vk.view_type <= VK_IMAGE_VIEW_TYPE_CUBE_ARRAY ? dims[view->vk.view_type] : "2d";
   if (!strcmp(dim, "1d") && strcmp(wg_dimension(&image->vk), "1d"))
      dim = "2d";
   /* WebGPU has no multisampled arrays, and an input attachment is declared 2D: one layer's array view is its 2D view. */
   if (!strcmp(dim, "2d-array") && view->vk.layer_count == 1 &&
       (image->vk.samples > 1 || (view->vk.usage & (VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT)) ==
                                    VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT))
      dim = "2d";
   const bool layered = image->vk.image_type != VK_IMAGE_TYPE_3D;
   /* A 2D view of a 3D image is an attachment (`slice` below; VK_EXT_image_2d_view_of_3d isn't offered): WebGPU has none. */
   if (!layered)
      dim = "3d";
   /* A compressed image that isn't whole blocks is a corner of its texture (below, wg_CreateImage): sampled by the shader
    * (wgsl_sampler.c), which sees a cube's faces as a 2D array: such a texture needn't be square. */
   view->padded = image->fmt && (image->fmt->bw > 1 || image->fmt->bh > 1) &&
                  ((image->vk.extent.width % image->fmt->bw) || (image->vk.extent.height % image->fmt->bh));
   dev->padded_views |= view->padded;
   if (view->padded && (view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE || view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY))
      dim = "2d-array";
   struct wg_json j = { 0 };
   /* A multi-planar image's (VK3 L7.2): a view of one plane (a format compatible with the plane's), or of every plane,
    * each in its plane's format, which a sampler's YCbCr conversion samples together. Only sampled and copied. */
   if (image->plane_count > 1) {
      const VkImageAspectFlags a = view->vk.aspects;
      const bool one = a == VK_IMAGE_ASPECT_PLANE_0_BIT || a == VK_IMAGE_ASPECT_PLANE_1_BIT ||
                       a == VK_IMAGE_ASPECT_PLANE_2_BIT;
      const uint32_t first = one ? wg_image_plane(image, a) : 0;
      /* A plane's view in a format other than the plane's (or its twin) is of a texture of its own. */
      if (one)
         view->alias = image_alias(dev, image, first, view->vk.view_format);
      view->first_plane = first;
      view->plane_count = one ? 1 : image->plane_count;
      for (uint32_t p = 0; p < view->plane_count; p++) {
         const struct wg_image_plane *plane = &image->planes[first + p];
         const struct wg_texture_format *vf = one ? wg_texture_format(view->vk.view_format) : NULL;
         const struct wg_texture_format *f = vf ? vf : plane->fmt;
         wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"%s\",\"baseMipLevel\":0,"
                        "\"mipLevelCount\":1,\"baseArrayLayer\":%u,\"arrayLayerCount\":%u}",
                        view->alias ? image->aliases[view->alias - 1].tex : plane->tex, f->name, dim,
                        view->vk.base_array_layer, view->vk.layer_count);
         view->planes[p] = wg_create_json(WG_KIND_VIEW, &j);
      }
      view->fmt = one && wg_texture_format(view->vk.view_format) ? wg_texture_format(view->vk.view_format)
                                                                 : image->planes[first].fmt;
      view->view = view->planes[0];
      view->slice = -1;
      *pView = wg_image_view_to_handle(view);
      return VK_SUCCESS;
   }
   /* An aspect's view takes the aspect's format: left to WebGPU. An E5B9G9R9 view of words is of the words. */
   const char *format = view->rgb9e5 ? image->fmt->name : view->fmt->name;
   wg_json_printf(&j, "{\"texture\":%u,", tex);
   if (!strcmp(aspect, "all"))
      wg_json_printf(&j, "\"format\":\"%s\",", format);
   wg_json_printf(&j, "\"dimension\":\"%s\",\"aspect\":\"%s\",\"baseMipLevel\":%u,"
                  "\"mipLevelCount\":%u,\"baseArrayLayer\":%u,\"arrayLayerCount\":%u}",
                  dim, aspect, view->vk.base_mip_level, view->vk.level_count,
                  layered ? view->vk.base_array_layer : 0, layered ? view->vk.layer_count : 1);
   view->view = wg_create_json(WG_KIND_VIEW, &j);
   /* The component mapping: WebGPU's swizzle, on a view of its own (it allows only sampling through one). Cube views of
    * integer formats, and any sampled, have a 2D array twin: WGSL can only fetch from those, and has no fetch from cubes
    * (wgsl_sampler.c). */
   static const char channels[] = "rgba";
   char swizzle[32] = "";
   const VkComponentSwizzle mapping[4] = { view->vk.swizzle.r, view->vk.swizzle.g, view->vk.swizzle.b, view->vk.swizzle.a };
   bool identity = true;
   char letters[5] = "";
   for (uint32_t i = 0; i < 4; i++) {
      VkComponentSwizzle m = mapping[i] == VK_COMPONENT_SWIZZLE_IDENTITY ? VK_COMPONENT_SWIZZLE_R + i : mapping[i];
      /* Rendered alpha stays out of an opaque format's texture only by the write mask: reads say 1 whatever came in. */
      if (m == VK_COMPONENT_SWIZZLE_A && (view->fmt->flags & WG_FMT_OPAQUE))
         m = VK_COMPONENT_SWIZZLE_ONE;
      letters[i] = m == VK_COMPONENT_SWIZZLE_ZERO ? '0' : m == VK_COMPONENT_SWIZZLE_ONE ? '1' : channels[m - VK_COMPONENT_SWIZZLE_R];
      identity &= m == (VkComponentSwizzle)(VK_COMPONENT_SWIZZLE_R + i);
   }
   if (!identity && (wg_features & WG_FEATURE_SWIZZLE))
      snprintf(swizzle, sizeof(swizzle), "\"swizzle\":\"%s\",\"usage\":4,", letters);
   else if (!identity) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: the browser has no texture-component-swizzle: image views' component mappings are ignored\n");
      warned = true;
   }
   if (swizzle[0]) {
      wg_json_printf(&j, "{\"texture\":%u,%s", tex, swizzle);
      if (!strcmp(aspect, "all"))
         wg_json_printf(&j, "\"format\":\"%s\",", view->fmt->name);
      wg_json_printf(&j, "\"dimension\":\"%s\",\"aspect\":\"%s\",\"baseMipLevel\":%u,"
                     "\"mipLevelCount\":%u,\"baseArrayLayer\":%u,\"arrayLayerCount\":%u}",
                     dim, aspect, view->vk.base_mip_level, view->vk.level_count,
                     layered ? view->vk.base_array_layer : 0, layered ? view->vk.layer_count : 1);
      view->sampled = wg_create_json(WG_KIND_VIEW, &j);
   }
   /* A 2D array view bound where a stage declares 2D: its base layer, as native drivers read it (GD G4: one layer,
    * SDFGI's default texture; GD G7: the GI demo's SDFGI binds an 8-layer view so). */
   if (view->vk.view_type == VK_IMAGE_VIEW_TYPE_2D_ARRAY && layered &&
       !strcmp(dim, "2d-array") && (view->vk.usage & VK_IMAGE_USAGE_SAMPLED_BIT)) {
      wg_json_printf(&j, "{\"texture\":%u,%s", tex, swizzle);
      if (!strcmp(aspect, "all"))
         wg_json_printf(&j, "\"format\":\"%s\",", format);
      wg_json_printf(&j, "\"dimension\":\"2d\",\"aspect\":\"%s\",\"baseMipLevel\":%u,\"mipLevelCount\":%u,"
                     "\"baseArrayLayer\":%u,\"arrayLayerCount\":1}",
                     aspect, view->vk.base_mip_level, view->vk.level_count, view->vk.base_array_layer);
      view->flat = wg_create_json(WG_KIND_VIEW, &j);
   }
   /* Also any cube sampled: a min/max reduction's samples are fetched from its faces (VK4 T25). */
   if ((view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE || view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY) &&
       (vk_format_is_int(view->vk.view_format) || aspects == VK_IMAGE_ASPECT_STENCIL_BIT ||
        aspects == VK_IMAGE_ASPECT_DEPTH_BIT || (view->vk.usage & VK_IMAGE_USAGE_SAMPLED_BIT))) {
      wg_json_printf(&j, "{\"texture\":%u,%s", tex, swizzle);
      if (!strcmp(aspect, "all"))
         wg_json_printf(&j, "\"format\":\"%s\",", view->fmt->name);
      wg_json_printf(&j, "\"dimension\":\"2d-array\",\"aspect\":\"%s\",\"baseMipLevel\":%u,"
                     "\"mipLevelCount\":%u,\"baseArrayLayer\":%u,\"arrayLayerCount\":%u}",
                     aspect, view->vk.base_mip_level, view->vk.level_count, view->vk.base_array_layer, view->vk.layer_count);
      view->faces = wg_create_json(WG_KIND_VIEW, &j);
   }
   /* A storage texture's binding has no cube dimension: a cube view's faces as a 2D array (the translator declares
    * cube storage images as 2D arrays). */
   if ((view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE || view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY) &&
       (image->vk.usage & VK_IMAGE_USAGE_STORAGE_BIT)) {
      wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"2d-array\",\"baseMipLevel\":%u,"
                     "\"mipLevelCount\":%u,\"baseArrayLayer\":%u,\"arrayLayerCount\":%u}",
                     tex, view->fmt->name, view->vk.base_mip_level, view->vk.level_count,
                     view->vk.base_array_layer, view->vk.layer_count);
      view->storage = wg_create_json(WG_KIND_VIEW, &j);
   }
   /* As an attachment: one level and one layer, 2D; a 3D image's level as a 3D view and the slice the view starts at
    * (a 2D view of a 3D image), the render pass's depthSlice. */
   view->slice = -1;
   if (!layered && image->vk.usage & VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT && (view->fmt->flags & WG_FMT_RENDER)) {
      wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"3d\",\"baseMipLevel\":%u,\"mipLevelCount\":1}",
                     tex, view->fmt->name, view->vk.base_mip_level);
      view->att = wg_create_json(WG_KIND_VIEW, &j);
      view->slice = view->vk.base_array_layer;
   } else if (image->vk.usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT |
                          VK_IMAGE_USAGE_TRANSFER_DST_BIT) &&
       layered && strcmp(wg_dimension(&image->vk), "1d") &&
       (view->fmt->flags & (WG_FMT_RENDER | WG_FMT_DEPTH | WG_FMT_STENCIL))) {
      wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"2d\",\"baseMipLevel\":%u,"
                     "\"mipLevelCount\":1,\"baseArrayLayer\":%u,\"arrayLayerCount\":1}",
                     tex, view->fmt->name, view->vk.base_mip_level, view->vk.base_array_layer);
      view->att = wg_create_json(WG_KIND_VIEW, &j);
   }
   *pView = wg_image_view_to_handle(view);
   return VK_SUCCESS;
}

uint32_t
wg_view_att(struct wg_image_view *view, uint32_t index)
{
   /* A 3D image's slices are the pass's `depthSlice` of one view. */
   if (!index || index >= WG_MAX_LAYERS || view->slice >= 0 || !view->att)
      return view->att;
   if (!view->layer_atts)
      view->layer_atts = calloc(WG_MAX_LAYERS - 1, sizeof(*view->layer_atts));
   if (!view->layer_atts[index - 1]) {
      const struct wg_image *image = container_of(view->vk.image, struct wg_image, vk);
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"2d\",\"baseMipLevel\":%u,"
                     "\"mipLevelCount\":1,\"baseArrayLayer\":%u,\"arrayLayerCount\":1}",
                     view->alias ? image->aliases[view->alias - 1].tex : image->tex, view->fmt->name,
                     view->vk.base_mip_level, view->vk.base_array_layer + index);
      view->layer_atts[index - 1] = wg_create_json(WG_KIND_VIEW, &j);
   }
   return view->layer_atts[index - 1];
}

struct wg_view_crop *
wg_view_crop(struct wg_image_view *view, uint32_t width, uint32_t height)
{
   for (struct wg_view_crop *c = view->crops; c; c = c->next)
      if (c->width == width && c->height == height)
         return c;
   const uint32_t layers = view->vk.layer_count;
   struct wg_view_crop *c = calloc(1, sizeof(*c) + layers * sizeof(c->atts[0]));
   c->width = width, c->height = height;
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{");
   if (view->fmt->flags & WG_FMT_PACKED)
      packed_key(&j, view->fmt);
   /* COPY_SRC | COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT (the worker draws copies it can't make). */
   wg_json_printf(&j, "\"size\":[%u,%u,%u],\"format\":\"%s\",\"sampleCount\":%u,\"usage\":%u,\"viewFormats\":[",
                  width, height, layers, view->fmt->name, view->vk.image->samples,
                  4 | 16 | ((view->fmt->flags & WG_FMT_NOCOPY) && !(view->fmt->flags & WG_FMT_STENCIL) ? 0 : 3));
   /* As a multisampled image's: its copies are draws of raw values. */
   const char *twin = view->vk.image->samples > 1 ? srgb_twin(view->fmt) : NULL;
   if (twin)
      wg_json_printf(&j, "\"%s\"", twin);
   wg_json_printf(&j, "]}");
   c->texture = wg_create_json(WG_KIND_TEXTURE, &j);
   c->next = view->crops;
   view->crops = c;
   return c;
}

uint32_t
wg_crop_att(struct wg_image_view *view, struct wg_view_crop *crop, uint32_t index)
{
   if (!crop->atts[index]) {
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"texture\":%u,\"dimension\":\"2d\",\"mipLevelCount\":1,\"baseArrayLayer\":%u,\"arrayLayerCount\":1}",
                     crop->texture, index);
      crop->atts[index] = wg_create_json(WG_KIND_VIEW, &j);
   }
   return crop->atts[index];
}

uint32_t
wg_view_twin(struct wg_image_view *view)
{
   if (!view->twin) {
      const VkExtent3D e = vk_image_mip_level_extent(view->vk.image, view->vk.base_mip_level);
      const bool depth = view->fmt->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL);
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{");
      /* As the image's texture: the worker's copy between them is a packed format's own. */
      if (view->fmt->flags & WG_FMT_PACKED)
         packed_key(&j, view->fmt);
      /* TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT (depth24plus takes no copies: drawn). */
      wg_json_printf(&j, "\"size\":{\"width\":%u,\"height\":%u},\"format\":\"%s\",\"sampleCount\":%u,\"usage\":%u}",
                     e.width, e.height, view->fmt->name, view->vk.image->samples,
                     4 | 16 | ((view->fmt->flags & WG_FMT_NOCOPY) && !(view->fmt->flags & WG_FMT_STENCIL) ? 0 : 2));
      view->twin_tex = wg_create_json(WG_KIND_TEXTURE, &j);
      j = (struct wg_json){ 0 };
      wg_json_printf(&j, "{\"texture\":%u,\"dimension\":\"2d\",\"mipLevelCount\":1,\"arrayLayerCount\":1%s%s}", view->twin_tex,
                     (view->fmt->flags & WG_FMT_OPAQUE) && (wg_features & WG_FEATURE_SWIZZLE) ? ",\"swizzle\":\"rgb1\",\"usage\":4" : "",
                     !depth || view->vk.aspects == (VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT) ? ""
                     : view->vk.aspects & VK_IMAGE_ASPECT_DEPTH_BIT ? ",\"aspect\":\"depth-only\""
                                                                    : ",\"aspect\":\"stencil-only\"");
      view->twin = wg_create_json(WG_KIND_VIEW, &j);
   }
   return view->twin;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyImageView(VkDevice _device, VkImageView _view, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_image_view, view, _view);
   if (!view)
      return;
   wg_id_release(view->twin);
   wg_id_release(view->twin_tex);
   wg_id_release(view->flat);
   wg_id_release(view->view);
   wg_id_release(view->storage);
   wg_id_release(view->sampled);
   wg_id_release(view->faces);
   wg_id_release(view->att);
   for (uint32_t i = 0; view->layer_atts && i < WG_MAX_LAYERS - 1; i++)
      wg_id_release(view->layer_atts[i]);
   free(view->layer_atts);
   for (struct wg_view_crop *c = view->crops, *next; c; c = next) {
      next = c->next;
      for (uint32_t i = 0; i < view->vk.layer_count; i++)
         wg_id_release(c->atts[i]);
      wg_id_release(c->texture);
      free(c);
   }
   for (uint32_t p = 1; p < view->plane_count; p++)
      wg_id_release(view->planes[p]);
   vk_image_view_destroy(&dev->vk, pAllocator, &view->vk);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateBufferView(VkDevice _device, const VkBufferViewCreateInfo *pCreateInfo,
                    const VkAllocationCallbacks *pAllocator, VkBufferView *pView)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_buffer_view *view = vk_buffer_view_create(&dev->vk, pCreateInfo, pAllocator, sizeof(*view));
   if (!view)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   VK_FROM_HANDLE(wg_buffer, buffer, pCreateInfo->buffer);
   uint32_t x = 0, p1[3] = { 0 };
   bool storage;
   view->offered = wg_texel_buffer_layout(view->vk.format, &x, p1, &storage);
   if (!view->offered)
      fprintf(stderr, "wg: a buffer view of format %u, which texel buffers don't offer\n", view->vk.format);
   /* Its words bound from the memory's GPUBuffer at a storage-aligned offset; the parameters say where its first texel
    * is in that binding, and how many texels it has (a texel past them reads 0). */
   view->mem = buffer->mem;
   const uint64_t start = buffer->offset + view->vk.offset, align = MAX2(wg_limits.min_storage_buffer_offset_alignment, 4);
   view->at = start / align * align;
   view->size = align64(start - view->at + view->vk.range, 4);
   if (view->mem && view->at + view->size > view->mem->gpu_at + view->mem->size)
      view->size = view->mem->gpu_at + view->mem->size > view->at ? view->mem->gpu_at + view->mem->size - view->at : 0;
   const uint32_t params[8] = { x, (uint32_t)(start - view->at), view->vk.elements, 0, p1[0], p1[1], p1[2], 0 };
   memcpy(view->params, params, sizeof(params));
   *pView = wg_buffer_view_to_handle(view);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyBufferView(VkDevice _device, VkBufferView _view, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_buffer_view, view, _view);
   if (!view)
      return;
   vk_buffer_view_destroy(&dev->vk, pAllocator, &view->vk);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateSampler(VkDevice _device, const VkSamplerCreateInfo *pCreateInfo, const VkAllocationCallbacks *pAllocator,
                 VkSampler *pSampler)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_sampler *sampler = vk_sampler_create(&dev->vk, pCreateInfo, pAllocator, sizeof(*sampler));
   if (!sampler)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   /* Borders and mirror-once aren't WebGPU's: the shader's, on the nearest of its modes (wgsl_sampler.c). */
   static const char *const address[] = {
      [VK_SAMPLER_ADDRESS_MODE_REPEAT] = "repeat", [VK_SAMPLER_ADDRESS_MODE_MIRRORED_REPEAT] = "mirror-repeat",
      [VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE] = "clamp-to-edge",
      [VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_BORDER] = "clamp-to-edge",
      [VK_SAMPLER_ADDRESS_MODE_MIRROR_CLAMP_TO_EDGE] = "mirror-repeat",
   };
   static const char *const compare[] = { "never", "less", "equal", "less-equal", "greater", "not-equal",
                                          "greater-equal", "always" };
   const VkSamplerCreateInfo *c = pCreateInfo;
   /* Unnormalized coordinates: Vulkan asks for clamp-to-edge or border, a level; the shader makes them normalized. */
   const float lod_min = CLAMP(c->minLod, 0.0f, 32.0f), lod_max = CLAMP(c->maxLod, lod_min, 32.0f);
   const bool linear = c->magFilter == VK_FILTER_LINEAR && c->minFilter == VK_FILTER_LINEAR &&
                       c->mipmapMode == VK_SAMPLER_MIPMAP_MODE_LINEAR;
   const unsigned aniso = c->anisotropyEnable && linear ? CLAMP((unsigned)c->maxAnisotropy, 1, 16) : 1;
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"addressModeU\":\"%s\",\"addressModeV\":\"%s\",\"addressModeW\":\"%s\",\"magFilter\":\"%s\","
                  "\"minFilter\":\"%s\",\"mipmapFilter\":\"%s\",\"lodMinClamp\":%g,\"lodMaxClamp\":%g,\"maxAnisotropy\":%u",
                  address[MIN2(c->addressModeU, 4)], address[MIN2(c->addressModeV, 4)],
                  address[MIN2(c->addressModeW, 4)], c->magFilter == VK_FILTER_LINEAR ? "linear" : "nearest",
                  c->minFilter == VK_FILTER_LINEAR ? "linear" : "nearest",
                  c->mipmapMode == VK_SAMPLER_MIPMAP_MODE_LINEAR ? "linear" : "nearest", lod_min, lod_max, aniso);
   sampler->refs = 1;
   sampler->compare = c->compareEnable;
   memset(&sampler->key, 0, sizeof(sampler->key));
   sampler->key.address[0] = MIN2(c->addressModeU, WGSL_ADDRESS_MIRROR_ONCE);
   sampler->key.address[1] = MIN2(c->addressModeV, WGSL_ADDRESS_MIRROR_ONCE);
   sampler->key.address[2] = MIN2(c->addressModeW, WGSL_ADDRESS_MIRROR_ONCE);
   sampler->key.mag_linear = c->magFilter == VK_FILTER_LINEAR;
   sampler->key.min_linear = c->minFilter == VK_FILTER_LINEAR;
   sampler->key.mip_linear = c->mipmapMode == VK_SAMPLER_MIPMAP_MODE_LINEAR;
   sampler->key.unnormalized = c->unnormalizedCoordinates;
   sampler->key.compare = c->compareEnable ? c->compareOp : VK_COMPARE_OP_ALWAYS;
   sampler->key.bias = c->mipLodBias;
   /* VK_LOD_CLAMP_NONE and programs' infinities: WGSL's min and max are indeterminate on them. */
   sampler->key.min_lod = CLAMP(c->minLod, -1000.0f, 1000.0f);
   sampler->key.max_lod = CLAMP(c->maxLod, -1000.0f, 1000.0f);
   for (uint32_t i = 0; i < 3; i++)
      sampler->emulated |= sampler->key.address[i] == WGSL_ADDRESS_BORDER ||
                           sampler->key.address[i] == WGSL_ADDRESS_MIRROR_ONCE;
   sampler->emulated |= c->unnormalizedCoordinates || c->mipLodBias != 0.0f;
   /* A min/max reduction (VK_EXT_sampler_filter_minmax, VK4 T25): the shader's filter from fetches. A nearest one reads
    * the texel whatever the reduction: WebGPU's. */
   if (sampler->vk.reduction_mode == VK_SAMPLER_REDUCTION_MODE_MIN || sampler->vk.reduction_mode == VK_SAMPLER_REDUCTION_MODE_MAX)
      sampler->key.reduction = sampler->key.mag_linear || sampler->key.min_linear || sampler->key.mip_linear
                                  ? (sampler->vk.reduction_mode == VK_SAMPLER_REDUCTION_MODE_MIN ? 1 : 2)
                                  : 0;
   sampler->emulated |= sampler->key.reduction != 0;
   /* A non-seamless cube (VK4 T28): a linear filter that keeps to the face, from fetches of its faces (wg_cmd.c
    * `pair_key`, a cube's pairs only); a nearest one never leaves the face. */
   sampler->key.non_seamless = (c->flags & VK_SAMPLER_CREATE_NON_SEAMLESS_CUBE_MAP_BIT_EXT) &&
                               (sampler->key.mag_linear || sampler->key.min_linear);
   if (c->compareEnable)
      wg_json_printf(&j, ",\"compare\":\"%s\"", compare[c->compareOp & 7]);
   wg_json_printf(&j, "}");
   sampler->id = wg_create_json(WG_KIND_SAMPLER, &j);
   /* A filtering sampler's nearest twin, for views WebGPU can't filter (depth, unfilterable float). */
   if (!c->compareEnable && (c->magFilter == VK_FILTER_LINEAR || c->minFilter == VK_FILTER_LINEAR ||
                             c->mipmapMode == VK_SAMPLER_MIPMAP_MODE_LINEAR)) {
      wg_json_printf(&j, "{\"addressModeU\":\"%s\",\"addressModeV\":\"%s\",\"addressModeW\":\"%s\",\"lodMinClamp\":%g,"
                     "\"lodMaxClamp\":%g}", address[MIN2(c->addressModeU, 4)], address[MIN2(c->addressModeV, 4)],
                     address[MIN2(c->addressModeW, 4)], lod_min, lod_max);
      sampler->nearest = wg_create_json(WG_KIND_SAMPLER, &j);
   }
   *pSampler = wg_sampler_to_handle(sampler);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroySampler(VkDevice _device, VkSampler _sampler, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_sampler, sampler, _sampler);
   if (!sampler)
      return;
   wg_sampler_unref(dev, sampler, pAllocator);
}

void
wg_sampler_unref(struct wg_device *dev, struct wg_sampler *sampler, const VkAllocationCallbacks *alloc)
{
   if (--sampler->refs)
      return;
   wg_id_release(sampler->id);
   wg_id_release(sampler->nearest);
   vk_sampler_destroy(&dev->vk, alloc, &sampler->vk);
}

/* Queries and events. */

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateQueryPool(VkDevice _device, const VkQueryPoolCreateInfo *pCreateInfo,
                   const VkAllocationCallbacks *pAllocator, VkQueryPool *pPool)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_query_pool *pool = vk_query_pool_create(&dev->vk, pCreateInfo, pAllocator, sizeof(*pool));
   if (!pool)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   const uint32_t n = pCreateInfo->queryCount;
   pool->values = calloc(n, sizeof(uint64_t));
   pool->avail = calloc(n, 1);
   pool->ended = calloc(n, sizeof(uint32_t));
   if (!pool->values || !pool->avail || !pool->ended) {
      free(pool->values), free(pool->avail), free(pool->ended);
      vk_query_pool_destroy(&dev->vk, pAllocator, &pool->vk);
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   }
   if (pCreateInfo->queryType == VK_QUERY_TYPE_OCCLUSION) {
      struct wg_json j = { 0 };
      /* 64 spare slots where WebGPU's 4096 leave room. */
      pool->spares = n < 4096 ? MIN2(4096 - n, 64) : 0;
      wg_json_printf(&j, "{\"type\":\"occlusion\",\"count\":%u}", MIN2(n, 4096) + pool->spares);
      pool->set = wg_create_json(WG_KIND_QUERY_SET, &j);
      /* QUERY_RESOLVE | STORAGE (gpu_query_add) | COPY_SRC | COPY_DST */
      wg_json_printf(&j, "{\"size\":%u,\"usage\":%u}", (n + pool->spares) * 8, 0x200 | 0x80 | 4 | 8);
      pool->buf = wg_create_json(WG_KIND_BUFFER, &j);
   }
   *pPool = wg_query_pool_to_handle(pool);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyQueryPool(VkDevice _device, VkQueryPool _pool, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_query_pool, pool, _pool);
   if (!pool)
      return;
   /* Vulkan says its submits are done by now; were they not, their completion mustn't write into it. */
   wg_submits_forget_pool(dev, pool);
   wg_id_release(pool->set);
   wg_id_release(pool->buf);
   free(pool->values), free(pool->avail), free(pool->ended);
   vk_query_pool_destroy(&dev->vk, pAllocator, &pool->vk);
}

/* A query is available once the submit that ended it has completed (its value read back by then). The host can't wait
 * here for a submit (it completes in a later task of the worker's): with WAIT_BIT an unavailable query is VK_NOT_READY
 * too. Venus's guest driver reads its own feedback buffers, which vkCmdCopyQueryPoolResults fills, instead. */
VKAPI_ATTR VkResult VKAPI_CALL
wg_GetQueryPoolResults(VkDevice _device, VkQueryPool _pool, uint32_t first, uint32_t count, size_t dataSize,
                       void *pData, VkDeviceSize stride, VkQueryResultFlags flags)
{
   VK_FROM_HANDLE(wg_query_pool, pool, _pool);
   const bool wide = flags & VK_QUERY_RESULT_64_BIT;
   VkResult result = VK_SUCCESS;
   for (uint32_t i = 0; i < count; i++) {
      uint8_t *out = (uint8_t *)pData + stride * i;
      const uint32_t e = pool->ended[first + i];
      const bool avail = e && (int32_t)(wg_completed_serial - e) >= 0;
      if (!avail)
         result = VK_NOT_READY;
      const uint64_t v = avail ? pool->values[first + i] : 0;
      if (avail || (flags & VK_QUERY_RESULT_PARTIAL_BIT)) {
         if (wide)
            memcpy(out, &v, 8);
         else
            memcpy(out, &(uint32_t){ (uint32_t)v }, 4);
      }
      if (flags & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT) {
         if (wide)
            memcpy(out + 8, &(uint64_t){ avail }, 8);
         else
            memcpy(out + 4, &(uint32_t){ avail }, 4);
      }
   }
   return result;
}

VKAPI_ATTR void VKAPI_CALL
wg_ResetQueryPool(VkDevice _device, VkQueryPool _pool, uint32_t first, uint32_t count)
{
   VK_FROM_HANDLE(wg_query_pool, pool, _pool);
   memset(&pool->values[first], 0, count * sizeof(uint64_t));
   memset(&pool->avail[first], 0, count);
   memset(&pool->ended[first], 0, count * sizeof(uint32_t));
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateEvent(VkDevice _device, const VkEventCreateInfo *pCreateInfo, const VkAllocationCallbacks *pAllocator,
               VkEvent *pEvent)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_event *event = vk_object_zalloc(&dev->vk, pAllocator, sizeof(*event), VK_OBJECT_TYPE_EVENT);
   if (!event)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   *pEvent = wg_event_to_handle(event);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyEvent(VkDevice _device, VkEvent _event, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_event, event, _event);
   if (event)
      vk_object_free(&dev->vk, pAllocator, event);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_GetEventStatus(VkDevice _device, VkEvent _event)
{
   VK_FROM_HANDLE(wg_event, event, _event);
   return event->set ? VK_EVENT_SET : VK_EVENT_RESET;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_SetEvent(VkDevice _device, VkEvent _event)
{
   VK_FROM_HANDLE(wg_event, event, _event);
   event->set = true;
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_ResetEvent(VkDevice _device, VkEvent _event)
{
   VK_FROM_HANDLE(wg_event, event, _event);
   event->set = false;
   return VK_SUCCESS;
}
