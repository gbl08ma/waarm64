/*
 * The driver's instance, physical device, device, memory and objects (wg_private.h). Written on Mesa's Vulkan runtime
 * the way its drivers are (lavapipe's lvp_device.c for the shape); our own code.
 */
#include <stdlib.h>
#include <string.h>

#include "util/format/u_format.h"
#include "util/u_math.h"
#include "vk_common_entrypoints.h"
#include "vk_cmd_enqueue_entrypoints.h"
#include "vk_format.h"
#include "vk_util.h"

#include "wg_private.h"

/* The device's one heap and its two memory types: device-local, and host-visible coherent (a WebGPU device shares
 * the host's memory only through uploads, so "device-local" too: VK2's shadow buffers). */
#define WG_HEAP_SIZE (2ull << 30)
#define WG_MEMORY_HOST 1

static const struct vk_instance_extension_table wg_instance_extensions = {
   .KHR_device_group_creation = true,
   .KHR_external_fence_capabilities = true,
   .KHR_external_memory_capabilities = true,
   .KHR_external_semaphore_capabilities = true,
   .KHR_get_physical_device_properties2 = true,
   .EXT_debug_report = true,
   .EXT_debug_utils = true,
};

static void
wg_physical_device_destroy(struct vk_physical_device *vk)
{
   struct wg_physical_device *pdev = container_of(vk, struct wg_physical_device, vk);
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

   struct vk_features features = { 0 };
   wg_profile_features(&features);
   struct vk_properties props = {
      .apiVersion = VK_MAKE_API_VERSION(0, 1, 3, 296),
      .driverVersion = 1,
      .driverID = VK_DRIVER_ID_MESA_VENUS,
      .conformanceVersion = { 0, 0, 0, 0 },
      .maxMemoryAllocationSize = 1ull << 30,
      .maxPerSetDescriptors = 1024,
      .maxBufferSize = 1ull << 30,
   };
   wg_profile_properties(&props);
   snprintf(props.deviceName, sizeof(props.deviceName), "webpc null renderer (VK1)");
   snprintf(props.driverName, sizeof(props.driverName), "webpc");
   snprintf(props.driverInfo, sizeof(props.driverInfo), "WebGPU, null renderer (VK1)");
   memcpy(props.pipelineCacheUUID, "webpc-wg-vk1-000", VK_UUID_SIZE);
   memcpy(props.deviceUUID, "webpc-wg-device0", VK_UUID_SIZE);
   memcpy(props.driverUUID, "webpc-wg-driver0", VK_UUID_SIZE);

   /* Past the profile's: what Venus's guest shares through (its WSI wants dma-buf memory with modifiers, foreign queue
    * transfers and sync-file semaphores; the renderer exports blobs its own way, docs/devices.md "Venus"). */
   struct vk_device_extension_table exts = wg_profile_extensions;
   exts.KHR_external_memory_fd = true;
   exts.EXT_external_memory_dma_buf = true;
   exts.EXT_image_drm_format_modifier = true;
   exts.EXT_queue_family_foreign = true;
   exts.KHR_external_semaphore_fd = true;

   VkResult result = vk_physical_device_init(&pdev->vk, &instance->vk, &exts, &features, &props,
                                             &dispatch);
   if (result != VK_SUCCESS) {
      vk_free(&instance->vk.alloc, pdev);
      return result;
   }
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

/* Physical device queries the runtime doesn't answer from the profile. */

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

static const struct wg_format *
wg_format(VkFormat format)
{
   for (uint32_t i = 0; i < wg_profile_format_count; i++)
      if (wg_profile_formats[i].format == format)
         return &wg_profile_formats[i];
   return NULL;
}

VKAPI_ATTR void VKAPI_CALL
wg_GetPhysicalDeviceFormatProperties2(VkPhysicalDevice physicalDevice, VkFormat format,
                                      VkFormatProperties2 *pProps)
{
   const struct wg_format *f = wg_format(format);
   pProps->formatProperties = (VkFormatProperties){
      .linearTilingFeatures = f ? f->linear : 0,
      .optimalTilingFeatures = f ? f->optimal : 0,
      .bufferFeatures = f ? f->buffer : 0,
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
         /* One modifier, LINEAR, with the linear tiling's features. */
         VkDrmFormatModifierPropertiesListEXT *p = (void *)ext;
         VK_OUTARRAY_MAKE_TYPED(VkDrmFormatModifierPropertiesEXT, out, p->pDrmFormatModifierProperties,
                                &p->drmFormatModifierCount);
         if (f && f->linear) {
            vk_outarray_append_typed(VkDrmFormatModifierPropertiesEXT, &out, m) {
               *m = (VkDrmFormatModifierPropertiesEXT){
                  .drmFormatModifier = 0,
                  .drmFormatModifierPlaneCount = 1,
                  .drmFormatModifierTilingFeatures = f->linear,
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

VKAPI_ATTR VkResult VKAPI_CALL
wg_GetPhysicalDeviceImageFormatProperties2(VkPhysicalDevice physicalDevice,
                                           const VkPhysicalDeviceImageFormatInfo2 *info,
                                           VkImageFormatProperties2 *pProps)
{
   VK_FROM_HANDLE(wg_physical_device, pdev, physicalDevice);
   const struct vk_properties *p = &pdev->vk.properties;
   const struct wg_format *f = wg_format(info->format);
   const VkFormatFeatureFlags features =
      !f ? 0 : info->tiling == VK_IMAGE_TILING_OPTIMAL ? f->optimal : f->linear;
   VkFormatFeatureFlags needed = 0;
   if (info->usage & VK_IMAGE_USAGE_SAMPLED_BIT)
      needed |= VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT;
   if (info->usage & VK_IMAGE_USAGE_STORAGE_BIT)
      needed |= VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT;
   if (info->usage & VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT)
      needed |= VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT;
   if (info->usage & VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT)
      needed |= VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT;
   if (!features || (features & needed) != needed || info->type > VK_IMAGE_TYPE_3D) {
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
      .sampleCounts = info->tiling == VK_IMAGE_TILING_OPTIMAL && info->type == VK_IMAGE_TYPE_2D && attachment
                         ? p->framebufferColorSampleCounts
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

   /* Ours first, every command recorded in the runtime's queue, then the runtime's own. */
   struct vk_device_dispatch_table dispatch;
   vk_device_dispatch_table_from_entrypoints(&dispatch, &wg_device_entrypoints, true);
   vk_device_dispatch_table_from_entrypoints(&dispatch, &vk_cmd_enqueue_device_entrypoints, false);
   vk_device_dispatch_table_from_entrypoints(&dispatch, &vk_common_device_entrypoints, false);
   VkResult result = vk_device_init(&dev->vk, &pdev->vk, &dispatch, pCreateInfo, pAllocator);
   if (result != VK_SUCCESS) {
      vk_free(&dev->vk.alloc, dev);
      return result;
   }
   dev->vk.command_buffer_ops = &wg_cmd_buffer_ops;

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
   *pDevice = wg_device_to_handle(dev);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyDevice(VkDevice _device, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   if (!dev)
      return;
   vk_queue_finish(&dev->queue.vk);
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
   if (mem->vk.host_ptr) {
      /* vkr's storage (its patch: host-visible memory is the renderer's, then the window's). */
      mem->data = mem->vk.host_ptr;
   } else if (pAllocateInfo->memoryTypeIndex == WG_MEMORY_HOST) {
      mem->data = aligned_alloc(4096, align64(pAllocateInfo->allocationSize, 4096));
      if (!mem->data) {
         vk_device_memory_destroy(&dev->vk, pAllocator, &mem->vk);
         return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
      }
      memset(mem->data, 0, pAllocateInfo->allocationSize);
   }
   *pMem = wg_device_memory_to_handle(mem);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_FreeMemory(VkDevice _device, VkDeviceMemory _mem, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_device_memory, mem, _mem);
   if (!mem)
      return;
   if (!mem->vk.host_ptr && mem->vk.memory_type_index == WG_MEMORY_HOST)
      free(mem->data);
   vk_device_memory_destroy(&dev->vk, pAllocator, &mem->vk);
}

void
wg_memory_rebind(VkDeviceMemory _mem, void *data)
{
   VK_FROM_HANDLE(wg_device_memory, mem, _mem);
   mem->data = data;
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
   wg_requirements(reqs, MAX2(buffer->vk.size, 1), 256);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceBufferMemoryRequirements(VkDevice _device, const VkDeviceBufferMemoryRequirements *info,
                                     VkMemoryRequirements2 *reqs)
{
   wg_requirements(reqs, MAX2(info->pCreateInfo->size, 1), 256);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_BindBufferMemory2(VkDevice _device, uint32_t count, const VkBindBufferMemoryInfo *infos)
{
   for (uint32_t i = 0; i < count; i++) {
      VK_FROM_HANDLE(wg_buffer, buffer, infos[i].buffer);
      VK_FROM_HANDLE(wg_device_memory, mem, infos[i].memory);
      buffer->mem = mem;
      buffer->offset = infos[i].memoryOffset;
      const VkBindMemoryStatus *status = vk_find_struct_const(infos[i].pNext, BIND_MEMORY_STATUS);
      if (status)
         *status->pResult = VK_SUCCESS;
   }
   return VK_SUCCESS;
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
      const VkDeviceSize row = align64((VkDeviceSize)DIV_ROUND_UP(e.width, bw) * bytes, 256);
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
   *pImage = wg_image_to_handle(image);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyImage(VkDevice _device, VkImage _image, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_image, image, _image);
   if (image)
      vk_image_destroy(&dev->vk, pAllocator, &image->vk);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetImageMemoryRequirements2(VkDevice _device, const VkImageMemoryRequirementsInfo2 *info,
                               VkMemoryRequirements2 *reqs)
{
   VK_FROM_HANDLE(wg_image, image, info->image);
   wg_requirements(reqs, MAX2(image->size, 1), 4096);
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDeviceImageMemoryRequirements(VkDevice _device, const VkDeviceImageMemoryRequirements *info,
                                    VkMemoryRequirements2 *reqs)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct vk_image image;
   vk_image_init(&dev->vk, &image, info->pCreateInfo);
   wg_requirements(reqs, MAX2(wg_image_layout(&image, 0, 0, NULL), 1), 4096);
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
   for (uint32_t i = 0; i < count; i++) {
      VK_FROM_HANDLE(wg_image, image, infos[i].image);
      VK_FROM_HANDLE(wg_device_memory, mem, infos[i].memory);
      image->mem = mem;
      image->offset = infos[i].memoryOffset;
      const VkBindMemoryStatus *status = vk_find_struct_const(infos[i].pNext, BIND_MEMORY_STATUS);
      if (status)
         *status->pResult = VK_SUCCESS;
   }
   return VK_SUCCESS;
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
   *pView = wg_image_view_to_handle(view);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyImageView(VkDevice _device, VkImageView _view, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_image_view, view, _view);
   if (view)
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
   *pView = wg_buffer_view_to_handle(view);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroyBufferView(VkDevice _device, VkBufferView _view, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_buffer_view, view, _view);
   if (view)
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
   *pSampler = wg_sampler_to_handle(sampler);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_DestroySampler(VkDevice _device, VkSampler _sampler, const VkAllocationCallbacks *pAllocator)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   VK_FROM_HANDLE(wg_sampler, sampler, _sampler);
   if (sampler)
      vk_sampler_destroy(&dev->vk, pAllocator, &sampler->vk);
}

/* What VK1 only keeps: shader modules, pipelines and their caches, descriptor pools and sets. */

static VkResult
wg_object_create(struct wg_device *dev, VkObjectType type, const VkAllocationCallbacks *pAllocator, uint64_t *out)
{
   struct wg_object *o = vk_object_zalloc(&dev->vk, pAllocator, sizeof(*o), type);
   if (!o)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   *out = wg_object_to_handle(o);
   return VK_SUCCESS;
}

static void
wg_object_destroy(struct wg_device *dev, uint64_t handle, const VkAllocationCallbacks *pAllocator)
{
   if (handle)
      vk_object_free(&dev->vk, pAllocator, wg_object_from_handle(handle));
}

#define WG_OBJECT(Type, VK_TYPE)                                                                                   \
   VKAPI_ATTR void VKAPI_CALL wg_Destroy##Type(VkDevice _device, Vk##Type handle,                                 \
                                               const VkAllocationCallbacks *pAllocator)                           \
   {                                                                                                               \
      VK_FROM_HANDLE(wg_device, dev, _device);                                                                     \
      wg_object_destroy(dev, (uint64_t)handle, pAllocator);                                                        \
   }

WG_OBJECT(ShaderModule, VK_OBJECT_TYPE_SHADER_MODULE)
WG_OBJECT(Pipeline, VK_OBJECT_TYPE_PIPELINE)
WG_OBJECT(PipelineCache, VK_OBJECT_TYPE_PIPELINE_CACHE)
WG_OBJECT(DescriptorPool, VK_OBJECT_TYPE_DESCRIPTOR_POOL)

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateShaderModule(VkDevice _device, const VkShaderModuleCreateInfo *pCreateInfo,
                      const VkAllocationCallbacks *pAllocator, VkShaderModule *pModule)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   return wg_object_create(dev, VK_OBJECT_TYPE_SHADER_MODULE, pAllocator, (uint64_t *)pModule);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreatePipelineCache(VkDevice _device, const VkPipelineCacheCreateInfo *pCreateInfo,
                       const VkAllocationCallbacks *pAllocator, VkPipelineCache *pCache)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   return wg_object_create(dev, VK_OBJECT_TYPE_PIPELINE_CACHE, pAllocator, (uint64_t *)pCache);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_GetPipelineCacheData(VkDevice _device, VkPipelineCache cache, size_t *pSize, void *pData)
{
   *pSize = 0;
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_MergePipelineCaches(VkDevice _device, VkPipelineCache dst, uint32_t count, const VkPipelineCache *srcs)
{
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateGraphicsPipelines(VkDevice _device, VkPipelineCache cache, uint32_t count,
                           const VkGraphicsPipelineCreateInfo *infos, const VkAllocationCallbacks *pAllocator,
                           VkPipeline *pPipelines)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   for (uint32_t i = 0; i < count; i++) {
      VkResult r = wg_object_create(dev, VK_OBJECT_TYPE_PIPELINE, pAllocator, (uint64_t *)&pPipelines[i]);
      if (r != VK_SUCCESS)
         return r;
   }
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateComputePipelines(VkDevice _device, VkPipelineCache cache, uint32_t count,
                          const VkComputePipelineCreateInfo *infos, const VkAllocationCallbacks *pAllocator,
                          VkPipeline *pPipelines)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   for (uint32_t i = 0; i < count; i++) {
      VkResult r = wg_object_create(dev, VK_OBJECT_TYPE_PIPELINE, pAllocator, (uint64_t *)&pPipelines[i]);
      if (r != VK_SUCCESS)
         return r;
   }
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateDescriptorSetLayout(VkDevice _device, const VkDescriptorSetLayoutCreateInfo *pCreateInfo,
                             const VkAllocationCallbacks *pAllocator, VkDescriptorSetLayout *pLayout)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   struct wg_descriptor_set_layout *layout = vk_descriptor_set_layout_zalloc(&dev->vk, sizeof(*layout), pCreateInfo);
   if (!layout)
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
   *pLayout = wg_descriptor_set_layout_to_handle(layout);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_GetDescriptorSetLayoutSupport(VkDevice _device, const VkDescriptorSetLayoutCreateInfo *pCreateInfo,
                                 VkDescriptorSetLayoutSupport *pSupport)
{
   pSupport->supported = true;
   VkDescriptorSetVariableDescriptorCountLayoutSupport *v =
      vk_find_struct(pSupport->pNext, DESCRIPTOR_SET_VARIABLE_DESCRIPTOR_COUNT_LAYOUT_SUPPORT);
   if (v)
      v->maxVariableDescriptorCount = 1024;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_CreateDescriptorPool(VkDevice _device, const VkDescriptorPoolCreateInfo *pCreateInfo,
                        const VkAllocationCallbacks *pAllocator, VkDescriptorPool *pPool)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   return wg_object_create(dev, VK_OBJECT_TYPE_DESCRIPTOR_POOL, pAllocator, (uint64_t *)pPool);
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_ResetDescriptorPool(VkDevice _device, VkDescriptorPool pool, VkDescriptorPoolResetFlags flags)
{
   return VK_SUCCESS;
}

/* Sets are objects of their own, freed with FreeDescriptorSets; a pool's reset or destruction leaks those still held
 * (bounded by what a guest makes: VK2 tracks them by pool). */
VKAPI_ATTR VkResult VKAPI_CALL
wg_AllocateDescriptorSets(VkDevice _device, const VkDescriptorSetAllocateInfo *info, VkDescriptorSet *pSets)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   for (uint32_t i = 0; i < info->descriptorSetCount; i++) {
      VkResult r = wg_object_create(dev, VK_OBJECT_TYPE_DESCRIPTOR_SET, NULL, (uint64_t *)&pSets[i]);
      if (r != VK_SUCCESS)
         return r;
   }
   return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
wg_FreeDescriptorSets(VkDevice _device, VkDescriptorPool pool, uint32_t count, const VkDescriptorSet *pSets)
{
   VK_FROM_HANDLE(wg_device, dev, _device);
   for (uint32_t i = 0; i < count; i++)
      wg_object_destroy(dev, (uint64_t)pSets[i], NULL);
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_UpdateDescriptorSets(VkDevice _device, uint32_t writeCount, const VkWriteDescriptorSet *writes,
                        uint32_t copyCount, const VkCopyDescriptorSet *copies)
{
}

VKAPI_ATTR void VKAPI_CALL
wg_UpdateDescriptorSetWithTemplate(VkDevice _device, VkDescriptorSet set, VkDescriptorUpdateTemplate tmpl,
                                   const void *pData)
{
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
   pool->values = calloc(pCreateInfo->queryCount, sizeof(uint64_t));
   if (!pool->values) {
      vk_query_pool_destroy(&dev->vk, pAllocator, &pool->vk);
      return vk_error(dev, VK_ERROR_OUT_OF_HOST_MEMORY);
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
   free(pool->values);
   vk_query_pool_destroy(&dev->vk, pAllocator, &pool->vk);
}

/* Every query is available at once (the work is done at its submit), with the value it was given (0, or a timestamp). */
VKAPI_ATTR VkResult VKAPI_CALL
wg_GetQueryPoolResults(VkDevice _device, VkQueryPool _pool, uint32_t first, uint32_t count, size_t dataSize,
                       void *pData, VkDeviceSize stride, VkQueryResultFlags flags)
{
   VK_FROM_HANDLE(wg_query_pool, pool, _pool);
   const bool wide = flags & VK_QUERY_RESULT_64_BIT;
   for (uint32_t i = 0; i < count; i++) {
      uint8_t *out = (uint8_t *)pData + stride * i;
      const uint64_t v = pool->values[first + i];
      if (wide) {
         ((uint64_t *)out)[0] = v;
         if (flags & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT)
            ((uint64_t *)out)[1] = 1;
      } else {
         ((uint32_t *)out)[0] = (uint32_t)v;
         if (flags & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT)
            ((uint32_t *)out)[1] = 1;
      }
   }
   return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
wg_ResetQueryPool(VkDevice _device, VkQueryPool _pool, uint32_t first, uint32_t count)
{
   VK_FROM_HANDLE(wg_query_pool, pool, _pool);
   memset(&pool->values[first], 0, count * sizeof(uint64_t));
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
