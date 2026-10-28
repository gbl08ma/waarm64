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

/* The device's one heap and its two memory types: device-local, and host-visible coherent (a WebGPU device shares
 * the host's memory only through uploads, so "device-local" too: its shadow buffers). */
#define WG_HEAP_SIZE (2ull << 30)
#define WG_MEMORY_HOST 1

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

VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceQueueFamilyProperties2(VkPhysicalDevice physicalDevice, uint32_t *pCount,
                                           VkQueueFamilyProperties2 *pProps)
{
   VK_OUTARRAY_MAKE_TYPED(VkQueueFamilyProperties2, out, pProps, pCount);
   vk_outarray_append_typed(VkQueueFamilyProperties2, &out, p) {
      p->queueFamilyProperties = (VkQueueFamilyProperties){
         .queueFlags = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT | VK_QUEUE_TRANSFER_BIT,
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
           .heapIndex = 0 },
      },
      .memoryHeapCount = 1,
      .memoryHeaps = { { .size = WG_HEAP_SIZE, .flags = VK_MEMORY_HEAP_DEVICE_LOCAL_BIT } },
   };
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
         break;
      }
      case VK_STRUCTURE_TYPE_DRM_FORMAT_MODIFIER_PROPERTIES_LIST_EXT: {
         /* One modifier, LINEAR, with the optimal tiling's features: the renderer owns the image as any other (WebGPU
          * has no tiling to choose), and Venus's WSI renders into images with a modifier. */
         VkDrmFormatModifierPropertiesListEXT *p = (void *)ext;
         VK_OUTARRAY_MAKE_TYPED(VkDrmFormatModifierPropertiesEXT, out, p->pDrmFormatModifierProperties,
                                &p->drmFormatModifierCount);
         if (optimal) {
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
         if (optimal) {
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

VKAPI_ATTR VkResult VKAPI_CALL
wg_GetPhysicalDeviceImageFormatProperties2(VkPhysicalDevice physicalDevice,
                                           const VkPhysicalDeviceImageFormatInfo2 *info,
                                           VkImageFormatProperties2 *pProps)
{
   VK_FROM_HANDLE(wg_physical_device, pdev, physicalDevice);
   const struct vk_properties *p = &pdev->vk.properties;
   VkFormatFeatureFlags linear, optimal, buffer;
   wg_format_features(info->format, &linear, &optimal, &buffer);
   const VkFormatFeatureFlags features =
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
   /* A mutable image's views may differ from its format only in sRGB-ness in WebGPU (viewFormats): a format list
    * naming another format is refused (an image made without one gets views of other formats, which WebGPU refuses:
    * CreateImageView warns). */
   const VkImageFormatListCreateInfo *list = vk_find_struct_const(info->pNext, IMAGE_FORMAT_LIST_CREATE_INFO);
   if ((info->flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) && list) {
      for (uint32_t i = 0; i < list->viewFormatCount; i++)
         if (!view_format_ok(info->format, list->pViewFormats[i])) {
            pProps->imageFormatProperties = (VkImageFormatProperties){ 0 };
            return VK_ERROR_FORMAT_NOT_SUPPORTED;
         }
   }
   /* WebGPU: no 3D depth or compressed 3D textures, no cube arrays of 1D. */
   const bool depth = features & VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT;
   const struct wg_texture_format *tf = wg_texture_format(info->format);
   const bool compressed = tf && (tf->bw > 1 || tf->bh > 1);
   if (!features || (features & needed) != needed || info->type > VK_IMAGE_TYPE_3D ||
       (info->type != VK_IMAGE_TYPE_2D && (depth || compressed))) {
      pProps->imageFormatProperties = (VkImageFormatProperties){ 0 };
      return VK_ERROR_FORMAT_NOT_SUPPORTED;
   }
   const uint32_t dim = info->type == VK_IMAGE_TYPE_1D ? p->maxImageDimension1D
                       : info->type == VK_IMAGE_TYPE_2D ? p->maxImageDimension2D
                                                        : p->maxImageDimension3D;
   const bool attachment = info->usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT |
                                          VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT);
   pProps->imageFormatProperties = (VkImageFormatProperties){
      .maxExtent = { dim, info->type == VK_IMAGE_TYPE_1D ? 1 : dim, info->type == VK_IMAGE_TYPE_3D ? dim : 1 },
      .maxMipLevels = util_logbase2(dim) + 1,
      .maxArrayLayers = info->type == VK_IMAGE_TYPE_3D ? 1 : p->maxImageArrayLayers,
      /* WebGPU's multisampled textures: 4 samples, 2D, one level and layer, never storage, and none of the 32-bit
       * integer formats nor the float ones of two or four channels. */
      .sampleCounts = info->tiling == VK_IMAGE_TILING_OPTIMAL && info->type == VK_IMAGE_TYPE_2D && attachment &&
                            !(info->usage & VK_IMAGE_USAGE_STORAGE_BIT) && tf && strncmp(tf->name, "rg32", 4) &&
                            strncmp(tf->name, "rgba32", 6) && strcmp(tf->name, "r32uint") &&
                            strcmp(tf->name, "r32sint") &&
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
         ((VkSamplerYcbcrConversionImageFormatProperties *)ext)->combinedImageSamplerDescriptorCount = 1;
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
   list_inithead(&dev->linear_images);
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
   result = vk_queue_init(&dev->queue.vk, &dev->vk,
                          pCreateInfo->queueCreateInfoCount ? &pCreateInfo->pQueueCreateInfos[0] : &none, 0);
   if (result != VK_SUCCESS) {
      vk_device_finish(&dev->vk);
      vk_free(&dev->vk.alloc, dev);
      return result;
   }
   dev->queue.vk.driver_submit = wg_queue_submit;
   if (!wg_device_register(dev, true)) {
      vk_queue_finish(&dev->queue.vk);
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
   vk_queue_finish(&dev->queue.vk);
   wg_id_release(dev->push_buffer);
   wg_id_release(dev->fan_indices);
   wg_id_release(dev->query_scratch);
   free(dev->push_data);
   free(dev->pages);
   if (dev->vk.mem_cache)
      vk_pipeline_cache_destroy(dev->vk.mem_cache, NULL);
   vk_device_finish(&dev->vk);
   vk_free(&dev->vk.alloc, dev);
}

/* Memory. */

VKAPI_ATTR VkResult VKAPI_CALL
wg_AllocateMemory(VkDevice _device, const VkMemoryAllocateInfo *pAllocateInfo,
                  const VkAllocationCallbacks *pAllocator, VkDeviceMemory *pMem)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   if (pAllocateInfo->memoryTypeIndex > WG_MEMORY_HOST)
      return vk_error(dev, VK_ERROR_OUT_OF_DEVICE_MEMORY);
   struct wg_device_memory *mem = vk_device_memory_create(&dev->vk, pAllocateInfo, pAllocator, sizeof(*mem));
   if (!mem)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   mem->size = align64(MAX2(pAllocateInfo->allocationSize, 4), 4);
   mem->host = pAllocateInfo->memoryTypeIndex == WG_MEMORY_HOST;
   const VkImportMemoryFdInfoKHR *fd_info = vk_find_struct_const(pAllocateInfo->pNext, IMPORT_MEMORY_FD_INFO_KHR);
   if (fd_info && fd_info->handleType == VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT && fd_info->fd > 0) {
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
      if (!mem->data) {
         vk_device_memory_destroy(&dev->vk, pAllocator, &mem->vk);
         return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
      }
      memset(mem->data, 0, pAllocateInfo->allocationSize);
      mem->owned = true;
   }
   if (mem->host) {
      mem->dirty = true;
      list_addtail(&mem->link, &dev->host_memories);
   }
   *pMem = wg_device_memory_to_handle(mem);
   return VK_SUCCESS;
}

uint32_t
wg_memory_buffer(struct wg_device_memory *mem)
{
   if (!mem->gpu) {
      /* MAP_READ can't go with other usages: readbacks go through staging buffers (gpu_readback). */
      struct wg_json j = { 0 };
      wg_json_printf(&j, "{\"size\":%llu,\"usage\":%u}", (unsigned long long)mem->size,
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
   wg_id_release(mem->gpu);
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
   return buffer->mem && buffer->mem->data ? buffer->mem->data + buffer->offset + offset : NULL;
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

VKAPI_ATTR VkResult VKAPI_CALL
wg_BindBufferMemory2(VkDevice _device, uint32_t count, const VkBindBufferMemoryInfo *infos)
{
   for (uint32_t i = 0; i < count; i++) {
      VK_FROM_HANDLE(wg_buffer, buffer, infos[i].buffer);
      VK_FROM_HANDLE(wg_device_memory, mem, infos[i].memory);
      buffer->mem = mem;
      buffer->offset = infos[i].memoryOffset;
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

static uint32_t
wg_texture_create(struct wg_image *image)
{
   const struct vk_image *vi = &image->vk;
   const uint32_t flags = image->fmt->flags;
   const bool one_d = !strcmp(wg_dimension(vi), "1d");
   uint32_t usage = 0;
   if (vi->usage & VK_IMAGE_USAGE_TRANSFER_SRC_BIT)
      usage |= 1 | ((flags & WG_FMT_SAMPLE) && vi->samples == 1 ? 4 : 0);
   if (vi->usage & VK_IMAGE_USAGE_TRANSFER_DST_BIT)
      usage |= 2 | ((flags & (WG_FMT_RENDER | WG_FMT_DEPTH | WG_FMT_STENCIL)) && !one_d ? 16 : 0);
   if (vi->usage & (VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT))
      usage |= 4;
   if ((vi->usage & VK_IMAGE_USAGE_STORAGE_BIT) && (flags & WG_FMT_STORAGE))
      usage |= 8;
   if (vi->usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT))
      usage |= 16;
   /* A multisampled depth or stencil attachment is read by its resolve's draw (the worker's resolveDepth). */
   if (vi->samples > 1 && (vi->usage & VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT))
      usage |= 4;
   /* A linear image may be bound to host-visible memory: copied to and from it at each submit. */
   if (vi->tiling == VK_IMAGE_TILING_LINEAR)
      usage |= 1 | 2;
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
   const VkExtent3D e = vi->extent;
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"size\":[%u,%u,%u],\"mipLevelCount\":%u,\"sampleCount\":%u,\"dimension\":\"%s\","
                  "\"format\":\"%s\",\"usage\":%u,\"viewFormats\":[",
                  DIV_ROUND_UP(e.width, image->fmt->bw) * image->fmt->bw, DIV_ROUND_UP(e.height, image->fmt->bh) * image->fmt->bh,
                  vi->image_type == VK_IMAGE_TYPE_3D ? e.depth : vi->array_layers, vi->mip_levels,
                  vi->samples, wg_dimension(vi), image->fmt->name, usage);
   if ((vi->create_flags & VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT) || shared) {
      const VkFormat twin = vk_format_is_srgb(vi->format)
                               ? vk_format_srgb_to_linear(vi->format)
                               : vk_format_from_pipe_format(util_format_srgb(vk_format_to_pipe_format(vi->format)));
      const struct wg_texture_format *t = twin != vi->format ? wg_texture_format(twin) : NULL;
      if (t)
         wg_json_printf(&j, "\"%s\"", t->name);
   }
   wg_json_printf(&j, "]}");
   return wg_create_json(WG_KIND_TEXTURE, &j);
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
   if (!image->fmt) {
      vk_image_destroy(&dev->vk, pAllocator, &image->vk);
      return vk_error(dev, VK_ERROR_FORMAT_NOT_SUPPORTED);
   }
   image->shared = image->vk.external_handle_types || image->vk.tiling == VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT;
   image->tex = wg_texture_create(image);
   *pImage = wg_image_to_handle(image);
   return VK_SUCCESS;
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
   if (image->imported)
      gpu_texture_import(image->tex, 0);
   wg_id_release(image->tex);
   vk_image_destroy(&dev->vk, pAllocator, &image->vk);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetImageMemoryRequirements2(VkDevice _device, const VkImageMemoryRequirementsInfo2 *info,
                               VkMemoryRequirements2 *reqs)
{
   VK_FROM_HANDLE(wg_image, image, info->image);
   wg_requirements(reqs, MAX2(image->size, 1), wg_image_dma_buf(&image->vk) ? 1 : 4096);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceImageMemoryRequirements(VkDevice _device, const VkDeviceImageMemoryRequirements *info,
                                    VkMemoryRequirements2 *reqs)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct vk_image image;
   vk_image_init(&dev->vk, &image, info->pCreateInfo);
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

VKAPI_ATTR void VKAPI_CALL
wg_GetImageSubresourceLayout(VkDevice _device, VkImage _image, const VkImageSubresource *sub,
                             VkSubresourceLayout *layout)
{
   VK_FROM_HANDLE(wg_image, image, _image);
   wg_image_layout(&image->vk, sub->mipLevel, sub->arrayLayer, layout);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetImageSubresourceLayout2(VkDevice _device, VkImage _image, const VkImageSubresource2 *sub,
                              VkSubresourceLayout2 *layout)
{
   VK_FROM_HANDLE(wg_image, image, _image);
   wg_image_layout(&image->vk, sub->imageSubresource.mipLevel, sub->imageSubresource.arrayLayer,
                   &layout->subresourceLayout);
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
   if (!view_format_ok(image->vk.format, view->vk.view_format) &&
       !(image->fmt->flags & (WG_FMT_DEPTH | WG_FMT_STENCIL)) && !vk_format_is_compressed(image->vk.format)) {
      static bool warned;
      if (!warned)
         fprintf(stderr, "wg: a view of format %d of an image of format %d: WebGPU's views differ only in sRGB-ness\n",
                 view->vk.view_format, image->vk.format);
      warned = true;
   }
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
   const bool layered = image->vk.image_type != VK_IMAGE_TYPE_3D;
   struct wg_json j = { 0 };
   /* An aspect's view takes the aspect's format: left to WebGPU. */
   wg_json_printf(&j, "{\"texture\":%u,", image->tex);
   if (!strcmp(aspect, "all"))
      wg_json_printf(&j, "\"format\":\"%s\",", view->fmt->name);
   wg_json_printf(&j, "\"dimension\":\"%s\",\"aspect\":\"%s\",\"baseMipLevel\":%u,"
                  "\"mipLevelCount\":%u,\"baseArrayLayer\":%u,\"arrayLayerCount\":%u}",
                  dim, aspect, view->vk.base_mip_level, view->vk.level_count,
                  layered ? view->vk.base_array_layer : 0, layered ? view->vk.layer_count : 1);
   view->view = wg_create_json(WG_KIND_VIEW, &j);
   /* A storage texture's binding has no cube dimension: a cube view's faces as a 2D array (the translator declares
    * cube storage images as 2D arrays). */
   if ((view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE || view->vk.view_type == VK_IMAGE_VIEW_TYPE_CUBE_ARRAY) &&
       (image->vk.usage & VK_IMAGE_USAGE_STORAGE_BIT)) {
      wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"2d-array\",\"baseMipLevel\":%u,"
                     "\"mipLevelCount\":%u,\"baseArrayLayer\":%u,\"arrayLayerCount\":%u}",
                     image->tex, view->fmt->name, view->vk.base_mip_level, view->vk.level_count,
                     view->vk.base_array_layer, view->vk.layer_count);
      view->storage = wg_create_json(WG_KIND_VIEW, &j);
   }
   /* As an attachment: one level and one layer, 2D; a 3D image's level as a 3D view and the slice the view starts at
    * (a 2D view of a 3D image), the render pass's depthSlice. */
   view->slice = -1;
   if (!layered && image->vk.usage & VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT && (image->fmt->flags & WG_FMT_RENDER)) {
      wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"3d\",\"baseMipLevel\":%u,\"mipLevelCount\":1}",
                     image->tex, view->fmt->name, view->vk.base_mip_level);
      view->att = wg_create_json(WG_KIND_VIEW, &j);
      view->slice = view->vk.base_array_layer;
   } else if (image->vk.usage & (VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT |
                          VK_IMAGE_USAGE_TRANSFER_DST_BIT) &&
       layered && strcmp(wg_dimension(&image->vk), "1d") &&
       (image->fmt->flags & (WG_FMT_RENDER | WG_FMT_DEPTH | WG_FMT_STENCIL))) {
      wg_json_printf(&j, "{\"texture\":%u,\"format\":\"%s\",\"dimension\":\"2d\",\"baseMipLevel\":%u,"
                     "\"mipLevelCount\":1,\"baseArrayLayer\":%u,\"arrayLayerCount\":1}",
                     image->tex, view->fmt->name, view->vk.base_mip_level, view->vk.base_array_layer);
      view->att = wg_create_json(WG_KIND_VIEW, &j);
   }
   *pView = wg_image_view_to_handle(view);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyImageView(VkDevice _device, VkImageView _view, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_image_view, view, _view);
   if (!view)
      return;
   wg_id_release(view->view);
   wg_id_release(view->storage);
   wg_id_release(view->att);
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
   if (!wg_texel_buffer_layout(view->vk.format, &x, p1, &storage))
      fprintf(stderr, "wg: a buffer view of format %u, which texel buffers don't offer\n", view->vk.format);
   /* Its words bound from the memory's GPUBuffer at a storage-aligned offset; the parameters say where its first texel
    * is in that binding, and how many texels it has (a texel past them reads 0). */
   view->mem = buffer->mem;
   const uint64_t start = buffer->offset + view->vk.offset, align = MAX2(wg_limits.min_storage_buffer_offset_alignment, 4);
   view->at = start / align * align;
   view->size = align64(start - view->at + view->vk.range, 4);
   if (view->mem && view->at + view->size > view->mem->size)
      view->size = view->mem->size - view->at;
   const uint32_t params[8] = { x, (uint32_t)(start - view->at), view->vk.elements, 0, p1[0], p1[1], p1[2], 0 };
   struct wg_json j = { 0 };
   wg_json_printf(&j, "{\"size\":32,\"usage\":%u}", 0x40 | 0x8); /* UNIFORM | COPY_DST */
   view->params = wg_create_json(WG_KIND_BUFFER, &j);
   gpu_write(view->params, 0, params, sizeof(params));
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
   wg_id_release(view->params);
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
   /* Borders and mirror-once aren't WebGPU's: the nearest of its modes (docs/backlog.md). */
   static const char *const address[] = {
      [VK_SAMPLER_ADDRESS_MODE_REPEAT] = "repeat", [VK_SAMPLER_ADDRESS_MODE_MIRRORED_REPEAT] = "mirror-repeat",
      [VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE] = "clamp-to-edge",
      [VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_BORDER] = "clamp-to-edge",
      [VK_SAMPLER_ADDRESS_MODE_MIRROR_CLAMP_TO_EDGE] = "mirror-repeat",
   };
   static const char *const compare[] = { "never", "less", "equal", "less-equal", "greater", "not-equal",
                                          "greater-equal", "always" };
   const VkSamplerCreateInfo *c = pCreateInfo;
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
   sampler->compare = c->compareEnable;
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
   wg_id_release(sampler->id);
   wg_id_release(sampler->nearest);
   vk_sampler_destroy(&dev->vk, pAllocator, &sampler->vk);
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
