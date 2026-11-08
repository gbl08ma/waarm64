/*
 * The driver's own tests (tests/venus-driver.test.ts): a Vulkan program run on the driver directly, in the renderer
 * module, in a browser with WebGPU. One submit draws a scene through a render pass (a cleared colour and depth
 * attachment; a textured, indexed quad placed by push constants, its texture uploaded from a buffer whose rows aren't
 * 256 bytes apart; a second draw behind it through a dynamic uniform offset), copies the image to host-visible
 * memory, runs a compute shader writing host-visible storage (its buffer in set 4, past WebGPU's 4 bind groups, and its
 * push constants 128 bytes, past WebGPU's immediates), and fills a host-visible buffer; its fence signals once all of
 * that is back in memory 0. Exported from the module (wgt_*); the shaders' SPIR-V comes from the test.
 */
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <vulkan/vulkan_core.h>

#define EXPORT __attribute__((visibility("default")))

PFN_vkVoidFunction VKAPI_CALL vkGetInstanceProcAddr(VkInstance instance, const char *pName);
int wgt_run(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words, const uint32_t *cs,
            uint32_t cs_words);
int wgt_done(void);
const uint8_t *wgt_pixels(void);
const uint8_t *wgt_storage(void);
const uint8_t *wgt_filled(void);
const char *wgt_error(void);
int wgt_import(uint32_t res);
const uint8_t *wgt_imported(void);
const uint32_t *wgt_caps(void);
int wgt_semaphores(void);
const uint32_t *wgt_heaps(void);
const uint32_t *wgt_memory(void);
uint32_t wgt_peers_memory(void);
uint32_t wgt_peers_at(void);
extern bool wg_unwaited_allocations;
const uint32_t *wgt_sync_freed(void);
int wgt_draw(const uint32_t *fs, uint32_t fs_words, uint32_t variant);
int wgt_draw_done(void);
int wgt_two_init(uint8_t *window, uint32_t size);
uint8_t *wgt_two_map(uint32_t d);
uint8_t *wgt_two_read(uint32_t d);
int wgt_two_submit(uint32_t d);
int wgt_two_done(uint32_t d);
int wgt_fl_init(uint8_t *window);
uint8_t *wgt_fl_map(uint32_t which);
int wgt_fl_submit(uint32_t i);
int wgt_fl_done(uint32_t i);
int wgt_link(void);
int wgt_variant(uint32_t scenario);
int wgt_xfb(uint32_t scenario, const uint32_t *vs, uint32_t vs_words);
uint8_t *wgt_xfb_map(void);
int wgt_xfb_done(void);
int wgt_flat(uint32_t scenario, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words);
int wgt_angle_ubo(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words);
int wgt_scope(uint32_t mask, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words,
              const uint32_t *cs, uint32_t cs_words);
uint8_t *wgt_scope_map(uint32_t which);
int wgt_draw_params(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words, uint32_t first_instance);
int wgt_pull(uint32_t scenario, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words,
             const uint32_t *fs2, uint32_t fs2_words);
int wgt_pass(uint32_t scenario);
const uint8_t *wgt_pass_pixels(void);
int wgt_pass_done(void);
const uint64_t *wgt_pass_query(void);
int wgt_misc(uint32_t scenario, const uint32_t *cs, uint32_t cs_words);
uint8_t *wgt_misc_map(void);
void wgt_misc_vs(const uint32_t *vs, uint32_t vs_words);
int wgt_misc_done(void);
int wgt_misc_signal(void);
int wgt_misc_pool_refs(void);
int wgt_fits(uint32_t scenario, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words);
int wgt_samples(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words);
/* wg_cmd.c: the pending submits' references to a query pool (destroyed or not). */
int wg_submits_pool_refs(const void *pool);
bool wg_counts_sane(uint32_t resources, uint32_t pairs, uint32_t int_pairs, uint32_t key_pairs);
int wgt_info_refused(void);
int wgt_merge_refused(void);
/* wg_shader.c: VK4 T37's test of its merge. */
int wg_merge_refuses(void);
/* wg_cmd.c: the syncs held submits signal or wait on. */
int wg_held_syncs(void);

#define FN(name) static PFN_vk##name name
FN(CreateInstance); FN(EnumeratePhysicalDevices); FN(CreateDevice); FN(GetDeviceQueue); FN(GetDeviceProcAddr);
FN(AllocateMemory); FN(MapMemory); FN(CreateBuffer); FN(BindBufferMemory); FN(CreateImage); FN(BindImageMemory);
FN(GetImageMemoryRequirements); FN(GetBufferMemoryRequirements); FN(CreateImageView); FN(CreateSampler);
FN(CreateShaderModule); FN(CreateDescriptorSetLayout); FN(CreatePipelineLayout); FN(CreateDescriptorPool);
FN(AllocateDescriptorSets); FN(UpdateDescriptorSets); FN(CreateRenderPass); FN(CreateFramebuffer);
FN(CreateGraphicsPipelines); FN(CreateComputePipelines); FN(CreateCommandPool); FN(AllocateCommandBuffers);
FN(BeginCommandBuffer); FN(EndCommandBuffer); FN(CmdPipelineBarrier); FN(CmdCopyBufferToImage); FN(CmdBeginRenderPass);
FN(CmdEndRenderPass); FN(CmdBindPipeline); FN(CmdBindDescriptorSets); FN(CmdBindVertexBuffers); FN(CmdBindIndexBuffer);
FN(CmdPushConstants); FN(CmdDrawIndexed); FN(CmdDraw); FN(CmdSetViewport); FN(CmdSetScissor); FN(CmdCopyImageToBuffer);
FN(CmdDispatch); FN(CmdFillBuffer); FN(CreateFence); FN(GetFenceStatus); FN(QueueSubmit); FN(ResetFences);
FN(GetMemoryFdPropertiesKHR); FN(CreatePipelineCache); FN(GetPipelineCacheData);
FN(CreateQueryPool); FN(DestroyQueryPool); FN(CmdResetQueryPool); FN(CmdBeginQuery); FN(CmdEndQuery);
FN(CmdCopyQueryPoolResults); FN(CmdWriteTimestamp);

static VkInstance instance;
static VkDevice dev;
static VkQueue queue;
/* A queue of the compute-only family (VK4 T22), and that family (UINT32_MAX: the device has none). */
static VkQueue queue2;
static uint32_t compute_family = UINT32_MAX;
static VkFence fence;
static uint8_t *pixels, *storage, *filled, *imported;
static char error[256];
/* What wgt_draw reuses of wgt_run's scene. */
static struct {
   VkGraphicsPipelineCreateInfo gpi;
   VkPipelineShaderStageCreateInfo stages[2];
   VkPipeline pipeline;
   VkPipelineLayout layout;
   VkRenderPass rp;
   VkFramebuffer fb;
   VkBuffer vertices, indices;
   const void *vertex_map;
   VkDescriptorSet set;
   VkCommandPool pool;
   VkImage color;
   VkBuffer readback;
   uint32_t w, h;
   VkDescriptorSetLayout set_layout;
   VkSampler sampler;
   VkBuffer uniforms;
} scene;

#define CHECK(x)                                                                                                       \
   do {                                                                                                                \
      VkResult r_ = (x);                                                                                               \
      if (r_ != VK_SUCCESS) {                                                                                          \
         snprintf(error, sizeof(error), "%s: %d (line %d)", #x, r_, __LINE__);                                         \
         return 1;                                                                                                     \
      }                                                                                                                \
   } while (0)

#define CHECK_NULL(x)                                                                                                  \
   do {                                                                                                                \
      VkResult r_ = (x);                                                                                               \
      if (r_ != VK_SUCCESS) {                                                                                          \
         snprintf(error, sizeof(error), "%s: %d (line %d)", #x, r_, __LINE__);                                         \
         return NULL;                                                                                                  \
      }                                                                                                                \
   } while (0)

static const void *memory_next; /* the next allocations' pNext */

static int
memory_for(VkMemoryRequirements req, bool host, VkDeviceMemory *out, void **map)
{
   const VkMemoryAllocateInfo info = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .pNext = memory_next,
                                       .allocationSize = req.size, .memoryTypeIndex = host ? 1 : 0 };
   CHECK(AllocateMemory(dev, &info, NULL, out));
   if (map)
      CHECK(MapMemory(dev, *out, 0, VK_WHOLE_SIZE, 0, map));
   return 0;
}

static int
buffer(VkDeviceSize size, VkBufferUsageFlags usage, bool host, VkBuffer *out, void **map)
{
   const VkBufferCreateInfo info = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size, .usage = usage };
   CHECK(CreateBuffer(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetBufferMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, host, &mem, map))
      return 1;
   CHECK(BindBufferMemory(dev, *out, mem, 0));
   return 0;
}

static int
image(VkFormat format, uint32_t w, uint32_t h, VkImageUsageFlags usage, VkImageAspectFlags aspect, VkImage *out,
      VkImageView *view)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format,
      .extent = { w, h, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = usage,
   };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   const VkImageViewCreateInfo vi = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = *out, .viewType = VK_IMAGE_VIEW_TYPE_2D,
      .format = format, .subresourceRange = { aspect, 0, 1, 0, 1 },
   };
   CHECK(CreateImageView(dev, &vi, NULL, view));
   return 0;
}

static int
shader(const uint32_t *code, uint32_t words, VkShaderModule *out)
{
   const VkShaderModuleCreateInfo info = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                           .codeSize = words * 4, .pCode = code };
   CHECK(CreateShaderModule(dev, &info, NULL, out));
   return 0;
}

static int
init(void)
{
   CreateInstance = (PFN_vkCreateInstance)vkGetInstanceProcAddr(NULL, "vkCreateInstance");
   const VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .apiVersion = VK_API_VERSION_1_3 };
   const VkInstanceCreateInfo ii = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app };
   CHECK(CreateInstance(&ii, NULL, &instance));
#define LOAD(name) name = (PFN_vk##name)vkGetInstanceProcAddr(instance, "vk" #name)
   LOAD(EnumeratePhysicalDevices); LOAD(CreateDevice); LOAD(GetDeviceProcAddr);
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   CHECK(EnumeratePhysicalDevices(instance, &n, &pdev));
   const float priority = 1;
   /* A queue of family 0, and one of a family with compute and without graphics where there is one (VK4 T22). */
   PFN_vkGetPhysicalDeviceQueueFamilyProperties GetFamilies = (PFN_vkGetPhysicalDeviceQueueFamilyProperties)
      vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceQueueFamilyProperties");
   VkQueueFamilyProperties families[8];
   uint32_t family_count = 8;
   GetFamilies(pdev, &family_count, families);
   for (uint32_t f = 0; f < family_count && compute_family == UINT32_MAX; f++)
      if ((families[f].queueFlags & VK_QUEUE_COMPUTE_BIT) && !(families[f].queueFlags & VK_QUEUE_GRAPHICS_BIT))
         compute_family = f;
   const VkDeviceQueueCreateInfo qis[2] = {
      { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1, .pQueuePriorities = &priority },
      { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = compute_family, .queueCount = 1,
        .pQueuePriorities = &priority },
   };
   /* wgt_import's: dma-buf memory and the LINEAR modifier. */
   const char *exts[] = { "VK_KHR_external_memory_fd", "VK_EXT_external_memory_dma_buf",
                          "VK_EXT_image_drm_format_modifier", "VK_EXT_provoking_vertex", "VK_EXT_transform_feedback" };
   const VkDeviceCreateInfo di = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
                                   .queueCreateInfoCount = compute_family == UINT32_MAX ? 1 : 2,
                                   .pQueueCreateInfos = qis, .enabledExtensionCount = 5,
                                   .ppEnabledExtensionNames = exts };
   CHECK(CreateDevice(pdev, &di, NULL, &dev));
#define DLOAD(name) name = (PFN_vk##name)GetDeviceProcAddr(dev, "vk" #name)
   DLOAD(GetDeviceQueue); DLOAD(AllocateMemory); DLOAD(MapMemory); DLOAD(CreateBuffer); DLOAD(BindBufferMemory);
   DLOAD(CreateImage); DLOAD(BindImageMemory); DLOAD(GetImageMemoryRequirements); DLOAD(GetBufferMemoryRequirements);
   DLOAD(CreateImageView); DLOAD(CreateSampler); DLOAD(CreateShaderModule); DLOAD(CreateDescriptorSetLayout);
   DLOAD(CreatePipelineLayout); DLOAD(CreateDescriptorPool); DLOAD(AllocateDescriptorSets); DLOAD(UpdateDescriptorSets);
   DLOAD(CreateRenderPass); DLOAD(CreateFramebuffer); DLOAD(CreateGraphicsPipelines); DLOAD(CreateComputePipelines);
   DLOAD(CreateCommandPool); DLOAD(AllocateCommandBuffers); DLOAD(BeginCommandBuffer); DLOAD(EndCommandBuffer);
   DLOAD(CmdPipelineBarrier); DLOAD(CmdCopyBufferToImage); DLOAD(CmdBeginRenderPass); DLOAD(CmdEndRenderPass);
   DLOAD(CmdBindPipeline); DLOAD(CmdBindDescriptorSets); DLOAD(CmdBindVertexBuffers); DLOAD(CmdBindIndexBuffer);
   DLOAD(CmdPushConstants); DLOAD(CmdDrawIndexed); DLOAD(CmdDraw); DLOAD(CmdSetViewport); DLOAD(CmdSetScissor);
   DLOAD(CmdCopyImageToBuffer); DLOAD(CmdDispatch); DLOAD(CmdFillBuffer); DLOAD(CreateFence); DLOAD(GetFenceStatus);
   DLOAD(QueueSubmit); DLOAD(ResetFences); DLOAD(GetMemoryFdPropertiesKHR); DLOAD(CreatePipelineCache);
   DLOAD(GetPipelineCacheData); DLOAD(CreateQueryPool); DLOAD(DestroyQueryPool); DLOAD(CmdResetQueryPool);
   DLOAD(CmdBeginQuery); DLOAD(CmdEndQuery); DLOAD(CmdCopyQueryPoolResults); DLOAD(CmdWriteTimestamp);
   GetDeviceQueue(dev, 0, 0, &queue);
   if (compute_family != UINT32_MAX)
      GetDeviceQueue(dev, compute_family, 0, &queue2);
   return 0;
}

/* The scene (see the top) and the compute pass; 0, or 1 with wgt_error(). */
EXPORT int
wgt_run(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words, const uint32_t *cs,
        uint32_t cs_words)
{
   if (!dev && init())
      return 1;
   const uint32_t W = 64, H = 64;

   VkImage color, depth, tex;
   VkImageView color_view, depth_view, tex_view;
   if (image(VK_FORMAT_R8G8B8A8_UNORM, W, H, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
             VK_IMAGE_ASPECT_COLOR_BIT, &color, &color_view) ||
       image(VK_FORMAT_D32_SFLOAT, W, H, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT, VK_IMAGE_ASPECT_DEPTH_BIT, &depth,
             &depth_view) ||
       image(VK_FORMAT_R8G8B8A8_UNORM, 4, 4, VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
             VK_IMAGE_ASPECT_COLOR_BIT, &tex, &tex_view))
      return 1;

   /* The texture: its top two rows red, the bottom two green; rows 16 bytes apart. */
   VkBuffer staging, vertices, indices, uniforms, readback, out, fill;
   uint8_t *s, *v, *u;
   uint16_t *ix;
   if (buffer(64, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, true, &staging, (void **)&s) ||
       buffer(10 * 5 * 4, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, true, &vertices, (void **)&v) ||
       buffer(12, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &indices, (void **)&ix) ||
       buffer(512, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &uniforms, (void **)&u) ||
       buffer(W * H * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &readback, (void **)&pixels) ||
       buffer(256 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, true, &out, (void **)&storage) ||
       buffer(64, VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &fill, (void **)&filled))
      return 1;
   for (uint32_t i = 0; i < 16; i++) {
      const uint8_t red[4] = { 255, 0, 0, 255 }, green[4] = { 0, 255, 0, 255 };
      memcpy(s + i * 4, i < 8 ? red : green, 4);
   }
   /* A quad at x -1.5 .. -0.5 (the push constants move it right by 0.5), y -1 .. 1, z 0.5 (position xyz, uv; indexed),
    * then two triangles over x -1 .. 1, y -1 .. 0.5 at z 0.75 (the top three quarters, behind it). Clockwise on the
    * screen, Vulkan's y down. */
   const float quad[10][5] = { { -1.5f, -1, 0.5f, 0, 0 }, { -0.5f, -1, 0.5f, 1, 0 }, { -0.5f, 1, 0.5f, 1, 1 },
                               { -1.5f, 1, 0.5f, 0, 1 },
                               { -1, -1, 0.75f, 0, 0 }, { 1, -1, 0.75f, 0, 0 }, { 1, 0.5f, 0.75f, 0, 0 },
                               { -1, -1, 0.75f, 0, 0 }, { 1, 0.5f, 0.75f, 0, 0 }, { -1, 0.5f, 0.75f, 0, 0 } };
   memcpy(v, quad, sizeof(quad));
   const uint16_t idx[6] = { 0, 1, 2, 0, 2, 3 };
   memcpy(ix, idx, sizeof(idx));
   /* The first draw's colour weight 0 (the texture), the second's 1 (yellow), 256 bytes apart. */
   const float tint0[4] = { 0, 0, 0, 0 }, tint1[4] = { 1, 1, 0, 1 };
   memcpy(u, tint0, 16);
   memcpy(u + 256, tint1, 16);

   VkSampler sampler;
   const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = VK_FILTER_NEAREST,
                                    .minFilter = VK_FILTER_NEAREST, .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                    .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                    .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .maxLod = 1 };
   CHECK(CreateSampler(dev, &si, NULL, &sampler));

   /* Set 0: the dynamic uniform block (binding 0) and the texture (binding 1); set 0 of the compute pipeline: storage. */
   const VkDescriptorSetLayoutBinding bindings[2] = {
      { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL },
   };
   const VkDescriptorSetLayoutBinding cbinding = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT,
                                                   NULL };
   VkDescriptorSetLayout set_layout, cset_layout;
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 2, .pBindings = bindings };
   const VkDescriptorSetLayoutCreateInfo cli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 1, .pBindings = &cbinding };
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &set_layout));
   CHECK(CreateDescriptorSetLayout(dev, &cli, NULL, &cset_layout));
   /* The compute pipeline's sets 0 to 3 are empty: its storage is set 4's. */
   VkDescriptorSetLayout empty;
   const VkDescriptorSetLayoutCreateInfo eli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO };
   CHECK(CreateDescriptorSetLayout(dev, &eli, NULL, &empty));
   const VkDescriptorSetLayout clayouts[5] = { empty, empty, empty, empty, cset_layout };
   const VkPushConstantRange push = { VK_SHADER_STAGE_VERTEX_BIT, 0, 16 };
   const VkPushConstantRange cpush = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 128 };
   VkPipelineLayout layout, clayout;
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &set_layout, .pushConstantRangeCount = 1,
                                            .pPushConstantRanges = &push };
   const VkPipelineLayoutCreateInfo cpli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                             .setLayoutCount = 5, .pSetLayouts = clayouts,
                                             .pushConstantRangeCount = 1, .pPushConstantRanges = &cpush };
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   CHECK(CreatePipelineLayout(dev, &cpli, NULL, &clayout));
   const VkDescriptorPoolSize sizes[3] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1 },
                                           { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 },
                                           { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   VkDescriptorPool pool;
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 2,
                                            .poolSizeCount = 3, .pPoolSizes = sizes };
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &pool));
   VkDescriptorSet sets[2];
   const VkDescriptorSetLayout both[2] = { set_layout, cset_layout };
   const VkDescriptorSetAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                            .descriptorPool = pool, .descriptorSetCount = 2, .pSetLayouts = both };
   CHECK(AllocateDescriptorSets(dev, &ai, sets));
   const VkDescriptorBufferInfo ubo = { uniforms, 0, 16 }, ssbo = { out, 0, VK_WHOLE_SIZE };
   const VkDescriptorImageInfo img = { sampler, tex_view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
   const VkWriteDescriptorSet writes[3] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, .pBufferInfo = &ubo },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &img },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[1], .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &ssbo },
   };
   UpdateDescriptorSets(dev, 3, writes, 0, NULL);

   /* A render pass of the old kind (the runtime's emulation over dynamic rendering): colour and depth cleared. */
   const VkAttachmentDescription atts[2] = {
      { 0, VK_FORMAT_R8G8B8A8_UNORM, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED,
        VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL },
      { 0, VK_FORMAT_D32_SFLOAT, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_DONT_CARE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED,
        VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL },
   };
   const VkAttachmentReference cref = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL },
                               dref = { 1, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
                                      .pColorAttachments = &cref, .pDepthStencilAttachment = &dref };
   VkRenderPass rp;
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 2,
                                        .pAttachments = atts, .subpassCount = 1, .pSubpasses = &sub };
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   VkFramebuffer fb;
   const VkImageView views[2] = { color_view, depth_view };
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 2, .pAttachments = views, .width = W, .height = H,
                                         .layers = 1 };
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));

   VkShaderModule vsm, fsm, csm;
   if (shader(vs, vs_words, &vsm) || shader(fs, fs_words, &fsm) || shader(cs, cs_words, &csm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT,
        .module = vsm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
        .module = fsm, .pName = "main" },
   };
   static const VkVertexInputBindingDescription vb = { 0, 20, VK_VERTEX_INPUT_RATE_VERTEX };
   static const VkVertexInputAttributeDescription va[2] = { { 0, 0, VK_FORMAT_R32G32B32_SFLOAT, 0 },
                                                     { 1, 0, VK_FORMAT_R32G32_SFLOAT, 12 } };
   static const VkPipelineVertexInputStateCreateInfo vis = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, .vertexBindingDescriptionCount = 1,
      .pVertexBindingDescriptions = &vb, .vertexAttributeDescriptionCount = 2, .pVertexAttributeDescriptions = va };
   static const VkPipelineInputAssemblyStateCreateInfo ias = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
      .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   static const VkPipelineViewportStateCreateInfo vps = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
                                                   .viewportCount = 1, .scissorCount = 1 };
   /* Culling back faces, the front clockwise: what the scene draws is clockwise on the screen. */
   static const VkPipelineRasterizationStateCreateInfo rs = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, .polygonMode = VK_POLYGON_MODE_FILL,
      .cullMode = VK_CULL_MODE_BACK_BIT, .frontFace = VK_FRONT_FACE_CLOCKWISE, .lineWidth = 1 };
   static const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   static const VkPipelineDepthStencilStateCreateInfo ds = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO, .depthTestEnable = VK_TRUE,
      .depthWriteEnable = VK_TRUE, .depthCompareOp = VK_COMPARE_OP_LESS };
   static const VkPipelineColorBlendAttachmentState cba = { .colorWriteMask = 0xf };
   static const VkPipelineColorBlendStateCreateInfo cbs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                     .attachmentCount = 1, .pAttachments = &cba };
   static const VkDynamicState dyn[2] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
   static const VkPipelineDynamicStateCreateInfo dys = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                                                  .dynamicStateCount = 2, .pDynamicStates = dyn };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
      .pVertexInputState = &vis, .pInputAssemblyState = &ias, .pViewportState = &vps, .pRasterizationState = &rs,
      .pMultisampleState = &ms, .pDepthStencilState = &ds, .pColorBlendState = &cbs, .pDynamicState = &dys,
      .layout = layout, .renderPass = rp,
   };
   VkPipeline pipeline, cpipeline;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &pipeline));
   const VkComputePipelineCreateInfo cpi = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = csm, .pName = "main" },
      .layout = clayout,
   };
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &cpi, NULL, &cpipeline));
   /* A pipeline cache holding a pipeline gives its data in a buffer of the size it says (libplacebo's passes), and a
    * cache made from that data makes the pipeline again from its shaders (wg_serialize, wg_deserialize). */
   VkPipelineCache pcache, pcache2;
   VkPipeline cached, cached2;
   const VkPipelineCacheCreateInfo pci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO };
   CHECK(CreatePipelineCache(dev, &pci, NULL, &pcache));
   CHECK(CreateComputePipelines(dev, pcache, 1, &cpi, NULL, &cached));
   size_t cache_size = 0;
   CHECK(GetPipelineCacheData(dev, pcache, &cache_size, NULL));
   uint8_t *cache_data = malloc(cache_size);
   if (!cache_data || cache_size < 32 || GetPipelineCacheData(dev, pcache, &cache_size, cache_data) != VK_SUCCESS) {
      snprintf(error, sizeof(error), "a pipeline cache of %zu bytes didn't give its data", cache_size);
      return 1;
   }
   const VkPipelineCacheCreateInfo pci2 = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO,
                                            .initialDataSize = cache_size, .pInitialData = cache_data };
   CHECK(CreatePipelineCache(dev, &pci2, NULL, &pcache2));
   free(cache_data);
   CHECK(CreateComputePipelines(dev, pcache2, 1, &cpi, NULL, &cached2));

   VkCommandPool cpool;
   const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
   CHECK(CreateCommandPool(dev, &cpo, NULL, &cpool));
   VkCommandBuffer cmd;
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = cpool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &cmd));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(cmd, &begin));
   const VkBufferImageCopy up = { .bufferRowLength = 4, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                  .imageExtent = { 4, 4, 1 } };
   CmdCopyBufferToImage(cmd, staging, tex, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &up);

   const VkClearValue clears[2] = { { .color = { .float32 = { 0, 0, 1, 1 } } }, { .depthStencil = { 1, 0 } } };
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp,
                                       .framebuffer = fb, .renderArea = { { 0, 0 }, { W, H } }, .clearValueCount = 2,
                                       .pClearValues = clears };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
   const VkViewport viewport = { 0, 0, W, H, 0, 1 };
   const VkRect2D scissor = { { 0, 0 }, { W, H } };
   CmdSetViewport(cmd, 0, 1, &viewport);
   CmdSetScissor(cmd, 0, 1, &scissor);
   const VkDeviceSize zero = 0;
   CmdBindVertexBuffers(cmd, 0, 1, &vertices, &zero);
   CmdBindIndexBuffer(cmd, indices, 0, VK_INDEX_TYPE_UINT16);
   uint32_t offset = 0;
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[0], 1, &offset);
   const float right[4] = { 0.5f, 0, 0, 0 };
   CmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, right);
   CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
   /* Behind it (z 0.75): the top three quarters in yellow. */
   const float wide[4] = { 0, 0, 0, 0 };
   offset = 256;
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[0], 1, &offset);
   CmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, wide);
   CmdDraw(cmd, 6, 1, 4, 0);
   CmdEndRenderPass(cmd);
   const VkBufferImageCopy down = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                    .imageExtent = { W, H, 1 } };
   CmdCopyImageToBuffer(cmd, color, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, readback, 1, &down);

   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, cpipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, clayout, 4, 1, &sets[1], 0, NULL);
   uint32_t k[32] = { 0 };
   k[28] = 7;
   CmdPushConstants(cmd, clayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(k), k);
   CmdDispatch(cmd, 4, 1, 1);
   CmdFillBuffer(cmd, fill, 16, 32, 0xdeadbeef);
   CHECK(EndCommandBuffer(cmd));

   const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
   CHECK(CreateFence(dev, &fi, NULL, &fence));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, fence));
   scene.gpi = gpi;
   memcpy(scene.stages, stages, sizeof(stages));
   scene.pipeline = pipeline;
   scene.layout = layout;
   scene.rp = rp;
   scene.fb = fb;
   scene.vertices = vertices;
   scene.vertex_map = v;
   scene.indices = indices;
   scene.set = sets[0];
   scene.set_layout = set_layout;
   scene.sampler = sampler;
   scene.uniforms = uniforms;
   scene.color = color;
   scene.readback = readback;
   scene.w = W;
   scene.h = H;
   return 0;
}

/* 1 once the submit's fence has signalled, 0 before. */
EXPORT int
wgt_done(void)
{
   return fence && GetFenceStatus(dev, fence) == VK_SUCCESS;
}

EXPORT const uint8_t *
wgt_pixels(void)
{
   return pixels;
}

EXPORT const uint8_t *
wgt_storage(void)
{
   return storage;
}

EXPORT const uint8_t *
wgt_filled(void)
{
   return filled;
}

EXPORT const char *
wgt_error(void)
{
   return error;
}

/* A dma-buf import (vk/README.md "Imports"): an R8G8 image of 4×2 texels with the LINEAR modifier, bound to memory
 * imported from "dma-buf" `res` (another renderer's resource: the GPU worker writes its bytes into the image's texture,
 * web/venus-import.ts), copied into a host-visible buffer (wgt_imported, 16 bytes) by a submit; wgt_done then says
 * when. Called again, the same image is copied again (the resource's bytes may have changed since). */
EXPORT int
wgt_import(uint32_t res)
{
   static VkImage img;
   static VkBuffer buf;
   static VkCommandBuffer cmd;
   if (!dev && init())
      return 1;
   if (!img) {
      VkMemoryFdPropertiesKHR props = { .sType = VK_STRUCTURE_TYPE_MEMORY_FD_PROPERTIES_KHR };
      CHECK(GetMemoryFdPropertiesKHR(dev, VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT, (int)res, &props));
      if (props.memoryTypeBits != 1) {
         snprintf(error, sizeof(error), "a dma-buf's memory types: %#x", props.memoryTypeBits);
         return 1;
      }
      const uint64_t linear = 0;
      const VkImageDrmFormatModifierListCreateInfoEXT mods = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_DRM_FORMAT_MODIFIER_LIST_CREATE_INFO_EXT, .drmFormatModifierCount = 1,
         .pDrmFormatModifiers = &linear,
      };
      const VkExternalMemoryImageCreateInfo ext = { .sType = VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO,
                                                     .pNext = &mods,
                                                     .handleTypes = VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT };
      const VkImageCreateInfo info = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .pNext = &ext, .imageType = VK_IMAGE_TYPE_2D,
         .format = VK_FORMAT_R8G8_UNORM, .extent = { 4, 2, 1 }, .mipLevels = 1, .arrayLayers = 1,
         .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT,
         .usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
      };
      CHECK(CreateImage(dev, &info, NULL, &img));
      VkMemoryRequirements req;
      GetImageMemoryRequirements(dev, img, &req);
      /* A dma-buf's rows are tight (4 texels of 2 bytes): the image fits a dma-buf of its texels alone. */
      if (req.size > 16) {
         snprintf(error, sizeof(error), "an imported image needs %llu bytes", (unsigned long long)req.size);
         return 1;
      }
      const VkImportMemoryFdInfoKHR fd = { .sType = VK_STRUCTURE_TYPE_IMPORT_MEMORY_FD_INFO_KHR,
                                           .handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT,
                                           .fd = (int)res };
      const VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .pNext = &fd,
                                        .allocationSize = 4096, .memoryTypeIndex = 0 };
      VkDeviceMemory mem;
      CHECK(AllocateMemory(dev, &ai, NULL, &mem));
      CHECK(BindImageMemory(dev, img, mem, 0));
      if (buffer(16, VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &buf, (void **)&imported))
         return 1;
      VkCommandPool pool;
      const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
      CHECK(CreateCommandPool(dev, &cpo, NULL, &pool));
      const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                                .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                                .commandBufferCount = 1 };
      CHECK(AllocateCommandBuffers(dev, &cbi, &cmd));
      const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
      CHECK(BeginCommandBuffer(cmd, &begin));
      const VkBufferImageCopy down = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                       .imageExtent = { 4, 2, 1 } };
      CmdCopyImageToBuffer(cmd, img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buf, 1, &down);
      CHECK(EndCommandBuffer(cmd));
   }
   if (fence) {
      CHECK(ResetFences(dev, 1, &fence));
   } else {
      const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
      CHECK(CreateFence(dev, &fi, NULL, &fence));
   }
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, fence));
   return 0;
}

EXPORT const uint8_t *
wgt_imported(void)
{
   return imported;
}

/* What the device advertises (tests/venus-renderer.test.ts: it follows the WebGPU device's features and limits), as
 * words: maxImageDimension2D, maxComputeWorkGroupInvocations, maxComputeWorkGroupSize[0],
 * maxPerStageDescriptorStorageImages, maxPerStageDescriptorSampledImages, maxStorageBufferRange, subgroupSize,
 * subgroupSupportedOperations, textureCompressionBC, shaderStorageImageExtendedFormats, depthClamp, then the optimal
 * tiling features of R16_SFLOAT, R16_UNORM, B10G11R11_UFLOAT_PACK32, R32_SFLOAT, vendorID and pipelineCacheUUID's first
 * word, the sample counts and features below, NV12's queries, maxPushDescriptors, then what's below it (36 words); NULL with wgt_error(). Its own instance: the
 * device's caps are read when the instance enumerates it. */
EXPORT const uint32_t *
wgt_caps(void)
{
   static uint32_t out[40];
   PFN_vkCreateInstance create = (PFN_vkCreateInstance)vkGetInstanceProcAddr(NULL, "vkCreateInstance");
   const VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .apiVersion = VK_API_VERSION_1_3 };
   const VkInstanceCreateInfo ii = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app };
   VkInstance inst;
   if (create(&ii, NULL, &inst) != VK_SUCCESS) {
      snprintf(error, sizeof(error), "vkCreateInstance failed");
      return NULL;
   }
   PFN_vkEnumeratePhysicalDevices enumerate = (PFN_vkEnumeratePhysicalDevices)vkGetInstanceProcAddr(inst, "vkEnumeratePhysicalDevices");
   PFN_vkGetPhysicalDeviceProperties2 props2 = (PFN_vkGetPhysicalDeviceProperties2)vkGetInstanceProcAddr(inst, "vkGetPhysicalDeviceProperties2");
   PFN_vkGetPhysicalDeviceFeatures2 features2 = (PFN_vkGetPhysicalDeviceFeatures2)vkGetInstanceProcAddr(inst, "vkGetPhysicalDeviceFeatures2");
   PFN_vkGetPhysicalDeviceFormatProperties formats = (PFN_vkGetPhysicalDeviceFormatProperties)vkGetInstanceProcAddr(inst, "vkGetPhysicalDeviceFormatProperties");
   PFN_vkDestroyInstance destroy = (PFN_vkDestroyInstance)vkGetInstanceProcAddr(inst, "vkDestroyInstance");
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   if (enumerate(inst, &n, &pdev) < 0 || n != 1) {
      snprintf(error, sizeof(error), "no physical device");
      return NULL;
   }
   VkPhysicalDeviceVulkan11Properties p11 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES };
   VkPhysicalDeviceProperties2 p = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &p11 };
   props2(pdev, &p);
   VkPhysicalDeviceFeatures2 f = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
   features2(pdev, &f);
   const VkPhysicalDeviceLimits *l = &p.properties.limits;
   uint32_t i = 0;
   out[i++] = l->maxImageDimension2D;
   out[i++] = l->maxComputeWorkGroupInvocations;
   out[i++] = l->maxComputeWorkGroupSize[0];
   out[i++] = l->maxPerStageDescriptorStorageImages;
   out[i++] = l->maxPerStageDescriptorSampledImages;
   out[i++] = l->maxStorageBufferRange;
   out[i++] = p11.subgroupSize;
   out[i++] = p11.subgroupSupportedOperations;
   out[i++] = f.features.textureCompressionBC;
   out[i++] = f.features.shaderStorageImageExtendedFormats;
   out[i++] = f.features.depthClamp;
   const VkFormat fmts[] = { VK_FORMAT_R16_SFLOAT, VK_FORMAT_R16_UNORM, VK_FORMAT_B10G11R11_UFLOAT_PACK32, VK_FORMAT_R32_SFLOAT };
   for (uint32_t k = 0; k < 4; k++) {
      VkFormatProperties fp;
      formats(pdev, fmts[k], &fp);
      out[i++] = fp.optimalTilingFeatures;
   }
   out[i++] = p.properties.vendorID;
   memcpy(&out[i++], p.properties.pipelineCacheUUID, 4);
   /* The out-of-context review of the translator, findings 3, 12 and 13. */
   PFN_vkGetPhysicalDeviceImageFormatProperties image_formats =
      (PFN_vkGetPhysicalDeviceImageFormatProperties)vkGetInstanceProcAddr(inst, "vkGetPhysicalDeviceImageFormatProperties");
   const VkFormat ms[] = { VK_FORMAT_R32G32B32A32_SFLOAT, VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R32_UINT };
   for (uint32_t k = 0; k < 3; k++) {
      VkImageFormatProperties ip = { 0 };
      image_formats(pdev, ms[k], VK_IMAGE_TYPE_2D, VK_IMAGE_TILING_OPTIMAL, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, 0, &ip);
      out[i++] = ip.sampleCounts;
   }
   VkPhysicalDeviceVulkan12Properties p12 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_PROPERTIES };
   VkPhysicalDeviceProperties2 q = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &p12 };
   props2(pdev, &q);
   out[i++] = p12.framebufferIntegerColorSampleCounts;
   out[i++] = l->maxComputeSharedMemorySize;
   out[i++] = f.features.dualSrcBlend;
   /* The integer colour-attachment formats whose sample counts miss framebufferIntegerColorSampleCounts, as bits of
    * `ints`' order (Vulkan wants a superset: the out-of-context review of L4f, finding 3). */
   const VkFormat ints[] = { VK_FORMAT_R8_UINT, VK_FORMAT_R8_SINT, VK_FORMAT_R16_UINT, VK_FORMAT_R16_SINT,
                             VK_FORMAT_R32_UINT, VK_FORMAT_R32_SINT, VK_FORMAT_R8G8B8A8_UINT,
                             VK_FORMAT_R16G16B16A16_SINT, VK_FORMAT_R32G32_UINT, VK_FORMAT_R32G32B32A32_SINT };
   uint32_t missing = 0;
   for (uint32_t k = 0; k < sizeof(ints) / sizeof(ints[0]); k++) {
      VkImageFormatProperties ip = { 0 };
      if (image_formats(pdev, ints[k], VK_IMAGE_TYPE_2D, VK_IMAGE_TILING_OPTIMAL, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, 0,
                        &ip) == VK_SUCCESS &&
          (ip.sampleCounts & p12.framebufferIntegerColorSampleCounts) != p12.framebufferIntegerColorSampleCounts)
         missing |= 1u << k;
   }
   out[i++] = missing;
   VkPhysicalDeviceVulkan11Features f11 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES };
   VkPhysicalDeviceFeatures2 g = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &f11 };
   features2(pdev, &g);
   out[i++] = f11.samplerYcbcrConversion;
   /* NV12's optimal features (VK3 L7.2: the multi-planar formats with the conversions only). */
   VkFormatProperties nv12;
   formats(pdev, VK_FORMAT_G8_B8R8_2PLANE_420_UNORM, &nv12);
   out[i++] = nv12.optimalTilingFeatures;
   /* The out-of-context review of L6b-L7.3, findings 3 and 4: a mutable NV12 image whose format list names its
    * planes' formats (supported), one naming a format no plane has (refused), and NV12 on external memory (refused:
    * planes aren't imported nor exported); each the query's VkResult. */
   PFN_vkGetPhysicalDeviceImageFormatProperties2 image_formats2 =
      (PFN_vkGetPhysicalDeviceImageFormatProperties2)vkGetInstanceProcAddr(inst, "vkGetPhysicalDeviceImageFormatProperties2");
   const VkFormat planes[2] = { VK_FORMAT_R8_UNORM, VK_FORMAT_R8G8_UNORM }, other[2] = { VK_FORMAT_R8_UNORM, VK_FORMAT_R8G8B8A8_UNORM };
   for (uint32_t k = 0; k < 3; k++) {
      const VkImageFormatListCreateInfo list = { .sType = VK_STRUCTURE_TYPE_IMAGE_FORMAT_LIST_CREATE_INFO,
                                                 .viewFormatCount = 2, .pViewFormats = k ? other : planes };
      const VkPhysicalDeviceExternalImageFormatInfo ext = {
         .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO,
         .handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT };
      const VkPhysicalDeviceImageFormatInfo2 fi = {
         .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_FORMAT_INFO_2, .pNext = k == 2 ? (const void *)&ext : &list,
         .format = VK_FORMAT_G8_B8R8_2PLANE_420_UNORM, .type = VK_IMAGE_TYPE_2D, .tiling = VK_IMAGE_TILING_OPTIMAL,
         .usage = VK_IMAGE_USAGE_SAMPLED_BIT, .flags = k == 2 ? 0 : VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT };
      VkExternalImageFormatProperties ep = { .sType = VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES };
      VkImageFormatProperties2 ip = { .sType = VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2, .pNext = k == 2 ? &ep : NULL };
      out[i++] = (uint32_t)image_formats2(pdev, &fi, &ip);
   }
   /* The out-of-context review of VK4: VK_KHR_push_descriptor's maxPushDescriptors (Vulkan: at least 32). */
   VkPhysicalDevicePushDescriptorPropertiesKHR push = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PUSH_DESCRIPTOR_PROPERTIES_KHR };
   VkPhysicalDeviceProperties2 r = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &push };
   props2(pdev, &r);
   out[i++] = push.maxPushDescriptors;
   /* VK4 R7: maxMemoryAllocationSize's low and high words; BC1_RGB's features; maxVertexInputBindings. */
   VkPhysicalDeviceMaintenance3Properties m3 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_3_PROPERTIES };
   VkPhysicalDeviceProperties2 s = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &m3 };
   props2(pdev, &s);
   out[i++] = (uint32_t)m3.maxMemoryAllocationSize;
   out[i++] = (uint32_t)(m3.maxMemoryAllocationSize >> 32);
   VkFormatProperties bc1;
   formats(pdev, VK_FORMAT_BC1_RGB_UNORM_BLOCK, &bc1);
   out[i++] = bc1.optimalTilingFeatures;
   out[i++] = s.properties.limits.maxVertexInputBindings;
   /* R32G32B32_SFLOAT's optimal features (an rgba32float texture, which WebGPU doesn't multisample: no colour
    * attachment, as Vulkan wants one at framebufferColorSampleCounts), and an input attachment of it (refused). */
   VkFormatProperties rgb32;
   formats(pdev, VK_FORMAT_R32G32B32_SFLOAT, &rgb32);
   out[i++] = rgb32.optimalTilingFeatures;
   VkImageFormatProperties rgb32_input;
   out[i++] = (uint32_t)image_formats(pdev, VK_FORMAT_R32G32B32_SFLOAT, VK_IMAGE_TYPE_2D, VK_IMAGE_TILING_OPTIMAL,
                                      VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT, 0, &rgb32_input);
   destroy(inst, NULL);
   return out;
}

/* The heaps (VK4 T2): [0] their count, [1] the host-visible type's heap, [2] its size and [3] its budget (MiB), then its
 * usage (KiB) [4] before, [5] with 1 MiB of host-visible memory and an import of it (the guest's export imported again:
 * an opaque fd naming the memory, wg_AllocateMemory), [6] with the memory freed and its import left, [7] with both
 * freed; [8] 1 if the import's map reads what the memory's wrote, [9] if it still does once the memory is freed. NULL
 * with wgt_error(). */
EXPORT const uint32_t *
wgt_heaps(void)
{
   static uint32_t out[10];
   if (!dev && init())
      return NULL;
   PFN_vkGetPhysicalDeviceMemoryProperties2 props =
      (PFN_vkGetPhysicalDeviceMemoryProperties2)vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceMemoryProperties2");
   PFN_vkFreeMemory FreeMemory = (PFN_vkFreeMemory)GetDeviceProcAddr(dev, "vkFreeMemory");
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   if (EnumeratePhysicalDevices(instance, &n, &pdev) < 0) {
      snprintf(error, sizeof(error), "no physical device");
      return NULL;
   }
   VkPhysicalDeviceMemoryBudgetPropertiesEXT budget = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_BUDGET_PROPERTIES_EXT };
   VkPhysicalDeviceMemoryProperties2 mp = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_PROPERTIES_2, .pNext = &budget };
   props(pdev, &mp);
   const uint32_t heap = mp.memoryProperties.memoryTypes[1].heapIndex;
   out[0] = mp.memoryProperties.memoryHeapCount;
   out[1] = heap;
   out[2] = (uint32_t)(mp.memoryProperties.memoryHeaps[heap].size >> 20);
   out[3] = (uint32_t)(budget.heapBudget[heap] >> 20);
   out[4] = (uint32_t)(budget.heapUsage[heap] >> 10);
   const VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = 1 << 20,
                                     .memoryTypeIndex = 1 };
   VkDeviceMemory mem, alias;
   uint8_t *a, *b;
   if (AllocateMemory(dev, &ai, NULL, &mem) != VK_SUCCESS || MapMemory(dev, mem, 0, VK_WHOLE_SIZE, 0, (void **)&a)) {
      snprintf(error, sizeof(error), "host-visible memory not made");
      return NULL;
   }
   a[100] = 0x5a;
   const VkImportMemoryFdInfoKHR fd = { .sType = VK_STRUCTURE_TYPE_IMPORT_MEMORY_FD_INFO_KHR,
                                        .handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT,
                                        .fd = (int)(uintptr_t)mem };
   const VkMemoryAllocateInfo ii = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .pNext = &fd,
                                     .allocationSize = 1 << 20, .memoryTypeIndex = 1 };
   if (AllocateMemory(dev, &ii, NULL, &alias) != VK_SUCCESS || MapMemory(dev, alias, 0, VK_WHOLE_SIZE, 0, (void **)&b)) {
      snprintf(error, sizeof(error), "the import not made");
      return NULL;
   }
   props(pdev, &mp);
   out[5] = (uint32_t)(budget.heapUsage[heap] >> 10);
   out[8] = b[100] == 0x5a;
   FreeMemory(dev, mem, NULL);
   props(pdev, &mp);
   out[6] = (uint32_t)(budget.heapUsage[heap] >> 10);
   out[9] = b[100] == 0x5a;
   FreeMemory(dev, alias, NULL);
   props(pdev, &mp);
   out[7] = (uint32_t)(budget.heapUsage[heap] >> 10);
   return out;
}

/* VK4 R6: memory (the review's O1, O3, O11) on a device of its own. [0] the low word of a buffer's device address, on an
 * import that wants addresses of a memory made without, [1] the result of such an import of a memory with a buffer bound,
 * [2], [3] of set layouts with bindings 0x40000001 and 0xffffffff, [4] the device-local MiB allocated before a refusal
 * ([5] its result), and for a guest that doesn't wait: [6] the result past the heap, [7] of a map of that memory (none
 * host-visible: of one of the other heap's), [8] the import of [1] for such a guest, [9] that memory's buffer's address.
 * NULL with wgt_error(). */
EXPORT const uint32_t *
wgt_memory(void)
{
   static uint32_t out[10];
   if (!dev && init())
      return NULL;
   PFN_vkFreeMemory FreeMemory = (PFN_vkFreeMemory)GetDeviceProcAddr(dev, "vkFreeMemory");
   PFN_vkGetBufferDeviceAddress Address = (PFN_vkGetBufferDeviceAddress)GetDeviceProcAddr(dev, "vkGetBufferDeviceAddress");
   const VkMemoryAllocateInfo plain = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = 65536 };
   const VkMemoryAllocateFlagsInfo flags = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO, .flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT };
   const VkBufferCreateInfo bi = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = 4096,
                                   .usage = VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT };
   VkDeviceMemory a, b, c, e;
   VkBuffer buf;
   if (AllocateMemory(dev, &plain, NULL, &a) != VK_SUCCESS || AllocateMemory(dev, &plain, NULL, &c) != VK_SUCCESS ||
       CreateBuffer(dev, &bi, NULL, &buf) != VK_SUCCESS) {
      snprintf(error, sizeof(error), "memory not made");
      return NULL;
   }
   VkImportMemoryFdInfoKHR fd = { .sType = VK_STRUCTURE_TYPE_IMPORT_MEMORY_FD_INFO_KHR, .pNext = &flags,
                                  .handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT, .fd = (int)(uintptr_t)a };
   const VkMemoryAllocateInfo imp = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .pNext = &fd, .allocationSize = 65536 };
   if (AllocateMemory(dev, &imp, NULL, &b) != VK_SUCCESS || BindBufferMemory(dev, buf, b, 0) != VK_SUCCESS) {
      snprintf(error, sizeof(error), "the import not made");
      return NULL;
   }
   const VkBufferDeviceAddressInfo ai = { .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO, .buffer = buf };
   out[0] = (uint32_t)Address(dev, &ai);
   VkBuffer other;
   if (CreateBuffer(dev, &bi, NULL, &other) != VK_SUCCESS || BindBufferMemory(dev, other, c, 0) != VK_SUCCESS) {
      snprintf(error, sizeof(error), "a buffer not bound");
      return NULL;
   }
   fd.fd = (int)(uintptr_t)c;
   const bool was = wg_unwaited_allocations;
   wg_unwaited_allocations = false;
   out[1] = (uint32_t)AllocateMemory(dev, &imp, NULL, &e);
   /* A guest that doesn't wait for it: the import all the same, no address. */
   wg_unwaited_allocations = true;
   out[8] = (uint32_t)AllocateMemory(dev, &imp, NULL, &e);
   wg_unwaited_allocations = was;
   const VkBufferDeviceAddressInfo oi = { .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO, .buffer = other };
   out[9] = (uint32_t)Address(dev, &oi);
   for (uint32_t i = 0; i < 2; i++) {
      const VkDescriptorSetLayoutBinding binding = { i ? 0xffffffffu : 0x40000001u, VK_DESCRIPTOR_TYPE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &binding };
      VkDescriptorSetLayout dsl;
      out[2 + i] = (uint32_t)CreateDescriptorSetLayout(dev, &dli, NULL, &dsl);
   }
   VkPhysicalDeviceMaintenance3Properties m3 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_3_PROPERTIES };
   VkPhysicalDeviceProperties2 pp = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &m3 };
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   EnumeratePhysicalDevices(instance, &n, &pdev);
   ((PFN_vkGetPhysicalDeviceProperties2)vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceProperties2"))(pdev, &pp);
   VkMemoryAllocateInfo big = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = m3.maxMemoryAllocationSize };
   VkDeviceMemory all[64];
   uint32_t count = 0;
   VkResult r = VK_SUCCESS;
   const bool unwaited = wg_unwaited_allocations;
   wg_unwaited_allocations = false;
   while (count < 64 && (r = AllocateMemory(dev, &big, NULL, &all[count])) == VK_SUCCESS)
      count++;
   out[4] = (uint32_t)(count * (m3.maxMemoryAllocationSize >> 20));
   out[5] = (uint32_t)r;
   wg_unwaited_allocations = true;
   out[6] = (uint32_t)AllocateMemory(dev, &big, NULL, &e);
   void *map;
   out[7] = (uint32_t)MapMemory(dev, e, 0, VK_WHOLE_SIZE, 0, &map);
   FreeMemory(dev, e, NULL);
   wg_unwaited_allocations = unwaited;
   while (count)
      FreeMemory(dev, all[--count], NULL);
   return out;
}

/* A host-visible memory for venus_test_peers (VK4 R6), and where a map of it says its bytes are. */
static VkDeviceMemory peers_memory;

EXPORT uint32_t
wgt_peers_memory(void)
{
   if (!dev && init())
      return 0;
   const VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = 8192, .memoryTypeIndex = 1 };
   return AllocateMemory(dev, &ai, NULL, &peers_memory) == VK_SUCCESS ? (uint32_t)(uintptr_t)peers_memory : 0;
}

EXPORT uint32_t
wgt_peers_at(void)
{
   void *map = NULL;
   return MapMemory(dev, peers_memory, 0, VK_WHOLE_SIZE, 0, &map) == VK_SUCCESS ? (uint32_t)(uintptr_t)map : 0;
}

/* A sync destroyed while a held submit names it (VK4 T2: NVIDIA's trap in wg_complete, a completion signalling a freed
 * sync through its type's functions): a submit held for a timeline semaphore's value 1 that signals a fence; the
 * syncs held submits name [0] then, [1] once the fence is destroyed (the semaphore's wait only), [2] the host's signal
 * of the value's result (the submit replayed and completed: no device), [3] the held syncs after. NULL with
 * wgt_error(). */
EXPORT const uint32_t *
wgt_sync_freed(void)
{
   static uint32_t out[4];
   if (!dev && init())
      return NULL;
   PFN_vkCreateSemaphore CreateSemaphore = (PFN_vkCreateSemaphore)GetDeviceProcAddr(dev, "vkCreateSemaphore");
   PFN_vkDestroySemaphore DestroySemaphore = (PFN_vkDestroySemaphore)GetDeviceProcAddr(dev, "vkDestroySemaphore");
   PFN_vkDestroyFence DestroyFence = (PFN_vkDestroyFence)GetDeviceProcAddr(dev, "vkDestroyFence");
   PFN_vkSignalSemaphore SignalSemaphore = (PFN_vkSignalSemaphore)GetDeviceProcAddr(dev, "vkSignalSemaphore");
   const VkSemaphoreTypeCreateInfo type = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
                                            .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE };
   const VkSemaphoreCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, .pNext = &type };
   VkSemaphore sem;
   VkFence f;
   CHECK_NULL(CreateSemaphore(dev, &si, NULL, &sem));
   CHECK_NULL(CreateFence(dev, &(VkFenceCreateInfo){ .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO }, NULL, &f));
   const uint64_t one = 1;
   const VkTimelineSemaphoreSubmitInfo ti = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
                                              .waitSemaphoreValueCount = 1, .pWaitSemaphoreValues = &one };
   const VkPipelineStageFlags stage = VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &ti, .waitSemaphoreCount = 1,
                                 .pWaitSemaphores = &sem, .pWaitDstStageMask = &stage };
   CHECK_NULL(QueueSubmit(queue, 1, &submit, f));
   out[0] = (uint32_t)wg_held_syncs();
   DestroyFence(dev, f, NULL);
   out[1] = (uint32_t)wg_held_syncs();
   const VkSemaphoreSignalInfo signal = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = sem, .value = 1 };
   out[2] = (uint32_t)SignalSemaphore(dev, &signal);
   out[3] = (uint32_t)wg_held_syncs();
   DestroySemaphore(dev, sem, NULL);
   return out;
}

/* Semaphores made with an export of each set of handle types (VK3 L7.1b: Venus's guest creates them asynchronously, so
 * one the driver refuses is a handle vkr never has): a bit each, in the order below, for those made. */
EXPORT int
wgt_semaphores(void)
{
   if (!dev && init())
      return -1;
   PFN_vkCreateSemaphore CreateSemaphore = (PFN_vkCreateSemaphore)GetDeviceProcAddr(dev, "vkCreateSemaphore");
   PFN_vkDestroySemaphore DestroySemaphore = (PFN_vkDestroySemaphore)GetDeviceProcAddr(dev, "vkDestroySemaphore");
   const VkExternalSemaphoreHandleTypeFlags types[] = {
      0, VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_SYNC_FD_BIT, VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT,
      VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT | VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_SYNC_FD_BIT,
      VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT, /* a timeline semaphore's */
   };
   int made = 0;
   for (uint32_t k = 0; k < sizeof(types) / sizeof(types[0]); k++) {
      const VkSemaphoreTypeCreateInfo type = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
                                               .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE, .initialValue = 3 };
      const VkExportSemaphoreCreateInfo export = { .sType = VK_STRUCTURE_TYPE_EXPORT_SEMAPHORE_CREATE_INFO,
                                                   .pNext = k == 4 ? &type : NULL, .handleTypes = types[k] };
      const VkSemaphoreCreateInfo sci = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, .pNext = &export };
      VkSemaphore sem;
      if (CreateSemaphore(dev, &sci, NULL, &sem) == VK_SUCCESS) {
         made |= 1 << k;
         DestroySemaphore(dev, sem, NULL);
      }
   }
   return made;
}

/* bench/vulkan/costs.ts (VK2's costs: a pipeline's, a submit's): after wgt_run, one submit drawing its quad into its
 * render pass. `variant` 0 binds wgt_run's pipeline; any other makes a pipeline anew with `fs` (a fragment shader whose
 * specialization constant 0 is `variant`, so its WGSL is new: translated, compiled and made from nothing) in its place.
 * wgt_draw_done then says when the submit's fence signalled. */
static VkFence draw_fence;
static VkShaderModule draw_fs;
static VkPipeline last;
/* wgt_flat's: a draw of these vertices, not indexed (0: the quad's six indices). */
static uint32_t draw_vertices;
/* wgt_draw_params's: its commands in place of the draw (`in_pass`), and before the pass. */
static void (*draw_custom)(VkCommandBuffer cmd, bool in_pass);

static int draw_with(const uint32_t *fs, uint32_t fs_words, uint32_t variant, VkPipeline given);

EXPORT int
wgt_draw(const uint32_t *fs, uint32_t fs_words, uint32_t variant)
{
   return draw_with(fs, fs_words, variant, VK_NULL_HANDLE);
}

/* wgt_draw's draw, with `given` (not destroyed here) in place of the pipeline if not null, the colour image then copied
 * into wgt_pixels. */
static int
draw_with(const uint32_t *fs, uint32_t fs_words, uint32_t variant, VkPipeline given)
{
   static PFN_vkResetCommandPool ResetCommandPool;
   static PFN_vkDestroyPipeline DestroyPipeline;
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   if (!draw_fence) {
      const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
      CHECK(CreateFence(dev, &fi, NULL, &draw_fence));
      if (fs && shader(fs, fs_words, &draw_fs))
         return 1;
      const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
      CHECK(CreateCommandPool(dev, &cpo, NULL, &scene.pool));
      ResetCommandPool = (PFN_vkResetCommandPool)GetDeviceProcAddr(dev, "vkResetCommandPool");
      DestroyPipeline = (PFN_vkDestroyPipeline)GetDeviceProcAddr(dev, "vkDestroyPipeline");
   } else if (GetFenceStatus(dev, draw_fence) != VK_SUCCESS) {
      snprintf(error, sizeof(error), "the last draw isn't done");
      return 1;
   }
   if (last)
      DestroyPipeline(dev, last, NULL);
   last = VK_NULL_HANDLE;
   CHECK(ResetFences(dev, 1, &draw_fence));
   CHECK(ResetCommandPool(dev, scene.pool, 0));
   VkPipeline pipeline = given ? given : scene.pipeline;
   if (variant && !given) {
      const float k = (float)variant;
      const VkSpecializationMapEntry entry = { 0, 0, 4 };
      const VkSpecializationInfo spec = { 1, &entry, 4, &k };
      VkPipelineShaderStageCreateInfo stages[2] = { scene.stages[0], scene.stages[1] };
      stages[1].module = draw_fs;
      stages[1].pSpecializationInfo = &spec;
      VkGraphicsPipelineCreateInfo gpi = scene.gpi;
      gpi.pStages = stages;
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &pipeline));
   }
   VkCommandBuffer cmd;
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = scene.pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &cmd));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(cmd, &begin));
   if (draw_custom)
      draw_custom(cmd, false);
   const VkClearValue clears[2] = { { .color = { .float32 = { 0, 0, 1, 1 } } }, { .depthStencil = { 1, 0 } } };
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = scene.rp,
                                       .framebuffer = scene.fb, .renderArea = { { 0, 0 }, { scene.w, scene.h } },
                                       .clearValueCount = 2, .pClearValues = clears };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
   const VkViewport viewport = { 0, 0, scene.w, scene.h, 0, 1 };
   const VkRect2D scissor = { { 0, 0 }, { scene.w, scene.h } };
   CmdSetViewport(cmd, 0, 1, &viewport);
   CmdSetScissor(cmd, 0, 1, &scissor);
   const VkDeviceSize zero = 0;
   CmdBindVertexBuffers(cmd, 0, 1, &scene.vertices, &zero);
   CmdBindIndexBuffer(cmd, scene.indices, 0, VK_INDEX_TYPE_UINT16);
   const uint32_t offset = 0;
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, scene.layout, 0, 1, &scene.set, 1, &offset);
   const float right[4] = { 0.5f, 0, 0, 0 };
   CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, right);
   if (draw_custom)
      draw_custom(cmd, true);
   else if (draw_vertices)
      CmdDraw(cmd, draw_vertices, 1, 0, 0);
   else
      CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
   CmdEndRenderPass(cmd);
   if (given) {
      const VkBufferImageCopy down = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                       .imageExtent = { scene.w, scene.h, 1 } };
      CmdCopyImageToBuffer(cmd, scene.color, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, scene.readback, 1, &down);
   }
   CHECK(EndCommandBuffer(cmd));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, draw_fence));
   /* Freed at the next draw, once this one is done. */
   last = variant && !given ? pipeline : VK_NULL_HANDLE;
   return 0;
}

/*
 * A draw whose vertex and fragment shaders came with different programs (VK3 L4c-D; the review's finding 4), after
 * wgt_run: wgt_run's graphics pipeline made through a pipeline cache, the cache's data changed so that its vertex
 * shader's link (the last 32 bytes of its entry, wg_shader.c `wg_serialize`) differs from its fragment shader's, a cache
 * made from that data, and the pipeline made again from it (both stages found there: the fragment shader joins the live
 * program of its link, the vertex shader gets one of its own). Then wgt_draw's quad with it, copied into wgt_pixels;
 * wgt_draw_done says when. Its left half is the texture's (red over green) only if the draw kept its fragment shader.
 */
EXPORT int
wgt_link(void)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   const VkPipelineCacheCreateInfo pci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO };
   VkPipelineCache c1, c2;
   CHECK(CreatePipelineCache(dev, &pci, NULL, &c1));
   VkGraphicsPipelineCreateInfo gpi = scene.gpi;
   gpi.pStages = scene.stages;
   VkPipeline p1, p2;
   CHECK(CreateGraphicsPipelines(dev, c1, 1, &gpi, NULL, &p1));
   size_t n = 0;
   CHECK(GetPipelineCacheData(dev, c1, &n, NULL));
   uint8_t *d = malloc(n);
   CHECK(GetPipelineCacheData(dev, c1, &n, d));
   /* vk_pipeline_cache.c's data: the header (its size first), a count, then each object's type, key size, data size,
    * key and (8-aligned) data. A shader's data: format, stage (0: vertex), translated, its WGSL, ..., its link. */
   uint32_t at, count, changed = 0;
   memcpy(&at, d, 4);
   memcpy(&count, d + at, 4);
   at += 4;
   for (uint32_t i = 0; i < count && at + 12 <= n; i++) {
      uint32_t head[3];
      memcpy(head, d + at, 12);
      at = (at + 12 + head[1] + 7) & ~7u;
      const uint32_t size = head[2];
      if (at + size > n)
         break;
      uint32_t shader[3];
      if (size >= 12 + 32) {
         memcpy(shader, d + at, 12);
         bool vertex = false;
         for (uint32_t k = 12; k + 7 <= size && !vertex; k++)
            vertex = !memcmp(d + at + k, "@vertex", 7);
         if (shader[1] == 0 && shader[2] == 1 && vertex) {
            d[at + size - 1] ^= 0x5a;
            changed++;
         }
      }
      /* The next object's header 4-aligned (blob_write_uint32 aligns): a shader's data needn't end on a word. */
      at = (at + size + 3) & ~3u;
   }
   if (changed != 1) {
      snprintf(error, sizeof(error), "%u vertex shaders in a pipeline cache's %u objects", changed, count);
      return 1;
   }
   const VkPipelineCacheCreateInfo pci2 = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO,
                                            .initialDataSize = n, .pInitialData = d };
   CHECK(CreatePipelineCache(dev, &pci2, NULL, &c2));
   free(d);
   CHECK(CreateGraphicsPipelines(dev, c2, 1, &gpi, NULL, &p2));
   return draw_with(NULL, 0, 0, p2);
}

/*
 * Pipelines a valid Vulkan program makes that WebGPU must not refuse (the out-of-context review of the driver, findings
 * 1, 6 and 11), after wgt_run: wgt_draw's quad (indexed, six indices) with wgt_run's pipeline changed by `scenario`,
 * copied into wgt_pixels; wgt_draw_done says when.
 * 0: a triangle strip, primitive restart off: the quad drawn (its indices 0 1 2 0 2 3 as a strip cover it);
 * 1: no fragment shader, in the pass with a colour attachment: nothing coloured (blue);
 * 2: a line list with depth bias on (Vulkan biases only polygons): blue on the right half.
 */
EXPORT int
wgt_variant(uint32_t scenario)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   VkGraphicsPipelineCreateInfo gpi = scene.gpi;
   gpi.pStages = scene.stages;
   VkPipelineInputAssemblyStateCreateInfo ias = *gpi.pInputAssemblyState;
   VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
   gpi.pInputAssemblyState = &ias;
   gpi.pRasterizationState = &rs;
   if (scenario == 0) {
      ias.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP;
      rs.cullMode = VK_CULL_MODE_NONE;
   } else if (scenario == 1) {
      gpi.stageCount = 1;
   } else {
      ias.topology = VK_PRIMITIVE_TOPOLOGY_LINE_LIST;
      rs.depthBiasEnable = VK_TRUE;
      rs.depthBiasConstantFactor = 4;
      rs.depthBiasSlopeFactor = 1;
   }
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   return draw_with(NULL, 0, 0, p);
}

/*
 * The provoking vertex (VK3 L7.4, VK_EXT_provoking_vertex), after wgt_run: wgt_draw's quad with `vs` and `fs`
 * (flat.vert, flat.frag: each vertex's uv as a flat colour; its triangles (0, 1, 2), the top right of its half, and
 * (0, 2, 3), the bottom left), copied into wgt_pixels; wgt_draw_done says when.
 * 0: indexed, the last vertex provoking: v2's (1, 1) top left, v3's (0, 1) bottom left;
 * 1: its four vertices as a fan, not indexed, the last vertex provoking (triangles (1, 2, 0), (2, 3, 0)): as 0;
 * 2: as 1, the first vertex provoking: v1's (1, 0) top left, v2's (1, 1) bottom left.
 * The out-of-context review of L7.4-L7.5 (finding 1: a 16-bit index range ending on a half-word lost its last index),
 * through a 16-bit index buffer of its own whose size isn't a multiple of 4:
 * 3: an indexed fan, the first vertex provoking, its 5 indices (0, 0, 1, 2, 3) in 10 bytes: a degenerate triangle,
 *    then as 2;
 * 4: an indexed triangle list, the last vertex provoking, its 3 indices (0, 1, 2) in 6 bytes: v2's (1, 1) top left,
 *    the bottom left not drawn (blue).
 * 5: (the review's finding 7: a restarted strip walked by one invocation) an indexed strip with primitive restart,
 *    the last vertex provoking: 255 restarts, then (0, 1, 2), a restart, (0, 2, 3), so that its runs cross the walk's
 *    parts: as 0.
 */
static struct {
   VkBuffer fan, list, strip;
   uint32_t which; /* 0 fan, 1 list, 2 strip */
} flat;

static void
flat_record(VkCommandBuffer cmd, bool in_pass)
{
   if (!in_pass)
      return;
   CmdBindIndexBuffer(cmd, flat.which == 0 ? flat.fan : flat.which == 1 ? flat.list : flat.strip, 0,
                      VK_INDEX_TYPE_UINT16);
   CmdDrawIndexed(cmd, flat.which == 0 ? 5 : flat.which == 1 ? 3 : 262, 1, 0, 0, 0);
}

EXPORT int
wgt_flat(uint32_t scenario, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   VkGraphicsPipelineCreateInfo gpi = scene.gpi;
   VkPipelineShaderStageCreateInfo stages[2] = { scene.stages[0], scene.stages[1] };
   stages[1].pSpecializationInfo = NULL;
   if (shader(vs, vs_words, &stages[0].module) || shader(fs, fs_words, &stages[1].module))
      return 1;
   gpi.pStages = stages;
   VkPipelineInputAssemblyStateCreateInfo ias = *gpi.pInputAssemblyState;
   VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
   VkPipelineRasterizationProvokingVertexStateCreateInfoEXT pv = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_PROVOKING_VERTEX_STATE_CREATE_INFO_EXT,
   };
   pv.provokingVertexMode = scenario < 2 || scenario >= 4 ? VK_PROVOKING_VERTEX_MODE_LAST_VERTEX_EXT
                                                          : VK_PROVOKING_VERTEX_MODE_FIRST_VERTEX_EXT;
   rs.pNext = &pv;
   rs.cullMode = VK_CULL_MODE_NONE;
   if (scenario > 0 && scenario < 4)
      ias.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN;
   if (scenario == 5) {
      ias.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP;
      ias.primitiveRestartEnable = VK_TRUE;
   }
   gpi.pInputAssemblyState = &ias;
   gpi.pRasterizationState = &rs;
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   if (scenario >= 3 && !flat.fan) {
      uint16_t *fan, *list;
      if (buffer(10, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &flat.fan, (void **)&fan) ||
          buffer(6, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &flat.list, (void **)&list))
         return 1;
      memcpy(fan, (const uint16_t[]){ 0, 0, 1, 2, 3 }, 10);
      memcpy(list, (const uint16_t[]){ 0, 1, 2 }, 6);
      uint16_t *strip;
      if (buffer(262 * 2, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &flat.strip, (void **)&strip))
         return 1;
      memset(strip, 0xff, 262 * 2);
      memcpy(strip + 255, (const uint16_t[]){ 0, 1, 2, 0xffff, 0, 2, 3 }, 14);
   }
   draw_vertices = scenario > 0 ? 4 : 0;
   flat.which = scenario - 3;
   if (scenario >= 3)
      draw_custom = flat_record;
   const int r = draw_with(NULL, 0, 0, p);
   draw_vertices = 0;
   draw_custom = NULL;
   return r;
}

/*
 * Draw parameters (VK3 L7.5, shaderDrawParameters), after wgt_run: `vs` (draw-params.vert: a quad by its vertices'
 * index less the base vertex, its flat colour the draw's parameters) and `fs` (flat.frag) in four draws of one pass,
 * a quarter each, copied into wgt_pixels; wgt_draw_done says when. Top left: vkCmdDraw from vertex 10, instance 20;
 * bottom left: vkCmdDrawIndexed (indices 0 to 5) at vertex offset 30, instance 40; top right: vkCmdDrawIndirect of
 * host-written arguments (vertex 50, instance 60); bottom right: vkCmdDrawIndexedIndirect of arguments written by
 * vkCmdUpdateBuffer before the pass (vertex offset 70, instance 80, or 0 without drawIndirectFirstInstance:
 * `first_instance`). Push constants place the quads, the first two's the same (the shader moves the second down).
 */
static struct {
   VkBuffer indices, args;
   uint32_t *map;
   uint32_t first_instance;
} dp;

static void
draw_params_record(VkCommandBuffer cmd, bool in_pass)
{
   static PFN_vkCmdUpdateBuffer CmdUpdateBuffer;
   static PFN_vkCmdDrawIndirect CmdDrawIndirect;
   static PFN_vkCmdDrawIndexedIndirect CmdDrawIndexedIndirect;
   if (!CmdUpdateBuffer) {
      CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
      CmdDrawIndirect = (PFN_vkCmdDrawIndirect)GetDeviceProcAddr(dev, "vkCmdDrawIndirect");
      CmdDrawIndexedIndirect = (PFN_vkCmdDrawIndexedIndirect)GetDeviceProcAddr(dev, "vkCmdDrawIndexedIndirect");
   }
   if (!in_pass) {
      const uint32_t indexed[5] = { 6, 1, 0, 70, dp.first_instance };
      CmdUpdateBuffer(cmd, dp.args, 64, sizeof(indexed), indexed);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_INDIRECT_COMMAND_READ_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT, 0, 1, &mb, 0, NULL,
                         0, NULL);
      return;
   }
   const float off[4][4] = { { -1, -1 }, { 0 }, { 0.05f, -1 }, { 0.05f, 0.05f } };
   CmdBindIndexBuffer(cmd, dp.indices, 0, VK_INDEX_TYPE_UINT16);
   CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[0]);
   CmdDraw(cmd, 6, 1, 10, 20);
   /* The same push constants: the shader moves the quad down by its base vertex. */
   CmdDrawIndexed(cmd, 6, 1, 0, 30, 40);
   CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[2]);
   CmdDrawIndirect(cmd, dp.args, 0, 1, 16);
   CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[3]);
   CmdDrawIndexedIndirect(cmd, dp.args, 64, 1, 20);
}

EXPORT int
wgt_draw_params(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words, uint32_t first_instance)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   VkGraphicsPipelineCreateInfo gpi = scene.gpi;
   VkPipelineShaderStageCreateInfo stages[2] = { scene.stages[0], scene.stages[1] };
   stages[1].pSpecializationInfo = NULL;
   if (shader(vs, vs_words, &stages[0].module) || shader(fs, fs_words, &stages[1].module))
      return 1;
   gpi.pStages = stages;
   VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
   rs.cullMode = VK_CULL_MODE_NONE;
   gpi.pRasterizationState = &rs;
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   if (!dp.indices) {
      uint16_t *idx;
      if (buffer(16, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &dp.indices, (void **)&idx) ||
          buffer(256, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &dp.args,
                 (void **)&dp.map))
         return 1;
      for (uint16_t i = 0; i < 6; i++)
         idx[i] = i;
   }
   memset(dp.map, 0, 256);
   const uint32_t plain[4] = { 6, 1, 50, first_instance ? 60 : 0 };
   memcpy(dp.map, plain, sizeof(plain));
   dp.first_instance = first_instance ? 80 : 0;
   draw_custom = draw_params_record;
   const int r = draw_with(NULL, 0, 0, p);
   draw_custom = NULL;
   return r;
}

/*
 * Vertex layouts WebGPU's vertex buffers refuse (VK4 T5), after wgt_run: vertex-pull.vert's quads, each in a quarter, in
 * the scene's pass, each attribute's bytes written where its layout says.
 * 0: top left, a stride of 7, two 8-bit corners and a colour at byte 2 of it, drawn directly;
 *    top right, a stride of 8 bound at byte 2, indexed with a base vertex;
 *    bottom left, a float32x2 at byte 2 and a unorm16x4 at byte 10, a stride of 18, drawn indirectly;
 *    bottom right, corners from an ordinary binding, the colour from an instance binding of stride 1 at an odd offset
 *    (R8_UNORM: red, a first instance of 2);
 *    then top left again, by a pipeline that leaves that odd offset bound and unread.
 * 1: top left as 0's with a base instance of 7, which puts draw parameters' group 3 in the program, then top right
 *    with one of 9 and nothing else new (the groups set again for the parameters' new place, the pulled one too).
 * 2: pipelines with and without a set 1 in one pass, no push constants, the one without pulling its vertices from the
 *    group the other's set 1 stays bound in: top left with set 1, top right pulled without it, bottom left with set 1.
 * 3: the top left's quad rebound at other offsets of one layout: drawn at bytes 0 (top left), 1 (top right), 2
 *    (bottom left), 3 (bottom right) of the buffer.
 * 4: draws reading past their bindings' ends (Vulkan's robust buffer access; WebGPU refused them, the submit lost:
 *    VK4 T37): top left, a stride of 8 bound 44 bytes before the buffer's end, 6 vertices (the last one's colour past
 *    it), green; top right, corners from an ordinary binding and the colour from an instance binding of R8_UNORM bound
 *    4 bytes before the end, a first instance of 4 (past it: black).
 * 5: scenario 2's draws in a layout of four sets (`fs` four-sets.frag reads each), so no group is free for pulled
 *    vertices but its group 3 (VK4 T44): top left not pulled, top right pulled, bottom left not again.
 * 6: instance bindings with divisors (VK4 T44: VK_KHR_vertex_attribute_divisor), the colour from an R8_UNORM instance
 *    binding of stride 1 at an odd offset, whose records 0 to 5 are 200, 16, 64, 128, 32, 255: top left, a divisor of 2
 *    and a first instance of 5 (record 5, not 5 / 2); top right likewise indirectly; bottom left, a divisor of 0 and
 *    two instances from 3 (both record 3: the second drawn over the first); bottom right, a divisor of 2 and two
 *    instances from 0 (both record 0).
 */
static struct {
   VkPipeline pipeline[4];
   VkBuffer vb, ib, args;
   uint8_t *map;
   uint32_t scenario;
   VkPipelineLayout sets2, sets4;
   uint32_t *args_map;
} pull;

static const uint8_t pull_corner[6][2] = { { 0, 0 }, { 1, 0 }, { 1, 1 }, { 0, 0 }, { 1, 1 }, { 0, 1 } };
#define PULL_RED 0xff0000ffu
#define PULL_GREEN 0xff00ff00u
#define PULL_YELLOW 0xff00ffffu

/* A 7-byte stride's quad at `at` of the buffer. */
static void
pull_stride7(uint32_t at, uint32_t colour)
{
   for (uint32_t i = 0; i < 6; i++) {
      pull.map[at + 7 * i] = pull_corner[i][0] * 255;
      pull.map[at + 7 * i + 1] = pull_corner[i][1] * 255;
      memcpy(pull.map + at + 7 * i + 2, &colour, 4);
   }
}

static void
pull_record(VkCommandBuffer cmd, bool in_pass)
{
   static PFN_vkCmdDrawIndirect CmdDrawIndirect;
   if (!CmdDrawIndirect)
      CmdDrawIndirect = (PFN_vkCmdDrawIndirect)GetDeviceProcAddr(dev, "vkCmdDrawIndirect");
   if (!in_pass)
      return;
   static const float off[4][4] = { { -1, -1 }, { 0.05f, -1 }, { -1, 0.05f }, { 0.05f, 0.05f } };
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[0]);
   const VkDeviceSize zero = 0, at[4] = { 0, 8192 + 2, 16384, 24576 }, whole = 8192;
   if (pull.scenario == 4) {
      const VkDeviceSize end44 = 32768 - 44, end4 = 32768 - 4;
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[1]);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[0]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &end44);
      CmdDraw(cmd, 6, 1, 0, 0);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[3]);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[1]);
      const VkBuffer two[2] = { pull.vb, pull.vb };
      const VkDeviceSize places[2] = { at[3], end4 };
      CmdBindVertexBuffers(cmd, 0, 2, two, places);
      CmdDraw(cmd, 6, 1, 0, 4);
   } else if (pull.scenario == 1) {
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[0]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &zero);
      CmdDraw(cmd, 6, 1, 0, 7);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[1]);
      CmdDraw(cmd, 6, 1, 0, 9);
   } else if (pull.scenario == 6) {
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[3]);
      const VkBuffer two[2] = { pull.vb, pull.vb };
      const VkDeviceSize places[2] = { at[3], 28673 };
      CmdBindVertexBuffers(cmd, 0, 2, two, places);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[0]);
      CmdDraw(cmd, 6, 1, 0, 5);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[1]);
      CmdDrawIndirect(cmd, pull.args, 0, 1, 16);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[3]);
      CmdDraw(cmd, 6, 2, 0, 0);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[2]);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[2]);
      CmdDraw(cmd, 6, 2, 0, 3);
   } else if (pull.scenario == 2 || pull.scenario == 5) {
      const VkViewport quarter[3] = { { 0, 0, 32, 32, 0, 1 }, { 32, 0, 32, 32, 0, 1 }, { 0, 32, 32, 32, 0, 1 } };
      const uint32_t offsets[4] = { 0, 0, 0, 0 };
      const VkDescriptorSet sets[4] = { scene.set, scene.set, scene.set, scene.set };
      const uint32_t n = pull.scenario == 5 ? 4 : 2;
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, n == 4 ? pull.sets4 : pull.sets2, 0, n, sets, n, offsets);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[1]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &whole);
      CmdSetViewport(cmd, 0, 1, &quarter[0]);
      CmdDraw(cmd, 6, 1, 0, 0);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[0]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &zero);
      CmdSetViewport(cmd, 0, 1, &quarter[1]);
      CmdDraw(cmd, 6, 1, 0, 0);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[1]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &whole);
      CmdSetViewport(cmd, 0, 1, &quarter[2]);
      CmdDraw(cmd, 6, 1, 0, 0);
   } else if (pull.scenario == 3) {
      for (uint32_t i = 0; i < 4; i++) {
         const VkDeviceSize place = 1024 * i + i;
         CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &place);
         CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[i]);
         CmdDraw(cmd, 6, 1, 0, 0);
      }
   } else {
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[0]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &zero);
      CmdDraw(cmd, 6, 1, 0, 0);

      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[1]);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[1]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &at[1]);
      CmdBindIndexBuffer(cmd, pull.ib, 0, VK_INDEX_TYPE_UINT16);
      CmdDrawIndexed(cmd, 6, 1, 0, 3, 0);

      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[2]);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[2]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &at[2]);
      CmdDrawIndirect(cmd, pull.args, 0, 1, 16);

      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[3]);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[3]);
      const VkBuffer two[2] = { pull.vb, pull.vb };
      const VkDeviceSize places[2] = { at[3], 28673 };
      CmdBindVertexBuffers(cmd, 0, 2, two, places);
      CmdDraw(cmd, 6, 1, 0, 2);

      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.pipeline[0]);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[0]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &zero);
      CmdDraw(cmd, 6, 1, 0, 0);
   }
}

EXPORT int
wgt_pull(uint32_t scenario, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words,
         const uint32_t *fs2, uint32_t fs2_words)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   VkPipelineShaderStageCreateInfo stages[2] = { scene.stages[0], scene.stages[1] };
   stages[1].pSpecializationInfo = NULL;
   VkShaderModule fs2_module;
   if (shader(vs, vs_words, &stages[0].module) || shader(fs, fs_words, &stages[1].module) ||
       shader(fs2, fs2_words, &fs2_module))
      return 1;
   if (!pull.vb) {
      uint16_t *idx;
      uint32_t *args;
      if (buffer(32768, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, true, &pull.vb, (void **)&pull.map) ||
          buffer(16, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &pull.ib, (void **)&idx) ||
          buffer(16, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, true, &pull.args, (void **)&args))
         return 1;
      for (uint16_t i = 0; i < 6; i++)
         idx[i] = i;
      pull.args_map = args;
      VkDescriptorSetLayout layouts[2] = { scene.set_layout, scene.set_layout };
      const VkPushConstantRange range = { VK_SHADER_STAGE_VERTEX_BIT, 0, 16 };
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 2,
                                               .pSetLayouts = layouts, .pushConstantRangeCount = 1,
                                               .pPushConstantRanges = &range };
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &pull.sets2));
      VkDescriptorSetLayout four[4] = { scene.set_layout, scene.set_layout, scene.set_layout, scene.set_layout };
      VkPipelineLayoutCreateInfo pli4 = pli;
      pli4.setLayoutCount = 4;
      pli4.pSetLayouts = four;
      CHECK(CreatePipelineLayout(dev, &pli4, NULL, &pull.sets4));
   }
   memcpy(pull.args_map, scenario == 6 ? (uint32_t[4]){ 6, 1, 0, 5 } : (uint32_t[4]){ 6, 1, 0, 0 }, 16);
   memset(pull.map, 0, 32768);
   pull.scenario = scenario;
   /* Each shape's bindings and attributes (location 0 the corner, 1 the colour). */
   const struct {
      VkVertexInputBindingDescription b[2];
      VkVertexInputAttributeDescription a[2];
      uint32_t bindings;
   } shapes[4] = {
      { { { 0, 7, VK_VERTEX_INPUT_RATE_VERTEX } },
        { { 0, 0, VK_FORMAT_R8G8_UNORM, 0 }, { 1, 0, VK_FORMAT_R8G8B8A8_UNORM, 2 } }, 1 },
      { { { 0, 8, VK_VERTEX_INPUT_RATE_VERTEX } },
        { { 0, 0, VK_FORMAT_R8G8_UNORM, 0 }, { 1, 0, VK_FORMAT_R8G8B8A8_UNORM, 4 } }, 1 },
      { { { 0, 18, VK_VERTEX_INPUT_RATE_VERTEX } },
        { { 0, 0, VK_FORMAT_R32G32_SFLOAT, 2 }, { 1, 0, VK_FORMAT_R16G16B16A16_UNORM, 10 } }, 1 },
      { { { 0, 8, VK_VERTEX_INPUT_RATE_VERTEX }, { 1, 1, VK_VERTEX_INPUT_RATE_INSTANCE } },
        { { 0, 0, VK_FORMAT_R8G8_UNORM, 0 }, { 1, 1, VK_FORMAT_R8_UNORM, 0 } }, 2 },
   };
   for (uint32_t i = 0; i < 4; i++) {
      const VkPipelineVertexInputStateCreateInfo vis = {
         .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
         .vertexBindingDescriptionCount = shapes[i].bindings, .pVertexBindingDescriptions = shapes[i].b,
         .vertexAttributeDescriptionCount = 2, .pVertexAttributeDescriptions = shapes[i].a };
      VkGraphicsPipelineCreateInfo gpi = scene.gpi;
      VkPipelineShaderStageCreateInfo own[2] = { stages[0], stages[1] };
      VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
      rs.cullMode = VK_CULL_MODE_NONE;
      gpi.pRasterizationState = &rs;
      gpi.pVertexInputState = &vis;
      if (scenario == 2 && i == 1) {
         own[1].module = fs2_module;
         gpi.layout = pull.sets2;
      }
      if (scenario == 5)
         gpi.layout = pull.sets4;
      /* Scenario 6: binding 1's divisor, 2 (pipeline 3) or 0 (pipeline 2, shape 3's). */
      const VkVertexInputBindingDivisorDescriptionKHR divisor = { 1, i == 3 ? 2 : 0 };
      const VkPipelineVertexInputDivisorStateCreateInfoKHR divided = {
         .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_DIVISOR_STATE_CREATE_INFO_KHR, .vertexBindingDivisorCount = 1,
         .pVertexBindingDivisors = &divisor };
      VkPipelineVertexInputStateCreateInfo vis_divided = vis;
      if (scenario == 6 && i >= 2) {
         vis_divided.pVertexBindingDescriptions = shapes[3].b;
         vis_divided.vertexBindingDescriptionCount = shapes[3].bindings;
         vis_divided.pVertexAttributeDescriptions = shapes[3].a;
         vis_divided.pNext = &divided;
         gpi.pVertexInputState = &vis_divided;
      }
      gpi.pStages = own;
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &pull.pipeline[i]));
   }
   if (scenario == 3) {
      for (uint32_t i = 0; i < 4; i++)
         pull_stride7(1024 * i + i, i == 0 ? PULL_RED : i == 1 ? PULL_GREEN : i == 2 ? PULL_YELLOW : 0xffffffffu);
   } else if (scenario == 4) {
      for (uint32_t i = 0; i < 6; i++) {
         const uint32_t at = 32768 - 44 + 8 * i, green = PULL_GREEN;
         pull.map[at] = pull_corner[i][0] * 255;
         pull.map[at + 1] = pull_corner[i][1] * 255;
         if (at + 8 <= 32768)
            memcpy(pull.map + at + 4, &green, 4);
         pull.map[24576 + 8 * i] = pull_corner[i][0] * 255;
         pull.map[24576 + 8 * i + 1] = pull_corner[i][1] * 255;
      }
   } else {
      pull_stride7(0, PULL_RED);
      /* The indexed draw's base vertex of 3: its quad from the fourth stride. */
      for (uint32_t i = 0; i < 6; i++) {
         const uint32_t at = 8192 + (scenario == 2 || scenario == 5 ? 0 : 2 + 8 * 3) + 8 * i, green = PULL_GREEN;
         pull.map[at] = pull_corner[i][0] * 255;
         pull.map[at + 1] = pull_corner[i][1] * 255;
         memcpy(pull.map + at + 4, &green, 4);
         const float xy[2] = { pull_corner[i][0], pull_corner[i][1] };
         const uint16_t yellow[4] = { 65535, 65535, 0, 65535 };
         memcpy(pull.map + 16384 + 18 * i + 2, xy, 8);
         memcpy(pull.map + 16384 + 18 * i + 10, yellow, 8);
         pull.map[24576 + 8 * i] = pull_corner[i][0] * 255;
         pull.map[24576 + 8 * i + 1] = pull_corner[i][1] * 255;
      }
      pull.map[28673 + 2] = 128;
      if (scenario == 6)
         memcpy(pull.map + 28673, (const uint8_t[6]){ 200, 16, 64, 128, 32, 255 }, 6);
   }
   draw_custom = pull_record;
   const int r = draw_with(NULL, 0, 0, pull.pipeline[0]);
   draw_custom = NULL;
   return r;
}

/*
 * ANGLE's ES3 layout of uniform buffers (VK3 L7b, the review of L7.4-L7.5's finding 9: the tests of more than WebGPU's
 * uniform buffers a stage had one stage, one arrayed binding), after wgt_run: `vs` and `fs` (angle-ubo.vert, .frag), a
 * full-screen triangle; set 0 a dynamic uniform buffer for each stage (the default blocks: 100 and 44, at dynamic
 * offsets), set 1 12 blocks each stage alone sees (the vertex stage's k + 1, the fragment stage's 2k + 2): 13 uniform
 * buffers a stage, past WebGPU's 12. The image (178, 200, 0, 255) everywhere; wgt_draw_done says when.
 */
static struct {
   VkPipelineLayout layout;
   VkDescriptorSet sets[2];
} au;

static void
angle_record(VkCommandBuffer cmd, bool in_pass)
{
   if (!in_pass)
      return;
   const uint32_t offsets[2] = { 256, 512 };
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, au.layout, 0, 2, au.sets, 2, offsets);
   CmdDraw(cmd, 3, 1, 0, 0);
}

EXPORT int
wgt_angle_ubo(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   VkBuffer ub;
   uint32_t *w;
   if (buffer(32 * 256, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &ub, (void **)&w))
      return 1;
   memset(w, 0, 32 * 256);
   /* At 256 the vertex stage's default block, at 512 the fragment stage's; from 1024 the 24 blocks. */
   w[64] = 100;
   w[128] = 44;
   for (uint32_t k = 0; k < 12; k++) {
      w[64 * (4 + k)] = k + 1;
      w[64 * (16 + k)] = 2 * k + 2;
   }
   VkDescriptorSetLayoutBinding b0[2] = {
      { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1, VK_SHADER_STAGE_VERTEX_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL },
   };
   VkDescriptorSetLayoutBinding b1[24];
   for (uint32_t k = 0; k < 24; k++)
      b1[k] = (VkDescriptorSetLayoutBinding){ k, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1,
                                              k < 12 ? VK_SHADER_STAGE_VERTEX_BIT : VK_SHADER_STAGE_FRAGMENT_BIT, NULL };
   VkDescriptorSetLayout dsl[2];
   const VkDescriptorSetLayoutCreateInfo l0 = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 2, .pBindings = b0 };
   const VkDescriptorSetLayoutCreateInfo l1 = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 24, .pBindings = b1 };
   CHECK(CreateDescriptorSetLayout(dev, &l0, NULL, &dsl[0]));
   CHECK(CreateDescriptorSetLayout(dev, &l1, NULL, &dsl[1]));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 2, .pSetLayouts = dsl };
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &au.layout));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 2 },
                                        { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 24 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 2,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 2, .pSetLayouts = dsl };
   CHECK(AllocateDescriptorSets(dev, &dai, au.sets));
   VkDescriptorBufferInfo bi[26];
   VkWriteDescriptorSet wr[26];
   for (uint32_t k = 0; k < 26; k++) {
      bi[k] = (VkDescriptorBufferInfo){ ub, k < 2 ? 0 : 256 * (2 + k), 16 };
      wr[k] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = au.sets[k >= 2],
                                      .dstBinding = k < 2 ? k : k - 2, .descriptorCount = 1,
                                      .descriptorType = k < 2 ? VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC
                                                              : VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,
                                      .pBufferInfo = &bi[k] };
   }
   UpdateDescriptorSets(dev, 26, wr, 0, NULL);
   VkGraphicsPipelineCreateInfo gpi = scene.gpi;
   VkPipelineShaderStageCreateInfo stages[2] = { scene.stages[0], scene.stages[1] };
   stages[1].pSpecializationInfo = NULL;
   if (shader(vs, vs_words, &stages[0].module) || shader(fs, fs_words, &stages[1].module))
      return 1;
   gpi.pStages = stages;
   gpi.layout = au.layout;
   VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
   rs.cullMode = VK_CULL_MODE_NONE;
   gpi.pRasterizationState = &rs;
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   draw_custom = angle_record;
   const int r = draw_with(NULL, 0, 0, p);
   draw_custom = NULL;
   return r;
}

/*
 * Usage scopes (VK4 T3), after wgt_run: `vs` and `fs` (scope.vert, .frag: a full-screen triangle whose vertices carry
 * 1000, plus the vertex stage's read-only storage word, 200, and the fragment stage's uniform, 30; every fragment
 * writes their sum, 1230, to its storage buffer's first word) in the scene's render pass, depth testing off. Two
 * host-visible buffers, M and N (`wgt_scope_map`), each of its own memory, laid out alike: the written word at 0, the
 * uniform at 256, the storage at 512, the vertices at 1024, the indices at 1536, indexed indirect arguments at 2048.
 * The draw writes M's word 0; `mask` says which of its reads are bound from M too (else N): 1 the vertex buffer, 2 the
 * index buffer, 4 the uniform, 8 the storage, 16 the indirect arguments (vkCmdDrawIndexedIndirect; else
 * vkCmdDrawIndexed). 32: another draw before it in the pass, every read from M and its write to N's word 0. 64 (with
 * 4): `cs` (ubo-ssbo.comp) bound inside the pass with its uniform M's (30, the pass's copy of it) and `a` at M's 512
 * (200), `b` at N's 3072; after the pass M's uniform updated to 31 and `cs` dispatched: N's word 768 231 (the pass's
 * copies are its own: the driver records a set's bind at the dispatch, outside the pass, which this keeps true). 128
 * (with 4 and 32, VK4 R2): 32's draw writes M's uniform (1230) rather than N's word, then a barrier, and the mask's draw
 * reads it: M's word 0 2430 (a pass's draws read copies taken at its start, and a barrier ends that scope). VK4 T33
 * (vertexPipelineStoresAndAtomics), `vs` writing the storage binding (32 bytes then): 256, its draw writes words 1 to
 * 4 there (1000, 1001, 1002, then 3 by atomics: tests/venus/t33/store.vert); 512 (with 256), rasterizer discard on
 * (no fragment's write, the vertex stage's still); 1024 (with 256), vkCmdDraw of 3 vertices for the indexed draw. Each
 * VkDeviceMemory is one GPUBuffer, and WebGPU's usage scope (the whole pass) refuses a writable usage beside any other
 * of one buffer. M's and N's word 0 1230 where written, 0 where not; wgt_draw_done says when.
 */
static struct {
   VkPipelineLayout layout, clayout;
   VkPipeline compute;
   VkDescriptorSet sets[3]; /* the mask's draw's, 32's draw's, 64's dispatch's */
   VkBuffer m, n;
   uint32_t *maps[2];
   uint32_t mask;
} sc;

static void
scope_record(VkCommandBuffer cmd, bool in_pass)
{
   static PFN_vkCmdDrawIndexedIndirect CmdDrawIndexedIndirect;
   if (!CmdDrawIndexedIndirect)
      CmdDrawIndexedIndirect = (PFN_vkCmdDrawIndexedIndirect)GetDeviceProcAddr(dev, "vkCmdDrawIndexedIndirect");
   static PFN_vkCmdUpdateBuffer CmdUpdateBuffer;
   if (!CmdUpdateBuffer)
      CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   if (!in_pass)
      return;
   if (sc.mask & 64) {
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, sc.compute);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, sc.clayout, 0, 1, &sc.sets[2], 0, NULL);
   }
   const VkDeviceSize vat = 1024;
   if (sc.mask & 32) {
      CmdBindVertexBuffers(cmd, 0, 1, &sc.m, &vat);
      CmdBindIndexBuffer(cmd, sc.m, 1536, VK_INDEX_TYPE_UINT16);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, sc.layout, 0, 1, &sc.sets[1], 0, NULL);
      CmdDrawIndexed(cmd, 3, 1, 0, 0, 0);
   }
   if (sc.mask & 128) {
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_UNIFORM_READ_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
                         VK_DEPENDENCY_BY_REGION_BIT, 1, &mb, 0, NULL, 0, NULL);
   }
   CmdBindVertexBuffers(cmd, 0, 1, sc.mask & 1 ? &sc.m : &sc.n, &vat);
   CmdBindIndexBuffer(cmd, sc.mask & 2 ? sc.m : sc.n, 1536, VK_INDEX_TYPE_UINT16);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, sc.layout, 0, 1, &sc.sets[0], 0, NULL);
   if (sc.mask & 16)
      CmdDrawIndexedIndirect(cmd, sc.m, 2048, 1, 20);
   else if (sc.mask & 1024)
      CmdDraw(cmd, 3, 1, 0, 0);
   else
      CmdDrawIndexed(cmd, 3, 1, 0, 0, 0);
   if (sc.mask & 64) {
      /* After the pass (draw_with ends it after this): M's uniform 31, then the dispatch bound inside the pass. */
      CmdEndRenderPass(cmd);
      static const uint32_t k = 31;
      CmdUpdateBuffer(cmd, sc.m, 256, 4, &k);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_UNIFORM_READ_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                         NULL);
      CmdDispatch(cmd, 1, 1, 1);
      const VkClearValue clears[2] = { { .color = { .float32 = { 0, 0, 1, 1 } } }, { .depthStencil = { 1, 0 } } };
      const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = scene.rp,
                                          .framebuffer = scene.fb, .renderArea = { { 0, 0 }, { scene.w, scene.h } },
                                          .clearValueCount = 2, .pClearValues = clears };
      CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   }
}

EXPORT uint8_t *
wgt_scope_map(uint32_t which)
{
   return (uint8_t *)sc.maps[which];
}

EXPORT int
wgt_scope(uint32_t mask, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words,
          const uint32_t *cs, uint32_t cs_words)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   const VkBufferUsageFlags usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_INDEX_BUFFER_BIT |
                                    VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT |
                                    VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT;
   sc.mask = mask;
   if (buffer(4096, usage, true, &sc.m, (void **)&sc.maps[0]) || buffer(4096, usage, true, &sc.n, (void **)&sc.maps[1]))
      return 1;
   for (uint32_t i = 0; i < 2; i++) {
      uint32_t *w = sc.maps[i];
      memset(w, 0, 4096);
      w[64] = 30;
      w[128] = 200;
      const float pos[6] = { -1, -1, 3, -1, -1, 3 };
      for (uint32_t v = 0; v < 3; v++) {
         memcpy(&w[256 + 3 * v], &pos[2 * v], 8);
         w[256 + 3 * v + 2] = 1000;
      }
      const uint16_t idx[4] = { 0, 1, 2, 0 };
      memcpy(&w[384], idx, sizeof(idx));
      const uint32_t args[5] = { 3, 1, 0, 0, 0 };
      memcpy(&w[512], args, sizeof(args));
   }
   const VkDescriptorSetLayoutBinding b[3] = {
      { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT, NULL },
      { 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL },
   };
   VkDescriptorSetLayout dsl;
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 3, .pBindings = b };
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &sc.layout));
   /* The dispatch's (64): the same bindings, every stage seeing them. */
   VkDescriptorSetLayoutBinding cb[3] = { b[0], b[1], b[2] };
   for (uint32_t k = 0; k < 3; k++)
      cb[k].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
   VkDescriptorSetLayout cdsl;
   const VkDescriptorSetLayoutCreateInfo cli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 3, .pBindings = cb };
   CHECK(CreateDescriptorSetLayout(dev, &cli, NULL, &cdsl));
   const VkPipelineLayoutCreateInfo cpli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                             .setLayoutCount = 1, .pSetLayouts = &cdsl };
   CHECK(CreatePipelineLayout(dev, &cpli, NULL, &sc.clayout));
   if (mask & 64) {
      VkShaderModule m;
      if (shader(cs, cs_words, &m))
         return 1;
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = sc.clayout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &sc.compute));
   }
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 3 }, { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 6 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 3,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetLayout dsls[3] = { dsl, dsl, cdsl };
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 3, .pSetLayouts = dsls };
   CHECK(AllocateDescriptorSets(dev, &dai, sc.sets));
   const VkDescriptorBufferInfo bi[9] = {
      { mask & 4 ? sc.m : sc.n, 256, 16 }, { mask & 8 ? sc.m : sc.n, 512, mask & 256 ? 32 : 16 }, { sc.m, 0, 16 },
      { sc.m, 256, 16 }, { sc.m, 512, 16 }, mask & 128 ? (VkDescriptorBufferInfo){ sc.m, 256, 16 } : (VkDescriptorBufferInfo){ sc.n, 0, 16 },
      { sc.m, 256, 16 }, { sc.m, 512, 16 }, { sc.n, 3072, 16 },
   };
   VkWriteDescriptorSet wr[9];
   for (uint32_t k = 0; k < 9; k++)
      wr[k] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sc.sets[k / 3],
                                      .dstBinding = k % 3, .descriptorCount = 1,
                                      .descriptorType = k % 3 ? VK_DESCRIPTOR_TYPE_STORAGE_BUFFER
                                                              : VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,
                                      .pBufferInfo = &bi[k] };
   UpdateDescriptorSets(dev, 9, wr, 0, NULL);
   VkGraphicsPipelineCreateInfo gpi = scene.gpi;
   VkPipelineShaderStageCreateInfo stages[2] = { scene.stages[0], scene.stages[1] };
   stages[1].pSpecializationInfo = NULL;
   if (shader(vs, vs_words, &stages[0].module) || shader(fs, fs_words, &stages[1].module))
      return 1;
   const VkVertexInputBindingDescription vb = { 0, 12, VK_VERTEX_INPUT_RATE_VERTEX };
   const VkVertexInputAttributeDescription va[2] = { { 0, 0, VK_FORMAT_R32G32_SFLOAT, 0 },
                                                     { 1, 0, VK_FORMAT_R32_UINT, 8 } };
   const VkPipelineVertexInputStateCreateInfo vi = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, .vertexBindingDescriptionCount = 1,
      .pVertexBindingDescriptions = &vb, .vertexAttributeDescriptionCount = 2, .pVertexAttributeDescriptions = va };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
   rs.cullMode = VK_CULL_MODE_NONE;
   rs.rasterizerDiscardEnable = (mask & 512) != 0;
   VkPipelineDepthStencilStateCreateInfo ds = *gpi.pDepthStencilState;
   ds.depthTestEnable = ds.depthWriteEnable = VK_FALSE;
   gpi.pStages = stages;
   gpi.layout = sc.layout;
   gpi.pVertexInputState = &vi;
   gpi.pInputAssemblyState = &ia;
   gpi.pRasterizationState = &rs;
   gpi.pDepthStencilState = &ds;
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   draw_custom = scope_record;
   const int r = draw_with(NULL, 0, 0, p);
   draw_custom = NULL;
   return r;
}

/*
 * Transform feedback (VK3 L7.4, VK_EXT_transform_feedback), after wgt_run: `vs` (xfb.vert: each vertex's position and
 * (u, v, gl_VertexIndex, 7) captured, 32 bytes a vertex) on the scene's vertices, rasterizer discard on, in the scene's
 * render pass, into a host-visible buffer (`wgt_xfb_map`, 4 KiB filled 0xee, the capture bound at 0), its counter at
 * 2048 (wgt_xfb_done says when):
 * 0: a triangle list of vertices 0 to 5 (the binding 1024 bytes): their 6 records, the counter 192;
 * 1: as 0, the binding 160 bytes: the first triangle's 3 (a whole primitive or none), the counter 96;
 * 2: a strip of vertices 0 to 3 (indexed 0 1 2 3 through the scene's index buffer... not: drawn as is): triangles
 *    (0, 1, 2) and (1, 3, 2) in Vulkan's order, the counter 192;
 * 3: as 0 in two draws (vertices 0 to 2, then 3 to 5) with the capture ended and begun again between them, the second
 *    resuming from the counter: the same.
 * 4: `vs` xfb-many.vert (VK3 L7a, the binding review's finding 1): a triangle list of vertices 0 to 5 read through six
 *    vertex bindings (the position from binding 0, from bindings 1 to 5 one float of the vertex, at bytes 4, 8, 12,
 *    16, 0), captured into four buffers at 0, 512, 1024 and 1536 (16 bytes a vertex each), the first's counter 96.
 * The out-of-context review of L7.4-L7.5 (findings 2, 6, 4):
 * 5: as 0, drawn by vkCmdDrawIndirect (host-written arguments: 6 vertices from 0);
 * 6: the scene's indices (0 1 2 0 2 3) drawn by vkCmdDrawIndexedIndirect: their 6 records, the counter 192;
 * 7: as 0, in a dynamic rendering pass of 8 colour attachments, all null;
 * 8: 17 dynamic rendering passes without attachments, render areas 17x17 down to 1x1, each capturing vertices 0 to 2
 *    into its own 96 bytes (at 96 * i): 17 times the first triangle's 3 records, the counter 96.
 * VK4 T5:
 * 9: as 0, the vertices bound at byte 2 of a buffer of their own (pulled from a storage binding).
 * VK4 T40:
 * 10: as 0, `vs` t40/xfb-four.vert (a draw parameter read: the push buffer in group 3, four bind groups).
 * VK4 T45:
 * 11: as 0, then in a second render pass a draw by the counter's byte count (stride 32: the 6 vertices again) captured
 *     at 1024, its counter at 2052;
 * 12: as 11, both in one render pass (the second capture's count is the first's counter, written in the pass).
 * 13: as 1 inside a transform feedback query (begun and ended in the pass): its results copied to 3072 (64-bit, with
 *     availability: 1 written, 2 needed, 1) and 3104 (32-bit, the same);
 * 14: as 3 inside a query begun before the render pass and ended after it: its results at 3072 and 3104 (2, 2, 1).
 */
static struct {
   VkFence fence;
   uint8_t *map;
} xfb;

EXPORT int
wgt_xfb(uint32_t scenario, const uint32_t *vs, uint32_t vs_words)
{
   if (!scene.pipeline) {
      snprintf(error, sizeof(error), "wgt_run first");
      return 1;
   }
   PFN_vkCmdBindTransformFeedbackBuffersEXT Bind =
      (PFN_vkCmdBindTransformFeedbackBuffersEXT)GetDeviceProcAddr(dev, "vkCmdBindTransformFeedbackBuffersEXT");
   PFN_vkCmdBeginTransformFeedbackEXT Begin =
      (PFN_vkCmdBeginTransformFeedbackEXT)GetDeviceProcAddr(dev, "vkCmdBeginTransformFeedbackEXT");
   PFN_vkCmdEndTransformFeedbackEXT End =
      (PFN_vkCmdEndTransformFeedbackEXT)GetDeviceProcAddr(dev, "vkCmdEndTransformFeedbackEXT");
   PFN_vkCmdDrawIndirectByteCountEXT ByteCount =
      (PFN_vkCmdDrawIndirectByteCountEXT)GetDeviceProcAddr(dev, "vkCmdDrawIndirectByteCountEXT");
   if (!Bind || !Begin || !End || !ByteCount) {
      snprintf(error, sizeof(error), "no transform feedback entry points");
      return 1;
   }
   VkGraphicsPipelineCreateInfo gpi = scene.gpi;
   VkPipelineShaderStageCreateInfo stage = scene.stages[0];
   if (shader(vs, vs_words, &stage.module))
      return 1;
   gpi.pStages = &stage;
   gpi.stageCount = 1;
   VkPipelineInputAssemblyStateCreateInfo ias = *gpi.pInputAssemblyState;
   VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
   rs.rasterizerDiscardEnable = VK_TRUE;
   ias.topology = scenario == 2 ? VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
   gpi.pInputAssemblyState = &ias;
   gpi.pRasterizationState = &rs;
   VkVertexInputBindingDescription vbs[6];
   VkVertexInputAttributeDescription vas[6];
   const VkPipelineVertexInputStateCreateInfo vis = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, .vertexBindingDescriptionCount = 6,
      .pVertexBindingDescriptions = vbs, .vertexAttributeDescriptionCount = 6, .pVertexAttributeDescriptions = vas };
   if (scenario == 4) {
      for (uint32_t b = 0; b < 6; b++) {
         vbs[b] = (VkVertexInputBindingDescription){ b, 20, VK_VERTEX_INPUT_RATE_VERTEX };
         vas[b] = (VkVertexInputAttributeDescription){ b, b, b ? VK_FORMAT_R32_SFLOAT : VK_FORMAT_R32G32B32_SFLOAT, 0 };
      }
      gpi.pVertexInputState = &vis;
   }
   /* Dynamic rendering's: its colour formats (none), no render pass. */
   const VkFormat nulls[8] = { VK_FORMAT_UNDEFINED };
   const VkPipelineRenderingCreateInfo pri = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO,
                                               .colorAttachmentCount = scenario == 7 ? 8 : 0,
                                               .pColorAttachmentFormats = nulls };
   if (scenario >= 7) {
      gpi.pNext = &pri;
      gpi.renderPass = VK_NULL_HANDLE;
      gpi.pColorBlendState = NULL;
      gpi.pDepthStencilState = NULL;
   }
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   VkBuffer args = VK_NULL_HANDLE;
   if (scenario == 5 || scenario == 6) {
      uint32_t *a;
      if (buffer(64, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, true, &args, (void **)&a))
         return 1;
      memset(a, 0, 64);
      /* At 16: VkDrawIndirectCommand (6 vertices, 1 instance, from 0) or VkDrawIndexedIndirectCommand (6 indices). */
      memcpy(a + 4, (const uint32_t[]){ 6, 1, 0, 0, 0 }, 20);
   }
   VkBuffer out;
   if (buffer(4096, VK_BUFFER_USAGE_TRANSFORM_FEEDBACK_BUFFER_BIT_EXT |
                       VK_BUFFER_USAGE_TRANSFORM_FEEDBACK_COUNTER_BUFFER_BIT_EXT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
              true, &out, (void **)&xfb.map))
      return 1;
   memset(xfb.map, 0xee, 4096);
   if (!xfb.fence) {
      const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
      CHECK(CreateFence(dev, &fi, NULL, &xfb.fence));
   } else {
      CHECK(ResetFences(dev, 1, &xfb.fence));
   }
   VkCommandPool pool;
   const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
   CHECK(CreateCommandPool(dev, &cpo, NULL, &pool));
   VkCommandBuffer cmd;
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &cmd));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(cmd, &begin));
   const VkClearValue clears[2] = { { .color = { .float32 = { 0, 0, 1, 1 } } }, { .depthStencil = { 1, 0 } } };
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = scene.rp,
                                       .framebuffer = scene.fb, .renderArea = { { 0, 0 }, { scene.w, scene.h } },
                                       .clearValueCount = 2, .pClearValues = clears };
   const VkDeviceSize zero = 0, size = scenario == 1 || scenario == 13 ? 160 : 1024, counter_at = 2048;
   VkQueryPool qp = VK_NULL_HANDLE;
   if (scenario == 13 || scenario == 14) {
      const VkQueryPoolCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                         .queryType = VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT, .queryCount = 2 };
      CHECK(CreateQueryPool(dev, &qi, NULL, &qp));
      CmdResetQueryPool(cmd, qp, 0, 2);
   }
   if (scenario == 14)
      CmdBeginQuery(cmd, qp, 1, 0);
   if (scenario == 8) {
      static PFN_vkCmdBeginRendering BeginRendering;
      static PFN_vkCmdEndRendering EndRendering;
      if (!BeginRendering) {
         BeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
         EndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
      }
      for (uint32_t i = 0; i < 17; i++) {
         /* Smaller each time: a pass given a later pass's attachment would have its viewport past it. */
         const uint32_t e = 17 - i;
         const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO,
                                      .renderArea = { { 0, 0 }, { e, e } }, .layerCount = 1 };
         BeginRendering(cmd, &ri);
         CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
         const VkViewport viewport = { 0, 0, e, e, 0, 1 };
         const VkRect2D scissor = { { 0, 0 }, { e, e } };
         CmdSetViewport(cmd, 0, 1, &viewport);
         CmdSetScissor(cmd, 0, 1, &scissor);
         CmdBindVertexBuffers(cmd, 0, 1, &scene.vertices, &zero);
         const VkDeviceSize at = 96 * i, n = 96;
         Bind(cmd, 0, 1, &out, &at, &n);
         Begin(cmd, 0, 0, NULL, NULL);
         CmdDraw(cmd, 3, 1, 0, 0);
         End(cmd, 0, 1, &out, &counter_at);
         EndRendering(cmd);
      }
      CHECK(EndCommandBuffer(cmd));
      const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                    .pCommandBuffers = &cmd };
      CHECK(QueueSubmit(queue, 1, &submit, xfb.fence));
      return 0;
   }
   static PFN_vkCmdEndRendering EndRendering;
   if (scenario == 7) {
      static PFN_vkCmdBeginRendering BeginRendering;
      if (!BeginRendering) {
         BeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
         EndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
      }
      VkRenderingAttachmentInfo atts[8];
      for (uint32_t i = 0; i < 8; i++)
         atts[i] = (VkRenderingAttachmentInfo){ .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO };
      const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO,
                                   .renderArea = { { 0, 0 }, { scene.w, scene.h } }, .layerCount = 1,
                                   .colorAttachmentCount = 8, .pColorAttachments = atts };
      BeginRendering(cmd, &ri);
   } else {
      CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   }
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   const VkViewport viewport = { 0, 0, scene.w, scene.h, 0, 1 };
   const VkRect2D scissor = { { 0, 0 }, { scene.w, scene.h } };
   CmdSetViewport(cmd, 0, 1, &viewport);
   CmdSetScissor(cmd, 0, 1, &scissor);
   CmdBindVertexBuffers(cmd, 0, 1, &scene.vertices, &zero);
   if (scenario == 9) {
      VkBuffer moved;
      uint8_t *m;
      if (buffer(10 * 5 * 4 + 2, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, true, &moved, (void **)&m))
         return 1;
      memcpy(m + 2, scene.vertex_map, 10 * 5 * 4);
      const VkDeviceSize two = 2;
      CmdBindVertexBuffers(cmd, 0, 1, &moved, &two);
   }
   if (scenario == 4) {
      const VkBuffer vb[5] = { scene.vertices, scene.vertices, scene.vertices, scene.vertices, scene.vertices };
      const VkDeviceSize at[5] = { 4, 8, 12, 16, 0 };
      CmdBindVertexBuffers(cmd, 1, 5, vb, at);
      const VkBuffer xb[4] = { out, out, out, out };
      const VkDeviceSize xat[4] = { 0, 512, 1024, 1536 }, xsize[4] = { 512, 512, 512, 512 };
      Bind(cmd, 0, 4, xb, xat, xsize);
   } else {
      Bind(cmd, 0, 1, &out, &zero, &size);
   }
   if (scenario == 13)
      CmdBeginQuery(cmd, qp, 1, 0);
   if (scenario == 3 || scenario == 14) {
      Begin(cmd, 0, 0, NULL, NULL);
      CmdDraw(cmd, 3, 1, 0, 0);
      End(cmd, 0, 1, &out, &counter_at);
      Begin(cmd, 0, 1, &out, &counter_at);
      CmdDraw(cmd, 3, 1, 3, 0);
   } else if (scenario == 5 || scenario == 6) {
      Begin(cmd, 0, 0, NULL, NULL);
      if (scenario == 6) {
         CmdBindIndexBuffer(cmd, scene.indices, 0, VK_INDEX_TYPE_UINT16);
         ((PFN_vkCmdDrawIndexedIndirect)GetDeviceProcAddr(dev, "vkCmdDrawIndexedIndirect"))(cmd, args, 16, 1, 20);
      } else {
         ((PFN_vkCmdDrawIndirect)GetDeviceProcAddr(dev, "vkCmdDrawIndirect"))(cmd, args, 16, 1, 16);
      }
   } else {
      Begin(cmd, 0, 0, NULL, NULL);
      CmdDraw(cmd, scenario == 2 ? 4 : 6, 1, 0, 0);
   }
   End(cmd, 0, 1, &out, &counter_at);
   if (scenario == 11 || scenario == 12) {
      if (scenario == 11) {
         CmdEndRenderPass(cmd);
         CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
         CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
         CmdSetViewport(cmd, 0, 1, &viewport);
         CmdSetScissor(cmd, 0, 1, &scissor);
         CmdBindVertexBuffers(cmd, 0, 1, &scene.vertices, &zero);
      }
      const VkDeviceSize second = 1024, second_counter = 2052;
      Bind(cmd, 0, 1, &out, &second, &size);
      Begin(cmd, 0, 0, NULL, NULL);
      ByteCount(cmd, 1, 0, out, counter_at, 0, 32);
      End(cmd, 0, 1, &out, &second_counter);
   }
   if (scenario == 13)
      CmdEndQuery(cmd, qp, 1);
   if (scenario == 7)
      EndRendering(cmd);
   else
      CmdEndRenderPass(cmd);
   if (scenario == 14)
      CmdEndQuery(cmd, qp, 1);
   if (qp) {
      CmdCopyQueryPoolResults(cmd, qp, 1, 1, out, 3072, 24, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
      CmdCopyQueryPoolResults(cmd, qp, 1, 1, out, 3104, 12, VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
   }
   CHECK(EndCommandBuffer(cmd));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, xfb.fence));
   return 0;
}

EXPORT uint8_t *
wgt_xfb_map(void)
{
   return xfb.map;
}

EXPORT int
wgt_xfb_done(void)
{
   return xfb.fence && GetFenceStatus(dev, xfb.fence) == VK_SUCCESS;
}

/*
 * Load and store ops (VK3 L4c-D; the review's finding 6 and "suspended and resumed passes"), after wgt_run: a 64×64
 * RGBA8 image, first cleared blue by a pass of its own, then, by `scenario`, with dynamic rendering:
 * 0: a pass loading with LOAD_OP_NONE (clear value red): stays blue;
 * 1: a pass over the left half only, DONT_CARE (clear value red): the right half stays blue;
 * 2: a pass clearing green that suspends (its store op DONT_CARE), red put into its left half by vkCmdClearAttachments,
 *    then the pass resuming it (CLEAR green, STORE): the left half red, the right green;
 * 3: as 2 over the top half only (CLEAR as clear rects): top left red, top right green, the bottom half blue.
 * 4: a D32 image cleared to 0.75 by a pass of its own, then a pass with it as the depth attachment in
 *    DEPTH_STENCIL_READ_ONLY_OPTIMAL and the colour image loaded, drawing wgt_run's quad (depth 0.5, tested LESS) with
 *    its texture the same depth image: the left half (0.75, 0, 0, 1) (the driver review's finding 2: an attachment
 *    sampled in its pass must be WebGPU's read-only one, or the pass is invalid).
 * 5: as 4 with the depth image cleared to 1.0 and an occlusion pool of three queries (VK3 L6c; the L5-L6a review's
 *    finding 4: the worker's clear draws were counted): 0 around a vkCmdClearAttachments of the left half, 1 around
 *    that clear, the quad and the clear again, 2 around the quad alone; their 64-bit values at wgt_pass_query: 0, and
 *    1's equal to 2's.
 * 6: the colour image loaded with a D32S8 attachment (depth 1.0, stencil 0), wgt_run's quad (its texture, right half)
 *    drawn by its pipeline made for dynamic rendering with culling off and the stencil test on, ALWAYS and KEEP on both
 *    faces, the front's reference 1 and the back's 2 (VK3 L6c, the L5-L6a review's finding 7: one draw, since neither
 *    face uses its reference, and a split one reorders the draw's primitives).
 * 7: as 6 with EQUAL on both faces, the front's reference 0: the quad (front faces) drawn, in two draws.
 * 8: as 5 with a pool of 5,000 occlusion queries and one of 3 timestamps (VK4 T46): 1 around the quad with 100
 *    vkCmdClearAttachments before and after it, 4500 around the quad alone, 4999 around 70 clears and the quad; the
 *    timestamps before the pass, inside it and after it; copied to wgt_pass_query 64-bit with their availability, 16
 *    bytes apart (queries 1 and 2, 2 never begun: its value's bytes left 0xee; 4500 at 32, 4999 at 48, the timestamps
 *    at 64), and query 1 in 32 bits with its availability at 112.
 * All in one submit, the image then copied into wgt_pass_pixels (rows of 256 bytes); wgt_pass_done says when.
 */
static struct {
   VkImage image;
   VkImageView view;
   VkBuffer readback, query;
   uint64_t *values;
   uint8_t *pixels;
   VkFence fence;
   VkCommandPool pool;
} lo;

static void
rendering(VkCommandBuffer cmd, VkRect2D area, VkRenderingFlags flags, VkAttachmentLoadOp load,
          VkAttachmentStoreOp store, const float color[4])
{
   static PFN_vkCmdBeginRendering CmdBeginRendering;
   if (!CmdBeginRendering)
      CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   const VkRenderingAttachmentInfo att = {
      .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = lo.view,
      .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .loadOp = load, .storeOp = store,
      .clearValue = { .color = { .float32 = { color[0], color[1], color[2], color[3] } } },
   };
   const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .flags = flags, .renderArea = area,
                                .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &att };
   CmdBeginRendering(cmd, &ri);
}

EXPORT int
wgt_pass(uint32_t scenario)
{
   static PFN_vkCmdEndRendering CmdEndRendering;
   static PFN_vkCmdClearAttachments CmdClearAttachments;
   if (!dev && init())
      return 1;
   if (!lo.image) {
      CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
      CmdClearAttachments = (PFN_vkCmdClearAttachments)GetDeviceProcAddr(dev, "vkCmdClearAttachments");
      if (image(VK_FORMAT_R8G8B8A8_UNORM, 64, 64,
                VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT, VK_IMAGE_ASPECT_COLOR_BIT,
                &lo.image, &lo.view) ||
          buffer(64 * 64 * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &lo.readback, (void **)&lo.pixels) ||
          buffer(256, VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &lo.query, (void **)&lo.values))
         return 1;
      const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
      CHECK(CreateFence(dev, &fi, NULL, &lo.fence));
      const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
      CHECK(CreateCommandPool(dev, &cpo, NULL, &lo.pool));
   } else {
      CHECK(ResetFences(dev, 1, &lo.fence));
   }
   VkCommandBuffer cmd;
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = lo.pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &cmd));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(cmd, &begin));
   VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                              .dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
                              .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                              .newLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .image = lo.image,
                              .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, 0, 0,
                      NULL, 0, NULL, 1, &b);
   const float blue[4] = { 0, 0, 1, 1 }, red[4] = { 1, 0, 0, 1 }, green[4] = { 0, 1, 0, 1 };
   const VkRect2D full = { { 0, 0 }, { 64, 64 } }, left = { { 0, 0 }, { 32, 64 } }, top = { { 0, 0 }, { 64, 32 } };
   rendering(cmd, full, 0, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE, blue);
   CmdEndRendering(cmd);
   if (scenario == 0) {
      rendering(cmd, full, 0, VK_ATTACHMENT_LOAD_OP_NONE, VK_ATTACHMENT_STORE_OP_STORE, red);
      CmdEndRendering(cmd);
   } else if (scenario == 1) {
      rendering(cmd, left, 0, VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_STORE, red);
      CmdEndRendering(cmd);
   } else if (scenario == 6 || scenario == 7) {
      if (!scene.pipeline) {
         snprintf(error, sizeof(error), "wgt_run first");
         return 1;
      }
      static PFN_vkCmdBeginRendering CmdBeginRendering;
      if (!CmdBeginRendering)
         CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
      VkImage ds_image;
      VkImageView dsv;
      if (image(VK_FORMAT_D32_SFLOAT_S8_UINT, 64, 64, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT,
                VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT, &ds_image, &dsv))
         return 1;
      const VkFormat color = VK_FORMAT_R8G8B8A8_UNORM, dsf = VK_FORMAT_D32_SFLOAT_S8_UINT;
      const VkPipelineRenderingCreateInfo pr = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO,
                                                 .colorAttachmentCount = 1, .pColorAttachmentFormats = &color,
                                                 .depthAttachmentFormat = dsf, .stencilAttachmentFormat = dsf };
      VkGraphicsPipelineCreateInfo gpi = scene.gpi;
      gpi.pNext = &pr;
      gpi.renderPass = VK_NULL_HANDLE;
      gpi.pStages = scene.stages;
      VkPipelineRasterizationStateCreateInfo rs = *gpi.pRasterizationState;
      rs.cullMode = VK_CULL_MODE_NONE;
      gpi.pRasterizationState = &rs;
      VkPipelineDepthStencilStateCreateInfo dss = *gpi.pDepthStencilState;
      dss.stencilTestEnable = VK_TRUE;
      const VkCompareOp cmp = scenario == 6 ? VK_COMPARE_OP_ALWAYS : VK_COMPARE_OP_EQUAL;
      dss.front = (VkStencilOpState){ VK_STENCIL_OP_KEEP, VK_STENCIL_OP_KEEP, VK_STENCIL_OP_KEEP, cmp, 0xff, 0xff,
                                      scenario == 6 ? 1 : 0 };
      dss.back = (VkStencilOpState){ VK_STENCIL_OP_KEEP, VK_STENCIL_OP_KEEP, VK_STENCIL_OP_KEEP, cmp, 0xff, 0xff, 2 };
      gpi.pDepthStencilState = &dss;
      VkPipeline sp;
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &sp));
      const VkRenderingAttachmentInfo c = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = lo.view,
         .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_LOAD,
         .storeOp = VK_ATTACHMENT_STORE_OP_STORE };
      const VkRenderingAttachmentInfo d = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = dsv,
         .imageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
         .storeOp = VK_ATTACHMENT_STORE_OP_STORE, .clearValue = { .depthStencil = { 1.0f, 0 } } };
      const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = full, .layerCount = 1,
                                   .colorAttachmentCount = 1, .pColorAttachments = &c, .pDepthAttachment = &d,
                                   .pStencilAttachment = &d };
      CmdBeginRendering(cmd, &ri);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, sp);
      const VkViewport viewport = { 0, 0, 64, 64, 0, 1 };
      CmdSetViewport(cmd, 0, 1, &viewport);
      CmdSetScissor(cmd, 0, 1, &full);
      const VkDeviceSize zero = 0;
      CmdBindVertexBuffers(cmd, 0, 1, &scene.vertices, &zero);
      CmdBindIndexBuffer(cmd, scene.indices, 0, VK_INDEX_TYPE_UINT16);
      const uint32_t offset = 0;
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, scene.layout, 0, 1, &scene.set, 1, &offset);
      const float right[4] = { 0.5f, 0, 0, 0 };
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, right);
      CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
      CmdEndRendering(cmd);
   } else if (scenario == 4 || scenario == 5 || scenario == 8) {
      if (!scene.pipeline) {
         snprintf(error, sizeof(error), "wgt_run first");
         return 1;
      }
      VkImage depth;
      VkImageView dview;
      if (image(VK_FORMAT_D32_SFLOAT, 64, 64, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
                VK_IMAGE_ASPECT_DEPTH_BIT, &depth, &dview))
         return 1;
      VkQueryPool qp = VK_NULL_HANDLE, tp = VK_NULL_HANDLE;
      if (scenario == 5 || scenario == 8) {
         const VkQueryPoolCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                            .queryType = VK_QUERY_TYPE_OCCLUSION,
                                            .queryCount = scenario == 8 ? 5000 : 3 };
         CHECK(CreateQueryPool(dev, &qi, NULL, &qp));
         CmdResetQueryPool(cmd, qp, 0, qi.queryCount);
      }
      if (scenario == 8) {
         const VkQueryPoolCreateInfo ti = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                            .queryType = VK_QUERY_TYPE_TIMESTAMP, .queryCount = 3 };
         CHECK(CreateQueryPool(dev, &ti, NULL, &tp));
         CmdResetQueryPool(cmd, tp, 0, 3);
         CmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, tp, 0);
         memset(lo.values, 0xee, 256);
      }
      VkRenderingAttachmentInfo d = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = dview,
         .imageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
         .storeOp = VK_ATTACHMENT_STORE_OP_STORE, .clearValue = { .depthStencil = { scenario != 4 ? 1.0f : 0.75f, 0 } } };
      VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = full, .layerCount = 1,
                             .pDepthAttachment = &d };
      static PFN_vkCmdBeginRendering CmdBeginRendering;
      if (!CmdBeginRendering)
         CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
      CmdBeginRendering(cmd, &ri);
      CmdEndRendering(cmd);
      const VkImageMemoryBarrier db = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                        .srcAccessMask = VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT,
                                        .dstAccessMask = VK_ACCESS_SHADER_READ_BIT |
                                                         VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_READ_BIT,
                                        .oldLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
                                        .newLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_READ_ONLY_OPTIMAL, .image = depth,
                                        .subresourceRange = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 } };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0, 0,
                         NULL, 0, NULL, 1, &db);
      const VkDescriptorPoolSize sizes[2] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1 },
                                              { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 } };
      VkDescriptorPool pool;
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 2, .pPoolSizes = sizes };
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &pool));
      VkDescriptorSet set;
      const VkDescriptorSetAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                               .descriptorPool = pool, .descriptorSetCount = 1,
                                               .pSetLayouts = &scene.set_layout };
      CHECK(AllocateDescriptorSets(dev, &ai, &set));
      const VkDescriptorBufferInfo ubo = { scene.uniforms, 0, 16 };
      const VkDescriptorImageInfo img = { scene.sampler, dview, VK_IMAGE_LAYOUT_DEPTH_STENCIL_READ_ONLY_OPTIMAL };
      const VkWriteDescriptorSet writes[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, .pBufferInfo = &ubo },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &img },
      };
      UpdateDescriptorSets(dev, 2, writes, 0, NULL);
      const VkRenderingAttachmentInfo c = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = lo.view,
         .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_LOAD,
         .storeOp = VK_ATTACHMENT_STORE_OP_STORE };
      d.imageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_READ_ONLY_OPTIMAL;
      d.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD;
      d.storeOp = VK_ATTACHMENT_STORE_OP_NONE;
      ri.colorAttachmentCount = 1;
      ri.pColorAttachments = &c;
      CmdBeginRendering(cmd, &ri);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, scene.pipeline);
      const VkViewport viewport = { 0, 0, 64, 64, 0, 1 };
      CmdSetViewport(cmd, 0, 1, &viewport);
      CmdSetScissor(cmd, 0, 1, &full);
      const VkDeviceSize zero = 0;
      CmdBindVertexBuffers(cmd, 0, 1, &scene.vertices, &zero);
      CmdBindIndexBuffer(cmd, scene.indices, 0, VK_INDEX_TYPE_UINT16);
      const uint32_t offset = 0;
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, scene.layout, 0, 1, &set, 1, &offset);
      const float right[4] = { 0.5f, 0, 0, 0 };
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, right);
      if (scenario == 5) {
         const VkClearAttachment ca = { VK_IMAGE_ASPECT_COLOR_BIT, 0, { .color = { .float32 = { 1, 0, 0, 1 } } } };
         const VkClearRect rect = { { { 0, 0 }, { 32, 64 } }, 0, 1 };
         CmdBeginQuery(cmd, qp, 0, 0);
         CmdClearAttachments(cmd, 1, &ca, 1, &rect);
         CmdEndQuery(cmd, qp, 0);
         CmdBeginQuery(cmd, qp, 1, 0);
         CmdClearAttachments(cmd, 1, &ca, 1, &rect);
         CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
         CmdClearAttachments(cmd, 1, &ca, 1, &rect);
         CmdEndQuery(cmd, qp, 1);
         CmdBeginQuery(cmd, qp, 2, 0);
      }
      if (scenario == 8) {
         /* VK4 T46: a query cut by 100 clears on each side of the quad (past what spare slots a pool had), one past
          * slot 4,096 around the quad alone, one past it cut by 70 clears, and a timestamp inside the pass. */
         const VkClearAttachment ca = { VK_IMAGE_ASPECT_COLOR_BIT, 0, { .color = { .float32 = { 1, 0, 0, 1 } } } };
         const VkClearRect rect = { { { 0, 0 }, { 32, 64 } }, 0, 1 };
         CmdBeginQuery(cmd, qp, 1, 0);
         for (int k = 0; k < 100; k++)
            CmdClearAttachments(cmd, 1, &ca, 1, &rect);
         CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
         for (int k = 0; k < 100; k++)
            CmdClearAttachments(cmd, 1, &ca, 1, &rect);
         CmdEndQuery(cmd, qp, 1);
         CmdBeginQuery(cmd, qp, 4500, 0);
         CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
         CmdEndQuery(cmd, qp, 4500);
         CmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, tp, 1);
         CmdBeginQuery(cmd, qp, 4999, 0);
         for (int k = 0; k < 70; k++)
            CmdClearAttachments(cmd, 1, &ca, 1, &rect);
      }
      CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
      if (scenario == 5)
         CmdEndQuery(cmd, qp, 2);
      if (scenario == 8)
         CmdEndQuery(cmd, qp, 4999);
      CmdEndRendering(cmd);
      if (scenario == 5)
         CmdCopyQueryPoolResults(cmd, qp, 0, 3, lo.query, 0, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
      if (scenario == 8) {
         CmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, tp, 2);
         /* Each 64-bit with its availability, 16 bytes apart: queries 1 and 2 (2 never begun: its value's bytes
          * untouched, availability 0), 4500 and 4999 at 32, the timestamps at 64; query 1 again in 32 bits at 112. */
         const VkQueryResultFlags f = VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT;
         CmdCopyQueryPoolResults(cmd, qp, 1, 2, lo.query, 0, 16, f);
         CmdCopyQueryPoolResults(cmd, qp, 4500, 1, lo.query, 32, 16, f);
         CmdCopyQueryPoolResults(cmd, qp, 4999, 1, lo.query, 48, 16, f);
         CmdCopyQueryPoolResults(cmd, tp, 0, 3, lo.query, 64, 16, f);
         CmdCopyQueryPoolResults(cmd, qp, 1, 1, lo.query, 112, 8, VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
      }
   } else {
      const VkRect2D area = scenario == 2 ? full : top;
      rendering(cmd, area, VK_RENDERING_SUSPENDING_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_DONT_CARE,
                green);
      const VkClearAttachment ca = { VK_IMAGE_ASPECT_COLOR_BIT, 0, { .color = { .float32 = { 1, 0, 0, 1 } } } };
      const VkClearRect rect = { { { 0, 0 }, { 32, area.extent.height } }, 0, 1 };
      CmdClearAttachments(cmd, 1, &ca, 1, &rect);
      CmdEndRendering(cmd);
      rendering(cmd, area, VK_RENDERING_RESUMING_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE,
                green);
      CmdEndRendering(cmd);
   }
   b.srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
   b.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
   b.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
   b.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL,
                      0, NULL, 1, &b);
   const VkBufferImageCopy down = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                    .imageExtent = { 64, 64, 1 } };
   CmdCopyImageToBuffer(cmd, lo.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, lo.readback, 1, &down);
   CHECK(EndCommandBuffer(cmd));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, lo.fence));
   return 0;
}

EXPORT const uint8_t *
wgt_pass_pixels(void)
{
   return lo.pixels;
}

EXPORT const uint64_t *
wgt_pass_query(void)
{
   return lo.values;
}

EXPORT int
wgt_pass_done(void)
{
   return lo.fence && GetFenceStatus(dev, lo.fence) == VK_SUCCESS;
}

EXPORT int
wgt_draw_done(void)
{
   return draw_fence && GetFenceStatus(dev, draw_fence) == VK_SUCCESS;
}

/*
 * Two devices sharing the host-visible window (VK3 L4c-A; the review's finding 1), as two Venus contexts do: each has a
 * memory in the window (`window` + d × 64 KiB, `two.size` bytes, imported as vkr's patch imports its storage) with a
 * buffer over it, and a host-visible buffer of its own; wgt_two_submit(d) copies the first into the second (a
 * readback) on device d's queue, wgt_two_done(d) says whether its fence signalled. Device 0 is made before device 1.
 * The test writes the window's bytes and marks its write-watch as the guest's stores would.
 * `size` odd: device 0's window memory is `size` bytes and goes through an R8 image (`size` × 1 texels) instead of a
 * buffer copy (an unaligned buffer copy is another of the review's defects), so its last bytes are read on the GPU.
 */
static struct {
   VkDevice dev[2];
   VkQueue queue[2];
   VkFence fence[2];
   VkCommandBuffer cmd[2];
   uint8_t *map[2], *read[2];
   uint32_t size;
} two;

static int
two_buffer(VkDevice d, VkDeviceSize size, VkBufferUsageFlags usage, void *host_ptr, VkBuffer *out, void **map)
{
   const VkBufferCreateInfo info = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size, .usage = usage };
   CHECK(CreateBuffer(d, &info, NULL, out));
   const VkImportMemoryHostPointerInfoEXT import = {
      .sType = VK_STRUCTURE_TYPE_IMPORT_MEMORY_HOST_POINTER_INFO_EXT,
      .handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_HOST_ALLOCATION_BIT_EXT, .pHostPointer = host_ptr,
   };
   const VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                     .pNext = host_ptr ? &import : NULL, .allocationSize = size,
                                     .memoryTypeIndex = 1 };
   VkDeviceMemory mem;
   CHECK(AllocateMemory(d, &ai, NULL, &mem));
   CHECK(MapMemory(d, mem, 0, VK_WHOLE_SIZE, 0, map));
   CHECK(BindBufferMemory(d, *out, mem, 0));
   return 0;
}

EXPORT int
wgt_two_init(uint8_t *window, uint32_t size)
{
   static PFN_vkCmdCopyBuffer CmdCopyBuffer;
   if (!dev && init())
      return 1;
   CmdCopyBuffer = (PFN_vkCmdCopyBuffer)GetDeviceProcAddr(dev, "vkCmdCopyBuffer");
   two.size = size;
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   CHECK(EnumeratePhysicalDevices(instance, &n, &pdev));
   for (uint32_t d = 0; d < 2; d++) {
      const float priority = 1;
      const VkDeviceQueueCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1,
                                           .pQueuePriorities = &priority };
      const VkDeviceCreateInfo di = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1,
                                      .pQueueCreateInfos = &qi };
      VkDevice D;
      CHECK(CreateDevice(pdev, &di, NULL, &D));
      two.dev[d] = D;
      GetDeviceQueue(D, 0, 0, &two.queue[d]);
      const bool odd = d == 0 && (size & 3);
      VkBuffer src, dst;
      if (two_buffer(D, size, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, window + d * 65536, &src, (void **)&two.map[d]) ||
          two_buffer(D, (size + 3) & ~3u, VK_BUFFER_USAGE_TRANSFER_DST_BIT, NULL, &dst, (void **)&two.read[d]))
         return 1;
      const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
      CHECK(CreateFence(D, &fi, NULL, &two.fence[d]));
      VkCommandPool pool;
      const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
      CHECK(CreateCommandPool(D, &cpo, NULL, &pool));
      const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                                .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                                .commandBufferCount = 1 };
      CHECK(AllocateCommandBuffers(D, &cbi, &two.cmd[d]));
      const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
      CHECK(BeginCommandBuffer(two.cmd[d], &begin));
      if (!odd) {
         const VkBufferCopy region = { 0, 0, size & ~3u };
         CmdCopyBuffer(two.cmd[d], src, dst, 1, &region);
      } else {
         const VkImageCreateInfo ii = {
            .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R8_UNORM,
            .extent = { size, 1, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
            .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
         };
         VkImage img;
         CHECK(CreateImage(D, &ii, NULL, &img));
         VkMemoryRequirements req;
         GetImageMemoryRequirements(D, img, &req);
         const VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                           .allocationSize = req.size, .memoryTypeIndex = 0 };
         VkDeviceMemory mem;
         CHECK(AllocateMemory(D, &ai, NULL, &mem));
         CHECK(BindImageMemory(D, img, mem, 0));
         const VkBufferImageCopy row = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                         .imageExtent = { size, 1, 1 } };
         VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                    .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                    .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                                    .newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, .image = img,
                                    .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
         CmdPipelineBarrier(two.cmd[d], VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL,
                            0, NULL, 1, &b);
         CmdCopyBufferToImage(two.cmd[d], src, img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &row);
         b.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
         b.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
         b.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
         b.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
         CmdPipelineBarrier(two.cmd[d], VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0,
                            NULL, 1, &b);
         CmdCopyImageToBuffer(two.cmd[d], img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, dst, 1, &row);
      }
      CHECK(EndCommandBuffer(two.cmd[d]));
   }
   return 0;
}

EXPORT uint8_t *
wgt_two_map(uint32_t d)
{
   return two.map[d];
}

EXPORT uint8_t *
wgt_two_read(uint32_t d)
{
   return two.read[d];
}

EXPORT int
wgt_two_submit(uint32_t d)
{
   VkDevice D = two.dev[d];
   CHECK(ResetFences(D, 1, &two.fence[d]));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &two.cmd[d] };
   CHECK(QueueSubmit(two.queue[d], 1, &submit, two.fence[d]));
   return 0;
}

EXPORT int
wgt_two_done(uint32_t d)
{
   return GetFenceStatus(two.dev[d], two.fence[d]) == VK_SUCCESS;
}

/*
 * GPU writes to host-visible memory in flight against the guest's writes to the same pages (VK3 L4c-B; the review's
 * finding 2). One device; memory M in the window (`window`, 8 KiB, two pages), `aux` (host-visible, 8 KiB, its own
 * storage) and `rd` (host-visible, 8 KiB) with buffers over them, and three command buffers:
 * 0: copy aux[0, 2048) into M[0, 2048) (a GPU write to page 0's first half);
 * 1: copy the whole of M into rd;
 * 2: copy aux[4096, 4104) into a 1×2 RGBA8 image, then the image into M at 4096 with rows 256 bytes apart (writes
 *    M[4096, 4100) and M[4352, 4356); the submit reads back [4096, 4356), the gap included);
 * 3: fill M[6144, 6160) with 0x04030201, then update the same bytes with 16, 17, ... 31 (two writes of the driver's own
 *    to one range in one submit, as Venus's query feedback resets a slot and copies results into it).
 * wgt_fl_map: 0 M, 1 aux, 2 rd. Each command buffer has its own fence.
 */
static struct {
   VkDevice dev;
   VkQueue queue;
   VkFence fence[4];
   VkCommandBuffer cmd[4];
   uint8_t *map[3];
} fl;

EXPORT int
wgt_fl_init(uint8_t *window)
{
   PFN_vkCmdCopyBuffer CmdCopyBuffer;
   if (!dev && init())
      return 1;
   CmdCopyBuffer = (PFN_vkCmdCopyBuffer)GetDeviceProcAddr(dev, "vkCmdCopyBuffer");
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   CHECK(EnumeratePhysicalDevices(instance, &n, &pdev));
   const float priority = 1;
   const VkDeviceQueueCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1,
                                        .pQueuePriorities = &priority };
   const VkDeviceCreateInfo di = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1,
                                   .pQueueCreateInfos = &qi };
   VkDevice D;
   CHECK(CreateDevice(pdev, &di, NULL, &D));
   fl.dev = D;
   GetDeviceQueue(D, 0, 0, &fl.queue);
   const VkBufferUsageFlags both = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
   VkBuffer m, aux, rd;
   if (two_buffer(D, 8192, both, window, &m, (void **)&fl.map[0]) ||
       two_buffer(D, 8192, both, NULL, &aux, (void **)&fl.map[1]) ||
       two_buffer(D, 8192, both, NULL, &rd, (void **)&fl.map[2]))
      return 1;
   const VkImageCreateInfo ii = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R8G8B8A8_UNORM,
      .extent = { 1, 2, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
   };
   VkImage img;
   CHECK(CreateImage(D, &ii, NULL, &img));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(D, img, &req);
   const VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
                                     .memoryTypeIndex = 0 };
   VkDeviceMemory imem;
   CHECK(AllocateMemory(D, &ai, NULL, &imem));
   CHECK(BindImageMemory(D, img, imem, 0));
   VkCommandPool pool;
   const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
   CHECK(CreateCommandPool(D, &cpo, NULL, &pool));
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 4 };
   CHECK(AllocateCommandBuffers(D, &cbi, fl.cmd));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
   for (uint32_t i = 0; i < 4; i++) {
      CHECK(CreateFence(D, &fi, NULL, &fl.fence[i]));
      CHECK(BeginCommandBuffer(fl.cmd[i], &begin));
   }
   CmdCopyBuffer(fl.cmd[0], aux, m, 1, &(VkBufferCopy){ 0, 0, 2048 });
   CmdCopyBuffer(fl.cmd[1], m, rd, 1, &(VkBufferCopy){ 0, 0, 8192 });
   VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                              .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT, .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                              .newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, .image = img,
                              .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CmdPipelineBarrier(fl.cmd[2], VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL,
                      1, &b);
   const VkBufferImageCopy up = { .bufferOffset = 4096, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                  .imageExtent = { 1, 2, 1 } };
   CmdCopyBufferToImage(fl.cmd[2], aux, img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &up);
   b.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
   b.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
   b.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
   b.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
   CmdPipelineBarrier(fl.cmd[2], VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1,
                      &b);
   const VkBufferImageCopy down = { .bufferOffset = 4096, .bufferRowLength = 64,
                                    .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 1, 2, 1 } };
   CmdCopyImageToBuffer(fl.cmd[2], img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, m, 1, &down);
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   uint8_t update[16];
   for (uint32_t i = 0; i < 16; i++)
      update[i] = (uint8_t)(16 + i);
   CmdFillBuffer(fl.cmd[3], m, 6144, 16, 0x04030201);
   CmdUpdateBuffer(fl.cmd[3], m, 6144, 16, update);
   for (uint32_t i = 0; i < 4; i++)
      CHECK(EndCommandBuffer(fl.cmd[i]));
   return 0;
}

EXPORT uint8_t *
wgt_fl_map(uint32_t which)
{
   return fl.map[which];
}

EXPORT int
wgt_fl_submit(uint32_t i)
{
   CHECK(ResetFences(fl.dev, 1, &fl.fence[i]));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &fl.cmd[i] };
   CHECK(QueueSubmit(fl.queue, 1, &submit, fl.fence[i]));
   return 0;
}

EXPORT int
wgt_fl_done(uint32_t i)
{
   return GetFenceStatus(fl.dev, fl.fence[i]) == VK_SUCCESS;
}

/*
 * Transfers and pushes WebGPU has no direct form for (VK3 L4c-F; the static review's "other real defects"), each
 * scenario one submit on new objects, its results in a host-visible buffer (`wgt_misc_map`, 4 KiB; 0xee where
 * nothing was written), `wgt_misc_done` when its fence signalled:
 * 0: buffer copies at offsets and sizes that aren't 4-aligned, in one submit after a fill of the result: from
 *    host-visible memory (S, bytes i * 7 + 3 written by the CPU) S[1, 14) → 6; from device-local memory written
 *    on the GPU (filled 0x04030201, its [16, 32) updated to 0x40 + i) L[17, 27) → 101; from host-visible memory
 *    the same submit filled on the GPU (S[4096, 4112) = 0x0d0c0b0a) S[4097, 4104) → 203; aligned S[8, 72) → 300;
 *    and a long one, S[2, 3003) → 1001.
 * 1: clears: an E5B9G9R9 image (4×4, not renderable in WebGPU) cleared to (1, 0.5, 0.25) → [0, 64) (each texel
 *    0x81010100); a 3D RGBA8 image (4×4×2) cleared to blue → [256, 384) (both slices).
 * 2: a blit from a 3D image (4×4×2 RGBA8, slice 0 red, slice 1 green) of its slice 1 into a 2D image → [0, 64).
 * 3: `cs` (push.comp) dispatched 5,000 times, each with its index as push constant k → v[k], [0, 20000) of a
 *    buffer of its own (`wgt_misc_map` then that).
 * 4: as 3, after a submit of one dispatch with the same pipeline (its push buffer's bind group kept, then the buffer
 *    grown for the 5,000: the out-of-context review of the driver, finding 3).
 * 5: a linear image in host-visible memory, that memory freed (the image kept), then host-visible memory of the same
 *    size (`wgt_misc_map` then that) written 0x5a by the CPU and filled 0x11 by the submit through a buffer: 0x11 (the
 *    review's finding 4: the submit must not reach the freed memory, nor what took its place, through the image).
 * 6: `cs` dispatched 4 times (k 0 to 3) on the result bound as a dynamic storage buffer (64 bytes at dynamic offset
 *    256): v[k] = 3k + 1 at [256, 272) (the review's finding 5: read back at its dynamic offset).
 * 7: as 6 on a result of 4,098 bytes bound whole, without dynamic offset: v[k] at [0, 16) (WebGPU binds storage in
 *    multiples of 4 bytes: the review's "smaller spec gaps").
 * 8: `cs` (depth-read.comp) as pipeline A and, through a pipeline cache of A's data, as pipeline B (a shader of its
 *    own on A's program); A and its cache destroyed, then a pipeline C of `cs` with its scale 2 (a new module, which may
 *    take A's module's id); B dispatched reading a D32 image cleared to 0.25 (the program's variant for a depth view,
 *    made now): 0.25 at [0, 4) (the review's finding 7: the variant was made from A's freed module, C's then).
 * 9: a 4-sample D32S8 attachment cleared to depth 0.25 and stencil 0x5a by dynamic rendering, resolved (SAMPLE_ZERO)
 *    into a single-sample one: its depth at [0, 64), its stencil at [256, 272) (the reviews' depth and stencil resolves,
 *    which WebGPU doesn't do: the worker's draws).
 * 10: as 9 with the store op DONT_CARE (the L4f review's finding 1: resolved before the store op discards).
 * 11: a 4-sample D32S8 image cleared to 0.25 and 0x5a, its resolve target to 1.0 and 0x33, then a pass that loads
 *    them over the render area (0, 0, 2, 2), resolved: its depth at [0, 64), its stencil at [256, 272): the area's
 *    resolved, the rest the target's (the L4f review's finding 5; WebGPU has no multisampled arrays to resolve layers of).
 * 12: `cs` (ssbo-copy.comp: b[i] = a[i] · 2 + 1, `a` read-only) on two storage buffers of the result's memory, `a` at
 *    [512, 528) (1, 2, 3, 4 written by the submit), `b` at [0, 16): 3, 5, 7, 9 (the L4f review's finding 2: a buffer
 *    read and one written in one memory, one GPUBuffer).
 * 14: `cs` (texel-buffer.comp) reading four uniform texel buffers of a host-visible buffer (S, as in 0) through views
 *    at 0, 256, 512 and 768 (B8G8R8A8_UNORM, R16_SINT, A2B10G10R10_UINT_PACK32, R8G8B8_SNORM; 16 texels each), each
 *    invocation's four texels at [64i, 64i + 64) as integers, the views' sizes and a fetch past one at [1024, 1040),
 *    and writing a storage texel buffer (R16G16B16A16_SFLOAT, a view of the result at 2048) (L6b: texel buffers).
 * 16: depth copies WebGPU won't make (L6b: the worker's draws and compute passes): a D32 image cleared to 1.0 with
 *    (0.25, 0.5; 0.75, 0.125) uploaded at (1, 1), whole → [0, 64) and its (1, 1) 2×2 → [256, 272); an X8_D24 image
 *    uploaded whole from words (i · 0x111111 + 7) & 0xffffff, whole → [512, 576); a D32 image cleared to 0 with the
 *    first's (1, 1) 2×2 copied to its (0, 0), whole → [1024, 1088); an S8 image cleared to 0x33 with (0x5a, 0xa5;
 *    0x01, 0xfe) uploaded at (1, 1), whole → [2048, 2064).
 * 15: `cs` (spec-add.comp: b[i] += K) as six pipelines (K = 1 to 6, so six programs) on one set layout, each
 *    dispatched three times in turn on one set: 0xeeeeeeee + 63 at [0, 16), and the set's bind group made once for
 *    them all (L6b: bind groups kept by their layouts' content; a set keeps 4).
 * 13: 64 bytes copied from a host-visible buffer by a submit that waits on a timeline semaphore's value 1, which the
 *    host signals after writing the source (0x11, then 0x22): the copy sees 0x22 (the driver review's finding 8: a wait
 *    before its signal used to run at once).
 * 17: `cs` (ubo-ssbo.comp: b[i] = a[i] + k) with `k` a uniform buffer at [0, 16) and `a` a read-only storage buffer
 *    at [256, 272) of one host-visible memory (100; 1, 2, 3, 4, written by the CPU), `b` at [0, 16) of the result:
 *    101, 102, 103, 104 (the L5-L6a review's finding 2: `a` read-write made the uniform and it one usage scope's
 *    conflict, which invalidated the submit).
 * 18: as 17, dispatched indirectly with its arguments (1, 1, 1) at [512, 524) of that memory: the same.
 * VK4 T3 (usage scopes: a dispatch that writes storage of a memory it reads otherwise), as 17 but:
 * 33: `k` at [256, 272) of the result (100, written by the submit): 101, 102, 103, 104 at [0, 16), 100 at 256;
 * 34: dispatched indirectly with its arguments (1, 1, 1) at [512, 524) of the result: the same at [0, 16);
 * 35: `a` at [0, 16) of the result, the words `b` writes (1, 2, 3, 4 written by the submit): 101 to 104 there.
 * 20: as 7 (4,096 bytes) inside an occlusion query begun and ended outside a render pass, its result copied to
 *    [1024, 1028): v[k] at [0, 16) and 0 there (no pass in it; the L5-L6a review's finding 3: the query's write was
 *    recorded with the compute pass open, which invalidated the submit).
 * 21: a render pass (a 4×4 RGBA8 image, cleared) with an occlusion query of a pool of four begun and ended in it, the
 *    pool destroyed as soon as the submit is made, and 32 blocks of 32 bytes allocated at once (one in the place of the
 *    pool's values, freed with its other arrays) filled 0xab (`wgt_misc_canary`): still 0xab once the fence signals (the L5-L6a review's finding 8: the completion
 *    wrote the query's value into the freed pool).
 * 23: `cs` (many-ubo.comp: b[i] = u[i].k + the push constants' last word) with 13 uniform buffers (100 + i, at 256i
 *     of one host-visible memory) and 128 bytes of push constants (past the immediates: the push buffer's binding
 *     too), 5 pushed: 105 to 117 at [0, 52) (VK3 L7.4: past WebGPU's 12 uniform buffers a stage, some read as storage).
 * 19: as 13's copy, held for its wait, then a submit of nothing but a fence (vkQueueSubmit(queue, 0, NULL, fence), as
 *    Mesa's vkQueueWaitIdle): the fence unsignalled until the host's signal (`wgt_misc_signal`), and the copy 0x22 (the
 *    L5-L6a review's finding 1: such a submit went ahead of held ones, its fence saying they were done).
 */
static struct {
   VkFence fence;
   uint8_t *map;
   int pool_refs;
} misc;
static struct {
   VkBuffer src;
   uint8_t *bytes;
   VkSemaphore sem;
} misc13;

static VkQueryPool misc21_pool;

static int
misc_image_samples(VkFormat format, VkImageType type, uint32_t depth, VkImageUsageFlags usage,
                   VkSampleCountFlagBits samples, VkImage *out)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = type, .format = format, .extent = { 4, 4, depth },
      .mipLevels = 1, .arrayLayers = 1, .samples = samples, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = usage,
   };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   return 0;
}

static int
misc_image(VkFormat format, VkImageType type, uint32_t depth, VkImageUsageFlags usage, VkImage *out)
{
   return misc_image_samples(format, type, depth, usage, VK_SAMPLE_COUNT_1_BIT, out);
}

static void
misc_barrier(VkCommandBuffer cmd, VkImage image, VkImageLayout from, VkImageLayout to)
{
   const VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                    .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                    .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT,
                                    .oldLayout = from, .newLayout = to, .image = image,
                                    .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &b);
}

/*
 * VK3 L7a (the binding model's limits and identities: the out-of-context reviews after L7), wgt_misc's scenarios 24 to
 * 29, each a compute pipeline of `cs` on one set layout of compute bindings, into `out` (filled 0xee):
 * 24: texel-many.comp (8 storage buffers, at 256i of `out`, and 3 uniform texel buffers of R32_UINT, 100, 200, 300, each
 *     of a buffer of its own): WebGPU's storage buffers 11, past SwiftShader's 10 (the L6b-L7.3 review's finding 2):
 *     refused, `out` untouched (at the dispatch since VK4 T40: words of one buffer would have shared a binding); or,
 *     where the adapter has 11, (100, 200, 300)[i % 3] + i at 256i.
 * 25: dyn-ubo.comp with as many dynamic uniform buffers as the device advertises (100 + i at 256i of one memory; binding 1
 *     dynamic only where it advertises 8) and 128 bytes of push constants, 5 pushed: 105 to 112 at [0, 32) (the L7.4-L7.5
 *     review's finding 5: the push buffer was a ninth dynamic uniform buffer).
 * 26: spec-mode.comp as two pipelines on one set, X at [0, 16) and Y at [512, 528) of `out` (X 1, 2, 3, 4 first):
 *     mode 0 (Y = X), then mode 1 (X = 7, Y = 9): 7s and 9s (the binding review's finding 3: mode 1's group was taken
 *     for mode 0's variant's, and its writes of X never read back).
 * 27: sampled.comp mode 0: a combined image sampler whose immutable sampler is LINEAR written with a NEAREST one: 50 at
 *     [0, 4) (finding 7).
 * 28: sampled.comp mode 2: a uniform block of 4 KiB over a 1 KiB buffer of its own memory (41 at its start) and one of
 *     128 KiB bound 64 KiB of a 192 KiB buffer (42 at word 1): 41, 42 at [0, 8) (finding 5).
 * 29: sampled.comp mode 1: the texture and a D32 view (cleared 0.25) sampled through one separate LINEAR sampler: 50 and
 *     25 at [0, 8) (finding 2: the depth view's nearest twin of the sampler filtered the texture too).
 * 91: texel-uniforms.comp (a storage buffer, `out`; 9 uniform texel buffers of R32_UINT, 100(i + 1) at 256i of a buffer;
 *     4 uniform buffers, 1000 + j at 256j of another): 100(i + 1) at word i of `out`, 1000 + j at word 9 + j (VK4 T21:
 *     the texel buffers' parameters were a uniform buffer each, past WebGPU's limits, and the pipeline was refused).
 * 113: t40/shared.comp (a storage buffer, `out`; 12 uniform texel buffers of R32_UINT, two texels each: 10 of a buffer,
 *     100(i + 1) and i at 256i, 2 of another, 5000 + i and 1 at 256i; 13 uniform buffers, 1000 + j at 256j of a third;
 *     4 inline uniform blocks, 7000 + k): 100(i + 1) + i at word i of `out` (5000 + i + 1 for 10 and 11), 1000 + j at
 *     word 12 + j, 7000 + k at word 25 + k (VK4 T40: 20 storage buffers, the texel buffers' words, 3 folded uniform
 *     buffers and the 4 blocks, past SwiftShader's 10: the pipeline was refused; the blocks share their set's buffer's
 *     binding, the rest their memories').
 * 32: as 27, binding 0 then copied (vkUpdateDescriptorSets' copies) from a set whose combined image sampler isn't
 *     immutable, NEAREST: still 50 (VK3 L8a, the track-end review's finding 4: copies overwrote immutable samplers).
 */
static int
l7a_image(VkFormat format, VkImageAspectFlags aspect, VkImage *image, VkImageView *view)
{
   if (misc_image(format, VK_IMAGE_TYPE_2D, 1,
                  VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, image))
      return 1;
   const VkImageViewCreateInfo vi = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = *image, .viewType = VK_IMAGE_VIEW_TYPE_2D,
      .format = format, .subresourceRange = { aspect, 0, 1, 0, 1 },
   };
   CHECK(CreateImageView(dev, &vi, NULL, view));
   return 0;
}

static void
l7a_barrier(VkCommandBuffer cmd, VkImage image, VkImageAspectFlags aspect, VkImageLayout from, VkImageLayout to)
{
   const VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                    .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                    .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_SHADER_READ_BIT,
                                    .oldLayout = from, .newLayout = to, .image = image,
                                    .subresourceRange = { aspect, 0, 1, 0, 1 } };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT,
                      VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 0, NULL, 0, NULL, 1,
                      &b);
}

static int
l7a_misc(uint32_t scenario, const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   PFN_vkCreateBufferView CreateBufferView = (PFN_vkCreateBufferView)GetDeviceProcAddr(dev, "vkCreateBufferView");
   PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
      (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
   PFN_vkGetPhysicalDeviceProperties GetProps =
      (PFN_vkGetPhysicalDeviceProperties)vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceProperties");
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   CHECK(EnumeratePhysicalDevices(instance, &n, &pdev));
   VkPhysicalDeviceProperties props;
   GetProps(pdev, &props);
   const VkBufferUsageFlags both = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;

   VkDescriptorSetLayoutBinding b[8];
   uint32_t nb = 0;
   VkSampler linear, nearest;
   VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = VK_FILTER_LINEAR,
                              .minFilter = VK_FILTER_LINEAR, .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                              .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                              .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE };
   CHECK(CreateSampler(dev, &si, NULL, &linear));
   si.magFilter = si.minFilter = VK_FILTER_NEAREST;
   CHECK(CreateSampler(dev, &si, NULL, &nearest));
   const uint32_t dyn = props.limits.maxDescriptorSetUniformBuffersDynamic < 8 ? props.limits.maxDescriptorSetUniformBuffersDynamic : 8;
   uint32_t mode = 0;
   if (scenario == 113) {
      b[nb++] = (VkDescriptorSetLayoutBinding){ 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] =
         (VkDescriptorSetLayoutBinding){ 1, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 12, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 2, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 13, VK_SHADER_STAGE_COMPUTE_BIT };
      for (uint32_t k = 0; k < 4; k++)
         b[nb++] = (VkDescriptorSetLayoutBinding){ 3 + k, VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, 16,
                                                   VK_SHADER_STAGE_COMPUTE_BIT };
   } else if (scenario == 91) {
      b[nb++] = (VkDescriptorSetLayoutBinding){ 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] =
         (VkDescriptorSetLayoutBinding){ 1, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 9, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 2, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 4, VK_SHADER_STAGE_COMPUTE_BIT };
   } else if (scenario == 24) {
      b[nb++] = (VkDescriptorSetLayoutBinding){ 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 8, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] =
         (VkDescriptorSetLayoutBinding){ 1, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 3, VK_SHADER_STAGE_COMPUTE_BIT };
   } else if (scenario == 25) {
      if (dyn < 7) {
         snprintf(error, sizeof(error), "maxDescriptorSetUniformBuffersDynamic %u", dyn);
         return 1;
      }
      b[nb++] =
         (VkDescriptorSetLayoutBinding){ 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 7, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){
         1, dyn >= 8 ? VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC : VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1,
         VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
   } else if (scenario == 26) {
      b[nb++] = (VkDescriptorSetLayoutBinding){ 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
   } else {
      mode = scenario == 27 || scenario == 32 || scenario == 77 ? 0 : scenario == 29 ? 1 : 2;
      b[nb++] = (VkDescriptorSetLayoutBinding){ 0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1,
                                                VK_SHADER_STAGE_COMPUTE_BIT, &linear };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 1, VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 2, VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 3, VK_DESCRIPTOR_TYPE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 4, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 5, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
      b[nb++] = (VkDescriptorSetLayoutBinding){ 6, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT };
   }
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = nb, .pBindings = b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   /* VK4 R6 (the review's O16): immutable samplers outlive their handles. */
   if (scenario == 77)
      ((PFN_vkDestroySampler)GetDeviceProcAddr(dev, "vkDestroySampler"))(dev, linear, NULL);
   const VkPushConstantRange range = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 128 };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1,
                                            .pPushConstantRanges = &range };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkPipeline pipelines[2];
   for (uint32_t i = 0; i < (scenario == 26 ? 2u : 1u); i++) {
      const uint32_t k = scenario == 26 ? i : mode;
      const VkSpecializationMapEntry entry = { 0, 0, 4 };
      const VkSpecializationInfo spec = { 1, &entry, 4, &k };
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main", .pSpecializationInfo = &spec },
      };
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipelines[i]));
   }
   const VkDescriptorPoolSize ps[6] = { { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 16 },
                                        { VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 12 },
                                        { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 8 },
                                        { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 13 },
                                        { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 2 },
                                        { VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 4 } };
   const VkDescriptorPoolSize ps2 = { VK_DESCRIPTOR_TYPE_SAMPLER, 2 };
   VkDescriptorPoolSize all[8];
   memcpy(all, ps, sizeof(ps));
   all[6] = ps2;
   all[7] = (VkDescriptorPoolSize){ VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, 64 };
   const VkDescriptorPoolInlineUniformBlockCreateInfo ipi = {
      .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_INLINE_UNIFORM_BLOCK_CREATE_INFO, .maxInlineUniformBlockBindings = 4 };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
                                            .pNext = scenario == 113 ? &ipi : NULL, .maxSets = 1,
                                            .poolSizeCount = scenario == 113 ? 8 : 7, .pPoolSizes = all };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT |
                                                                                            VK_ACCESS_SHADER_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
   uint32_t push[32] = { 0 };
   uint32_t offsets[8] = { 0 }, offset_count = 0;

   if (scenario == 113) {
      VkBuffer src, other, ubo;
      uint32_t *w, *wo, *wu;
      if (buffer(4096, both | VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT, true, &src, (void **)&w) ||
          buffer(1024, both | VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT, true, &other, (void **)&wo) ||
          buffer(4096, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &ubo, (void **)&wu))
         return 1;
      VkBufferView views[12];
      for (uint32_t i = 0; i < 12; i++) {
         uint32_t *at = i < 10 ? &w[64 * i] : &wo[64 * (i - 10)];
         at[0] = i < 10 ? 100 * (i + 1) : 5000 + i;
         at[1] = i < 10 ? i : 1;
         const VkBufferViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO,
                                             .buffer = i < 10 ? src : other, .format = VK_FORMAT_R32_UINT,
                                             .offset = 256 * (i < 10 ? i : i - 10), .range = 16 };
         CHECK(CreateBufferView(dev, &vi, NULL, &views[i]));
      }
      VkDescriptorBufferInfo ub[13];
      for (uint32_t j = 0; j < 13; j++) {
         wu[64 * j] = 1000 + j;
         ub[j] = (VkDescriptorBufferInfo){ ubo, 256 * j, 16 };
      }
      const VkDescriptorBufferInfo ob = { out, 0, 128 };
      static const uint32_t blocks[4][4] = { { 7000 }, { 7001 }, { 7002 }, { 7003 } };
      VkWriteDescriptorSetInlineUniformBlock iw[4];
      VkWriteDescriptorSet wr[7] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &ob },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 12,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, .pTexelBufferView = views },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 2, .descriptorCount = 13,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = ub },
      };
      for (uint32_t k = 0; k < 4; k++) {
         iw[k] = (VkWriteDescriptorSetInlineUniformBlock){
            .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_INLINE_UNIFORM_BLOCK, .dataSize = 16, .pData = blocks[k] };
         wr[3 + k] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .pNext = &iw[k], .dstSet = set,
                                             .dstBinding = 3 + k, .descriptorCount = 16,
                                             .descriptorType = VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK };
      }
      UpdateDescriptorSets(dev, 7, wr, 0, NULL);
   } else if (scenario == 91) {
      VkBuffer src, ubo;
      uint32_t *w, *wu;
      if (buffer(4096, both | VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT, true, &src, (void **)&w) ||
          buffer(1024, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &ubo, (void **)&wu))
         return 1;
      VkBufferView views[9];
      for (uint32_t i = 0; i < 9; i++) {
         w[64 * i] = 100 * (i + 1);
         const VkBufferViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO, .buffer = src,
                                             .format = VK_FORMAT_R32_UINT, .offset = 256 * i, .range = 16 };
         CHECK(CreateBufferView(dev, &vi, NULL, &views[i]));
      }
      VkDescriptorBufferInfo ub[4];
      for (uint32_t j = 0; j < 4; j++) {
         wu[64 * j] = 1000 + j;
         ub[j] = (VkDescriptorBufferInfo){ ubo, 256 * j, 16 };
      }
      const VkDescriptorBufferInfo ob = { out, 0, 64 };
      const VkWriteDescriptorSet wr[3] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &ob },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 9,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, .pTexelBufferView = views },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 2, .descriptorCount = 4,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = ub },
      };
      UpdateDescriptorSets(dev, 3, wr, 0, NULL);
   } else if (scenario == 24) {
      /* Three buffers: the words of one would share a binding (VK4 T40). */
      VkBuffer src[3];
      VkBufferView views[3];
      for (uint32_t i = 0; i < 3; i++) {
         uint32_t *w;
         if (buffer(256, both | VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT, true, &src[i], (void **)&w))
            return 1;
         w[0] = 100 * (i + 1);
         const VkBufferViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO, .buffer = src[i],
                                             .format = VK_FORMAT_R32_UINT, .offset = 0, .range = 16 };
         CHECK(CreateBufferView(dev, &vi, NULL, &views[i]));
      }
      VkDescriptorBufferInfo bi[8];
      for (uint32_t i = 0; i < 8; i++)
         bi[i] = (VkDescriptorBufferInfo){ out, 256 * i, 16 };
      const VkWriteDescriptorSet wr[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 8,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = bi },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 3,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, .pTexelBufferView = views },
      };
      UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   } else if (scenario == 25) {
      VkBuffer in;
      uint32_t *w;
      if (buffer(4096, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &in, (void **)&w))
         return 1;
      VkDescriptorBufferInfo bi[9];
      for (uint32_t i = 0; i < 8; i++) {
         w[64 * i] = 100 + i;
         bi[i] = (VkDescriptorBufferInfo){ in, 256 * i, 16 };
      }
      bi[8] = (VkDescriptorBufferInfo){ out, 0, 64 };
      const VkWriteDescriptorSet wr[3] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 7,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, .pBufferInfo = bi },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
           .descriptorType = b[1].descriptorType, .pBufferInfo = &bi[7] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 2, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[8] },
      };
      UpdateDescriptorSets(dev, 3, wr, 0, NULL);
      offset_count = dyn >= 8 ? 8 : 7;
      push[31] = 5;
   } else if (scenario == 26) {
      const VkDescriptorBufferInfo bi[2] = { { out, 0, 16 }, { out, 512, 16 } };
      const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set,
                                        .descriptorCount = 2, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                        .pBufferInfo = bi };
      UpdateDescriptorSets(dev, 1, &wr, 0, NULL);
      const uint32_t x[4] = { 1, 2, 3, 4 };
      CmdUpdateBuffer(cmd, out, 0, sizeof(x), x);
   } else {
      /* The texture (left half 0, right half 255) and the depth view (cleared 0.25). */
      VkImage tex, depth;
      VkImageView tex_view, depth_view;
      VkBuffer staging;
      uint8_t *s;
      if (l7a_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_ASPECT_COLOR_BIT, &tex, &tex_view) ||
          l7a_image(VK_FORMAT_D32_SFLOAT, VK_IMAGE_ASPECT_DEPTH_BIT, &depth, &depth_view) ||
          buffer(64, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, true, &staging, (void **)&s))
         return 1;
      for (uint32_t i = 0; i < 64; i++)
         s[i] = (i / 4) % 4 >= 2 ? 255 : 0;
      l7a_barrier(cmd, tex, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
      const VkBufferImageCopy up = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                     .imageExtent = { 4, 4, 1 } };
      CmdCopyBufferToImage(cmd, staging, tex, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &up);
      l7a_barrier(cmd, tex, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                  VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
      l7a_barrier(cmd, depth, VK_IMAGE_ASPECT_DEPTH_BIT, VK_IMAGE_LAYOUT_UNDEFINED,
                  VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
      const VkClearDepthStencilValue quarter = { 0.25f, 0 };
      const VkImageSubresourceRange dr = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 };
      CmdClearDepthStencilImage(cmd, depth, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &quarter, 1, &dr);
      l7a_barrier(cmd, depth, VK_IMAGE_ASPECT_DEPTH_BIT, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                  VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
      /* The uniform blocks' buffers, each of its own memory. */
      VkBuffer small, big;
      uint32_t *ws, *wb;
      if (buffer(1024, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &small, (void **)&ws) ||
          buffer(3 * 65536, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &big, (void **)&wb))
         return 1;
      ws[0] = 41;
      wb[1] = 42;
      const VkImageLayout ro = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
      const VkDescriptorImageInfo ii[4] = { { nearest, tex_view, ro }, { VK_NULL_HANDLE, tex_view, ro },
                                            { VK_NULL_HANDLE, depth_view, ro }, { linear, VK_NULL_HANDLE, ro } };
      const VkDescriptorBufferInfo bi[3] = { { small, 0, VK_WHOLE_SIZE }, { big, 0, 65536 }, { out, 0, 64 } };
      const VkWriteDescriptorSet wr[7] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &ii[0] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, .pImageInfo = &ii[1] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 2, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, .pImageInfo = &ii[2] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 3, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLER, .pImageInfo = &ii[3] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 4, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &bi[0] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 5, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &bi[1] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 6, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[2] },
      };
      UpdateDescriptorSets(dev, 7, wr, 0, NULL);
      if (scenario == 32) {
         /* A set of a layout without immutable samplers, its combined image sampler NEAREST, copied over binding 0. */
         const VkDescriptorSetLayoutBinding mb0 = { 0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1,
                                                    VK_SHADER_STAGE_COMPUTE_BIT };
         const VkDescriptorSetLayoutCreateInfo mli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                       .bindingCount = 1, .pBindings = &mb0 };
         VkDescriptorSetLayout mutable_layout;
         CHECK(CreateDescriptorSetLayout(dev, &mli, NULL, &mutable_layout));
         const VkDescriptorPoolSize mps = { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 };
         const VkDescriptorPoolCreateInfo mpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
                                                  .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &mps };
         VkDescriptorPool mpool;
         CHECK(CreateDescriptorPool(dev, &mpi, NULL, &mpool));
         const VkDescriptorSetAllocateInfo mai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                   .descriptorPool = mpool, .descriptorSetCount = 1,
                                                   .pSetLayouts = &mutable_layout };
         VkDescriptorSet from;
         CHECK(AllocateDescriptorSets(dev, &mai, &from));
         const VkWriteDescriptorSet mw = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = from,
                                           .dstBinding = 0, .descriptorCount = 1,
                                           .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
                                           .pImageInfo = &ii[0] };
         const VkCopyDescriptorSet copy = { .sType = VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET, .srcSet = from,
                                            .dstSet = set, .descriptorCount = 1 };
         UpdateDescriptorSets(dev, 1, &mw, 0, NULL);
         UpdateDescriptorSets(dev, 0, NULL, 1, &copy);
      }
   }
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                      NULL);
   for (uint32_t i = 0; i < (scenario == 26 ? 2u : 1u); i++) {
      if (i)
         CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb,
                            0, NULL, 0, NULL);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipelines[i]);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, offset_count, offsets);
      CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 128, push);
      CmdDispatch(cmd, 1, 1, 1);
   }
   return 0;
}

/*
 * VK3 L8a (the track-end review's finding 1: WebGPU copies neither a buffer into itself nor a subresource into itself),
 * wgt_misc's scenarios 30 and 31, into `out` (filled 0xee):
 * 30: buffer copies within one VkDeviceMemory: A [0, 1024) and B [1024, 2048) of one device-local memory, A's [0, 16)
 *     updated to 1, 2, 3, 4 and copied into B, B's copied to `out` [0, 16); A's [256, 272) updated to 5 to 8, copied to
 *     A's [512, 528) (one buffer's disjoint ranges), that to `out` [256, 272); `out`'s own [1024, 1040) updated to 9
 *     to 12 and copied to its [2048, 2064).
 * 31: a 4×4 RGBA8 image (texel i 0xff000000 | i), in GENERAL: its (0, 0) 2×2 copied to (2, 2) and blitted (NEAREST, the
 *     same size) to (2, 0) of the same subresource; the image at [0, 64).
 */
/* VK4 T10, what no dEQP-VK case of the direct set runs. 36: a blue multisampled 4×4 image resolved into slice 1 of a
 * red 3D image. 37: red and blue multisampled images, the blue one's (0, 0) 2×2 copied into the
 * red one's, that copied within the image to (2, 2), and the image resolved. The result's texels at `out`'s start. */
static int
t10_misc(uint32_t scenario, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdResolveImage CmdResolveImage = (PFN_vkCmdResolveImage)GetDeviceProcAddr(dev, "vkCmdResolveImage");
   PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
   const VkImageUsageFlags usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
   const VkImageUsageFlags ms_usage = usage | VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
   const VkImageLayout general = VK_IMAGE_LAYOUT_GENERAL;
   const VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
   const VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   const VkImageSubresourceLayers layer = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
   const VkClearColorValue red = { .float32 = { 1, 0, 0, 1 } }, blue = { .float32 = { 0, 0, 1, 1 } };
   VkImage a, b, c;
   if (misc_image_samples(format, VK_IMAGE_TYPE_2D, 1, ms_usage, VK_SAMPLE_COUNT_4_BIT, &a) ||
       misc_image_samples(format, VK_IMAGE_TYPE_2D, 1, ms_usage, VK_SAMPLE_COUNT_4_BIT, &b) ||
       misc_image(format, scenario == 36 ? VK_IMAGE_TYPE_3D : VK_IMAGE_TYPE_2D, scenario == 36 ? 2 : 1, usage, &c))
      return 1;
   CmdClearColorImage(cmd, a, general, &blue, 1, &all);
   CmdClearColorImage(cmd, b, general, &red, 1, &all);
   CmdClearColorImage(cmd, c, general, &red, 1, &all);
   if (scenario == 36) {
      CmdResolveImage(cmd, a, general, c, general, 1,
                      &(VkImageResolve){ layer, { 0, 0, 0 }, layer, { 0, 0, 1 }, { 4, 4, 1 } });
      CmdCopyImageToBuffer(cmd, c, general, out, 1,
                           &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 2 } });
   } else {
      CmdCopyImage(cmd, a, general, b, general, 1, &(VkImageCopy){ layer, { 0, 0, 0 }, layer, { 0, 0, 0 }, { 2, 2, 1 } });
      CmdCopyImage(cmd, b, general, b, general, 1, &(VkImageCopy){ layer, { 0, 0, 0 }, layer, { 2, 2, 0 }, { 2, 2, 1 } });
      CmdResolveImage(cmd, b, general, c, general, 1,
                      &(VkImageResolve){ layer, { 0, 0, 0 }, layer, { 0, 0, 0 }, { 4, 4, 1 } });
      CmdCopyImageToBuffer(cmd, c, general, out, 1,
                           &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 1 } });
   }
   return 0;
}

static int
l8a_misc(uint32_t scenario, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdCopyBuffer CmdCopyBuffer = (PFN_vkCmdCopyBuffer)GetDeviceProcAddr(dev, "vkCmdCopyBuffer");
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
   PFN_vkCmdBlitImage CmdBlitImage = (PFN_vkCmdBlitImage)GetDeviceProcAddr(dev, "vkCmdBlitImage");
   const VkBufferUsageFlags both = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT };
#define L8A_BARRIER()                                                                                                 \
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &mb, 0, NULL, 0, NULL)
   if (scenario == 30) {
      VkBuffer a, b;
      const VkBufferCreateInfo bi = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = 1024, .usage = both };
      CHECK(CreateBuffer(dev, &bi, NULL, &a));
      CHECK(CreateBuffer(dev, &bi, NULL, &b));
      VkMemoryRequirements req;
      GetBufferMemoryRequirements(dev, a, &req);
      req.size = 4096;
      VkDeviceMemory mem;
      if (memory_for(req, false, &mem, NULL))
         return 1;
      CHECK(BindBufferMemory(dev, a, mem, 0));
      CHECK(BindBufferMemory(dev, b, mem, 1024));
      const uint32_t x[4] = { 1, 2, 3, 4 }, y[4] = { 5, 6, 7, 8 }, z[4] = { 9, 10, 11, 12 };
      CmdUpdateBuffer(cmd, a, 0, 16, x);
      CmdUpdateBuffer(cmd, a, 256, 16, y);
      CmdUpdateBuffer(cmd, out, 1024, 16, z);
      L8A_BARRIER();
      CmdCopyBuffer(cmd, a, b, 1, &(VkBufferCopy){ 0, 0, 16 });
      CmdCopyBuffer(cmd, a, a, 1, &(VkBufferCopy){ 256, 512, 16 });
      CmdCopyBuffer(cmd, out, out, 1, &(VkBufferCopy){ 1024, 2048, 16 });
      L8A_BARRIER();
      CmdCopyBuffer(cmd, b, out, 1, &(VkBufferCopy){ 0, 0, 16 });
      CmdCopyBuffer(cmd, a, out, 1, &(VkBufferCopy){ 512, 256, 16 });
      return 0;
   }
   VkImage img;
   VkBuffer src;
   uint32_t *s;
   if (misc_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_2D, 1,
                  VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, &img) ||
       buffer(64, both, true, &src, (void **)&s))
      return 1;
   for (uint32_t i = 0; i < 16; i++)
      s[i] = 0xff000000u | i;
   const VkImageSubresourceLayers layer = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
   misc_barrier(cmd, img, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
   CmdCopyBufferToImage(cmd, src, img, VK_IMAGE_LAYOUT_GENERAL, 1,
                        &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 1 } });
   misc_barrier(cmd, img, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL);
   const VkImageCopy copy = { .srcSubresource = layer, .dstSubresource = layer, .dstOffset = { 2, 2, 0 },
                              .extent = { 2, 2, 1 } };
   CmdCopyImage(cmd, img, VK_IMAGE_LAYOUT_GENERAL, img, VK_IMAGE_LAYOUT_GENERAL, 1, &copy);
   const VkImageBlit blit = { .srcSubresource = layer, .srcOffsets = { { 0, 0, 0 }, { 2, 2, 1 } },
                              .dstSubresource = layer, .dstOffsets = { { 2, 0, 0 }, { 4, 2, 1 } } };
   CmdBlitImage(cmd, img, VK_IMAGE_LAYOUT_GENERAL, img, VK_IMAGE_LAYOUT_GENERAL, 1, &blit, VK_FILTER_NEAREST);
   misc_barrier(cmd, img, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL);
   CmdCopyImageToBuffer(cmd, img, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                        &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 1 } });
#undef L8A_BARRIER
   return 0;
}

/*
 * VK3 L7a: a graphics pipeline made, not drawn, of `vs` (l7a/fits.vert) and `fs` on a render pass whose subpass reads
 * attachment 1 as its input attachment, the fragment stage's set 0 by `scenario`:
 * 0: 16 combined image samplers (binding 0) and an input attachment (binding 1): l7a/input-many.frag (the binding
 *    review's finding 6). What a test reads is WebGPU's errors (none) and the driver's word on the pipeline.
 */
EXPORT int
wgt_fits(uint32_t scenario, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words)
{
   if (!dev && init())
      return 1;
   VkShaderModule vm, fm;
   if (shader(vs, vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkDescriptorSetLayoutBinding b[2] = {
      { 0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 16, VK_SHADER_STAGE_FRAGMENT_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = scenario == 0 ? 2 : 0, .pBindings = b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkAttachmentDescription atts[2] = {
      { 0, VK_FORMAT_R8G8B8A8_UNORM, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED,
        VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL },
      { 0, VK_FORMAT_R8G8B8A8_UNORM, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
        VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL },
   };
   const VkAttachmentReference cref = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL },
                               iref = { 1, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
                                      .inputAttachmentCount = 1, .pInputAttachments = &iref,
                                      .colorAttachmentCount = 1, .pColorAttachments = &cref };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 2,
                                        .pAttachments = atts, .subpassCount = 1, .pSubpasses = &sub };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm,
        .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
        .module = fm, .pName = "main" },
   };
   const VkPipelineVertexInputStateCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkPipelineViewportStateCreateInfo vp = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
                                                  .viewportCount = 1, .scissorCount = 1 };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkPipelineColorBlendAttachmentState cba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo cb = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &cba };
   const VkDynamicState dyn[2] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
   const VkPipelineDynamicStateCreateInfo ds = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                                                 .dynamicStateCount = 2, .pDynamicStates = dyn };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
      .pVertexInputState = &vi, .pInputAssemblyState = &ia, .pViewportState = &vp, .pRasterizationState = &rs,
      .pMultisampleState = &ms, .pColorBlendState = &cb, .pDynamicState = &ds, .layout = layout, .renderPass = rp,
   };
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   return 0;
}

/*
 * VK3 L8a (the track-end review's finding 3): passes without attachments at the pipeline's rasterizationSamples (4) by
 * dynamic rendering, `vs` and `fs` l8a/samples.*: a triangle over a 4×4 render area whose fragment shader, run per
 * sample, sets its sample's bit and counts itself, into a host-visible buffer (`wgt_misc_map`, 4 KiB, zeroed; when
 * `wgt_misc_done`): 0 drawn in the pass, at [0, 8); 1 drawn by a secondary command buffer whose inheritance says 4
 * samples and no attachments, at [256, 264). Each: 0xf and 64.
 */
EXPORT int
wgt_samples(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words)
{
   if (!dev && init())
      return 1;
   PFN_vkCmdBeginRendering BeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   PFN_vkCmdEndRendering EndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
   PFN_vkCmdExecuteCommands ExecuteCommands = (PFN_vkCmdExecuteCommands)GetDeviceProcAddr(dev, "vkCmdExecuteCommands");
   VkShaderModule vm, fm;
   if (shader(vs, vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   VkBuffer out;
   if (buffer(4096, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &out,
              (void **)&misc.map))
      return 1;
   const VkDescriptorSetLayoutBinding b = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_FRAGMENT_BIT };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 1, .pBindings = &b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 2 };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 2,
                                            .poolSizeCount = 1, .pPoolSizes = &ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetLayout two[2] = { dsl, dsl };
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 2, .pSetLayouts = two };
   VkDescriptorSet sets[2];
   CHECK(AllocateDescriptorSets(dev, &dai, sets));
   const VkDescriptorBufferInfo bi[2] = { { out, 0, 256 }, { out, 256, 256 } };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[0] },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[1], .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[1] },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm,
        .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
        .module = fm, .pName = "main" },
   };
   const VkPipelineVertexInputStateCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport viewport = { 0, 0, 4, 4, 0, 1 };
   const VkRect2D scissor = { { 0, 0 }, { 4, 4 } };
   const VkPipelineViewportStateCreateInfo vp = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
                                                  .viewportCount = 1, .pViewports = &viewport, .scissorCount = 1,
                                                  .pScissors = &scissor };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_4_BIT };
   const VkPipelineRenderingCreateInfo pri = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .pNext = &pri, .stageCount = 2, .pStages = stages,
      .pVertexInputState = &vi, .pInputAssemblyState = &ia, .pViewportState = &vp, .pRasterizationState = &rs,
      .pMultisampleState = &ms, .layout = layout,
   };
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   if (!misc.fence) {
      const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
      CHECK(CreateFence(dev, &fi, NULL, &misc.fence));
   } else {
      CHECK(ResetFences(dev, 1, &misc.fence));
   }
   VkCommandPool pool;
   const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
   CHECK(CreateCommandPool(dev, &cpo, NULL, &pool));
   VkCommandBuffer cmd, second;
   VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
                                       .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &cmd));
   cbi.level = VK_COMMAND_BUFFER_LEVEL_SECONDARY;
   CHECK(AllocateCommandBuffers(dev, &cbi, &second));
   /* The secondary: its pass's attachments none, its samples 4. */
   const VkCommandBufferInheritanceRenderingInfo inr = {
      .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_RENDERING_INFO, .rasterizationSamples = VK_SAMPLE_COUNT_4_BIT };
   const VkCommandBufferInheritanceInfo inh = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO, .pNext = &inr };
   const VkCommandBufferBeginInfo sbegin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                             .flags = VK_COMMAND_BUFFER_USAGE_RENDER_PASS_CONTINUE_BIT,
                                             .pInheritanceInfo = &inh };
   CHECK(BeginCommandBuffer(second, &sbegin));
   CmdBindPipeline(second, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   CmdBindDescriptorSets(second, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[1], 0, NULL);
   CmdDraw(second, 3, 1, 0, 0);
   CHECK(EndCommandBuffer(second));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(cmd, &begin));
   CmdFillBuffer(cmd, out, 0, VK_WHOLE_SIZE, 0);
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                      NULL);
   VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { 4, 4 } },
                          .layerCount = 1 };
   BeginRendering(cmd, &ri);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[0], 0, NULL);
   CmdDraw(cmd, 3, 1, 0, 0);
   EndRendering(cmd);
   ri.flags = VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT;
   BeginRendering(cmd, &ri);
   ExecuteCommands(cmd, 1, &second);
   EndRendering(cmd);
   CHECK(EndCommandBuffer(cmd));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, misc.fence));
   return 0;
}

/*
 * VK4 T4, wgt_misc's scenario 38, `cs` mutable-view.comp: a 4x4 R8G8B8A8_UNORM mutable image of two levels, both cleared
 * in its format (level 0 green, level 1 red); the shader stores 0x04030201 at (1, 1) of level 0 through an R32_UINT
 * storage view and reads level 1 through an R32_UINT sampled view into the buffer's first word; then both levels
 * are copied out in the image's format, at 256 and 512. The store keeps the clear's other texels only if the view's
 * texture took them, and the copy sees the store only if it comes back.
 */
static int
t4_misc(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT,
      .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R8G8B8A8_UNORM, .extent = { 4, 4, 1 }, .mipLevels = 2,
      .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_STORAGE_BIT |
               VK_IMAGE_USAGE_SAMPLED_BIT,
   };
   VkImage img;
   CHECK(CreateImage(dev, &info, NULL, &img));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, img, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, img, mem, 0));
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++) {
      const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img,
                                         .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_R32_UINT,
                                         .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, i, 1, 0, 1 } };
      CHECK(CreateImageView(dev, &vi, NULL, &views[i]));
   }
   const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO };
   VkSampler sampler;
   CHECK(CreateSampler(dev, &si, NULL, &sampler));
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   const VkDescriptorSetLayoutBinding bindings[3] = {
      { 0, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 3, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[3] = { { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1 },
                                        { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 },
                                        { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 3, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorImageInfo stored = { VK_NULL_HANDLE, views[0], VK_IMAGE_LAYOUT_GENERAL },
                               sampled = { sampler, views[1], VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[3] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = &stored },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &sampled },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 2, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 3, wr, 0, NULL);
   const VkImageSubresourceRange level0 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }, level1 = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 1, 0, 1 };
   CmdClearColorImage(cmd, img, VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { 0, 1, 0, 1 } }, 1, &level0);
   CmdClearColorImage(cmd, img, VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { 1, 0, 0, 1 } }, 1, &level1);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   const VkBufferImageCopy down[2] = {
      { .bufferOffset = 256, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 4, 4, 1 } },
      { .bufferOffset = 512, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 0, 1 }, .imageExtent = { 2, 2, 1 } },
   };
   CmdCopyImageToBuffer(cmd, img, VK_IMAGE_LAYOUT_GENERAL, out, 2, down);
   return 0;
}

/*
 * VK4 T24 (maintenance8), wgt_misc's scenario 95, into `out` (filled 0xee): copies between depth or stencil and colour
 * images of their texels' size, and blits between an array's layers and a 3D image's slices.
 * - an R32_SFLOAT 4×4 image of 0.0625·i, its (1, 1) 2×2 copied to (0, 0) of a D32 image cleared to 1.0, whole → [0, 64);
 *   then that D32's (0, 0) 2×2 to (2, 2) of an R32_SFLOAT image cleared to 0, whole → [256, 320);
 * - an R8_UINT 4×4 image of 7i, its (0, 0) 2×2 copied to (2, 2) of an S8 image cleared to 0x33, whole → [512, 528);
 *   then the S8 whole into an R8_UINT image, whole → [768, 784);
 * - a 2×2 RGBA8 array of two layers (red, green) blitted into a 2×2×2 3D image's slices, whole → [1024, 1056); the 3D
 *   image's slices blitted into another array's two layers, whole → [1280, 1312).
 */
static int
t24_image(VkFormat format, VkImageType type, uint32_t w, uint32_t h, uint32_t depth, uint32_t layers, VkImage *out)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = type, .format = format, .extent = { w, h, depth },
      .mipLevels = 1, .arrayLayers = layers, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT |
               ((format == VK_FORMAT_D32_SFLOAT || format == VK_FORMAT_S8_UINT || format == VK_FORMAT_D16_UNORM_S8_UINT)
                   ? VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT
                   : VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT),
   };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   return 0;
}

static void
t24_general(VkCommandBuffer cmd, VkImage image, VkImageAspectFlags aspect, uint32_t layers)
{
   const VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                    .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT,
                                    .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED, .newLayout = VK_IMAGE_LAYOUT_GENERAL,
                                    .image = image, .subresourceRange = { aspect, 0, 1, 0, layers } };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &b);
}

static int
t24_misc(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
      (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
   PFN_vkCmdBlitImage CmdBlitImage = (PFN_vkCmdBlitImage)GetDeviceProcAddr(dev, "vkCmdBlitImage");
   const VkImageLayout G = VK_IMAGE_LAYOUT_GENERAL;
   VkImage r32, d32, r32b, r8, s8, r8b, arr, vol, arr2;
   VkBuffer src;
   uint8_t *sb;
   if (t24_image(VK_FORMAT_R32_SFLOAT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &r32) ||
       t24_image(VK_FORMAT_D32_SFLOAT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &d32) ||
       t24_image(VK_FORMAT_R32_SFLOAT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &r32b) ||
       t24_image(VK_FORMAT_R8_UINT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &r8) ||
       t24_image(VK_FORMAT_S8_UINT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &s8) ||
       t24_image(VK_FORMAT_R8_UINT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &r8b) ||
       t24_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_2D, 2, 2, 1, 2, &arr) ||
       t24_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_3D, 2, 2, 2, 1, &vol) ||
       t24_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_2D, 2, 2, 1, 2, &arr2) ||
       buffer(4096, VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &src, (void **)&sb))
      return 1;
   for (uint32_t i = 0; i < 16; i++) {
      ((float *)sb)[i] = 0.0625f * (float)i;
      sb[256 + i] = (uint8_t)(7 * i);
   }
   const VkImageAspectFlags C = VK_IMAGE_ASPECT_COLOR_BIT, D = VK_IMAGE_ASPECT_DEPTH_BIT, S = VK_IMAGE_ASPECT_STENCIL_BIT;
   t24_general(cmd, r32, C, 1), t24_general(cmd, d32, D, 1), t24_general(cmd, r32b, C, 1);
   t24_general(cmd, r8, C, 1), t24_general(cmd, s8, S, 1), t24_general(cmd, r8b, C, 1);
   t24_general(cmd, arr, C, 2), t24_general(cmd, vol, C, 1), t24_general(cmd, arr2, C, 2);
   const VkImageSubresourceLayers c1 = { C, 0, 0, 1 }, d1 = { D, 0, 0, 1 }, s1 = { S, 0, 0, 1 }, c2 = { C, 0, 0, 2 };

   /* Depth with R32_SFLOAT. */
   CmdCopyBufferToImage(cmd, src, r32, G, 1, &(VkBufferImageCopy){ .imageSubresource = c1, .imageExtent = { 4, 4, 1 } });
   CmdClearDepthStencilImage(cmd, d32, G, &(VkClearDepthStencilValue){ 1.0f, 0 }, 1, &(VkImageSubresourceRange){ D, 0, 1, 0, 1 });
   CmdClearColorImage(cmd, r32b, G, &(VkClearColorValue){ .float32 = { 0 } }, 1, &(VkImageSubresourceRange){ C, 0, 1, 0, 1 });
   CmdCopyImage(cmd, r32, G, d32, G, 1, &(VkImageCopy){ .srcSubresource = c1, .srcOffset = { 1, 1, 0 }, .dstSubresource = d1, .extent = { 2, 2, 1 } });
   CmdCopyImageToBuffer(cmd, d32, G, out, 1, &(VkBufferImageCopy){ .imageSubresource = d1, .imageExtent = { 4, 4, 1 } });
   CmdCopyImage(cmd, d32, G, r32b, G, 1, &(VkImageCopy){ .srcSubresource = d1, .dstSubresource = c1, .dstOffset = { 2, 2, 0 }, .extent = { 2, 2, 1 } });
   CmdCopyImageToBuffer(cmd, r32b, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 256, .imageSubresource = c1, .imageExtent = { 4, 4, 1 } });

   /* Stencil with R8_UINT. */
   CmdCopyBufferToImage(cmd, src, r8, G, 1, &(VkBufferImageCopy){ .bufferOffset = 256, .imageSubresource = c1, .imageExtent = { 4, 4, 1 } });
   CmdClearDepthStencilImage(cmd, s8, G, &(VkClearDepthStencilValue){ 0, 0x33 }, 1, &(VkImageSubresourceRange){ S, 0, 1, 0, 1 });
   CmdCopyImage(cmd, r8, G, s8, G, 1, &(VkImageCopy){ .srcSubresource = c1, .dstSubresource = s1, .dstOffset = { 2, 2, 0 }, .extent = { 2, 2, 1 } });
   CmdCopyImageToBuffer(cmd, s8, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 512, .imageSubresource = s1, .imageExtent = { 4, 4, 1 } });
   CmdCopyImage(cmd, s8, G, r8b, G, 1, &(VkImageCopy){ .srcSubresource = s1, .dstSubresource = c1, .extent = { 4, 4, 1 } });
   CmdCopyImageToBuffer(cmd, r8b, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 768, .imageSubresource = c1, .imageExtent = { 4, 4, 1 } });

   /* An array's layers into a 3D image's slices, and back into another array. */
   CmdClearColorImage(cmd, arr, G, &(VkClearColorValue){ .float32 = { 1, 0, 0, 1 } }, 1, &(VkImageSubresourceRange){ C, 0, 1, 0, 1 });
   CmdClearColorImage(cmd, arr, G, &(VkClearColorValue){ .float32 = { 0, 1, 0, 1 } }, 1, &(VkImageSubresourceRange){ C, 0, 1, 1, 1 });
   CmdBlitImage(cmd, arr, G, vol, G, 1,
                &(VkImageBlit){ .srcSubresource = c2, .srcOffsets = { { 0, 0, 0 }, { 2, 2, 1 } }, .dstSubresource = c1,
                                .dstOffsets = { { 0, 0, 0 }, { 2, 2, 2 } } }, VK_FILTER_NEAREST);
   CmdCopyImageToBuffer(cmd, vol, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 1024, .imageSubresource = c1, .imageExtent = { 2, 2, 2 } });
   CmdBlitImage(cmd, vol, G, arr2, G, 1,
                &(VkImageBlit){ .srcSubresource = c1, .srcOffsets = { { 0, 0, 0 }, { 2, 2, 2 } }, .dstSubresource = c2,
                                .dstOffsets = { { 0, 0, 0 }, { 2, 2, 1 } } }, VK_FILTER_NEAREST);
   CmdCopyImageToBuffer(cmd, arr2, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 1280, .imageSubresource = c2, .imageExtent = { 2, 2, 1 } });
   return 0;
}

/*
 * VK4 T30, wgt_misc's scenario 96, into `out` (filled 0xee): packed formats WebGPU hasn't and D16_UNORM_S8_UINT, their
 * texels uploaded from `src` and read back (the bits kept through their textures' channels).
 * - R4G4 4×1 (bytes 0x12 0x34 0xab 0xf0) → [0, 4); copied into an R8_UNORM image, read back → [256, 260);
 * - A4R4G4B4 4×1 (0x1234 0x5678 0x9abc 0xdef0) → [512, 520); one cleared to (1, 0, 0, 1), 1×1 → [768, 770) (0xff00);
 * - A1B5G5R5 4×1 (0x8001 0x7fff 0x0421 0xffff) → [1024, 1032);
 * - A2R10G10B10_UNORM 2×1 (0xc0100401 0x3ff003ff) → [1280, 1288); one cleared to (1, 0, 0, 1) → [1536, 1540)
 *   (0xfff00000); A2R10G10B10_UINT 2×1 (0x80300c03 0x12345678) → [1792, 1800), then cleared to (204, 102, 716, 2),
 *   1×1 → [1800, 1804); another loaded by a pass cleared to that, its first texel the same by vkCmdClearAttachments →
 *   [1808, 1816) (Dawn cuts rgb10a2uint's clear values to 8 bits: drawn);
 * - D16S8 4×4, depth 0x1001·i, stencil 7i: depth whole → [2048, 2080), stencil whole → [2304, 2320), the depth's (1, 1)
 *   2×2 → [2560, 2568); its (1, 1) 2×2 copied to (0, 0) of another cleared to (1.0, 0x33): depth → [2816, 2848),
 *   stencil → [3072, 3088).
 */
static int
t30_misc(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
      (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
   const VkImageLayout G = VK_IMAGE_LAYOUT_GENERAL;
   VkImage r4g4, r8, argb4, argb4c, a1bgr5, a2u, a2uc, a2i, d16, d16b;
   VkBuffer src;
   uint8_t *sb;
   if (t24_image(VK_FORMAT_R4G4_UNORM_PACK8, VK_IMAGE_TYPE_2D, 4, 1, 1, 1, &r4g4) ||
       t24_image(VK_FORMAT_R8_UNORM, VK_IMAGE_TYPE_2D, 4, 1, 1, 1, &r8) ||
       t24_image(VK_FORMAT_A4R4G4B4_UNORM_PACK16, VK_IMAGE_TYPE_2D, 4, 1, 1, 1, &argb4) ||
       t24_image(VK_FORMAT_A4R4G4B4_UNORM_PACK16, VK_IMAGE_TYPE_2D, 1, 1, 1, 1, &argb4c) ||
       t24_image(VK_FORMAT_A1B5G5R5_UNORM_PACK16_KHR, VK_IMAGE_TYPE_2D, 4, 1, 1, 1, &a1bgr5) ||
       t24_image(VK_FORMAT_A2R10G10B10_UNORM_PACK32, VK_IMAGE_TYPE_2D, 2, 1, 1, 1, &a2u) ||
       t24_image(VK_FORMAT_A2R10G10B10_UNORM_PACK32, VK_IMAGE_TYPE_2D, 1, 1, 1, 1, &a2uc) ||
       t24_image(VK_FORMAT_A2R10G10B10_UINT_PACK32, VK_IMAGE_TYPE_2D, 2, 1, 1, 1, &a2i) ||
       t24_image(VK_FORMAT_D16_UNORM_S8_UINT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &d16) ||
       t24_image(VK_FORMAT_D16_UNORM_S8_UINT, VK_IMAGE_TYPE_2D, 4, 4, 1, 1, &d16b) ||
       buffer(4096, VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &src, (void **)&sb))
      return 1;
   static const uint8_t r4g4_texels[4] = { 0x12, 0x34, 0xab, 0xf0 };
   static const uint16_t argb4_texels[4] = { 0x1234, 0x5678, 0x9abc, 0xdef0 }, a1_texels[4] = { 0x8001, 0x7fff, 0x0421, 0xffff };
   static const uint32_t a2u_texels[2] = { 0xc0100401, 0x3ff003ff }, a2i_texels[2] = { 0x80300c03, 0x12345678 };
   memcpy(sb, r4g4_texels, 4);
   memcpy(sb + 16, argb4_texels, 8);
   memcpy(sb + 32, a1_texels, 8);
   memcpy(sb + 48, a2u_texels, 8);
   memcpy(sb + 64, a2i_texels, 8);
   for (uint32_t i = 0; i < 16; i++) {
      ((uint16_t *)(sb + 512))[i] = (uint16_t)(0x1001 * i);
      sb[768 + i] = (uint8_t)(7 * i);
   }
   const VkImageAspectFlags C = VK_IMAGE_ASPECT_COLOR_BIT, D = VK_IMAGE_ASPECT_DEPTH_BIT, S = VK_IMAGE_ASPECT_STENCIL_BIT;
   const VkImage colours[] = { r4g4, r8, argb4, argb4c, a1bgr5, a2u, a2uc, a2i };
   for (uint32_t i = 0; i < 8; i++)
      t24_general(cmd, colours[i], C, 1);
   t24_general(cmd, d16, D | S, 1), t24_general(cmd, d16b, D | S, 1);
   const VkImageSubresourceLayers c1 = { C, 0, 0, 1 }, d1 = { D, 0, 0, 1 }, s1 = { S, 0, 0, 1 };
#define UP(img, at, w, h)                                                                                             \
   CmdCopyBufferToImage(cmd, src, img, G, 1,                                                                          \
                        &(VkBufferImageCopy){ .bufferOffset = at, .imageSubresource = c1, .imageExtent = { w, h, 1 } })
#define DOWN(img, sub, at, x, y, w, h)                                                                                \
   CmdCopyImageToBuffer(cmd, img, G, out, 1,                                                                          \
                        &(VkBufferImageCopy){ .bufferOffset = at, .imageSubresource = sub, .imageOffset = { x, y, 0 }, \
                                              .imageExtent = { w, h, 1 } })
   const VkClearColorValue red = { .float32 = { 1, 0, 0, 1 } };
   const VkImageSubresourceRange cr = { C, 0, 1, 0, 1 };

   UP(r4g4, 0, 4, 1);
   DOWN(r4g4, c1, 0, 0, 0, 4, 1);
   CmdCopyImage(cmd, r4g4, G, r8, G, 1, &(VkImageCopy){ .srcSubresource = c1, .dstSubresource = c1, .extent = { 4, 1, 1 } });
   DOWN(r8, c1, 256, 0, 0, 4, 1);
   UP(argb4, 16, 4, 1);
   DOWN(argb4, c1, 512, 0, 0, 4, 1);
   CmdClearColorImage(cmd, argb4c, G, &red, 1, &cr);
   DOWN(argb4c, c1, 768, 0, 0, 1, 1);
   UP(a1bgr5, 32, 4, 1);
   DOWN(a1bgr5, c1, 1024, 0, 0, 4, 1);
   UP(a2u, 48, 2, 1);
   DOWN(a2u, c1, 1280, 0, 0, 2, 1);
   CmdClearColorImage(cmd, a2uc, G, &red, 1, &cr);
   DOWN(a2uc, c1, 1536, 0, 0, 1, 1);
   UP(a2i, 64, 2, 1);
   DOWN(a2i, c1, 1792, 0, 0, 2, 1);
   CmdClearColorImage(cmd, a2i, G, &(VkClearColorValue){ .uint32 = { 204, 102, 716, 2 } }, 1, &cr);
   DOWN(a2i, c1, 1800, 0, 0, 1, 1);
   {
      /* A pass loading it cleared to (204, 102, 716, 2), (204, 102, 716, 2) put into its first texel by vkCmdClearAttachments. */
      PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
      PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
      PFN_vkCmdClearAttachments CmdClearAttachments =
         (PFN_vkCmdClearAttachments)GetDeviceProcAddr(dev, "vkCmdClearAttachments");
      VkImage img;
      VkImageView view;
      if (image(VK_FORMAT_A2R10G10B10_UINT_PACK32, 2, 1, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
                C, &img, &view))
         return 1;
      t24_general(cmd, img, C, 1);
      const VkRenderingAttachmentInfo att = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = view, .imageLayout = G,
         .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
         .clearValue = { .color = { .uint32 = { 204, 102, 716, 2 } } },
      };
      const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { 2, 1 } },
                                   .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &att };
      CmdBeginRendering(cmd, &ri);
      CmdClearAttachments(cmd, 1,
                          &(VkClearAttachment){ .aspectMask = C, .colorAttachment = 0,
                                                .clearValue = { .color = { .uint32 = { 204, 102, 716, 2 } } } },
                          1, &(VkClearRect){ .rect = { { 0, 0 }, { 1, 1 } }, .layerCount = 1 });
      CmdEndRendering(cmd);
      DOWN(img, c1, 1808, 0, 0, 2, 1);
   }

   CmdCopyBufferToImage(cmd, src, d16, G, 1, &(VkBufferImageCopy){ .bufferOffset = 512, .imageSubresource = d1, .imageExtent = { 4, 4, 1 } });
   CmdCopyBufferToImage(cmd, src, d16, G, 1, &(VkBufferImageCopy){ .bufferOffset = 768, .imageSubresource = s1, .imageExtent = { 4, 4, 1 } });
   DOWN(d16, d1, 2048, 0, 0, 4, 4);
   DOWN(d16, s1, 2304, 0, 0, 4, 4);
   DOWN(d16, d1, 2560, 1, 1, 2, 2);
   CmdClearDepthStencilImage(cmd, d16b, G, &(VkClearDepthStencilValue){ 1.0f, 0x33 }, 1,
                             &(VkImageSubresourceRange){ D | S, 0, 1, 0, 1 });
   CmdCopyImage(cmd, d16, G, d16b, G, 1,
                &(VkImageCopy){ .srcSubresource = { D | S, 0, 0, 1 }, .srcOffset = { 1, 1, 0 },
                                .dstSubresource = { D | S, 0, 0, 1 }, .extent = { 2, 2, 1 } });
   DOWN(d16b, d1, 2816, 0, 0, 4, 4);
   DOWN(d16b, s1, 3072, 0, 0, 4, 4);
#undef UP
#undef DOWN
   return 0;
}

/* VK4 T31's images: transfers only (scaled formats offer nothing else). */
static int
t31_image(VkFormat format, uint32_t w, VkImage *out)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format, .extent = { w, 1, 1 },
      .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
   };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   return 0;
}

/*
 * VK4 T31, wgt_misc's scenario 97: formats WebGPU has no texture of, in wider textures, keep their texels through
 * copies in and out: RGB8 at a 3-byte offset, copied into B8G8R8_SNORM; RGB16 floats, RGB32 integers; USCALED bytes
 * and their copy into R8G8B8A8_UINT; SSCALED halves; BGRA's SINT; A2B10G10R10_SINT's signed 10 bits; clears of RGB8
 * (alpha dropped), R8_SRGB (0.5 encoded) and a USCALED one (integers, as dEQP-VK clears them: 300 clamped).
 */
static int
t31_misc(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
   const VkImageLayout G = VK_IMAGE_LAYOUT_GENERAL;
   VkImage rgb8, bgr8, rgb16, rgb32, us8, u8, ss16, bgrai, a2i, rgb8c, srgb8, us8c;
   VkBuffer src;
   uint8_t *sb;
   if (t31_image(VK_FORMAT_R8G8B8_UNORM, 4, &rgb8) || t31_image(VK_FORMAT_B8G8R8_SNORM, 4, &bgr8) ||
       t31_image(VK_FORMAT_R16G16B16_SFLOAT, 3, &rgb16) || t31_image(VK_FORMAT_R32G32B32_UINT, 2, &rgb32) ||
       t31_image(VK_FORMAT_R8G8B8A8_USCALED, 2, &us8) || t31_image(VK_FORMAT_R8G8B8A8_UINT, 2, &u8) ||
       t31_image(VK_FORMAT_R16G16_SSCALED, 2, &ss16) || t31_image(VK_FORMAT_B8G8R8A8_SINT, 2, &bgrai) ||
       t31_image(VK_FORMAT_A2B10G10R10_SINT_PACK32, 2, &a2i) || t31_image(VK_FORMAT_R8G8B8_UNORM, 1, &rgb8c) ||
       t31_image(VK_FORMAT_R8_SRGB, 2, &srgb8) || t31_image(VK_FORMAT_R8G8B8A8_USCALED, 1, &us8c) ||
       buffer(4096, VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, true, &src, (void **)&sb))
      return 1;
   for (uint32_t i = 0; i < 12; i++)
      sb[3 + i] = (uint8_t)(0x11 * i + 1);
   static const uint16_t halves[9] = { 0x3c00, 0xc000, 0x3555, 0x7bff, 0x0001, 0x8000, 0x4248, 0x0000, 0xbc00 };
   memcpy(sb + 32, halves, sizeof(halves));
   static const uint32_t words[6] = { 0xdeadbeef, 0x00000001, 0xffffffff, 0x12345678, 0x80000000, 0x7fffffff };
   memcpy(sb + 64, words, sizeof(words));
   static const uint8_t bytes[8] = { 0, 1, 127, 128, 200, 254, 255, 3 };
   memcpy(sb + 96, bytes, 8);
   static const int16_t shorts[4] = { -32768, 32767, -1, 12345 };
   memcpy(sb + 112, shorts, 8);
   static const int8_t sbytes[8] = { -128, 127, -1, 5, 0, -77, 64, -2 };
   memcpy(sb + 128, sbytes, 8);
   /* A2B10G10R10_SINT: R -512, G 511, B -1, A -2; then R 1, G -300, B 0, A 1. */
   const uint32_t a2[2] = { (512u) | (511u << 10) | (1023u << 20) | (2u << 30),
                            1u | ((uint32_t)(-300 & 1023) << 10) | (0u << 20) | (1u << 30) };
   memcpy(sb + 144, a2, 8);
   const VkImageAspectFlags C = VK_IMAGE_ASPECT_COLOR_BIT;
   const VkImage all[] = { rgb8, bgr8, rgb16, rgb32, us8, u8, ss16, bgrai, a2i, rgb8c, srgb8, us8c };
   for (uint32_t i = 0; i < sizeof(all) / sizeof(all[0]); i++)
      t24_general(cmd, all[i], C, 1);
   const VkImageSubresourceLayers c1 = { C, 0, 0, 1 };
   const VkImageSubresourceRange cr = { C, 0, 1, 0, 1 };
#define UP(img, at, w)                                                                                                \
   CmdCopyBufferToImage(cmd, src, img, G, 1,                                                                          \
                        &(VkBufferImageCopy){ .bufferOffset = at, .imageSubresource = c1, .imageExtent = { w, 1, 1 } })
#define DOWN(img, at, w)                                                                                              \
   CmdCopyImageToBuffer(cmd, img, G, out, 1,                                                                          \
                        &(VkBufferImageCopy){ .bufferOffset = at, .imageSubresource = c1, .imageExtent = { w, 1, 1 } })
#define COPY(a, b, w) CmdCopyImage(cmd, a, G, b, G, 1, &(VkImageCopy){ .srcSubresource = c1, .dstSubresource = c1, .extent = { w, 1, 1 } })
   UP(rgb8, 3, 4);
   DOWN(rgb8, 3, 4);
   COPY(rgb8, bgr8, 4);
   DOWN(bgr8, 259, 4);
   UP(rgb16, 32, 3);
   DOWN(rgb16, 512, 3);
   UP(rgb32, 64, 2);
   DOWN(rgb32, 768, 2);
   UP(us8, 96, 2);
   DOWN(us8, 1024, 2);
   COPY(us8, u8, 2);
   DOWN(u8, 1032, 2);
   UP(ss16, 112, 2);
   DOWN(ss16, 1280, 2);
   UP(bgrai, 128, 2);
   DOWN(bgrai, 1536, 2);
   UP(a2i, 144, 2);
   DOWN(a2i, 1792, 2);
   CmdClearColorImage(cmd, rgb8c, G, &(VkClearColorValue){ .float32 = { 1, 0, 0.2f, 0 } }, 1, &cr);
   DOWN(rgb8c, 2048, 1);
   CmdClearColorImage(cmd, srgb8, G, &(VkClearColorValue){ .float32 = { 0.5f, 1, 1, 0 } }, 1, &cr);
   DOWN(srgb8, 2304, 2);
   CmdClearColorImage(cmd, us8c, G, &(VkClearColorValue){ .uint32 = { 3, 300, 0, 7 } }, 1, &cr);
   DOWN(us8c, 2560, 1);
#undef UP
#undef DOWN
#undef COPY
   return 0;
}

/*
 * VK4 T23, wgt_misc's scenario 94, `cs` t23-rgb9e5.comp: a 2x1 R32_UINT image (mutable, as Godot's SDFGI makes them)
 * given two E5B9G9R9 words, (1, 0.5, 0.25) and (3, 2, 0), by a copy from the buffer, then sampled through an
 * E5B9G9R9 view with a linear sampler halfway between them, (2, 1.25, 0.125, 1), and its second texel fetched, into the
 * buffer's first 32 bytes. The view is of the image's own texture, its words decoded in the shader: nothing is copied
 * into a texture of the format.
 */
static int
t23_misc(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT,
      .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R32_UINT, .extent = { 2, 1, 1 }, .mipLevels = 1,
      .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
   };
   VkImage img;
   CHECK(CreateImage(dev, &info, NULL, &img));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, img, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, img, mem, 0));
   const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img,
                                      .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_E5B9G9R9_UFLOAT_PACK32,
                                      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   VkImageView view;
   CHECK(CreateImageView(dev, &vi, NULL, &view));
   const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = VK_FILTER_LINEAR,
                                    .minFilter = VK_FILTER_LINEAR, .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                    .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                    .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE };
   VkSampler sampler;
   CHECK(CreateSampler(dev, &si, NULL, &sampler));
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   const VkDescriptorSetLayoutBinding bindings[2] = {
      { 0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 2, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 },
                                        { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorImageInfo sampled = { sampler, view, VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo bi = { out, 0, 32 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &sampled },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   /* (1, 0.5, 0.25): mantissas 256, 128, 64 at exponent 16 (2^-8); (3, 2, 0): 384, 256, 0 at 17 (2^-7). */
   const uint32_t words[2] = { 256u | 128u << 9 | 64u << 18 | 16u << 27, 384u | 256u << 9 | 17u << 27 };
   CmdUpdateBuffer(cmd, out, 1024, sizeof(words), words);
   const VkMemoryBarrier barrier = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
                                     .srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT,
                                     .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 1, &barrier, 0,
                      NULL, 0, NULL);
   const VkBufferImageCopy up = { .bufferOffset = 1024, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                  .imageExtent = { 2, 1, 1 } };
   CmdCopyBufferToImage(cmd, out, img, VK_IMAGE_LAYOUT_GENERAL, 1, &up);
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 1, &barrier, 0,
                      NULL, 0, NULL);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   return 0;
}

/*
 * VK4 T34, wgt_misc's scenario 101, `cs` t34/mutable.comp: three bindings of mutable descriptors, each first written as
 * another type of its list and then as the one the shader declares (a uniform buffer of (11, 12, 13, 14) at 1024, the
 * output at 0, an R32_UINT image cleared to 77), dispatched writing (o[0], o[1]); a second set copied from the first,
 * its uniform buffer then rewritten at 1280 (21..24), dispatched writing (o[2], o[3]). The device
 * reports `mutableDescriptorType`.
 */
static int
t34_misc(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkEnumeratePhysicalDevices enumerate =
      (PFN_vkEnumeratePhysicalDevices)vkGetInstanceProcAddr(instance, "vkEnumeratePhysicalDevices");
   PFN_vkGetPhysicalDeviceFeatures2 features2 =
      (PFN_vkGetPhysicalDeviceFeatures2)vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceFeatures2");
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   if (enumerate(instance, &n, &pdev) < 0 || n != 1) {
      snprintf(error, sizeof(error), "no physical device");
      return 1;
   }
   VkPhysicalDeviceMutableDescriptorTypeFeaturesEXT mf = {
      .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MUTABLE_DESCRIPTOR_TYPE_FEATURES_EXT };
   VkPhysicalDeviceFeatures2 f = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &mf };
   features2(pdev, &f);
   if (!mf.mutableDescriptorType) {
      snprintf(error, sizeof(error), "mutableDescriptorType isn't reported");
      return 1;
   }
   VkImage img;
   VkImageView view;
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R32_UINT,
      .extent = { 1, 1, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
   };
   CHECK(CreateImage(dev, &info, NULL, &img));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, img, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, img, mem, 0));
   const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img,
                                      .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_R32_UINT,
                                      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CHECK(CreateImageView(dev, &vi, NULL, &view));
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   const VkDescriptorType list[] = { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                     VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE };
   const VkMutableDescriptorTypeListEXT lists[3] = { { 3, list }, { 3, list }, { 3, list } };
   const VkMutableDescriptorTypeCreateInfoEXT mi = { .sType = VK_STRUCTURE_TYPE_MUTABLE_DESCRIPTOR_TYPE_CREATE_INFO_EXT,
                                                     .mutableDescriptorTypeListCount = 3,
                                                     .pMutableDescriptorTypeLists = lists };
   /* Out of binding order, as a program may give them (the lists go by the create info's order). */
   const VkDescriptorSetLayoutBinding bindings[3] = {
      { 2, VK_DESCRIPTOR_TYPE_MUTABLE_EXT, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 0, VK_DESCRIPTOR_TYPE_MUTABLE_EXT, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_MUTABLE_EXT, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .pNext = &mi,
                                                .bindingCount = 3, .pBindings = bindings };
   /* Supported; an array of 200 that may be storage images (past any adapter's storage textures a stage) not, nor 200
    * that may be texel buffers (storage buffers of words) beside 4 storage buffers. */
   PFN_vkGetDescriptorSetLayoutSupport LayoutSupport =
      (PFN_vkGetDescriptorSetLayoutSupport)GetDeviceProcAddr(dev, "vkGetDescriptorSetLayoutSupport");
   VkDescriptorSetLayoutSupport support = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_SUPPORT };
   LayoutSupport(dev, &li, &support);
   const VkDescriptorType images[] = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE };
   const VkDescriptorType texels[] = { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER };
   const VkMutableDescriptorTypeListEXT big_lists[2] = { { 2, images }, { 2, texels } };
   const VkMutableDescriptorTypeCreateInfoEXT big_mi = { .sType = VK_STRUCTURE_TYPE_MUTABLE_DESCRIPTOR_TYPE_CREATE_INFO_EXT,
                                                         .mutableDescriptorTypeListCount = 2,
                                                         .pMutableDescriptorTypeLists = big_lists };
   const VkDescriptorSetLayoutBinding big[2] = {
      { 0, VK_DESCRIPTOR_TYPE_MUTABLE_EXT, 200, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 4, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   VkDescriptorSetLayoutCreateInfo big_li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                              .pNext = &big_mi, .bindingCount = 1, .pBindings = big };
   VkDescriptorSetLayoutSupport big_support = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_SUPPORT };
   LayoutSupport(dev, &big_li, &big_support);
   const VkDescriptorSetLayoutBinding texel_big[2] = {
      { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 4, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_MUTABLE_EXT, 200, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkMutableDescriptorTypeListEXT texel_lists[2] = { { 0, NULL }, { 2, texels } };
   const VkMutableDescriptorTypeCreateInfoEXT texel_mi = { .sType = VK_STRUCTURE_TYPE_MUTABLE_DESCRIPTOR_TYPE_CREATE_INFO_EXT,
                                                           .mutableDescriptorTypeListCount = 2,
                                                           .pMutableDescriptorTypeLists = texel_lists };
   const VkDescriptorSetLayoutCreateInfo texel_li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                      .pNext = &texel_mi, .bindingCount = 2, .pBindings = texel_big };
   VkDescriptorSetLayoutSupport texel_support = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_SUPPORT };
   LayoutSupport(dev, &texel_li, &texel_support);
   if (!support.supported || big_support.supported || texel_support.supported) {
      snprintf(error, sizeof(error), "layout support: %u, of 200 storage images %u, of texel buffers %u",
               support.supported, big_support.supported, texel_support.supported);
      return 1;
   }
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPushConstantRange pr = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 4 };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &pr };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_MUTABLE_EXT, 6 };
   const VkMutableDescriptorTypeCreateInfoEXT pmi = { .sType = VK_STRUCTURE_TYPE_MUTABLE_DESCRIPTOR_TYPE_CREATE_INFO_EXT,
                                                      .mutableDescriptorTypeListCount = 1,
                                                      .pMutableDescriptorTypeLists = lists };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .pNext = &pmi,
                                            .maxSets = 2, .poolSizeCount = 1, .pPoolSizes = &ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetLayout two[2] = { dsl, dsl };
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 2, .pSetLayouts = two };
   VkDescriptorSet sets[2];
   CHECK(AllocateDescriptorSets(dev, &dai, sets));
   const VkDescriptorImageInfo sampled = { VK_NULL_HANDLE, view, VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo ubo = { out, 1024, 16 }, ssbo = { out, 0, 64 }, other = { out, 2048, 16 };
   /* Each binding first as another type (the image where the uniform buffer goes, buffers where the image goes). */
   const VkWriteDescriptorSet before[3] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, .pImageInfo = &sampled },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &other },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 2, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &other },
   };
   UpdateDescriptorSets(dev, 3, before, 0, NULL);
   const VkWriteDescriptorSet wr[3] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &ubo },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &ssbo },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 2, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, .pImageInfo = &sampled },
   };
   UpdateDescriptorSets(dev, 3, wr, 0, NULL);
   const VkCopyDescriptorSet copy = { .sType = VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET, .srcSet = sets[0], .dstSet = sets[1],
                                      .descriptorCount = 3 };
   UpdateDescriptorSets(dev, 0, NULL, 1, &copy);
   const VkDescriptorBufferInfo ubo2 = { out, 1280, 16 };
   const VkWriteDescriptorSet wr2 = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[1], .dstBinding = 0,
                                      .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,
                                      .pBufferInfo = &ubo2 };
   UpdateDescriptorSets(dev, 1, &wr2, 0, NULL);
   const uint32_t words[4] = { 11, 12, 13, 14 }, words2[4] = { 21, 22, 23, 24 };
   CmdUpdateBuffer(cmd, out, 1024, sizeof(words), words);
   CmdUpdateBuffer(cmd, out, 1280, sizeof(words2), words2);
   const VkClearColorValue c77 = { .uint32 = { 77, 0, 0, 0 } };
   const VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, img, VK_IMAGE_LAYOUT_GENERAL, &c77, 1, &all);
   const VkMemoryBarrier barrier = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
                                     .srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT,
                                     .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 1, &barrier, 0,
                      NULL, 0, NULL);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   for (uint32_t i = 0; i < 2; i++) {
      const uint32_t at = 2 * i;
      CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &at);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &sets[i], 0, NULL);
      CmdDispatch(cmd, 1, 1, 1);
   }
   return 0;
}

/*
 * VK4 T11, wgt_misc's scenarios 41 and 42, `cs` t11-rw-view.comp and t11-rw-wide.comp: a 130x4 image of two levels and
 * two layers, R8G8_UNORM or R32G32_SFLOAT, which no adapter's WebGPU loads and stores as a texture. Each texel of the
 * corner of level 1, layer 1 is cleared, then swapped by the shader, twice over (0.2, 0.8 or 0.25, 0.75, then cleared
 * again 0.4, 0.6 or 0.375, 0.625), each time copied out after: to 256, 512, then level 0, layer 1 to 768 (a clear the
 * words mustn't lose), and the size the shader saw to the buffer's start.
 */
static int
t11_misc(uint32_t scenario, const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const VkFormat format = scenario == 42 ? VK_FORMAT_R32G32_SFLOAT : VK_FORMAT_R8G8_UNORM;
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format,
      .extent = { 130, 4, 1 }, .mipLevels = 2, .arrayLayers = 2, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_STORAGE_BIT,
   };
   VkImage img;
   CHECK(CreateImage(dev, &info, NULL, &img));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, img, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, img, mem, 0));
   const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img,
                                      .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = format,
                                      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 1, 1, 1 } };
   VkImageView view;
   CHECK(CreateImageView(dev, &vi, NULL, &view));
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   const VkDescriptorSetLayoutBinding bindings[2] = {
      { 0, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 2, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1 }, { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorImageInfo stored = { VK_NULL_HANDLE, view, VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = &stored },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   const VkImageSubresourceRange level1 = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 1, 1, 1 }, level0 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, 1 };
   const bool wide = scenario == 42;
   const VkClearColorValue a = { .float32 = { wide ? 0.25f : 0.2f, wide ? 0.75f : 0.8f, 0, 0 } },
                           b = { .float32 = { wide ? 0.375f : 0.4f, wide ? 0.625f : 0.6f, 0, 0 } },
                           c = { .float32 = { 1, 0, 0, 0 } };
   CmdClearColorImage(cmd, img, VK_IMAGE_LAYOUT_GENERAL, &c, 1, &level0);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   for (uint32_t i = 0; i < 2; i++) {
      CmdClearColorImage(cmd, img, VK_IMAGE_LAYOUT_GENERAL, i ? &b : &a, 1, &level1);
      CmdDispatch(cmd, 1, 1, 1);
      const VkBufferImageCopy down = { .bufferOffset = 256 + 256 * i, .bufferRowLength = 2,
                                       .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 1, 1 },
                                       .imageExtent = { 2, 2, 1 } };
      CmdCopyImageToBuffer(cmd, img, VK_IMAGE_LAYOUT_GENERAL, out, 1, &down);
   }
   const VkBufferImageCopy whole = { .bufferOffset = 768, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1 },
                                     .imageExtent = { 4, 4, 1 } };
   CmdCopyImageToBuffer(cmd, img, VK_IMAGE_LAYOUT_GENERAL, out, 1, &whole);
   return 0;
}

/* An image of `format` for g4_misc, its memory bound. */
static int
g4_image(VkFormat format, uint32_t size, uint32_t levels, uint32_t layers, VkImageCreateFlags flags, VkImage *img)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = flags, .imageType = VK_IMAGE_TYPE_2D, .format = format,
      .extent = { size, size, 1 }, .mipLevels = levels, .arrayLayers = layers, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_STORAGE_BIT,
   };
   CHECK(CreateImage(dev, &info, NULL, img));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *img, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *img, mem, 0));
   return 0;
}

/*
 * GD G4, wgt_misc's scenario 84, `cs` g4/read-only.comp: ten storage images the stage only reads (bound as textures:
 * past WebGPU's 8 storage textures a stage, the pipeline was refused) beside one it writes. A 4x4 R32_UINT image of two
 * levels and six layers (cube-compatible), level l of layer k cleared to 100 l + k + 1, viewed as level 1 of each
 * layer, level 0 of layer 0, level 1 of layers 2 and 3 as an array and level 1 as a cube; a 2x2 RGBA8 image cleared to
 * (1, 0, 1, 1); a 2x2 R32_UINT image cleared to 7 that the shader stores 1103 into at (1, 0), copied to 256.
 */
static int
g4_misc(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   VkImage a, b, d;
   if (g4_image(VK_FORMAT_R32_UINT, 4, 2, 6, VK_IMAGE_CREATE_CUBE_COMPATIBLE_BIT, &a) ||
       g4_image(VK_FORMAT_R8G8B8A8_UNORM, 2, 1, 1, 0, &b) || g4_image(VK_FORMAT_R32_UINT, 2, 1, 1, 0, &d))
      return 1;
   VkImageView views[11];
   for (uint32_t i = 0; i < 11; i++) {
      const bool level0 = i == 6;
      VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = a,
                                   .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_R32_UINT,
                                   .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, level0 ? 0 : 1, 1, i < 6 ? i : 0, 1 } };
      if (i == 7)
         vi.viewType = VK_IMAGE_VIEW_TYPE_2D_ARRAY, vi.subresourceRange.baseArrayLayer = 2, vi.subresourceRange.layerCount = 2;
      else if (i == 8)
         vi.viewType = VK_IMAGE_VIEW_TYPE_CUBE, vi.subresourceRange.layerCount = 6;
      else if (i == 9)
         vi.image = b, vi.format = VK_FORMAT_R8G8B8A8_UNORM, vi.subresourceRange.baseMipLevel = 0;
      else if (i == 10)
         vi.image = d, vi.subresourceRange.baseMipLevel = 0;
      CHECK(CreateImageView(dev, &vi, NULL, &views[i]));
   }
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   VkDescriptorSetLayoutBinding bindings[12];
   for (uint32_t i = 0; i < 12; i++)
      bindings[i] = (VkDescriptorSetLayoutBinding){ i, i < 11 ? VK_DESCRIPTOR_TYPE_STORAGE_IMAGE : VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                                    1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 12, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 11 }, { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   VkDescriptorImageInfo ii[11];
   for (uint32_t i = 0; i < 11; i++)
      ii[i] = (VkDescriptorImageInfo){ VK_NULL_HANDLE, views[i], VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo bi = { out, 0, 64 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 11,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = ii },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 11, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   for (uint32_t l = 0; l < 2; l++)
      for (uint32_t k = 0; k < 6; k++) {
         const VkImageSubresourceRange r = { VK_IMAGE_ASPECT_COLOR_BIT, l, 1, k, 1 };
         const VkClearColorValue v = { .uint32 = { 100 * l + k + 1 } };
         CmdClearColorImage(cmd, a, VK_IMAGE_LAYOUT_GENERAL, &v, 1, &r);
      }
   const VkImageSubresourceRange whole = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, b, VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { 1, 0, 1, 1 } }, 1, &whole);
   CmdClearColorImage(cmd, d, VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .uint32 = { 7 } }, 1, &whole);
   const VkMemoryBarrier before = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                    .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &before, 0, NULL,
                      0, NULL);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   const VkMemoryBarrier after = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &after, 0, NULL,
                      0, NULL);
   const VkBufferImageCopy down = { .bufferOffset = 256, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                    .imageExtent = { 2, 2, 1 } };
   CmdCopyImageToBuffer(cmd, d, VK_IMAGE_LAYOUT_GENERAL, out, 1, &down);
   return 0;
}

/*
 * GD G4, wgt_misc's scenario 85, `cs` g4/views.comp: a 2x2 RGBA8 image of two layers, layer 1 cleared green, bound by a
 * 2D array view of layer 1 where the shader declares a 2D texture; a 2x2 R16_UINT mutable image cleared to 0x1234,
 * bound by an R4G4B4A4 view (0x44332211 packed: its nibbles 1, 2, 3, 4 of 15). Both fetched into the buffer's first
 * two words. GD G7's scenario 90 (`many`): the first image of three layers, its view two (layers 1 and 2), where the
 * shader declares 2D: the view's base layer, as native drivers read it (the GI demo's SDFGI binds an 8-layer view so).
 */
static int
g4_views(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out, bool many)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   VkImage imgs[2];
   for (uint32_t i = 0; i < 2; i++) {
      const VkImageCreateInfo info = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = i ? VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT : 0,
         .imageType = VK_IMAGE_TYPE_2D, .format = i ? VK_FORMAT_R16_UINT : VK_FORMAT_R8G8B8A8_UNORM,
         .extent = { 2, 2, 1 }, .mipLevels = 1, .arrayLayers = i ? 1 : many ? 3 : 2, .samples = VK_SAMPLE_COUNT_1_BIT,
         .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
      };
      CHECK(CreateImage(dev, &info, NULL, &imgs[i]));
      VkMemoryRequirements req;
      GetImageMemoryRequirements(dev, imgs[i], &req);
      VkDeviceMemory mem;
      if (memory_for(req, false, &mem, NULL))
         return 1;
      CHECK(BindImageMemory(dev, imgs[i], mem, 0));
   }
   const VkImageViewCreateInfo vis[2] = {
      { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = imgs[0], .viewType = VK_IMAGE_VIEW_TYPE_2D_ARRAY,
        .format = VK_FORMAT_R8G8B8A8_UNORM, .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, many ? 2 : 1 } },
      { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = imgs[1], .viewType = VK_IMAGE_VIEW_TYPE_2D,
        .format = VK_FORMAT_R4G4B4A4_UNORM_PACK16, .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } },
   };
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++)
      CHECK(CreateImageView(dev, &vis[i], NULL, &views[i]));
   const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO };
   VkSampler sampler;
   CHECK(CreateSampler(dev, &si, NULL, &sampler));
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   const VkDescriptorSetLayoutBinding bindings[3] = {
      { 0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 3, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 2 },
                                        { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorImageInfo ii[2] = { { sampler, views[0], VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL },
                                         { sampler, views[1], VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL } };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 2,
        .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = ii },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 2, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   const VkImageSubresourceRange layer1 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, 1 }, whole = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, imgs[0], VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { 0, 1, 0, 1 } }, 1, &layer1);
   CmdClearColorImage(cmd, imgs[1], VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .uint32 = { 0x1234 } }, 1, &whole);
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_SHADER_READ_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                      NULL);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   return 0;
}

/*
 * GD G4, wgt_misc's scenarios 86 (`cs` g4/textures-full.comp) and 87 (g4/size-only.comp): a set of 16 sampled images
 * (one 2x2 RGBA8 image cleared green), a sampler, a storage image (a 2x2 R32_UINT image cleared to 42) and the buffer.
 * 86 sums the textures' green and reads the image (16, 42 in the first words); 87 only asks the image's size through a
 * declaration without a format (2: GD G5 keys it by the view's format).
 */
static int
g4_limits(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   VkImage imgs[2];
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++) {
      const VkFormat format = i ? VK_FORMAT_R32_UINT : VK_FORMAT_R8G8B8A8_UNORM;
      const VkImageCreateInfo info = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format,
         .extent = { 2, 2, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
         .tiling = VK_IMAGE_TILING_OPTIMAL,
         .usage = VK_IMAGE_USAGE_TRANSFER_DST_BIT | (i ? VK_IMAGE_USAGE_STORAGE_BIT : VK_IMAGE_USAGE_SAMPLED_BIT),
      };
      CHECK(CreateImage(dev, &info, NULL, &imgs[i]));
      VkMemoryRequirements req;
      GetImageMemoryRequirements(dev, imgs[i], &req);
      VkDeviceMemory mem;
      if (memory_for(req, false, &mem, NULL))
         return 1;
      CHECK(BindImageMemory(dev, imgs[i], mem, 0));
      const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = imgs[i],
                                         .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = format,
                                         .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
      CHECK(CreateImageView(dev, &vi, NULL, &views[i]));
   }
   const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO };
   VkSampler sampler;
   CHECK(CreateSampler(dev, &si, NULL, &sampler));
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   const VkDescriptorSetLayoutBinding bindings[4] = {
      { 0, VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 16, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 16, VK_DESCRIPTOR_TYPE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 17, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 18, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 4, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[4] = { { VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 16 }, { VK_DESCRIPTOR_TYPE_SAMPLER, 1 },
                                        { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1 }, { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 4, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   VkDescriptorImageInfo tex[16];
   for (uint32_t i = 0; i < 16; i++)
      tex[i] = (VkDescriptorImageInfo){ VK_NULL_HANDLE, views[0], VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
   const VkDescriptorImageInfo smp = { sampler, VK_NULL_HANDLE, VK_IMAGE_LAYOUT_UNDEFINED },
                               img = { VK_NULL_HANDLE, views[1], VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[4] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 16,
        .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, .pImageInfo = tex },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 16, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLER, .pImageInfo = &smp },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 17, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = &img },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 18, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 4, wr, 0, NULL);
   const VkImageSubresourceRange whole = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, imgs[0], VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { 0, 1, 0, 1 } }, 1, &whole);
   CmdClearColorImage(cmd, imgs[1], VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .uint32 = { 42 } }, 1, &whole);
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_SHADER_READ_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                      NULL);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   return 0;
}

/*
 * GD G5, wgt_misc's scenario 88, `cs` g5/formatless.comp: three 2x2 storage images the shader declares without a
 * format: RGBA8_UNORM cleared to 0, R8G8_UNORM cleared to 0, R32_SFLOAT cleared to 3. The shader writes (1, 0, 1, 1)
 * at (1, 0) of the first, (0.2, 0.8) at (0, 1) of the second and 2 c + 1 at (1, 1) of the third; each is copied out
 * (256, 512, 768) and the first's width is at the buffer's start. GD G7's scenario 89 (g7/declared.comp, `formats`):
 * the same with formats declared, the second R8_UNORM where the shader declares rgba8.
 */
static int
g5_formatless(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out, const VkFormat formats[3])
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   VkImage imgs[3];
   VkImageView views[3];
   for (uint32_t i = 0; i < 3; i++) {
      if (g4_image(formats[i], 2, 1, 1, 0, &imgs[i]))
         return 1;
      const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = imgs[i],
                                         .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = formats[i],
                                         .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
      CHECK(CreateImageView(dev, &vi, NULL, &views[i]));
   }
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   VkDescriptorSetLayoutBinding bindings[4];
   for (uint32_t i = 0; i < 4; i++)
      bindings[i] = (VkDescriptorSetLayoutBinding){ i, i < 3 ? VK_DESCRIPTOR_TYPE_STORAGE_IMAGE : VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                                    1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = 4, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 3 }, { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   VkDescriptorImageInfo ii[3];
   for (uint32_t i = 0; i < 3; i++)
      ii[i] = (VkDescriptorImageInfo){ VK_NULL_HANDLE, views[i], VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 3,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = ii },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 3, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   const VkImageSubresourceRange whole = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   for (uint32_t i = 0; i < 3; i++)
      CmdClearColorImage(cmd, imgs[i], VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { i == 2 ? 3.0f : 0.0f } },
                         1, &whole);
   const VkMemoryBarrier before = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                    .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &before, 0, NULL,
                      0, NULL);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   const VkMemoryBarrier after = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &after, 0, NULL,
                      0, NULL);
   for (uint32_t i = 0; i < 3; i++) {
      const VkBufferImageCopy down = { .bufferOffset = 256 * (i + 1), .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                       .imageExtent = { 2, 2, 1 } };
      CmdCopyImageToBuffer(cmd, imgs[i], VK_IMAGE_LAYOUT_GENERAL, out, 1, &down);
   }
   return 0;
}

/* VK4 T7: inline uniform blocks (tests/venus/inline.comp): a template update running from one block into the next, then
 * the set copied, the copy dispatched. */
static int
t7_inline(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out, uint32_t second)
{
   PFN_vkCreateDescriptorUpdateTemplate CreateDescriptorUpdateTemplate =
      (PFN_vkCreateDescriptorUpdateTemplate)GetDeviceProcAddr(dev, "vkCreateDescriptorUpdateTemplate");
   PFN_vkUpdateDescriptorSetWithTemplate UpdateDescriptorSetWithTemplate =
      (PFN_vkUpdateDescriptorSetWithTemplate)GetDeviceProcAddr(dev, "vkUpdateDescriptorSetWithTemplate");
   const VkDescriptorSetLayoutBinding bindings[3] = {
      { 0, VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, 16, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, second, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
   };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 3, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkShaderModuleCreateInfo smi = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                          .codeSize = cs_words * 4, .pCode = cs };
   VkShaderModule module;
   CHECK(CreateShaderModule(dev, &smi, NULL, &module));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = module, .pName = "main" },
      .layout = layout };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, 16384 },
                                        { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 2 } };
   const VkDescriptorPoolInlineUniformBlockCreateInfo ipi = {
      .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_INLINE_UNIFORM_BLOCK_CREATE_INFO, .maxInlineUniformBlockBindings = 4 };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .pNext = &ipi,
                                            .maxSets = 2, .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetLayout layouts[2] = { dsl, dsl };
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 2, .pSetLayouts = layouts };
   VkDescriptorSet sets[2];
   CHECK(AllocateDescriptorSets(dev, &dai, sets));
   const VkDescriptorUpdateTemplateEntry entry = { .dstBinding = 0, .descriptorCount = 32,
                                                   .descriptorType = VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, .stride = 1 };
   const VkDescriptorUpdateTemplateCreateInfo ti = {
      .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_UPDATE_TEMPLATE_CREATE_INFO, .descriptorUpdateEntryCount = 1,
      .pDescriptorUpdateEntries = &entry, .templateType = VK_DESCRIPTOR_UPDATE_TEMPLATE_TYPE_DESCRIPTOR_SET,
      .descriptorSetLayout = dsl };
   VkDescriptorUpdateTemplate tmpl;
   CHECK(CreateDescriptorUpdateTemplate(dev, &ti, NULL, &tmpl));
   static const uint32_t bytes[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
   UpdateDescriptorSetWithTemplate(dev, sets[0], tmpl, bytes);
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[1], .dstBinding = 2,
                                     .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                     .pBufferInfo = &bi };
   /* All 32 bytes copied by one copy, across the bindings. */
   const VkCopyDescriptorSet copy = { .sType = VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET, .srcSet = sets[0], .dstSet = sets[1],
                                      .descriptorCount = 32 };
   UpdateDescriptorSets(dev, 1, &wr, 1, &copy);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &sets[1], 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   return 0;
}

/* `cs` dispatched once with one set of `n` bindings, each of `types[k]` and `ranges[k]` (VK4 R2 on). */
static int
dispatch_with(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, uint32_t n, const VkDescriptorType *types,
              const VkDescriptorBufferInfo *ranges)
{
   VkDescriptorSetLayoutBinding b[8];
   VkDescriptorPoolSize ps[8];
   for (uint32_t k = 0; k < n; k++) {
      b[k] = (VkDescriptorSetLayoutBinding){ k, types[k], 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
      ps[k] = (VkDescriptorPoolSize){ types[k], 1 };
   }
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = n, .pBindings = b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule module;
   if (shader(cs, cs_words, &module))
      return 1;
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = module, .pName = "main" } };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = n, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   VkWriteDescriptorSet wr[8];
   for (uint32_t k = 0; k < n; k++)
      wr[k] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = k,
                                      .descriptorCount = 1, .descriptorType = types[k], .pBufferInfo = &ranges[k] };
   UpdateDescriptorSets(dev, n, wr, 0, NULL);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   return 0;
}

/* A 2D image of `layers` with a view of them (its format `view_format`), usable as a colour attachment and a copy's
 * either end (`extra` its other usage: the driver gives every attachment what its copies need, for the crops, and scenario
 * 47 has no transfer usage at all, as a program's attachments). */
static int
layered_image(VkFormat format, VkFormat view_format, uint32_t w, uint32_t h, uint32_t layers, VkImageUsageFlags extra,
              VkImageCreateFlags flags, VkImage *out, VkImageView *view)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = flags, .imageType = VK_IMAGE_TYPE_2D, .format = format,
      .extent = { w, h, 1 }, .mipLevels = 1, .arrayLayers = layers, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | extra,
   };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   const VkImageViewCreateInfo vi = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = *out,
      .viewType = layers > 1 ? VK_IMAGE_VIEW_TYPE_2D_ARRAY : VK_IMAGE_VIEW_TYPE_2D, .format = view_format,
      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, layers } };
   CHECK(CreateImageView(dev, &vi, NULL, view));
   return 0;
}

static void
copy_texel(VkCommandBuffer cmd, VkImage image, VkImageAspectFlags aspect, uint32_t layer, int32_t x, int32_t y, VkBuffer out,
           VkDeviceSize at)
{
   const VkBufferImageCopy r = { .bufferOffset = at, .imageSubresource = { aspect, 0, layer, 1 }, .imageOffset = { x, y, 0 },
                                 .imageExtent = { 1, 1, 1 } };
   CmdCopyImageToBuffer(cmd, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1, &r);
}

/* A 2D image for R4's copies: `layers`, `samples`, of every usage a multisampled one takes. */
static int
copy_image(VkFormat format, uint32_t w, uint32_t h, uint32_t layers, VkSampleCountFlagBits samples, VkImage *out)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format, .extent = { w, h, 1 },
      .mipLevels = 1, .arrayLayers = layers, .samples = samples, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
               VK_IMAGE_USAGE_SAMPLED_BIT };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   return 0;
}

/* VK4 T39 (`out` as wgt_misc's): 111, resolves into RGBA8 images of 8 layers, which SwiftShader's WebGPU leaves short (the
 * last 2 * width - 4 texels of the layer unwritten: `clear_color_image.2d.optimal.multiple_layers.*_sample_count_4`'s
 * failures). A 64x64 image of 4 samples and 8 layers cleared whole to zero, layers 2 to 6 to (0.25, 0.5, 0.75, 1), every
 * layer resolved by one region: texels (5, 5) and (63, 63) of layers 0 to 7 at 0 to 28 and 32 to 60 (zero, zero, the colour
 * five times, zero). Then a pass of a 4-sample attachment cleared to that colour, resolved into a 2D view of layer 3 of
 * another such image: its (63, 63) at 64. */
static int
t39_resolves(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdResolveImage CmdResolveImage = (PFN_vkCmdResolveImage)GetDeviceProcAddr(dev, "vkCmdResolveImage");
   PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
   const uint32_t size = 64, layers = 8;
   VkImage ms, a, pass_ms, b;
   if (copy_image(VK_FORMAT_R8G8B8A8_UNORM, size, size, layers, VK_SAMPLE_COUNT_4_BIT, &ms) ||
       copy_image(VK_FORMAT_R8G8B8A8_UNORM, size, size, layers, VK_SAMPLE_COUNT_1_BIT, &a) ||
       copy_image(VK_FORMAT_R8G8B8A8_UNORM, size, size, 1, VK_SAMPLE_COUNT_4_BIT, &pass_ms) ||
       copy_image(VK_FORMAT_R8G8B8A8_UNORM, size, size, layers, VK_SAMPLE_COUNT_1_BIT, &b))
      return 1;
   const VkClearColorValue zero = { 0 }, v = { .float32 = { 0.25f, 0.5f, 0.75f, 1 } };
   const VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS },
                                 some = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 2, 5 };
   CmdClearColorImage(cmd, ms, VK_IMAGE_LAYOUT_GENERAL, &zero, 1, &all);
   CmdClearColorImage(cmd, ms, VK_IMAGE_LAYOUT_GENERAL, &v, 1, &some);
   const VkImageResolve r = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, layers },
                              .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, layers }, .extent = { size, size, 1 } };
   CmdResolveImage(cmd, ms, VK_IMAGE_LAYOUT_GENERAL, a, VK_IMAGE_LAYOUT_GENERAL, 1, &r);
   for (uint32_t l = 0; l < layers; l++) {
      copy_texel(cmd, a, VK_IMAGE_ASPECT_COLOR_BIT, l, 5, 5, out, l * 4);
      copy_texel(cmd, a, VK_IMAGE_ASPECT_COLOR_BIT, l, size - 1, size - 1, out, 32 + l * 4);
   }
   VkImageView views[2];
   const VkImage of[2] = { pass_ms, b };
   for (uint32_t i = 0; i < 2; i++) {
      const VkImageViewCreateInfo vi = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = of[i], .viewType = VK_IMAGE_VIEW_TYPE_2D,
         .format = VK_FORMAT_R8G8B8A8_UNORM, .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, i ? 3 : 0, 1 } };
      CHECK(CreateImageView(dev, &vi, NULL, &views[i]));
   }
   const VkRenderingAttachmentInfo c = {
      .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = views[0],
      .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .resolveMode = VK_RESOLVE_MODE_AVERAGE_BIT,
      .resolveImageView = views[1], .resolveImageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
      .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE, .clearValue = { .color = v } };
   const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { size, size } },
                                .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &c };
   CmdBeginRendering(cmd, &ri);
   CmdEndRendering(cmd);
   copy_texel(cmd, b, VK_IMAGE_ASPECT_COLOR_BIT, 3, size - 1, size - 1, out, 64);
   return 0;
}

/* VK4 T39 (`out` as wgt_misc's): 112, multisampled copies between layouts the bits shader didn't take apart (a packed
 * format and a plain one, rgb10a2 and another of 4 bytes): 4-sample images cleared, copied into the other format's,
 * resolved (sample 0 of an integer format) and read back. R5G6B5 cleared to red into R16_UINT: 0x00, 0xf8 at 0;
 * A2B10G10R10_UNORM to (1, 0, 0, 1) into R8G8B8A8_UINT: 0xff, 0x03, 0x00, 0xc0 at 4; A2R10G10B10_UNORM (a packed format)
 * to (1, 0, 0, 1) into R16G16_UINT: 0x00, 0x00, 0xf0, 0xff at 8 (red at bit 20); R16_UINT of 0x07ff into R5G6B5
 * (red 0, green 63, blue 31): 0xff, 0x07 at 12. */
static int
t39_ms_bits(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdResolveImage CmdResolveImage = (PFN_vkCmdResolveImage)GetDeviceProcAddr(dev, "vkCmdResolveImage");
   PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
   static const struct { VkFormat from, to; VkClearColorValue v; } pairs[4] = {
      { VK_FORMAT_R5G6B5_UNORM_PACK16, VK_FORMAT_R16_UINT, { .float32 = { 1, 0, 0, 1 } } },
      { VK_FORMAT_A2B10G10R10_UNORM_PACK32, VK_FORMAT_R8G8B8A8_UINT, { .float32 = { 1, 0, 0, 1 } } },
      { VK_FORMAT_A2R10G10B10_UNORM_PACK32, VK_FORMAT_R16G16_UINT, { .float32 = { 1, 0, 0, 1 } } },
      { VK_FORMAT_R16_UINT, VK_FORMAT_R5G6B5_UNORM_PACK16, { .uint32 = { 0x07ff, 0, 0, 1 } } },
   };
   const uint32_t size = 8;
   for (uint32_t i = 0; i < 4; i++) {
      VkImage a, b, c;
      if (copy_image(pairs[i].from, size, size, 1, VK_SAMPLE_COUNT_4_BIT, &a) || copy_image(pairs[i].to, size, size, 1, VK_SAMPLE_COUNT_4_BIT, &b) ||
          copy_image(pairs[i].to, size, size, 1, VK_SAMPLE_COUNT_1_BIT, &c))
         return 1;
      const VkImageSubresourceRange r = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
      CmdClearColorImage(cmd, a, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &pairs[i].v, 1, &r);
      const VkImageCopy copy = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                 .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .extent = { size, size, 1 } };
      CmdCopyImage(cmd, a, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, b, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &copy);
      const VkImageResolve res = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                   .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .extent = { size, size, 1 } };
      CmdResolveImage(cmd, b, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, c, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &res);
      copy_texel(cmd, c, VK_IMAGE_ASPECT_COLOR_BIT, 0, 3, 3, out, i * 4);
   }
   return 0;
}

/* VK4 R4's transfers (`out` as wgt_misc's):
 * 52 (the review's X1): a 10x1 region of an RGBA8 image from [0, 40) (i + 1 a byte) with bufferImageHeight 4, and back
 *    to 64: the bytes.
 * 55 (X4): two layers of 4 samples cleared to A and B, both copied into a second image, each resolved and its
 *    texel at 0, 4: A, B.
 * 56 (X5): 4 samples of RGBA8_SRGB cleared to 0.5 (bytes 188), copied into RGBA8_UNORM, resolved: 188 at 0.
 * 57 (X8): 4 samples of R5G6B5 cleared to red, copied into B5G6R5, resolved: the same bits (0xf800) at 0.
 * 59 (backlog "Copies WebGPU refuses"): 4 samples of RGBA8 cleared to A, copied into R16G16_UINT, resolved: A's bytes at 0.
 * 63, 64 (the review of R1 to R4's D3, W3): two layers of 4 samples of RGBA8_SRGB, R5G6B5, the first cleared and copied
 * to the second within the image, that resolved: 188 a channel, 0xf800 at 0. */
static int
r4_misc(uint32_t scenario, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
   PFN_vkCmdResolveImage CmdResolveImage = (PFN_vkCmdResolveImage)GetDeviceProcAddr(dev, "vkCmdResolveImage");
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   PFN_vkCmdCopyBufferToImage CmdCopyBufferToImage = (PFN_vkCmdCopyBufferToImage)GetDeviceProcAddr(dev, "vkCmdCopyBufferToImage");
   const VkImageLayout src = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, dst = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
   if (scenario == 52) {
      uint8_t bytes[40];
      for (uint32_t i = 0; i < 40; i++)
         bytes[i] = i + 1;
      CmdUpdateBuffer(cmd, out, 0, sizeof(bytes), bytes);
      VkImage image;
      if (copy_image(VK_FORMAT_R8G8B8A8_UNORM, 16, 16, 1, VK_SAMPLE_COUNT_1_BIT, &image))
         return 1;
      VkBufferImageCopy r = { .bufferOffset = 0, .bufferImageHeight = 4, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                              .imageExtent = { 10, 1, 1 } };
      CmdCopyBufferToImage(cmd, out, image, dst, 1, &r);
      r.bufferOffset = 64;
      CmdCopyImageToBuffer(cmd, image, src, out, 1, &r);
      return 0;
   }
   if (scenario == 63 || scenario == 64) {
      const VkFormat f = scenario == 63 ? VK_FORMAT_R8G8B8A8_SRGB : VK_FORMAT_R5G6B5_UNORM_PACK16;
      VkImage a, c;
      if (copy_image(f, 16, 16, 2, VK_SAMPLE_COUNT_4_BIT, &a) || copy_image(f, 16, 16, 1, VK_SAMPLE_COUNT_1_BIT, &c))
         return 1;
      const VkClearColorValue v = { .float32 = { scenario == 63 ? 0.5f : 1, scenario == 63 ? 0.5f : 0, scenario == 63 ? 0.5f : 0, 1 } };
      const VkImageSubresourceRange l0 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
      CmdClearColorImage(cmd, a, dst, &v, 1, &l0);
      const VkImageCopy copy = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                 .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1 }, .extent = { 16, 16, 1 } };
      CmdCopyImage(cmd, a, src, a, dst, 1, &copy);
      const VkImageResolve r = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1 },
                                 .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .extent = { 16, 16, 1 } };
      CmdResolveImage(cmd, a, src, c, dst, 1, &r);
      copy_texel(cmd, c, VK_IMAGE_ASPECT_COLOR_BIT, 0, 8, 8, out, 0);
      return 0;
   }
   const VkFormat from = scenario == 56 ? VK_FORMAT_R8G8B8A8_SRGB : scenario == 57 ? VK_FORMAT_R5G6B5_UNORM_PACK16 : VK_FORMAT_R8G8B8A8_UNORM;
   const VkFormat to = scenario == 56 ? VK_FORMAT_R8G8B8A8_UNORM : scenario == 57 ? VK_FORMAT_B5G6R5_UNORM_PACK16 :
                       scenario == 59 ? VK_FORMAT_R16G16_UINT : from;
   const uint32_t layers = scenario == 55 ? 2 : 1, size = 16;
   VkImage a, b, c;
   if (copy_image(from, size, size, layers, VK_SAMPLE_COUNT_4_BIT, &a) || copy_image(to, size, size, layers, VK_SAMPLE_COUNT_4_BIT, &b) ||
       copy_image(to, size, size, layers, VK_SAMPLE_COUNT_1_BIT, &c))
      return 1;
   const VkClearColorValue first = { .float32 = { scenario == 57 ? 1.0f : 0.5f, scenario == 57 ? 0 : 0.5f, scenario == 57 ? 0 : 0.5f, 1 } };
   const VkClearColorValue second = { .float32 = { 0.25f, 0.5f, 0.75f, 1 } };
   VkImageSubresourceRange range = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, a, dst, &first, 1, &range);
   range.baseArrayLayer = 1;
   if (layers == 2)
      CmdClearColorImage(cmd, a, dst, &second, 1, &range);
   const VkImageCopy copy = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, layers },
                              .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, layers }, .extent = { size, size, 1 } };
   CmdCopyImage(cmd, a, src, b, dst, 1, &copy);
   for (uint32_t l = 0; l < layers; l++) {
      const VkImageResolve r = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, l, 1 },
                                 .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, l, 1 }, .extent = { size, size, 1 } };
      CmdResolveImage(cmd, b, src, c, dst, 1, &r);
      copy_texel(cmd, c, VK_IMAGE_ASPECT_COLOR_BIT, l, 8, 8, out, l * 4);
   }
   return 0;
}

/* 53 (the review's X2): a pass of 4 samples of RGBA8_UNORM images' SRGB views over a part of them, cleared to 0.5 and
 * resolved into the second's: the resolve's a draw (a render area short of the image), in the views' format: 188 at 0. */
static int
r4_resolve(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
   VkImage images[2];
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++) {
      const VkImageCreateInfo info = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT, .imageType = VK_IMAGE_TYPE_2D,
         .format = VK_FORMAT_R8G8B8A8_UNORM, .extent = { 16, 16, 1 }, .mipLevels = 1, .arrayLayers = 1,
         .samples = i ? VK_SAMPLE_COUNT_1_BIT : VK_SAMPLE_COUNT_4_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
         .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
      CHECK(CreateImage(dev, &info, NULL, &images[i]));
      VkMemoryRequirements req;
      GetImageMemoryRequirements(dev, images[i], &req);
      VkDeviceMemory mem;
      if (memory_for(req, false, &mem, NULL))
         return 1;
      CHECK(BindImageMemory(dev, images[i], mem, 0));
      const VkImageViewCreateInfo vi = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = images[i], .viewType = VK_IMAGE_VIEW_TYPE_2D,
         .format = VK_FORMAT_R8G8B8A8_SRGB, .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
      CHECK(CreateImageView(dev, &vi, NULL, &views[i]));
   }
   const VkRenderingAttachmentInfo c = {
      .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = views[0],
      .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .resolveMode = VK_RESOLVE_MODE_AVERAGE_BIT,
      .resolveImageView = views[1], .resolveImageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
      .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
      .clearValue = { .color = { .float32 = { 0.5f, 0.5f, 0.5f, 1 } } } };
   const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { 12, 12 } },
                                .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &c };
   CmdBeginRendering(cmd, &ri);
   CmdEndRendering(cmd);
   copy_texel(cmd, images[1], VK_IMAGE_ASPECT_COLOR_BIT, 0, 6, 6, out, 0);
   return 0;
}

/* VK4 R3's passes (`out` as wgt_misc's):
 * 47 (the review's R2): a 32x32 colour attachment and a 64x64 depth one, its whole cleared to 0.75, the pass's area 32x32
 *    clearing colour to (0.25, 0.5, 0.75, 1) and depth to 0.25: the colour's (16, 16) at 0, depth's (8, 8) at 256 and its
 *    (48, 48), outside the pass's size, at 260.
 * 48 (R6): an image of RGBA8 cleared to that colour, a pass with load and store op NONE on an R32_UINT view of it (a
 *    texture of its own), no draws: the colour at 0.
 * 49 (R7): 40 layers, a layered pass of 40 clearing them to that colour: layers 35 and 39 at 0 and 4. */
static int
r3_misc(uint32_t scenario, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
      (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
   const VkClearValue colour = { .color = { .float32 = { 0.25f, 0.5f, 0.75f, 1 } } };
   const uint32_t layers = scenario == 49 ? 40 : 1, size = 32;
   VkImage target;
   VkImageView view;
   const VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
   if (layered_image(format, scenario == 48 ? VK_FORMAT_R32_UINT : format, size, size, layers, 0,
                     scenario == 48 ? VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT : 0, &target, &view))
      return 1;
   const VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, layers };
   if (scenario == 48)
      CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &colour.color, 1, &all);
   VkImage depth = VK_NULL_HANDLE;
   VkImageView dview = VK_NULL_HANDLE;
   if (scenario == 47) {
      if (image(VK_FORMAT_D32_SFLOAT, 64, 64, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT, VK_IMAGE_ASPECT_DEPTH_BIT, &depth, &dview))
         return 1;
      const VkClearDepthStencilValue v = { 0.75f, 0 };
      const VkImageSubresourceRange r = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 };
      CmdClearDepthStencilImage(cmd, depth, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &v, 1, &r);
   }
   const VkRenderingAttachmentInfo c = {
      .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = view,
      .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
      .loadOp = scenario == 48 ? VK_ATTACHMENT_LOAD_OP_NONE : VK_ATTACHMENT_LOAD_OP_CLEAR,
      .storeOp = scenario == 48 ? VK_ATTACHMENT_STORE_OP_NONE : VK_ATTACHMENT_STORE_OP_STORE, .clearValue = colour };
   const VkRenderingAttachmentInfo d = {
      .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = dview,
      .imageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
      .storeOp = VK_ATTACHMENT_STORE_OP_STORE, .clearValue = { .depthStencil = { 0.25f, 0 } } };
   const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { size, size } },
                                .layerCount = layers, .colorAttachmentCount = 1, .pColorAttachments = &c,
                                .pDepthAttachment = scenario == 47 ? &d : NULL };
   CmdBeginRendering(cmd, &ri);
   CmdEndRendering(cmd);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, scenario == 49 ? 35 : 0, 16, 16, out, 0);
   if (scenario == 49)
      copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 39, 16, 16, out, 4);
   if (scenario == 47) {
      copy_texel(cmd, depth, VK_IMAGE_ASPECT_DEPTH_BIT, 0, 8, 8, out, 256);
      copy_texel(cmd, depth, VK_IMAGE_ASPECT_DEPTH_BIT, 0, 48, 48, out, 260);
   }
   return 0;
}

/* VK4 R3's input attachments (feedback.vert, set by `wgt_misc_vs`, and `cs`: feedback.frag), a draw reading what it
 * writes: 50 (the review's R3): one 128x128 R5G6B5 view, cleared to red, attachment and input: red at 0; 51 (R8): a
 * framebuffer of two layers of RGBA8, layer 0 cleared to one colour and 1 to another, the input a view of layer 1, so the
 * pass's draw copies layer 1 into layer 0: that colour at 0. */
static const uint32_t *feedback_vs;
static uint32_t feedback_vs_words;

EXPORT void
wgt_misc_vs(const uint32_t *vs, uint32_t vs_words)
{
   feedback_vs = vs, feedback_vs_words = vs_words;
}

static int
r3_feedback(uint32_t scenario, const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const bool packed = scenario == 50;
   const VkFormat format = packed ? VK_FORMAT_R5G6B5_UNORM_PACK16 : VK_FORMAT_R8G8B8A8_UNORM;
   const uint32_t size = packed ? 128 : 16, layers = packed ? 1 : 2;
   VkImage target;
   VkImageView att, input;
   if (layered_image(format, format, size, size, layers, VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT, 0, &target, &att))
      return 1;
   const VkImageViewCreateInfo ivi = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = target, .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = format,
      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, packed ? 0 : 1, 1 } };
   CHECK(CreateImageView(dev, &ivi, NULL, &input));
   const VkClearColorValue first = { .float32 = { 1, 0, 0, 1 } }, second = { .float32 = { 0, 1, 0, 1 } };
   const VkImageSubresourceRange l0 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }, l1 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, 1 };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &first, 1, &l0);
   if (!packed)
      CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &second, 1, &l1);
   const VkAttachmentDescription ad[2] = {
      { 0, format, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE, VK_ATTACHMENT_LOAD_OP_DONT_CARE,
        VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL },
      { 0, format, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE, VK_ATTACHMENT_LOAD_OP_DONT_CARE,
        VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL } };
   const VkAttachmentReference cr = { 0, VK_IMAGE_LAYOUT_GENERAL }, ir = { 1, VK_IMAGE_LAYOUT_GENERAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .inputAttachmentCount = 1,
                                      .pInputAttachments = &ir, .colorAttachmentCount = 1, .pColorAttachments = &cr };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 2,
                                        .pAttachments = ad, .subpassCount = 1, .pSubpasses = &sub };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkImageView views[2] = { att, input };
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 2, .pAttachments = views, .width = size, .height = size,
                                         .layers = layers };
   VkFramebuffer fb;
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));
   const VkDescriptorSetLayoutBinding b = { 0, VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 1, .pBindings = &b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 1 };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 1, .pPoolSizes = &ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorImageInfo ii = { VK_NULL_HANDLE, input, VK_IMAGE_LAYOUT_GENERAL };
   const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .descriptorCount = 1,
                                     .descriptorType = VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, .pImageInfo = &ii };
   UpdateDescriptorSets(dev, 1, &wr, 0, NULL);
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &ba };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages, .pVertexInputState = &vis,
      .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs, .pMultisampleState = &ms,
      .pColorBlendState = &bs, .layout = layout, .renderPass = rp };
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
                                       .renderArea = area };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &set, 0, NULL);
   CmdDraw(cmd, 3, 1, 0, 0);
   CmdEndRenderPass(cmd);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, (int32_t)size / 2, (int32_t)size / 2, out, 0);
   return 0;
}

/*
 * VK4 T32, wgt_misc's scenario 98 (`fs`: tests/venus/t32/dst.frag, (192, 64, 128, 255) as bytes): draws reading the
 * attachments they write, in one render pass on an RGBA8 image cleared to (51, 153, 204, 255) and a D32 one cleared to
 * 0.25, each draw in its own 4-texel column: a logic op (XOR), an advanced blend (MULTIPLY), the depth bounds test
 * failing ([0.5, 1]) and passing ([0, 0.5]). Texel (1 + 4i, 8) of each at `out`'s 4i.
 */
static int
t32_misc(const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
      (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
   const uint32_t size = 16;
   VkImage target, depth;
   VkImageView att, dview;
   if (layered_image(VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_UNORM, size, size, 1,
                     VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0, &target, &att))
      return 1;
   const VkImageCreateInfo di = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_D32_SFLOAT,
      .extent = { size, size, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
   CHECK(CreateImage(dev, &di, NULL, &depth));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, depth, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, depth, mem, 0));
   const VkImageViewCreateInfo dvi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = depth,
                                       .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_D32_SFLOAT,
                                       .subresourceRange = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 } };
   CHECK(CreateImageView(dev, &dvi, NULL, &dview));
   const VkClearColorValue c = { .float32 = { 0.2f, 0.6f, 0.8f, 1 } };
   const VkClearDepthStencilValue z = { 0.25f, 0 };
   const VkImageSubresourceRange cr = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }, zr = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &c, 1, &cr);
   CmdClearDepthStencilImage(cmd, depth, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &z, 1, &zr);
   const VkAttachmentDescription ad[2] = {
      { 0, VK_FORMAT_R8G8B8A8_UNORM, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL },
      { 0, VK_FORMAT_D32_SFLOAT, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL } };
   const VkAttachmentReference cref = { 0, VK_IMAGE_LAYOUT_GENERAL }, zref = { 1, VK_IMAGE_LAYOUT_GENERAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
                                      .pColorAttachments = &cref, .pDepthStencilAttachment = &zref };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 2,
                                        .pAttachments = ad, .subpassCount = 1, .pSubpasses = &sub };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkImageView views[2] = { att, dview };
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 2, .pAttachments = views, .width = size, .height = size,
                                         .layers = 1 };
   VkFramebuffer fb;
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkDynamicState dyns[1] = { VK_DYNAMIC_STATE_SCISSOR };
   const VkPipelineDynamicStateCreateInfo dy = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                                                 .dynamicStateCount = 1, .pDynamicStates = dyns };
   VkPipeline p[4];
   for (uint32_t i = 0; i < 4; i++) {
      const VkPipelineColorBlendAttachmentState ba = {
         .blendEnable = i == 1, .colorBlendOp = i == 1 ? VK_BLEND_OP_MULTIPLY_EXT : VK_BLEND_OP_ADD,
         .alphaBlendOp = i == 1 ? VK_BLEND_OP_MULTIPLY_EXT : VK_BLEND_OP_ADD, .colorWriteMask = 0xf };
      const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                       .logicOpEnable = i == 0, .logicOp = VK_LOGIC_OP_XOR,
                                                       .attachmentCount = 1, .pAttachments = &ba };
      const VkPipelineDepthStencilStateCreateInfo ds = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO,
                                                         .depthBoundsTestEnable = i >= 2,
                                                         .minDepthBounds = i == 2 ? 0.5f : 0, .maxDepthBounds = i == 2 ? 1 : 0.5f };
      const VkGraphicsPipelineCreateInfo gpi = {
         .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages, .pVertexInputState = &vis,
         .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs, .pMultisampleState = &ms,
         .pDepthStencilState = &ds, .pColorBlendState = &bs, .pDynamicState = &dy, .layout = layout, .renderPass = rp };
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p[i]));
   }
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
                                       .renderArea = area };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   for (uint32_t i = 0; i < 4; i++) {
      const VkRect2D column = { { (int32_t)(4 * i), 0 }, { 4, size } };
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p[i]);
      CmdSetScissor(cmd, 0, 1, &column);
      CmdDraw(cmd, 3, 1, 0, 0);
   }
   CmdEndRenderPass(cmd);
   for (uint32_t i = 0; i < 4; i++)
      copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, (int32_t)(1 + 4 * i), 8, out, 4 * i);
   return 0;
}

/*
 * The review of VK4 T41 to T43 (finding 1), wgt_misc's scenario 117 (`fs`: tests/venus/t43/wrapped.frag, reading
 * gl_FrontFacing): draws whose fragment stage the driver wraps (wg_shader.c `post_text`: a depth bias on D24, which
 * WebGPU's can't give), in one render pass on an RGBA8 image cleared to (51, 153, 204, 255) and a D24S8 one cleared to
 * 0.25, each in its own 4-texel column, front-facing: the bias alone, and with the depth bounds test passing ([0, 0.5],
 * the attachments' reads' `dst_text` wrapped too). Texel (1 + 4i, 8) of each at `out`'s 4i: the stage's colour.
 */
static int
t43_wrapped(const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
      (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
   const uint32_t size = 16;
   const VkFormat zf = VK_FORMAT_D24_UNORM_S8_UINT;
   const VkImageAspectFlags za = VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT;
   VkImage target, depth;
   VkImageView att, dview;
   if (layered_image(VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_UNORM, size, size, 1,
                     VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0, &target, &att))
      return 1;
   const VkImageCreateInfo di = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = zf,
      .extent = { size, size, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
   CHECK(CreateImage(dev, &di, NULL, &depth));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, depth, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, depth, mem, 0));
   const VkImageViewCreateInfo dvi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = depth,
                                       .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = zf,
                                       .subresourceRange = { za, 0, 1, 0, 1 } };
   CHECK(CreateImageView(dev, &dvi, NULL, &dview));
   const VkClearColorValue c = { .float32 = { 0.2f, 0.6f, 0.8f, 1 } };
   const VkClearDepthStencilValue z = { 0.25f, 0 };
   const VkImageSubresourceRange cr = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }, zr = { za, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &c, 1, &cr);
   CmdClearDepthStencilImage(cmd, depth, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &z, 1, &zr);
   const VkAttachmentDescription ad[2] = {
      { 0, VK_FORMAT_R8G8B8A8_UNORM, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL },
      { 0, zf, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL } };
   const VkAttachmentReference cref = { 0, VK_IMAGE_LAYOUT_GENERAL }, zref = { 1, VK_IMAGE_LAYOUT_GENERAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
                                      .pColorAttachments = &cref, .pDepthStencilAttachment = &zref };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 2,
                                        .pAttachments = ad, .subpassCount = 1, .pSubpasses = &sub };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkImageView views[2] = { att, dview };
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 2, .pAttachments = views, .width = size, .height = size,
                                         .layers = 1 };
   VkFramebuffer fb;
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   /* feedback.vert's triangle, clockwise in the framebuffer: front-facing so. */
   const VkPipelineRasterizationStateCreateInfo rs = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, .polygonMode = VK_POLYGON_MODE_FILL,
      .frontFace = VK_FRONT_FACE_CLOCKWISE, .depthBiasEnable = VK_TRUE, .depthBiasConstantFactor = 1, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkDynamicState dyns[1] = { VK_DYNAMIC_STATE_SCISSOR };
   const VkPipelineDynamicStateCreateInfo dy = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                                                 .dynamicStateCount = 1, .pDynamicStates = dyns };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &ba };
   VkPipeline p[2];
   for (uint32_t i = 0; i < 2; i++) {
      const VkPipelineDepthStencilStateCreateInfo ds = {
         .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO, .depthTestEnable = VK_TRUE,
         .depthWriteEnable = VK_TRUE, .depthCompareOp = VK_COMPARE_OP_ALWAYS, .depthBoundsTestEnable = i == 1,
         .minDepthBounds = 0, .maxDepthBounds = 0.5f };
      const VkGraphicsPipelineCreateInfo gpi = {
         .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages, .pVertexInputState = &vis,
         .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs, .pMultisampleState = &ms,
         .pDepthStencilState = &ds, .pColorBlendState = &bs, .pDynamicState = &dy, .layout = layout, .renderPass = rp };
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p[i]));
   }
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
                                       .renderArea = area };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   for (uint32_t i = 0; i < 2; i++) {
      const VkRect2D column = { { (int32_t)(4 * i), 0 }, { 4, size } };
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p[i]);
      CmdSetScissor(cmd, 0, 1, &column);
      CmdDraw(cmd, 3, 1, 0, 0);
   }
   CmdEndRenderPass(cmd);
   for (uint32_t i = 0; i < 2; i++)
      copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, (int32_t)(1 + 4 * i), 8, out, 4 * i);
   return 0;
}

/* A 4x4 2D image of `samples` and its view, for t43_mapped. */
static int
t43_image(VkFormat format, VkSampleCountFlagBits samples, VkImageUsageFlags usage, VkImageAspectFlags aspect, VkImage *out,
          VkImageView *view)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format, .extent = { 4, 4, 1 },
      .mipLevels = 1, .arrayLayers = 1, .samples = samples, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = usage | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = *out,
                                      .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = format,
                                      .subresourceRange = { aspect, 0, 1, 0, 1 } };
   CHECK(CreateImageView(dev, &vi, NULL, view));
   return 0;
}

/*
 * The review of VK4 T41 to T43: draws through a map of their outputs' locations (VK_KHR_dynamic_rendering_local_read,
 * the pipeline's VkRenderingAttachmentLocationInfo), dynamic rendering on 4x4 RGBA8 attachments cleared to zeros.
 * Scenario 118 (finding 8; `fs`: tests/venus/t43/a2c-mapped.frag): at 4 samples, resolved into single-sampled images,
 * alpha to coverage and alpha to one with locations 0 and 1 swapped: location 0's alpha (0.25) covers one sample of each
 * attachment, its red at alpha 1. Texel (1, 1) of attachments 0 and 1's resolves at `out`'s 0 and 4.
 * Scenario 119 (finding 9; `fs`: tests/venus/t43/dual-mapped.frag, dual-source): one sample, one attachment at no
 * location (WebGPU's dual-source blending takes one target alone, so no other map is drawn), with a D24S8 attachment
 * cleared to 0.25 and a depth bias of 1 (the fragment stage's: D24). The stage's text can't be printed for the map
 * (`mapped_text`), so the draw is refused: the colour as cleared at `out`'s 0, the depth's word at 4.
 */
static int
t43_mapped(uint32_t scenario, const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
   const bool ms = scenario == 118;
   const VkSampleCountFlagBits samples = ms ? VK_SAMPLE_COUNT_4_BIT : VK_SAMPLE_COUNT_1_BIT;
   const VkFormat cf = VK_FORMAT_R8G8B8A8_UNORM, zf = VK_FORMAT_D24_UNORM_S8_UINT;
   const VkImageAspectFlags za = VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT;
   const uint32_t atts = ms ? 2 : 1;
   VkImage color[2], resolve[2], depth;
   VkImageView cview[2], rview[2], dview;
   for (uint32_t i = 0; i < atts; i++)
      if (t43_image(cf, samples, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, VK_IMAGE_ASPECT_COLOR_BIT, &color[i], &cview[i]))
         return 1;
   for (uint32_t i = 0; ms && i < 2; i++)
      if (t43_image(cf, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, VK_IMAGE_ASPECT_COLOR_BIT, &resolve[i],
                    &rview[i]))
         return 1;
   if (!ms && t43_image(zf, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT, za, &depth, &dview))
      return 1;
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport vp = { 0, 0, 4, 4, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { 4, 4 } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, .polygonMode = VK_POLYGON_MODE_FILL,
      .depthBiasEnable = !ms, .depthBiasConstantFactor = 1, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo mss = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, .rasterizationSamples = samples,
      .alphaToCoverageEnable = ms, .alphaToOneEnable = ms };
   const VkPipelineDepthStencilStateCreateInfo ds = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO, .depthTestEnable = VK_TRUE,
      .depthWriteEnable = VK_TRUE, .depthCompareOp = VK_COMPARE_OP_ALWAYS };
   /* Dual source: the first colour plus the destination times the second (zeros). */
   const VkPipelineColorBlendAttachmentState ba[2] = {
      { .blendEnable = !ms, .srcColorBlendFactor = VK_BLEND_FACTOR_ONE, .dstColorBlendFactor = VK_BLEND_FACTOR_SRC1_COLOR,
        .srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE, .dstAlphaBlendFactor = VK_BLEND_FACTOR_SRC1_ALPHA, .colorWriteMask = 0xf },
      { .blendEnable = !ms, .srcColorBlendFactor = VK_BLEND_FACTOR_ONE, .dstColorBlendFactor = VK_BLEND_FACTOR_SRC1_COLOR,
        .srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE, .dstAlphaBlendFactor = VK_BLEND_FACTOR_SRC1_ALPHA, .colorWriteMask = 0xf } };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = atts, .pAttachments = ba };
   const VkFormat formats[2] = { cf, cf };
   static const uint32_t swapped[2] = { 1, 0 }, unused[1] = { VK_ATTACHMENT_UNUSED };
   const VkRenderingAttachmentLocationInfo loc = { .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_LOCATION_INFO,
                                                   .colorAttachmentCount = atts,
                                                   .pColorAttachmentLocations = ms ? swapped : unused };
   const VkPipelineRenderingCreateInfo pri = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO, .pNext = &loc,
                                               .colorAttachmentCount = atts, .pColorAttachmentFormats = formats,
                                               .depthAttachmentFormat = ms ? VK_FORMAT_UNDEFINED : zf,
                                               .stencilAttachmentFormat = ms ? VK_FORMAT_UNDEFINED : zf };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .pNext = &pri, .stageCount = 2, .pStages = stages,
      .pVertexInputState = &vis, .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs,
      .pMultisampleState = &mss, .pDepthStencilState = &ds, .pColorBlendState = &bs, .layout = layout };
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   VkRenderingAttachmentInfo att[2];
   for (uint32_t i = 0; i < atts; i++)
      att[i] = (VkRenderingAttachmentInfo){
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = cview[i],
         .imageLayout = VK_IMAGE_LAYOUT_GENERAL, .resolveMode = ms ? VK_RESOLVE_MODE_AVERAGE_BIT : VK_RESOLVE_MODE_NONE,
         .resolveImageView = ms ? rview[i] : VK_NULL_HANDLE, .resolveImageLayout = VK_IMAGE_LAYOUT_GENERAL,
         .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE };
   const VkRenderingAttachmentInfo zatt = {
      .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = dview, .imageLayout = VK_IMAGE_LAYOUT_GENERAL,
      .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
      .clearValue = { .depthStencil = { 0.25f, 0 } } };
   const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = area, .layerCount = 1,
                                .colorAttachmentCount = atts, .pColorAttachments = att,
                                .pDepthAttachment = ms ? NULL : &zatt, .pStencilAttachment = ms ? NULL : &zatt };
   CmdBeginRendering(cmd, &ri);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   CmdDraw(cmd, 3, 1, 0, 0);
   CmdEndRendering(cmd);
   if (ms) {
      for (uint32_t i = 0; i < 2; i++)
         copy_texel(cmd, resolve[i], VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, out, 4 * i);
   } else {
      copy_texel(cmd, color[0], VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, out, 0);
      copy_texel(cmd, depth, VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 1, out, 4);
   }
   return 0;
}

/*
 * The review of VK4 T41 to T43 (findings 2 and 4), wgt_misc's scenario 122 (`feedback_vs`: tests/venus/t43/layer.vert,
 * gl_Layer = 1; `fs`: tests/venus/t43/layered.frag): draws in layer 1 of a layered pass (a framebuffer of two layers of
 * a 16x16 RGBA8 image, layer 0 cleared to (51, 153, 204, 255), layer 1 to (204, 102, 51, 255), the colour attachment
 * also the subpass's input), each in its own 4-texel column: a logic op (XOR: what it reads, a copy of the attachment,
 * of layer 1), an indexed triangle fan (drawn through indices of its own, OP_PROVOKE), a triangle inside an occlusion
 * query (its samples are layer 1's), and the input attachment read (as BGRA: layer 1's). Texel (1 + 4i, 8) of layer 1
 * at `out`'s 4i, of layer 0 (as cleared) at 16 + 4i; the query's count at 64.
 */
static int
t43_layered(const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const uint32_t size = 16;
   const VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
   VkImage target;
   VkImageView att;
   if (layered_image(format, format, size, size, 2,
                     VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
                     0, &target, &att))
      return 1;
   const VkQueryPoolCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                      .queryType = VK_QUERY_TYPE_OCCLUSION, .queryCount = 1 };
   VkQueryPool qp;
   CHECK(CreateQueryPool(dev, &qi, NULL, &qp));
   CmdResetQueryPool(cmd, qp, 0, 1);
   const VkClearColorValue first = { .float32 = { 0.2f, 0.6f, 0.8f, 1 } }, second = { .float32 = { 0.8f, 0.4f, 0.2f, 1 } };
   const VkImageSubresourceRange l0 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }, l1 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, 1 };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &first, 1, &l0);
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &second, 1, &l1);
   const VkAttachmentDescription ad = { 0, format, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
                                        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL,
                                        VK_IMAGE_LAYOUT_GENERAL };
   const VkAttachmentReference ref = { 0, VK_IMAGE_LAYOUT_GENERAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .inputAttachmentCount = 1,
                                      .pInputAttachments = &ref, .colorAttachmentCount = 1, .pColorAttachments = &ref };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 1,
                                        .pAttachments = &ad, .subpassCount = 1, .pSubpasses = &sub };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 1, .pAttachments = &att, .width = size, .height = size,
                                         .layers = 2 };
   VkFramebuffer fb;
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));
   const VkDescriptorSetLayoutBinding b = { 0, VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 1, .pBindings = &b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 1 };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 1, .pPoolSizes = &ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorImageInfo ii = { VK_NULL_HANDLE, att, VK_IMAGE_LAYOUT_GENERAL };
   const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .descriptorCount = 1,
                                     .descriptorType = VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, .pImageInfo = &ii };
   UpdateDescriptorSets(dev, 1, &wr, 0, NULL);
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkDynamicState dyns[1] = { VK_DYNAMIC_STATE_SCISSOR };
   const VkPipelineDynamicStateCreateInfo dy = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                                                 .dynamicStateCount = 1, .pDynamicStates = dyns };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   VkPipeline p[4];
   for (uint32_t i = 0; i < 4; i++) {
      const int32_t read = i == 3;
      const VkSpecializationMapEntry me = { 0, 0, 4 };
      const VkSpecializationInfo si = { 1, &me, 4, &read };
      const VkPipelineShaderStageCreateInfo stages[2] = {
         { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
         { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm,
           .pName = "main", .pSpecializationInfo = &si } };
      const VkPipelineInputAssemblyStateCreateInfo ia = {
         .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
         .topology = i == 1 ? VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
      const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                       .logicOpEnable = i == 0, .logicOp = VK_LOGIC_OP_XOR,
                                                       .attachmentCount = 1, .pAttachments = &ba };
      const VkGraphicsPipelineCreateInfo gpi = {
         .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages, .pVertexInputState = &vis,
         .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs, .pMultisampleState = &ms,
         .pColorBlendState = &bs, .pDynamicState = &dy, .layout = layout, .renderPass = rp };
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p[i]));
   }
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
                                       .renderArea = area };
   VkBuffer ib;
   uint16_t *indices;
   if (buffer(8, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &ib, (void **)&indices))
      return 1;
   for (uint16_t i = 0; i < 4; i++)
      indices[i] = i;
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &set, 0, NULL);
   CmdBindIndexBuffer(cmd, ib, 0, VK_INDEX_TYPE_UINT16);
   for (uint32_t i = 0; i < 4; i++) {
      const VkRect2D column = { { (int32_t)(4 * i), 0 }, { 4, size } };
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p[i]);
      CmdSetScissor(cmd, 0, 1, &column);
      if (i == 2)
         CmdBeginQuery(cmd, qp, 0, 0);
      if (i == 1)
         CmdDrawIndexed(cmd, 4, 1, 0, 0, 0);
      else
         CmdDraw(cmd, 3, 1, 0, 0);
      if (i == 2)
         CmdEndQuery(cmd, qp, 0);
   }
   CmdEndRenderPass(cmd);
   for (uint32_t i = 0; i < 4; i++) {
      copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 1, (int32_t)(1 + 4 * i), 8, out, 4 * i);
      copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, (int32_t)(1 + 4 * i), 8, out, 16 + 4 * i);
   }
   CmdCopyQueryPoolResults(cmd, qp, 0, 1, out, 64, 4, VK_QUERY_RESULT_WAIT_BIT);
   return 0;
}

/*
 * The review of VK4 T41 to T43 (finding 3), wgt_misc's scenario 123 (`feedback_vs`: tests/venus/t43/points.vert, gl_Layer
 * = 0; `fs`: tests/venus/t43/points.frag): 1000 draws of a point each, at the texel of its first vertex, its colour the
 * draw's number pushed (at 124: past the immediates, in the push buffer), in a layered pass of 6 layers of a 32x32 RGBA8
 * image cleared to zeros. Each draw writes gl_Layer, so it is replayed in each layer, a place of the push buffer each
 * time: 6000, past the buffer's 4096 unless the submit reserves them. Layer 0 at `out`'s 0: draw i's
 * (i & 255, i >> 8, 0, 255) at texel i, zeros past 1000.
 */
static int
t43_push_layers(const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const uint32_t size = 32, layers = 6, draws = 1000;
   const VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
   VkImage target;
   VkImageView att;
   if (layered_image(format, format, size, size, layers, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0,
                     &target, &att))
      return 1;
   const VkClearColorValue zero = { .float32 = { 0, 0, 0, 0 } };
   const VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, layers };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &zero, 1, &all);
   const VkAttachmentDescription ad = { 0, format, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
                                        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL,
                                        VK_IMAGE_LAYOUT_GENERAL };
   const VkAttachmentReference ref = { 0, VK_IMAGE_LAYOUT_GENERAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
                                      .pColorAttachments = &ref };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 1,
                                        .pAttachments = &ad, .subpassCount = 1, .pSubpasses = &sub };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 1, .pAttachments = &att, .width = size, .height = size,
                                         .layers = layers };
   VkFramebuffer fb;
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));
   const VkPushConstantRange range = { VK_SHADER_STAGE_VERTEX_BIT, 0, 128 };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .pushConstantRangeCount = 1, .pPushConstantRanges = &range };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_POINT_LIST };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &ba };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages, .pVertexInputState = &vis,
      .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs, .pMultisampleState = &ms,
      .pColorBlendState = &bs, .layout = layout, .renderPass = rp };
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
                                       .renderArea = area };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   uint32_t push[32] = { 0 };
   for (uint32_t i = 0; i < draws; i++) {
      push[31] = i;
      CmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(push), push);
      CmdDraw(cmd, 1, 1, i, 0);
   }
   CmdEndRenderPass(cmd);
   const VkBufferImageCopy r = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { size, size, 1 } };
   CmdCopyImageToBuffer(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1, &r);
   return 0;
}

/*
 * VK4 T44's warm-up (docs/backlog.md "Rendering", the review of T41 to T43), wgt_misc's scenario 124 (`feedback_vs`:
 * tests/venus/t44/fan.vert; `fs`: tests/venus/t44/fan-past.frag): two triangle fans in one pass of a 16x16 RGBA8 image
 * cleared to zeros, each through indices of their own. The first, vkCmdDrawIndirect of the left half's quad, binds a
 * 4100x4096 RG32_SFLOAT storage image the stage reaches as words (135 MB: past the test device's
 * maxStorageBufferBindingSize, 128 MiB), so it is refused (`words_past`); the second, an indexed fan of the right half's
 * quad (OP_PROVOKE), binds a 4x4 one and is drawn. Texel (4, 8) at `out`'s 0 (zeros), (12, 8) at 4 ((192, 64, 128, 255)).
 */
static int t37_image(VkImageType type, VkFormat format, VkExtent3D extent, uint32_t layers, VkImageUsageFlags usage,
                     VkImageCreateFlags flags, VkImage *out);
static int t37_view(VkImage image, VkImageViewType type, VkFormat format, uint32_t layer, uint32_t layers, VkImageView *out);

static int
t44_fan_past(const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdDrawIndirect CmdDrawIndirect = (PFN_vkCmdDrawIndirect)GetDeviceProcAddr(dev, "vkCmdDrawIndirect");
   const uint32_t size = 16;
   const VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
   VkImage target;
   VkImageView att;
   if (layered_image(format, format, size, size, 1, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0,
                     &target, &att))
      return 1;
   const VkClearColorValue zero = { .float32 = { 0, 0, 0, 0 } };
   const VkImageSubresourceRange whole = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &zero, 1, &whole);
   VkImage imgs[2];
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++)
      if (t37_image(VK_IMAGE_TYPE_2D, VK_FORMAT_R32G32_SFLOAT, i ? (VkExtent3D){ 4, 4, 1 } : (VkExtent3D){ 4100, 4096, 1 },
                    1, VK_IMAGE_USAGE_STORAGE_BIT, 0, &imgs[i]) ||
          t37_view(imgs[i], VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R32G32_SFLOAT, 0, 1, &views[i]))
         return 1;
   const VkAttachmentDescription ad = { 0, format, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD, VK_ATTACHMENT_STORE_OP_STORE,
                                        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_GENERAL,
                                        VK_IMAGE_LAYOUT_GENERAL };
   const VkAttachmentReference ref = { 0, VK_IMAGE_LAYOUT_GENERAL };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
                                      .pColorAttachments = &ref };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 1,
                                        .pAttachments = &ad, .subpassCount = 1, .pSubpasses = &sub };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 1, .pAttachments = &att, .width = size, .height = size,
                                         .layers = 1 };
   VkFramebuffer fb;
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));
   const VkDescriptorSetLayoutBinding b = { 0, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 1, .pBindings = &b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 2 };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 2,
                                            .poolSizeCount = 1, .pPoolSizes = &ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetLayout dsls[2] = { dsl, dsl };
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 2, .pSetLayouts = dsls };
   VkDescriptorSet sets[2];
   CHECK(AllocateDescriptorSets(dev, &dai, sets));
   for (uint32_t i = 0; i < 2; i++) {
      const VkDescriptorImageInfo ii = { VK_NULL_HANDLE, views[i], VK_IMAGE_LAYOUT_GENERAL };
      const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[i],
                                        .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,
                                        .pImageInfo = &ii };
      UpdateDescriptorSets(dev, 1, &wr, 0, NULL);
   }
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_FAN };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &ba };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages, .pVertexInputState = &vis,
      .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs, .pMultisampleState = &ms,
      .pColorBlendState = &bs, .layout = layout, .renderPass = rp };
   VkPipeline pipe;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &pipe));
   VkBuffer ib, args;
   uint16_t *indices;
   uint32_t *a;
   if (buffer(8, VK_BUFFER_USAGE_INDEX_BUFFER_BIT, true, &ib, (void **)&indices) ||
       buffer(16, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, true, &args, (void **)&a))
      return 1;
   for (uint16_t i = 0; i < 4; i++)
      indices[i] = 4 + i;
   memcpy(a, (const uint32_t[]){ 4, 1, 0, 0 }, 16);
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
                                       .renderArea = area };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
   CmdBindIndexBuffer(cmd, ib, 0, VK_INDEX_TYPE_UINT16);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[0], 0, NULL);
   CmdDrawIndirect(cmd, args, 0, 1, 16);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[1], 0, NULL);
   CmdDrawIndexed(cmd, 4, 1, 0, 0, 0);
   CmdEndRenderPass(cmd);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 4, 8, out, 0);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 12, 8, out, 4);
   return 0;
}

/*
 * VK4 T32, wgt_misc's scenario 99 (`fs`: tests/venus/t32/loop.frag): a feedback loop
 * (VK_EXT_attachment_feedback_loop_layout). An RGBA8 image of two layers, layer 0 cleared to (51, 102, 153, 255) and 1
 * to green, layer 0 the pass's attachment and the draw's sampled view both layers: the left half adds 64 to red of the
 * texel it writes, the right half writes layer 1's. A second draw after a barrier (a feedback loop's self-dependency)
 * on the left quarter adds again. Texels (2, 8), (6, 8) and (10, 8) at `out`'s 0, 4 and 8.
 */
static int
t32_loop(const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const uint32_t size = 16;
   VkImage target;
   VkImageView sampled, att;
   if (layered_image(VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8B8A8_UNORM, size, size, 2,
                     VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                        VK_IMAGE_USAGE_ATTACHMENT_FEEDBACK_LOOP_BIT_EXT,
                     0, &target, &sampled))
      return 1;
   const VkImageViewCreateInfo avi = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = target, .viewType = VK_IMAGE_VIEW_TYPE_2D,
      .format = VK_FORMAT_R8G8B8A8_UNORM, .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CHECK(CreateImageView(dev, &avi, NULL, &att));
   const VkClearColorValue first = { .float32 = { 0.2f, 0.4f, 0.6f, 1 } }, second = { .float32 = { 0, 1, 0, 1 } };
   const VkImageSubresourceRange l0 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }, l1 = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, 1 };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &first, 1, &l0);
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &second, 1, &l1);
   const VkImageLayout loop = VK_IMAGE_LAYOUT_ATTACHMENT_FEEDBACK_LOOP_OPTIMAL_EXT;
   const VkAttachmentDescription ad = { 0, VK_FORMAT_R8G8B8A8_UNORM, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_LOAD,
                                        VK_ATTACHMENT_STORE_OP_STORE, VK_ATTACHMENT_LOAD_OP_DONT_CARE,
                                        VK_ATTACHMENT_STORE_OP_DONT_CARE, loop, loop };
   const VkAttachmentReference cr = { 0, loop };
   const VkSubpassDescription sub = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
                                      .pColorAttachments = &cr };
   const VkSubpassDependency self = { 0, 0, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
                                      VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT,
                                      VK_DEPENDENCY_BY_REGION_BIT | VK_DEPENDENCY_FEEDBACK_LOOP_BIT_EXT };
   const VkRenderPassCreateInfo rpi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 1,
                                        .pAttachments = &ad, .subpassCount = 1, .pSubpasses = &sub,
                                        .dependencyCount = 1, .pDependencies = &self };
   VkRenderPass rp;
   CHECK(CreateRenderPass(dev, &rpi, NULL, &rp));
   const VkFramebufferCreateInfo fbi = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp,
                                         .attachmentCount = 1, .pAttachments = &att, .width = size, .height = size,
                                         .layers = 1 };
   VkFramebuffer fb;
   CHECK(CreateFramebuffer(dev, &fbi, NULL, &fb));
   const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO };
   VkSampler sampler;
   CHECK(CreateSampler(dev, &si, NULL, &sampler));
   const VkDescriptorSetLayoutBinding b = { 0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 1, .pBindings = &b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 1, .pPoolSizes = &ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorImageInfo ii = { sampler, sampled, loop };
   const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .descriptorCount = 1,
                                     .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &ii };
   UpdateDescriptorSets(dev, 1, &wr, 0, NULL);
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &ba };
   const VkDynamicState dyns[1] = { VK_DYNAMIC_STATE_SCISSOR };
   const VkPipelineDynamicStateCreateInfo dy = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                                                 .dynamicStateCount = 1, .pDynamicStates = dyns };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .flags = VK_PIPELINE_CREATE_COLOR_ATTACHMENT_FEEDBACK_LOOP_BIT_EXT,
      .stageCount = 2, .pStages = stages, .pVertexInputState = &vis, .pInputAssemblyState = &ia, .pViewportState = &vs,
      .pRasterizationState = &rs, .pMultisampleState = &ms, .pColorBlendState = &bs, .pDynamicState = &dy,
      .layout = layout, .renderPass = rp };
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   const VkRenderPassBeginInfo rbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
                                       .renderArea = area };
   CmdBeginRenderPass(cmd, &rbi, VK_SUBPASS_CONTENTS_INLINE);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &set, 0, NULL);
   CmdSetScissor(cmd, 0, 1, &area);
   CmdDraw(cmd, 3, 1, 0, 0);
   const VkImageMemoryBarrier ib = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                     .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
                                     .dstAccessMask = VK_ACCESS_SHADER_READ_BIT, .oldLayout = loop, .newLayout = loop,
                                     .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
                                     .image = target, .subresourceRange = l0 };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
                      VK_DEPENDENCY_BY_REGION_BIT | VK_DEPENDENCY_FEEDBACK_LOOP_BIT_EXT, 0, NULL, 0, NULL, 1, &ib);
   const VkRect2D quarter = { { 0, 0 }, { 4, size } };
   CmdSetScissor(cmd, 0, 1, &quarter);
   CmdDraw(cmd, 3, 1, 0, 0);
   CmdEndRenderPass(cmd);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 2, 8, out, 0);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 6, 8, out, 4);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 10, 8, out, 8);
   return 0;
}

/*
 * VK4 T32, wgt_misc's scenario 100 (`fs`: tests/venus/t32/dst.frag, (192, 64, 128, 255)): rendering a single-sampled
 * attachment at 4 samples (VK_EXT_multisampled_render_to_single_sampled), dynamic rendering. An RGBA8 image cleared to
 * (0, 0, 128, 255), loaded; a full-screen draw whose sample mask is 0b0011 writes 2 of the 4 samples, so the resolve
 * averages the colour and the load's: (96, 32, 128, 255). Texel (3, 3) at `out`'s 0.
 */
static int
t32_ms(const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdBeginRendering BeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   PFN_vkCmdEndRendering EndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
   const uint32_t size = 8;
   VkImage target;
   VkImageView att;
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = VK_IMAGE_CREATE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_BIT_EXT,
      .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R8G8B8A8_UNORM, .extent = { size, size, 1 }, .mipLevels = 1,
      .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
   CHECK(CreateImage(dev, &info, NULL, &target));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, target, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, target, mem, 0));
   const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = target,
                                      .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_R8G8B8A8_UNORM,
                                      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CHECK(CreateImageView(dev, &vi, NULL, &att));
   const VkClearColorValue blue = { .float32 = { 0, 0, 128.0f / 255, 1 } };
   const VkImageSubresourceRange cr = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, target, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &blue, 1, &cr);
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stages[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport vp = { 0, 0, (float)size, (float)size, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { size, size } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkSampleMask mask = 0x3;
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_4_BIT, .pSampleMask = &mask };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &ba };
   const VkFormat cf = VK_FORMAT_R8G8B8A8_UNORM;
   const VkPipelineRenderingCreateInfo pri = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO,
                                               .colorAttachmentCount = 1, .pColorAttachmentFormats = &cf };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .pNext = &pri, .stageCount = 2, .pStages = stages,
      .pVertexInputState = &vis, .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs,
      .pMultisampleState = &ms, .pColorBlendState = &bs, .layout = layout };
   VkPipeline p;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   const VkMultisampledRenderToSingleSampledInfoEXT mrtss = {
      .sType = VK_STRUCTURE_TYPE_MULTISAMPLED_RENDER_TO_SINGLE_SAMPLED_INFO_EXT,
      .multisampledRenderToSingleSampledEnable = VK_TRUE, .rasterizationSamples = VK_SAMPLE_COUNT_4_BIT };
   const VkRenderingAttachmentInfo ca = { .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = att,
                                          .imageLayout = VK_IMAGE_LAYOUT_GENERAL, .loadOp = VK_ATTACHMENT_LOAD_OP_LOAD,
                                          .storeOp = VK_ATTACHMENT_STORE_OP_STORE };
   const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .pNext = &mrtss, .renderArea = area,
                                .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &ca };
   BeginRendering(cmd, &ri);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   CmdDraw(cmd, 3, 1, 0, 0);
   EndRendering(cmd);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 3, 3, out, 0);
   return 0;
}

/* A 2D image of a sampling scenario: every layer and level in GENERAL, its depth cleared to 0.25 or its colour to `c`. */
static int
r5_image(VkCommandBuffer cmd, VkFormat format, uint32_t size, uint32_t layers, uint32_t levels, const VkClearColorValue *c,
         VkImage *out, VkImageView *view, VkImageViewType type)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
      (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
   const VkImageAspectFlags aspect = format == VK_FORMAT_D32_SFLOAT ? VK_IMAGE_ASPECT_DEPTH_BIT : VK_IMAGE_ASPECT_COLOR_BIT;
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = layers == 6 ? VK_IMAGE_CREATE_CUBE_COMPATIBLE_BIT : 0,
      .imageType = VK_IMAGE_TYPE_2D, .format = format, .extent = { size, size, 1 }, .mipLevels = levels,
      .arrayLayers = layers, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   const VkImageSubresourceRange range = { aspect, 0, levels, 0, layers };
   const VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .newLayout = VK_IMAGE_LAYOUT_GENERAL,
                                    .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT, .image = *out, .subresourceRange = range };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &b);
   if (aspect == VK_IMAGE_ASPECT_DEPTH_BIT)
      CmdClearDepthStencilImage(cmd, *out, VK_IMAGE_LAYOUT_GENERAL, &(VkClearDepthStencilValue){ .depth = 0.25f }, 1, &range);
   else
      CmdClearColorImage(cmd, *out, VK_IMAGE_LAYOUT_GENERAL, c, 1, &range);
   const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = *out, .viewType = type,
                                      .format = format, .subresourceRange = range };
   CHECK(CreateImageView(dev, &vi, NULL, view));
   return 0;
}

/* VK4 R5: sampling, the review's C findings, drawn: a 4×4 RGBA8 target by dynamic rendering, cleared to 0x11, with
 * feedback_vs and `fs` (tests/venus/r5/) on set 0: images at 0 and 1, samplers at 2 and 3; texel (1, 1) at `out`'s 0.
 * 70 (C1): an RGBA8 red image, a stage writing depth without an attachment for it: drawn with a clamp-to-edge sampler,
 * then a clamp-to-border one: its white.
 * 71 (C2): D32 at 0.25 at binding 0, a 2×2 image of columns 255 and 0 at 1; a comparison sampler (GREATER) at 2, a linear
 * one at 3: 255, 64, 64 and 128 (the columns filtered).
 * 72 (C3): R32_UINT at 0, the 2×2 image at 1, the linear sampler at 3: 0, 128, 0, 255.
 * 73 (C5): a cube of D32 of 3 levels at 0; comparison samplers GREATER at 2 and LESS at 3 (the vertex stage's size through
 * the one at 3): 255, 0, 4, 255.
 * 74 (C6): as 73: refused, so not drawn: the clear.
 * 75 (C7): depth-eight.frag, every colour location and depth, no attachment for depth: red.
 * 78 (VK4 R7): r7/sixteen.vert with 16 vertex bindings of a float each, 1/16 at every vertex: 255, 128, 64, 255.
 * The review of R5 to R7:
 * 79 (B1, B5): as 78, then one binding pulled for its stride, then that binding not pulled, then in a new pass the same:
 * as 78, the vertex buffers past WebGPU's never set.
 * 80 (B2): cube-plain.frag on a cube of D32 of one level: 255, 64, 0, 255.
 * 81 (B6): r7/vs-compare.*, the depth image of 71: 255, 64, 0, 255.
 * 82 (B4): r7/four-sets.frag with 73's vertex inputs: four groups taken, the bindings past WebGPU's pulled in group 3
 *    (VK4 T44; refused before, not drawn): as 78.
 * 83 (C2): a block of BC1_RGB's transparent texels blitted: 0, 0, 0, 255. */
static int
r5_misc(uint32_t scenario, const uint32_t *fs, uint32_t fs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdBeginRendering BeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
   PFN_vkCmdEndRendering EndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
   const VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
   VkImage target, i0, i1;
   VkImageView tv, v0, v1;
   const VkImageCreateInfo tinfo = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format, .extent = { 4, 4, 1 },
      .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
      .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
   CHECK(CreateImage(dev, &tinfo, NULL, &target));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, target, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, target, mem, 0));
   const VkImageViewCreateInfo tvi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = target,
                                       .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = format,
                                       .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CHECK(CreateImageView(dev, &tvi, NULL, &tv));
   const VkClearColorValue red = { .float32 = { 1, 0, 0, 1 } }, none = { 0 };
   if (scenario == 83) {
      const VkImageCreateInfo bi = { .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D,
                                     .format = VK_FORMAT_BC1_RGB_UNORM_BLOCK, .extent = { 4, 4, 1 }, .mipLevels = 1, .arrayLayers = 1,
                                     .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
                                     .usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT };
      VkImage bc;
      CHECK(CreateImage(dev, &bi, NULL, &bc));
      GetImageMemoryRequirements(dev, bc, &req);
      if (memory_for(req, false, &mem, NULL))
         return 1;
      CHECK(BindImageMemory(dev, bc, mem, 0));
      VkBuffer block;
      uint32_t *w;
      if (buffer(8, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, true, &block, (void **)&w))
         return 1;
      w[0] = 0xffff0000u, w[1] = 0xffffffffu; /* color0 <= color1, every index 3: BC1's transparent black */
      const VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
      const VkImageMemoryBarrier b[2] = {
         { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .newLayout = VK_IMAGE_LAYOUT_GENERAL, .image = bc, .subresourceRange = all },
         { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .newLayout = VK_IMAGE_LAYOUT_GENERAL, .image = target, .subresourceRange = all } };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 2, b);
      CmdCopyBufferToImage(cmd, block, bc, VK_IMAGE_LAYOUT_GENERAL, 1,
                           &(VkBufferImageCopy){ .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 4, 4, 1 } });
      const VkImageBlit blit = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .srcOffsets = { { 0, 0, 0 }, { 4, 4, 1 } },
                                 .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .dstOffsets = { { 0, 0, 0 }, { 4, 4, 1 } } };
      ((PFN_vkCmdBlitImage)GetDeviceProcAddr(dev, "vkCmdBlitImage"))(cmd, bc, VK_IMAGE_LAYOUT_GENERAL, target, VK_IMAGE_LAYOUT_GENERAL, 1, &blit, VK_FILTER_NEAREST);
      const VkImageMemoryBarrier s = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                       .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT, .oldLayout = VK_IMAGE_LAYOUT_GENERAL,
                                       .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, .image = target, .subresourceRange = all };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &s);
      copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, out, 0);
      return 0;
   }
   const bool cube = scenario == 73 || scenario == 74 || scenario == 80;
   const bool sixteen = scenario == 78 || scenario == 79 || scenario == 82;
   int bad;
   if (cube)
      bad = r5_image(cmd, VK_FORMAT_D32_SFLOAT, 4, 6, scenario == 80 ? 1 : 3, NULL, &i0, &v0, VK_IMAGE_VIEW_TYPE_CUBE);
   else if (scenario == 70 || scenario == 75 || sixteen || scenario == 83)
      bad = r5_image(cmd, format, 4, 1, 1, &red, &i0, &v0, VK_IMAGE_VIEW_TYPE_2D);
   else if (scenario == 71 || scenario == 81)
      bad = r5_image(cmd, VK_FORMAT_D32_SFLOAT, 4, 1, 1, NULL, &i0, &v0, VK_IMAGE_VIEW_TYPE_2D);
   else
      bad = r5_image(cmd, VK_FORMAT_R32_UINT, 4, 1, 1, &none, &i0, &v0, VK_IMAGE_VIEW_TYPE_2D);
   if (bad || r5_image(cmd, format, 2, 1, 1, &none, &i1, &v1, VK_IMAGE_VIEW_TYPE_2D))
      return 1;
   VkBuffer texels;
   uint32_t *tm;
   if (buffer(16, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, true, &texels, (void **)&tm))
      return 1;
   tm[0] = tm[2] = 0xffffffffu, tm[1] = tm[3] = 0;
   CmdCopyBufferToImage(cmd, texels, i1, VK_IMAGE_LAYOUT_GENERAL, 1,
                        &(VkBufferImageCopy){ .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 2, 2, 1 } });
   VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO,
                              .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                              .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                              .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .maxLod = 1000 };
   VkSampler s[3];
   CHECK(CreateSampler(dev, &si, NULL, &s[0]));
   si.addressModeU = si.addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_BORDER;
   si.borderColor = VK_BORDER_COLOR_FLOAT_OPAQUE_WHITE;
   if (scenario == 70) {
      CHECK(CreateSampler(dev, &si, NULL, &s[1]));
   } else if (cube) {
      si.addressModeU = si.addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
      si.compareEnable = VK_TRUE;
      si.compareOp = VK_COMPARE_OP_LESS;
      if (scenario == 80)
         si.compareEnable = VK_FALSE;
      CHECK(CreateSampler(dev, &si, NULL, &s[1]));
      si.compareEnable = VK_TRUE;
      si.compareOp = VK_COMPARE_OP_GREATER;
      CHECK(CreateSampler(dev, &si, NULL, &s[0]));
   } else {
      si.addressModeU = si.addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
      si.minFilter = si.magFilter = VK_FILTER_LINEAR;
      CHECK(CreateSampler(dev, &si, NULL, &s[1]));
      si.compareEnable = VK_TRUE;
      si.compareOp = VK_COMPARE_OP_GREATER;
      CHECK(CreateSampler(dev, &si, NULL, &s[0]));
   }
   const VkShaderStageFlags stages = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT;
   const VkDescriptorSetLayoutBinding b[4] = { { 0, VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1, stages, NULL },
                                               { 1, VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1, stages, NULL },
                                               { 2, VK_DESCRIPTOR_TYPE_SAMPLER, 1, stages, NULL },
                                               { 3, VK_DESCRIPTOR_TYPE_SAMPLER, 1, stages, NULL } };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 4, .pBindings = b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkDescriptorSetLayout layouts[2] = { dsl, dsl };
   const VkDescriptorSetLayout four[4] = { dsl, dsl, dsl, dsl };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = scenario == 82 ? 4 : 1,
                                            .pSetLayouts = four };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 4 }, { VK_DESCRIPTOR_TYPE_SAMPLER, 4 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 2,
                                            .poolSizeCount = 2, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dp,
                                             .descriptorSetCount = 2, .pSetLayouts = layouts };
   VkDescriptorSet sets[2];
   CHECK(AllocateDescriptorSets(dev, &dai, sets));
   for (uint32_t k = 0; k < 2; k++) {
      /* 70's second set has the border's sampler where its shader looks: binding 2. */
      const VkDescriptorImageInfo images[4] = { { .imageView = v0, .imageLayout = VK_IMAGE_LAYOUT_GENERAL },
                                                { .imageView = v1, .imageLayout = VK_IMAGE_LAYOUT_GENERAL },
                                                { .sampler = s[k && scenario == 70 ? 1 : 0] }, { .sampler = s[1 - (scenario == 70)] } };
      VkWriteDescriptorSet w[4];
      for (uint32_t i = 0; i < 4; i++)
         w[i] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[k], .dstBinding = i,
                                        .descriptorCount = 1, .descriptorType = b[i].descriptorType, .pImageInfo = &images[i] };
      UpdateDescriptorSets(dev, 4, w, 0, NULL);
   }
   VkShaderModule vm, fm;
   if (shader(feedback_vs, feedback_vs_words, &vm) || shader(fs, fs_words, &fm))
      return 1;
   const VkPipelineShaderStageCreateInfo stage[2] = {
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vm, .pName = "main" },
      { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fm, .pName = "main" } };
   VkVertexInputBindingDescription vib[16];
   VkVertexInputAttributeDescription via[16];
   VkBuffer vbufs[16];
   const VkDeviceSize voffs[16] = { 0 };
   for (uint32_t i = 0; sixteen && i < 16; i++) {
      vib[i] = (VkVertexInputBindingDescription){ i, 4, VK_VERTEX_INPUT_RATE_VERTEX };
      via[i] = (VkVertexInputAttributeDescription){ i, i, VK_FORMAT_R32_SFLOAT, 0 };
      float *v;
      if (buffer(16, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, true, &vbufs[i], (void **)&v))
         return 1;
      v[0] = v[1] = v[2] = 1 / 16.0f;
   }
   const VkPipelineVertexInputStateCreateInfo vis = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
                                                      .vertexBindingDescriptionCount = sixteen ? 16 : 0, .pVertexBindingDescriptions = vib,
                                                      .vertexAttributeDescriptionCount = sixteen ? 16 : 0, .pVertexAttributeDescriptions = via };
   const VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                                       .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkViewport vp = { 0, 0, 4, 4, 0, 1 };
   const VkRect2D area = { { 0, 0 }, { 4, 4 } };
   const VkPipelineViewportStateCreateInfo vs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                                  .pViewports = &vp, .scissorCount = 1, .pScissors = &area };
   const VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                                       .polygonMode = VK_POLYGON_MODE_FILL, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkPipelineColorBlendAttachmentState ba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo bs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                    .attachmentCount = 1, .pAttachments = &ba };
   const VkPipelineRenderingCreateInfo pri = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO, .colorAttachmentCount = 1,
                                               .pColorAttachmentFormats = &format };
   const VkGraphicsPipelineCreateInfo gpi = {
      .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .pNext = &pri, .stageCount = 2, .pStages = stage,
      .pVertexInputState = &vis, .pInputAssemblyState = &ia, .pViewportState = &vs, .pRasterizationState = &rs,
      .pMultisampleState = &ms, .pColorBlendState = &bs, .layout = layout };
   VkPipeline p, one, pulled;
   CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &p));
   if (scenario == 79) {
      /* Every attribute from binding 0: of a stride WebGPU takes, then of one it doesn't. */
      VkVertexInputAttributeDescription same[16];
      for (uint32_t i = 0; i < 16; i++)
         same[i] = (VkVertexInputAttributeDescription){ i, 0, VK_FORMAT_R32_SFLOAT, 0 };
      VkVertexInputBindingDescription b0 = { 0, 4, VK_VERTEX_INPUT_RATE_VERTEX };
      const VkPipelineVertexInputStateCreateInfo vone = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
                                                          .vertexBindingDescriptionCount = 1, .pVertexBindingDescriptions = &b0,
                                                          .vertexAttributeDescriptionCount = 16, .pVertexAttributeDescriptions = same };
      VkGraphicsPipelineCreateInfo g = gpi;
      g.pVertexInputState = &vone;
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &g, NULL, &one));
      b0.stride = 6;
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &g, NULL, &pulled));
   }
   const VkImageMemoryBarrier toc = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
                                      .newLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .image = target,
                                      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, 0, 0, NULL, 0, NULL, 1, &toc);
   const VkRenderingAttachmentInfo ca = { .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = tv,
                                          .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
                                          .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
                                          .clearValue = { .color = { .float32 = { 1 / 15.0f, 1 / 15.0f, 1 / 15.0f, 1 / 15.0f } } } };
   const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = area, .layerCount = 1,
                                .colorAttachmentCount = 1, .pColorAttachments = &ca };
   BeginRendering(cmd, &ri);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, p);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[0], 0, NULL);
   if (scenario == 82)
      for (uint32_t k = 1; k < 4; k++)
         CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, k, 1, &sets[0], 0, NULL);
   if (sixteen)
      ((PFN_vkCmdBindVertexBuffers)GetDeviceProcAddr(dev, "vkCmdBindVertexBuffers"))(cmd, 0, 16, vbufs, voffs);
   CmdDraw(cmd, 3, 1, 0, 0);
   if (scenario == 79) {
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pulled);
      CmdDraw(cmd, 3, 1, 0, 0);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, one);
      CmdDraw(cmd, 3, 1, 0, 0);
      EndRendering(cmd);
      VkRenderingAttachmentInfo again = ca;
      again.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD;
      VkRenderingInfo next = ri;
      next.pColorAttachments = &again;
      BeginRendering(cmd, &next);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, one);
      CmdDraw(cmd, 3, 1, 0, 0);
   }
   if (scenario == 70) {
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &sets[1], 0, NULL);
      CmdDraw(cmd, 3, 1, 0, 0);
   }
   EndRendering(cmd);
   const VkImageMemoryBarrier tos = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
                                      .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT, .oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
                                      .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, .image = target,
                                      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &tos);
   copy_texel(cmd, target, VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 1, out, 0);
   return 0;
}

/* VK4 R2's dispatches in one host-visible memory (`out`, 4 KiB; tests/venus/):
 * 44 (two-reads.comp, the review's R4): `a` and `b` read-only, both at [1024, 1056) (1, 2, 3, 4), `o` at [0, 32).
 * 45 (two-writes.comp): two writable bindings of [256, 320).
 * 46 (two-writes.comp): two writable bindings, [256, 768) and [512, 1024).
 * The review of R1 to R4: 60 (three-writes.comp): three writable bindings of [256, 320); 61 (two-writes.comp): two of
 * [256, 318), not whole words. */
static int
r2_misc(uint32_t scenario, const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   const VkDescriptorType s = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
   const VkDescriptorType types[3] = { s, s, s };
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   static const uint32_t a[4] = { 1, 2, 3, 4 };
   if (scenario == 44)
      CmdUpdateBuffer(cmd, out, 1024, sizeof(a), a);
   const VkDescriptorBufferInfo reads[3] = { { out, 1024, 32 }, { out, 1024, 32 }, { out, 0, 32 } };
   const VkDescriptorBufferInfo same[2] = { { out, 256, 64 }, { out, 256, 64 } };
   const VkDescriptorBufferInfo over[2] = { { out, 256, 512 }, { out, 512, 512 } };
   const VkDescriptorBufferInfo three[3] = { { out, 256, 64 }, { out, 256, 64 }, { out, 256, 64 } };
   const VkDescriptorBufferInfo odd[2] = { { out, 256, 62 }, { out, 256, 62 } };
   if (scenario == 60)
      return dispatch_with(cs, cs_words, cmd, 3, types, three);
   if (scenario == 61)
      return dispatch_with(cs, cs_words, cmd, 2, types, odd);
   return dispatch_with(cs, cs_words, cmd, scenario == 44 ? 3 : 2, types, scenario == 44 ? reads : scenario == 45 ? same : over);
}

/* VK4 T7: device addresses (tests/venus/address.comp). A device-local memory filled and a submit later the address
 * buffer grown past it; then a dispatch reading it through a pointer, writing a host-visible memory through a pointer
 * and through a storage buffer descriptor of that memory, which would alias the pointers' binding. With `uniform` (VK4
 * R2, the review's R1; address-ubo.comp): the shader adds a uniform buffer of that memory at 2048 too, whose shadow is
 * only read while the descriptor's is written, in one usage scope. With `beside` (VK4 T41's follow-up, the review of R1
 * to R4's W2; t41/beside.comp, scenario 116): the descriptor is 32 bytes, half of them written through it and half
 * through the pointers, each half read the other way. */
static int
t7_addresses(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkCommandPool pool, bool uniform, bool beside)
{
   PFN_vkGetBufferDeviceAddress GetBufferDeviceAddress =
      (PFN_vkGetBufferDeviceAddress)GetDeviceProcAddr(dev, "vkGetBufferDeviceAddress");
   const VkBufferUsageFlags usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT |
                                    VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT |
                                    VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT;
   const VkMemoryAllocateFlagsInfo flags = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO,
                                             .flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT };
   memory_next = &flags;
   VkBuffer local, big, host;
   void *map;
   if (buffer(4096, usage, false, &local, NULL) || buffer(4096, usage, true, &host, &map)) {
      memory_next = NULL;
      return 1;
   }
   misc.map = map;
   memset(map, 0xee, 4096);
   if (uniform)
      *(uint32_t *)((uint8_t *)map + 2048) = 1000;
   VkCommandBuffer first;
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &first));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(first, &begin));
   CmdFillBuffer(first, local, 0, 4096, 40);
   CHECK(EndCommandBuffer(first));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &first };
   CHECK(QueueSubmit(queue, 1, &submit, VK_NULL_HANDLE));
   const int grown = buffer(100u << 20, usage, false, &big, NULL);
   memory_next = NULL;
   if (grown)
      return 1;

   const VkDescriptorSetLayoutBinding binding[2] = { { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
                                                     { 1, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL } };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = uniform ? 2 : 1, .pBindings = binding };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPushConstantRange range = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 16 };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &range };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkShaderModuleCreateInfo smi = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                          .codeSize = cs_words * 4, .pCode = cs };
   VkShaderModule module;
   CHECK(CreateShaderModule(dev, &smi, NULL, &module));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = module, .pName = "main" },
      .layout = layout };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 }, { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = uniform ? 2 : 1, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   const VkDescriptorBufferInfo bi[2] = { { host, 1024, beside ? 32 : 16 }, { host, 2048, 16 } };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[0] },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &bi[1] } };
   UpdateDescriptorSets(dev, uniform ? 2 : 1, wr, 0, NULL);
   const VkBufferDeviceAddressInfo from = { .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO, .buffer = local };
   const VkBufferDeviceAddressInfo to = { .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO, .buffer = host };
   const uint64_t push[2] = { GetBufferDeviceAddress(dev, &from), GetBufferDeviceAddress(dev, &to) };
   PFN_vkCmdPushConstants CmdPushConstants = (PFN_vkCmdPushConstants)GetDeviceProcAddr(dev, "vkCmdPushConstants");
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(push), push);
   CmdDispatch(cmd, 1, 1, 1);
   return 0;
}

/* The review of VK4 T41 to T43 (finding 6), wgt_misc's scenario 121 (tests/venus/t41/full.comp), on scenario 115's
 * device (the address buffer regions of 1 MiB, so several, each a storage binding in a stage reading pointers): an
 * array of as many storage buffers as maxPerStageDescriptorStorageBuffers, each its own memory, beside a pointer to 40s;
 * buffer k gets 40 + k, copied to `out`'s 4k. */
static int
t41_full(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkGetBufferDeviceAddress GetBufferDeviceAddress =
      (PFN_vkGetBufferDeviceAddress)GetDeviceProcAddr(dev, "vkGetBufferDeviceAddress");
   PFN_vkGetPhysicalDeviceProperties GetProps =
      (PFN_vkGetPhysicalDeviceProperties)vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceProperties");
   PFN_vkCmdCopyBuffer CmdCopyBuffer = (PFN_vkCmdCopyBuffer)GetDeviceProcAddr(dev, "vkCmdCopyBuffer");
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   CHECK(EnumeratePhysicalDevices(instance, &n, &pdev));
   VkPhysicalDeviceProperties props;
   GetProps(pdev, &props);
   const uint32_t count = props.limits.maxPerStageDescriptorStorageBuffers < 16 ? props.limits.maxPerStageDescriptorStorageBuffers : 16;
   const VkBufferUsageFlags usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT |
                                    VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT;
   const VkMemoryAllocateFlagsInfo flags = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO,
                                             .flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT };
   memory_next = &flags;
   VkBuffer from;
   const int made = buffer(256, usage, false, &from, NULL);
   memory_next = NULL;
   if (made)
      return 1;
   VkBuffer b[16];
   for (uint32_t k = 0; k < count; k++)
      if (buffer(256, VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, false, &b[k], NULL))
         return 1;
   CmdFillBuffer(cmd, from, 0, 256, 40);
   const VkDescriptorSetLayoutBinding binding = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, count, VK_SHADER_STAGE_COMPUTE_BIT,
                                                  NULL };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 1, .pBindings = &binding };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPushConstantRange range = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 8 };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1,
                                            .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &range };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule module;
   if (shader(cs, cs_words, &module))
      return 1;
   const VkSpecializationMapEntry entry = { 0, 0, 4 };
   const VkSpecializationInfo spec = { 1, &entry, 4, &count };
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = module, .pName = "main", .pSpecializationInfo = &spec },
      .layout = layout };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, count };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 1, .pPoolSizes = &ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   VkDescriptorBufferInfo bi[16];
   for (uint32_t k = 0; k < count; k++)
      bi[k] = (VkDescriptorBufferInfo){ b[k], 0, 256 };
   const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .descriptorCount = count,
                                     .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = bi };
   UpdateDescriptorSets(dev, 1, &wr, 0, NULL);
   const VkBufferDeviceAddressInfo ai = { .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO, .buffer = from };
   const uint64_t push = GetBufferDeviceAddress(dev, &ai);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
   CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(push), &push);
   CmdDispatch(cmd, 1, 1, 1);
   for (uint32_t k = 0; k < count; k++)
      CmdCopyBuffer(cmd, b[k], out, 1, &(VkBufferCopy){ 0, 4 * k, 4 });
   /* The count, at 1020. */
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   CmdUpdateBuffer(cmd, out, 1020, 4, &count);
   return 0;
}

/* VK4 T41, wgt_misc's scenario 115 (tests/venus/t41/regions.comp), on a device that takes the adapter's storage
 * binding to be 1 MiB (the test page's caps), so that the address buffer is regions of 1 MiB: an image's memory made
 * for addresses, of 2 MiB, is had and takes no room there (DXVK and VMA give all memory the flag); a device-local memory of 600 KiB (40s) is in region 0, a host-visible one (zeros)
 * in region 1, two for capture and replay in regions 2 and 3, freed and made again in the other order at their captured
 * addresses (the first, 70s, read). The
 * dispatch writes b[i] = a[i] + d[i] + i and counts itself at b[16], all through pointers. */
static int
t41_regions(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkCommandPool pool)
{
   PFN_vkGetBufferDeviceAddress GetBufferDeviceAddress =
      (PFN_vkGetBufferDeviceAddress)GetDeviceProcAddr(dev, "vkGetBufferDeviceAddress");
   PFN_vkGetDeviceMemoryOpaqueCaptureAddress GetMemoryCapture =
      (PFN_vkGetDeviceMemoryOpaqueCaptureAddress)GetDeviceProcAddr(dev, "vkGetDeviceMemoryOpaqueCaptureAddress");
   PFN_vkFreeMemory FreeMemory = (PFN_vkFreeMemory)GetDeviceProcAddr(dev, "vkFreeMemory");
   const VkBufferUsageFlags usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT |
                                    VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT;
   const VkMemoryAllocateFlagsInfo flags = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO,
                                             .flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT };
   memory_next = &flags;
   VkImage img;
   VkImageView view;
   VkBuffer a, b;
   void *map;
   const int made = image(VK_FORMAT_R8G8B8A8_UNORM, 512, 1024, VK_IMAGE_USAGE_SAMPLED_BIT, VK_IMAGE_ASPECT_COLOR_BIT, &img, &view) ||
                    buffer(600u << 10, usage, false, &a, NULL) || buffer(600u << 10, usage, true, &b, &map);
   memory_next = NULL;
   if (made)
      return 1;
   misc.map = map;
   memset(map, 0, 4096);
   /* Capture and replay: a memory's address captured, the memory freed and made again there. */
   VkMemoryOpaqueCaptureAddressAllocateInfo replay = { .sType = VK_STRUCTURE_TYPE_MEMORY_OPAQUE_CAPTURE_ADDRESS_ALLOCATE_INFO };
   const VkMemoryAllocateFlagsInfo capture = {
      .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO, .pNext = &replay,
      .flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT | VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_CAPTURE_REPLAY_BIT };
   VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .pNext = &capture,
                               .allocationSize = 600u << 10, .memoryTypeIndex = 0 };
   /* Two, made again in the other order (as dEQP's replays do): the second's place is the first free one. */
   VkDeviceMemory first[2], again[2];
   uint64_t captured[2];
   for (uint32_t i = 0; i < 2; i++) {
      CHECK(AllocateMemory(dev, &ai, NULL, &first[i]));
      const VkDeviceMemoryOpaqueCaptureAddressInfo ci = {
         .sType = VK_STRUCTURE_TYPE_DEVICE_MEMORY_OPAQUE_CAPTURE_ADDRESS_INFO, .memory = first[i] };
      captured[i] = GetMemoryCapture(dev, &ci);
   }
   FreeMemory(dev, first[0], NULL);
   FreeMemory(dev, first[1], NULL);
   for (uint32_t i = 2; i-- > 0;) {
      replay.opaqueCaptureAddress = captured[i];
      CHECK(AllocateMemory(dev, &ai, NULL, &again[i]));
      const VkDeviceMemoryOpaqueCaptureAddressInfo ci = {
         .sType = VK_STRUCTURE_TYPE_DEVICE_MEMORY_OPAQUE_CAPTURE_ADDRESS_INFO, .memory = again[i] };
      if (GetMemoryCapture(dev, &ci) != captured[i]) {
         snprintf(error, sizeof(error), "a memory made again at %llx is at %llx", (unsigned long long)captured[i],
                  (unsigned long long)GetMemoryCapture(dev, &ci));
         return 1;
      }
   }
   replay.opaqueCaptureAddress = captured[0];
   const VkBufferCreateInfo bci = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = 600u << 10, .usage = usage,
                                    .flags = VK_BUFFER_CREATE_DEVICE_ADDRESS_CAPTURE_REPLAY_BIT };
   VkBuffer d;
   CHECK(CreateBuffer(dev, &bci, NULL, &d));
   CHECK(BindBufferMemory(dev, d, again[0], 0));
   VkBufferDeviceAddressInfo bi = { .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO, .buffer = a };
   uint64_t push[3];
   push[0] = GetBufferDeviceAddress(dev, &bi);
   bi.buffer = b;
   push[1] = GetBufferDeviceAddress(dev, &bi);
   bi.buffer = d;
   push[2] = GetBufferDeviceAddress(dev, &bi);
   if (push[0] >> 32 != 0 || push[1] >> 32 != 1 || push[2] >> 32 != 2 || !replay.opaqueCaptureAddress ||
       push[2] != replay.opaqueCaptureAddress) {
      snprintf(error, sizeof(error), "addresses %llx %llx %llx, captured %llx: not regions 0, 1 and 2 and the capture's",
               (unsigned long long)push[0], (unsigned long long)push[1], (unsigned long long)push[2],
               (unsigned long long)replay.opaqueCaptureAddress);
      return 1;
   }
   CmdFillBuffer(cmd, a, 0, 4096, 40);
   CmdFillBuffer(cmd, d, 0, 4096, 70);
   const VkMemoryBarrier barrier = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                     .dstAccessMask = VK_ACCESS_SHADER_READ_BIT };
   PFN_vkCmdPipelineBarrier CmdPipelineBarrier = (PFN_vkCmdPipelineBarrier)GetDeviceProcAddr(dev, "vkCmdPipelineBarrier");
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &barrier, 0, NULL, 0,
                      NULL);
   const VkPushConstantRange range = { VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(push) };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .pushConstantRangeCount = 1, .pPushConstantRanges = &range };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   VkShaderModule module;
   if (shader(cs, cs_words, &module))
      return 1;
   const VkComputePipelineCreateInfo pci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = module, .pName = "main" },
      .layout = layout };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &pci, NULL, &pipeline));
   PFN_vkCmdPushConstants CmdPushConstants = (PFN_vkCmdPushConstants)GetDeviceProcAddr(dev, "vkCmdPushConstants");
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(push), push);
   CmdDispatch(cmd, 1, 1, 1);
   return 0;
}

/*
 * VK4 T22, wgt_misc's scenarios 92 and 93: a queue of family 0 and one of the compute-only family, over one WebGPU queue.
 * `cmd` (family 0's) copies 64 bytes of 0x33 to `out` (0xee, written by the host) at 0; family 1's command buffer copies
 * `out`'s [0, 64) to [64, 128), waiting on a binary semaphore `cmd`'s submit signals, `misc.fence` its submit's. `cmd`'s
 * submit waits for a timeline value:
 * 92: signalled by a submit on the compute queue before family 1's copy: it ran only behind the held submit, which waits
 *     for it (every submit was held behind a held one, whatever its queue).
 * 93: signalled by the host after both are submitted: the copy waits for its binary semaphore's held signal (with one
 *     order a queue, nothing else held it back).
 * 0x33 at [0, 128) of `out` both ways.
 */
static int
two_queues(uint32_t scenario, VkCommandBuffer cmd, VkBuffer out)
{
   if (compute_family == UINT32_MAX) {
      snprintf(error, sizeof(error), "no queue family with compute and without graphics");
      return 1;
   }
   PFN_vkCmdCopyBuffer CmdCopyBuffer = (PFN_vkCmdCopyBuffer)GetDeviceProcAddr(dev, "vkCmdCopyBuffer");
   PFN_vkCreateSemaphore CreateSemaphore = (PFN_vkCreateSemaphore)GetDeviceProcAddr(dev, "vkCreateSemaphore");
   PFN_vkSignalSemaphore SignalSemaphore = (PFN_vkSignalSemaphore)GetDeviceProcAddr(dev, "vkSignalSemaphore");
   const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
                                         .queueFamilyIndex = compute_family };
   VkCommandPool pool;
   CHECK(CreateCommandPool(dev, &cpo, NULL, &pool));
   VkCommandBuffer copy;
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &copy));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(copy, &begin));
   CmdCopyBuffer(copy, out, out, 1, &(VkBufferCopy){ 0, 64, 64 });
   CHECK(EndCommandBuffer(copy));
   const VkSemaphoreTypeCreateInfo type = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
                                            .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE };
   const VkSemaphoreCreateInfo tci = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, .pNext = &type };
   const VkSemaphoreCreateInfo bci = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO };
   VkSemaphore timeline, binary;
   CHECK(CreateSemaphore(dev, &tci, NULL, &timeline));
   CHECK(CreateSemaphore(dev, &bci, NULL, &binary));
   const uint64_t one = 1, none = 0;
   const VkPipelineStageFlags stage = VK_PIPELINE_STAGE_TRANSFER_BIT;
   /* Family 0's copy: waits for the timeline's 1, signals the binary semaphore. */
   const uint64_t waits0[1] = { one }, signals0[1] = { none };
   const VkTimelineSemaphoreSubmitInfo t0 = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
                                              .waitSemaphoreValueCount = 1, .pWaitSemaphoreValues = waits0,
                                              .signalSemaphoreValueCount = 1, .pSignalSemaphoreValues = signals0 };
   const VkSubmitInfo s0 = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &t0, .waitSemaphoreCount = 1,
                             .pWaitSemaphores = &timeline, .pWaitDstStageMask = &stage, .commandBufferCount = 1,
                             .pCommandBuffers = &cmd, .signalSemaphoreCount = 1, .pSignalSemaphores = &binary };
   CHECK(QueueSubmit(queue, 1, &s0, VK_NULL_HANDLE));
   /* The timeline's 1 from the compute queue. */
   const VkTimelineSemaphoreSubmitInfo t1 = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
                                              .signalSemaphoreValueCount = 1, .pSignalSemaphoreValues = &one };
   const VkSubmitInfo s1 = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &t1, .signalSemaphoreCount = 1,
                             .pSignalSemaphores = &timeline };
   if (scenario == 92)
      CHECK(QueueSubmit(queue2, 1, &s1, VK_NULL_HANDLE));
   /* The compute queue's copy, after the binary semaphore. */
   const VkSubmitInfo s2 = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .waitSemaphoreCount = 1,
                             .pWaitSemaphores = &binary, .pWaitDstStageMask = &stage, .commandBufferCount = 1,
                             .pCommandBuffers = &copy };
   CHECK(QueueSubmit(queue2, 1, &s2, misc.fence));
   if (scenario == 93) {
      const VkSemaphoreSignalInfo signal = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = timeline,
                                             .value = 1 };
      CHECK(SignalSemaphore(dev, &signal));
   }
   return 0;
}

/*
 * VK4 T37: commands WebGPU refuses that the driver can avoid, each one submit into `out` (wgt_misc's, filled 0xee). Its
 * helpers: a compute pipeline over one set (binding i of `types[i]`, the set allocated), an image bound to memory, and
 * a dispatch of one invocation after a barrier from everything before.
 */
struct t37_pipe {
   VkPipeline pipeline;
   VkPipelineLayout layout;
   VkDescriptorSet set;
};

static int
t37_compute(const uint32_t *cs, uint32_t cs_words, const VkDescriptorType *types, uint32_t n, struct t37_pipe *p)
{
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   VkDescriptorSetLayoutBinding bindings[16];
   VkDescriptorPoolSize sizes[16];
   for (uint32_t i = 0; i < n; i++) {
      bindings[i] = (VkDescriptorSetLayoutBinding){ i, types[i], 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
      sizes[i] = (VkDescriptorPoolSize){ types[i], 1 };
   }
   const VkDescriptorSetLayoutCreateInfo li = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                .bindingCount = n, .pBindings = bindings };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &li, NULL, &dsl));
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl };
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &p->layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = p->layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &p->pipeline));
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = n, .pPoolSizes = sizes };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   CHECK(AllocateDescriptorSets(dev, &dai, &p->set));
   return 0;
}

static int
t37_image(VkImageType type, VkFormat format, VkExtent3D extent, uint32_t layers, VkImageUsageFlags usage,
          VkImageCreateFlags flags, VkImage *out)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = flags, .imageType = type, .format = format,
      .extent = extent, .mipLevels = 1, .arrayLayers = layers, .samples = VK_SAMPLE_COUNT_1_BIT,
      .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = usage,
   };
   CHECK(CreateImage(dev, &info, NULL, out));
   VkMemoryRequirements req;
   GetImageMemoryRequirements(dev, *out, &req);
   VkDeviceMemory mem;
   if (memory_for(req, false, &mem, NULL))
      return 1;
   CHECK(BindImageMemory(dev, *out, mem, 0));
   return 0;
}

static int
t37_view(VkImage image, VkImageViewType type, VkFormat format, uint32_t layer, uint32_t layers, VkImageView *out)
{
   const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = image,
                                      .viewType = type, .format = format,
                                      .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, layer, layers } };
   CHECK(CreateImageView(dev, &vi, NULL, out));
   return 0;
}

/* Everything before visible to a compute dispatch, and the dispatch's writes to transfers after. */
static void
t37_barrier(VkCommandBuffer cmd, bool after)
{
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
                                .srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT };
   CmdPipelineBarrier(cmd, after ? VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT : VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,
                      after ? VK_PIPELINE_STAGE_TRANSFER_BIT : VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 1, &mb, 0,
                      NULL, 0, NULL);
}

static void
t37_dispatch(VkCommandBuffer cmd, const struct t37_pipe *p)
{
   t37_barrier(cmd, false);
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, p->pipeline);
   CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, p->layout, 0, 1, &p->set, 0, NULL);
   CmdDispatch(cmd, 1, 1, 1);
   t37_barrier(cmd, true);
}

/* A layer of a 2x2 R32_UINT image (or the first `w` texels of one row) into `out` at `at`. */
static void
t37_read(VkCommandBuffer cmd, VkImage image, uint32_t layer, VkBuffer out, VkDeviceSize at, uint32_t w, uint32_t h)
{
   const VkBufferImageCopy c = { .bufferOffset = at,
                                 .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, layer, 1 },
                                 .imageExtent = { w, h, 1 } };
   CmdCopyImageToBuffer(cmd, image, VK_IMAGE_LAYOUT_GENERAL, out, 1, &c);
}

/*
 * 102, `cs` t37/flat-storage.comp: 2D array views of one layer bound where the shader declares 2D storage images (an
 * invalid bind group before): two 2x2 R32_UINT images of two layers, layer 1 of the first cleared 5 (layer 0 1), of
 * the second 9 (layer 0 3). The first loaded and stored (77 at (1, 1)), the second loaded as a texture: 5 and 9 at 0,
 * the first's layer 1 at 256 (5, 5, 5, 77).
 */
static int
t37_flat(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const VkImageUsageFlags usage = VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT |
                                   VK_IMAGE_USAGE_TRANSFER_DST_BIT;
   VkImage imgs[2];
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++) {
      if (t37_image(VK_IMAGE_TYPE_2D, VK_FORMAT_R32_UINT, (VkExtent3D){ 2, 2, 1 }, 2, usage, 0, &imgs[i]) ||
          t37_view(imgs[i], VK_IMAGE_VIEW_TYPE_2D_ARRAY, VK_FORMAT_R32_UINT, 1, 1, &views[i]))
         return 1;
      for (uint32_t l = 0; l < 2; l++) {
         const VkImageSubresourceRange r = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, l, 1 };
         const VkClearColorValue c = { .uint32 = { i ? (l ? 9 : 3) : (l ? 5 : 1) } };
         CmdClearColorImage(cmd, imgs[i], VK_IMAGE_LAYOUT_GENERAL, &c, 1, &r);
      }
   }
   static const VkDescriptorType types[3] = { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,
                                              VK_DESCRIPTOR_TYPE_STORAGE_BUFFER };
   struct t37_pipe p;
   if (t37_compute(cs, cs_words, types, 3, &p))
      return 1;
   const VkDescriptorImageInfo ii[2] = { { VK_NULL_HANDLE, views[0], VK_IMAGE_LAYOUT_GENERAL },
                                         { VK_NULL_HANDLE, views[1], VK_IMAGE_LAYOUT_GENERAL } };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 0, .descriptorCount = 2,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = ii },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 2, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   t37_dispatch(cmd, &p);
   t37_read(cmd, imgs[0], 1, out, 256, 2, 2);
   return 0;
}

/*
 * 103, `cs` t37/read-written.comp: subresources read as textures and written through storage bindings in one dispatch
 * (WebGPU refused the dispatch, its submit dropped): a 2x2 R32_UINT image cleared 7, read at (0, 0) and 42 stored
 * there; a 2x2x2 3D one cleared 3, read in slice 0 and 43 stored in slice 1 (its level one WebGPU subresource). The
 * reads at 0 (7, 3), the 2D image at 256 (42, 7, 7, 7), the 3D image's slice 1 at 512 (3, 3, 3, 43).
 */
static int
t37_read_written(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   const VkImageUsageFlags usage = VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT |
                                   VK_IMAGE_USAGE_TRANSFER_DST_BIT;
   VkImage imgs[2];
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++) {
      if (t37_image(i ? VK_IMAGE_TYPE_3D : VK_IMAGE_TYPE_2D, VK_FORMAT_R32_UINT, (VkExtent3D){ 2, 2, i ? 2 : 1 }, 1,
                    usage, 0, &imgs[i]) ||
          t37_view(imgs[i], i ? VK_IMAGE_VIEW_TYPE_3D : VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R32_UINT, 0, 1, &views[i]))
         return 1;
      const VkImageSubresourceRange r = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
      const VkClearColorValue c = { .uint32 = { i ? 3 : 7 } };
      CmdClearColorImage(cmd, imgs[i], VK_IMAGE_LAYOUT_GENERAL, &c, 1, &r);
   }
   static const VkDescriptorType types[5] = { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,
                                              VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,
                                              VK_DESCRIPTOR_TYPE_STORAGE_BUFFER };
   struct t37_pipe p;
   if (t37_compute(cs, cs_words, types, 5, &p))
      return 1;
   const VkDescriptorImageInfo ii[4] = { { VK_NULL_HANDLE, views[0], VK_IMAGE_LAYOUT_GENERAL },
                                         { VK_NULL_HANDLE, views[0], VK_IMAGE_LAYOUT_GENERAL },
                                         { VK_NULL_HANDLE, views[1], VK_IMAGE_LAYOUT_GENERAL },
                                         { VK_NULL_HANDLE, views[1], VK_IMAGE_LAYOUT_GENERAL } };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 0, .descriptorCount = 4,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = ii },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 4, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   t37_dispatch(cmd, &p);
   t37_read(cmd, imgs[0], 0, out, 256, 2, 2);
   const VkBufferImageCopy c = { .bufferOffset = 512, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                 .imageOffset = { 0, 0, 1 }, .imageExtent = { 2, 2, 1 } };
   CmdCopyImageToBuffer(cmd, imgs[1], VK_IMAGE_LAYOUT_GENERAL, out, 1, &c);
   return 0;
}

/*
 * 104: a packed format's 3D image whose texture's texels pass maxStorageBufferBindingSize (WebGPU's least, 128 MiB):
 * a 512x512x130 A4R4G4B4_UNORM_PACK16 image (rgba8unorm, 136 MB) uploaded from a buffer filled 0x12345678, unpacked by
 * the worker's compute pass (`packPass`, which cut its binding at the limit: the slices past it were left 0), then a
 * 4x2 corner of its last slice and of its first copied out (packed back): the fill's words, at 0 and 256.
 */
static int
t37_big_packed(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdCopyBufferToImage CopyIn = CmdCopyBufferToImage;
   const VkExtent3D e = { 512, 512, 130 };
   VkImage img;
   if (t37_image(VK_IMAGE_TYPE_3D, VK_FORMAT_A4R4G4B4_UNORM_PACK16, e, 1,
                 VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0, &img))
      return 1;
   VkBuffer src;
   const VkDeviceSize bytes = (VkDeviceSize)e.width * e.height * e.depth * 2;
   if (buffer(bytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, false, &src, NULL))
      return 1;
   CmdFillBuffer(cmd, src, 0, VK_WHOLE_SIZE, 0x12345678);
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT };
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 1, &mb, 0, NULL,
                      0, NULL);
   const VkBufferImageCopy whole = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = e };
   CopyIn(cmd, src, img, VK_IMAGE_LAYOUT_GENERAL, 1, &whole);
   CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 1, &mb, 0, NULL,
                      0, NULL);
   for (uint32_t i = 0; i < 2; i++) {
      const VkBufferImageCopy c = { .bufferOffset = i ? 256 : 0,
                                    .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                    .imageOffset = { 508, 510, i ? 0 : 129 }, .imageExtent = { 4, 2, 1 } };
      CmdCopyImageToBuffer(cmd, img, VK_IMAGE_LAYOUT_GENERAL, out, 1, &c);
   }
   return 0;
}

/*
 * 105, `cs` t37/words-past.comp: a storage image as words whose view is past maxStorageBufferBindingSize (the test's
 * device has WebGPU's least, 128 MiB): a 4100x4096 RG32_SFLOAT image (135 MB of words), loaded and stored by a
 * dispatch, which is refused (it wrote 1 at 0), then 0x77 written at 256 by the same submit (an invalid bind group lost
 * the submit).
 */
static int
t37_words_past(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   VkImage img;
   VkImageView view;
   if (t37_image(VK_IMAGE_TYPE_2D, VK_FORMAT_R32G32_SFLOAT, (VkExtent3D){ 4100, 4096, 1 }, 1,
                 VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0, &img) ||
       t37_view(img, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R32G32_SFLOAT, 0, 1, &view))
      return 1;
   static const VkDescriptorType types[2] = { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER };
   struct t37_pipe p;
   if (t37_compute(cs, cs_words, types, 2, &p))
      return 1;
   const VkDescriptorImageInfo ii = { VK_NULL_HANDLE, view, VK_IMAGE_LAYOUT_GENERAL };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = &ii },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   t37_dispatch(cmd, &p);
   static const uint32_t mark = 0x77;
   CmdUpdateBuffer(cmd, out, 256, 4, &mark);
   return 0;
}

/*
 * 106, `cs` t37/mismatched.comp: storage images whose declared format isn't their view's (dEQP-VK's
 * image.mismatched_formats): two 2x2 R32_UINT images cleared 0x3f800000, one read as declared r32f, one written as
 * declared rgba8. The dispatch runs (1 at 0; what it read and wrote undefined), its submit kept (0x77 at 256).
 */
static int
t37_mismatched(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   VkImage imgs[2];
   VkImageView views[2];
   for (uint32_t i = 0; i < 2; i++) {
      if (t37_image(VK_IMAGE_TYPE_2D, VK_FORMAT_R32_UINT, (VkExtent3D){ 2, 2, 1 }, 1,
                    VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0, &imgs[i]) ||
          t37_view(imgs[i], VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R32_UINT, 0, 1, &views[i]))
         return 1;
      const VkImageSubresourceRange r = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
      const VkClearColorValue c = { .uint32 = { 0x3f800000 } };
      CmdClearColorImage(cmd, imgs[i], VK_IMAGE_LAYOUT_GENERAL, &c, 1, &r);
   }
   static const VkDescriptorType types[3] = { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,
                                              VK_DESCRIPTOR_TYPE_STORAGE_BUFFER };
   struct t37_pipe p;
   if (t37_compute(cs, cs_words, types, 3, &p))
      return 1;
   const VkDescriptorImageInfo ii[2] = { { VK_NULL_HANDLE, views[0], VK_IMAGE_LAYOUT_GENERAL },
                                         { VK_NULL_HANDLE, views[1], VK_IMAGE_LAYOUT_GENERAL } };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 0, .descriptorCount = 2,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = ii },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 2, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   t37_dispatch(cmd, &p);
   static const uint32_t mark = 0x77;
   CmdUpdateBuffer(cmd, out, 256, 4, &mark);
   return 0;
}

/*
 * 107, `cs` t37/uniform-tail.comp: a uniform block declared whole (as large as the device takes: 64 KiB on SwiftShader)
 * over the last 4 KiB of a 256 MiB device-local buffer of its own memory, on a device whose maxBufferSize is WebGPU's
 * least, 256 MiB: its GPUBuffer has no room past the memory for the block (WG_MEMORY_PAD cut to none; WebGPU refused the
 * binding, smaller than the block: the submit lost). 41 at the range's byte 0 and 42 at 1604, written by the submit,
 * read at an index `out` gives (0 at byte 12): 41, 42 at 0.
 */
static int
t37_uniform_tail(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   VkBuffer ub;
   const VkDeviceSize size = 256u << 20, at = size - 4096;
   if (buffer(size, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, false, &ub, NULL))
      return 1;
   static const uint32_t a = 41, b = 42;
   CmdFillBuffer(cmd, ub, at, 4096, 0);
   CmdUpdateBuffer(cmd, ub, at, 4, &a);
   CmdUpdateBuffer(cmd, ub, at + 1604, 4, &b);
   static const uint32_t index = 0;
   CmdUpdateBuffer(cmd, out, 12, 4, &index);
   static const VkDescriptorType types[2] = { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER };
   struct t37_pipe p;
   if (t37_compute(cs, cs_words, types, 2, &p))
      return 1;
   const VkDescriptorBufferInfo bi[2] = { { ub, at, 4096 }, { out, 0, 16 } };
   const VkWriteDescriptorSet wr[2] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &bi[0] },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 1, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[1] },
   };
   UpdateDescriptorSets(dev, 2, wr, 0, NULL);
   t37_dispatch(cmd, &p);
   return 0;
}

/*
 * 108, `cs` t37/atomic-alias.comp: two writable storage buffers of one range (512 of `out`, 16 bytes), one an array of
 * atomics and one not, which can't be one binding: the dispatch refused (the range as filled), its submit kept (0x77
 * at 256; WebGPU refused the dispatch's writable aliasing, the submit lost).
 */
static int
t37_atomic_alias(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   static const VkDescriptorType types[2] = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER };
   struct t37_pipe p;
   if (t37_compute(cs, cs_words, types, 2, &p))
      return 1;
   const VkDescriptorBufferInfo bi[2] = { { out, 512, 16 }, { out, 512, 16 } };
   const VkWriteDescriptorSet wr = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = 0,
                                     .descriptorCount = 2, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                     .pBufferInfo = bi };
   UpdateDescriptorSets(dev, 1, &wr, 0, NULL);
   t37_dispatch(cmd, &p);
   static const uint32_t mark = 0x77;
   CmdUpdateBuffer(cmd, out, 256, 4, &mark);
   return 0;
}

/*
 * VK4 T38, wgt_misc's scenario 109: what T38 advertises (D32_SFLOAT's depth comparison in VkFormatProperties3, R8_UINT
 * storage texel buffers, R8G8B8A8_SRGB and R5G6B5 storage images, A8_UNORM sampled and as a colour attachment, the
 * 10-bit SNORM formats), else 1; and A2B10G10R10_SNORM's texels (in a half-float texture) back with their bits from
 * an upload, -512 to 511, at 0 (8 bytes), and A2R10G10B10_SNORM cleared with (2, -0.25, 0.25, -3): clamped, rounded,
 * at 256.
 */
static int
t38_misc(VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkGetPhysicalDeviceFormatProperties2 FormatProps =
      (PFN_vkGetPhysicalDeviceFormatProperties2)vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceFormatProperties2");
   VkPhysicalDevice pdev;
   uint32_t n = 1;
   CHECK(EnumeratePhysicalDevices(instance, &n, &pdev));
   static const struct { VkFormat f; int which; VkFormatFeatureFlags2 want; } asks[] = {
      { VK_FORMAT_D32_SFLOAT, 1, VK_FORMAT_FEATURE_2_SAMPLED_IMAGE_DEPTH_COMPARISON_BIT },
      { VK_FORMAT_D16_UNORM, 1, VK_FORMAT_FEATURE_2_SAMPLED_IMAGE_DEPTH_COMPARISON_BIT },
      { VK_FORMAT_R8_UINT, 2, VK_FORMAT_FEATURE_2_STORAGE_TEXEL_BUFFER_BIT },
      { VK_FORMAT_R16_SFLOAT, 2, VK_FORMAT_FEATURE_2_STORAGE_TEXEL_BUFFER_BIT },
      { VK_FORMAT_R8G8B8A8_SRGB, 1, VK_FORMAT_FEATURE_2_STORAGE_IMAGE_BIT },
      { VK_FORMAT_R5G6B5_UNORM_PACK16, 1, VK_FORMAT_FEATURE_2_STORAGE_IMAGE_BIT },
      { VK_FORMAT_A8_UNORM_KHR, 1, VK_FORMAT_FEATURE_2_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_2_COLOR_ATTACHMENT_BIT },
      { VK_FORMAT_A2B10G10R10_SNORM_PACK32, 1, VK_FORMAT_FEATURE_2_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_2_COLOR_ATTACHMENT_BIT },
      { VK_FORMAT_A2R10G10B10_SNORM_PACK32, 1, VK_FORMAT_FEATURE_2_TRANSFER_DST_BIT },
   };
   for (uint32_t i = 0; i < sizeof(asks) / sizeof(asks[0]); i++) {
      VkFormatProperties3 p3 = { .sType = VK_STRUCTURE_TYPE_FORMAT_PROPERTIES_3 };
      VkFormatProperties2 p = { .sType = VK_STRUCTURE_TYPE_FORMAT_PROPERTIES_2, .pNext = &p3 };
      FormatProps(pdev, asks[i].f, &p);
      const VkFormatFeatureFlags2 have = asks[i].which == 1 ? p3.optimalTilingFeatures : p3.bufferFeatures;
      if ((have & asks[i].want) != asks[i].want) {
         fprintf(stderr, "t38: format %d lacks 0x%llx\n", asks[i].f, (unsigned long long)(asks[i].want & ~have));
         return 1;
      }
   }
   VkImage sn, sc;
   VkBuffer src;
   uint32_t *sb;
   if (t31_image(VK_FORMAT_A2B10G10R10_SNORM_PACK32, 2, &sn) || t31_image(VK_FORMAT_A2R10G10B10_SNORM_PACK32, 1, &sc) ||
       buffer(256, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, true, &src, (void **)&sb))
      return 1;
   /* R -512 and A -2 (the most negative codes, read -1 as the next ones are), G 511, B 0; R 300, G -300, B -1, A -1. */
   sb[0] = 0x200u | (0x1ffu << 10) | (0u << 20) | (2u << 30);
   sb[1] = 300u | ((uint32_t)(-300 & 1023) << 10) | (0x3ffu << 20) | (3u << 30);
   const VkImageAspectFlags C = VK_IMAGE_ASPECT_COLOR_BIT;
   t24_general(cmd, sn, C, 1);
   t24_general(cmd, sc, C, 1);
   const VkImageSubresourceLayers c1 = { C, 0, 0, 1 };
   CmdCopyBufferToImage(cmd, src, sn, VK_IMAGE_LAYOUT_GENERAL, 1,
                        &(VkBufferImageCopy){ .imageSubresource = c1, .imageExtent = { 2, 1, 1 } });
   CmdCopyImageToBuffer(cmd, sn, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                        &(VkBufferImageCopy){ .imageSubresource = c1, .imageExtent = { 2, 1, 1 } });
   const VkImageSubresourceRange cr = { C, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, sc, VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { 2, -0.25f, 0.25f, -3 } }, 1, &cr);
   CmdCopyImageToBuffer(cmd, sc, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                        &(VkBufferImageCopy){ .bufferOffset = 256, .imageSubresource = c1, .imageExtent = { 1, 1, 1 } });
   return 0;
}

/*
 * 110, `cs` t38/stores.comp (its bindings 0-6): an R8_UINT storage texel buffer of 4 texels stored by 4 invocations, at
 * 256; a 1x1 R8G8B8A8_SRGB storage image stored 0.5 (bc bc bc 80), at 512; a 2x1 R5G6B5 one stored red and cyan
 * (f800 07ff), at 768; a 1x1 A8_UNORM image cleared to alpha 0.5, sampled (alpha 128 at 0, colour 0 at 4) and copied
 * out at 1280 (0x80); a 1x1x4 R32_UINT 3D image of 10, 20, 30, 40 by slice through 2D views: slice 2 fetched (30 at 8),
 * slice 3 stored 99, the image at 1024 (10 20 30 99).
 */
/* VK4 T40 (`out` as wgt_misc's): 114, t40/dynamic.comp: 8 dynamic uniform buffers (100 + i at 512i of a buffer, 132 + i
 * at 512i + 256) and 4 dynamic storage buffers (200 + j at 512j of another, 232 + j at 512j + 256) beside 128 bytes of
 * push constants, dispatched at dynamic offsets 0 with base 0 and add 1, then at 256 with base 16 and add 2: words
 * [0, 12) 101 + i, 201 + j; [16, 28) 134 + i, 234 + j. WebGPU's dynamic buffers are 8 and 4 on SwiftShader, and the
 * push buffer a dynamic one more: a storage buffer's offset is its bind group's (the pipeline was refused). */
static int
t40_dynamic(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   VkBuffer ubo, ssbo;
   uint32_t *wu, *ws;
   if (buffer(4096, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &ubo, (void **)&wu) ||
       buffer(4096, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, true, &ssbo, (void **)&ws))
      return 1;
   for (uint32_t i = 0; i < 8; i++)
      wu[128 * i] = 100 + i, wu[128 * i + 64] = 132 + i;
   for (uint32_t j = 0; j < 4; j++)
      ws[128 * j] = 200 + j, ws[128 * j + 64] = 232 + j;
   VkShaderModule m;
   if (shader(cs, cs_words, &m))
      return 1;
   const VkDescriptorSetLayoutBinding b[3] = {
      { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 8, VK_SHADER_STAGE_COMPUTE_BIT },
      { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 4, VK_SHADER_STAGE_COMPUTE_BIT },
      { 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT },
   };
   const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                 .bindingCount = 3, .pBindings = b };
   VkDescriptorSetLayout dsl;
   CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
   const VkPushConstantRange range = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 128 };
   const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1,
                                            .pPushConstantRanges = &range };
   VkPipelineLayout layout;
   CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
   const VkComputePipelineCreateInfo ci = {
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
      .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                 .module = m, .pName = "main" },
   };
   VkPipeline pipeline;
   CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
   const VkDescriptorPoolSize ps[3] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 8 },
                                        { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 4 },
                                        { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 3, .pPoolSizes = ps };
   VkDescriptorPool dp;
   CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
   const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                             .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
   VkDescriptorSet set;
   CHECK(AllocateDescriptorSets(dev, &dai, &set));
   VkDescriptorBufferInfo ub[8], sb[4];
   for (uint32_t i = 0; i < 8; i++)
      ub[i] = (VkDescriptorBufferInfo){ ubo, 512 * i, 16 };
   for (uint32_t j = 0; j < 4; j++)
      sb[j] = (VkDescriptorBufferInfo){ ssbo, 512 * j, 16 };
   const VkDescriptorBufferInfo ob = { out, 0, 256 };
   const VkWriteDescriptorSet wr[3] = {
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 8,
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, .pBufferInfo = ub },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 4,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, .pBufferInfo = sb },
      { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 2, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &ob },
   };
   UpdateDescriptorSets(dev, 3, wr, 0, NULL);
   const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
                                .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
   CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
   for (uint32_t d = 0; d < 2; d++) {
      uint32_t offsets[12], push[32] = { 0 };
      for (uint32_t i = 0; i < 12; i++)
         offsets[i] = 256 * d;
      push[0] = 16 * d;
      push[31] = 1 + d;
      if (d)
         CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0,
                            NULL, 0, NULL);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 12, offsets);
      CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 128, push);
      CmdDispatch(cmd, 1, 1, 1);
   }
   return 0;
}

static int
t38_stores(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCmdClearColorImage CmdClearColorImage = (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCreateBufferView CreateBufferView = (PFN_vkCreateBufferView)GetDeviceProcAddr(dev, "vkCreateBufferView");
   PFN_vkCmdCopyBuffer CmdCopyBuffer = (PFN_vkCmdCopyBuffer)GetDeviceProcAddr(dev, "vkCmdCopyBuffer");
   const VkImageUsageFlags SU = VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
   VkImage srgb, packed, a8, vol;
   VkImageView srgb_v, packed_v, a8_v, s2, s3;
   VkBuffer tb, src;
   uint32_t *sb;
   if (t37_image(VK_IMAGE_TYPE_2D, VK_FORMAT_R8G8B8A8_SRGB, (VkExtent3D){ 1, 1, 1 }, 1, SU, 0, &srgb) ||
       t37_view(srgb, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R8G8B8A8_SRGB, 0, 1, &srgb_v) ||
       t37_image(VK_IMAGE_TYPE_2D, VK_FORMAT_R5G6B5_UNORM_PACK16, (VkExtent3D){ 2, 1, 1 }, 1, SU, 0, &packed) ||
       t37_view(packed, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R5G6B5_UNORM_PACK16, 0, 1, &packed_v) ||
       t37_image(VK_IMAGE_TYPE_2D, VK_FORMAT_A8_UNORM_KHR, (VkExtent3D){ 1, 1, 1 }, 1,
                 VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, 0, &a8) ||
       t37_view(a8, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_A8_UNORM_KHR, 0, 1, &a8_v) ||
       t37_image(VK_IMAGE_TYPE_3D, VK_FORMAT_R32_UINT, (VkExtent3D){ 1, 1, 4 }, 1, SU | VK_IMAGE_USAGE_SAMPLED_BIT,
                 VK_IMAGE_CREATE_2D_VIEW_COMPATIBLE_BIT_EXT, &vol) ||
       t37_view(vol, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R32_UINT, 2, 1, &s2) ||
       t37_view(vol, VK_IMAGE_VIEW_TYPE_2D, VK_FORMAT_R32_UINT, 3, 1, &s3) ||
       buffer(256, VK_BUFFER_USAGE_STORAGE_TEXEL_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT, false, &tb, NULL) ||
       buffer(256, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, true, &src, (void **)&sb))
      return 1;
   const VkBufferViewCreateInfo bvi = { .sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO, .buffer = tb,
                                        .format = VK_FORMAT_R8_UINT, .offset = 0, .range = 4 };
   VkBufferView tbv;
   CHECK(CreateBufferView(dev, &bvi, NULL, &tbv));
   const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO,
                                    .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                    .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
                                    .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE };
   VkSampler sampler;
   CHECK(CreateSampler(dev, &si, NULL, &sampler));
   CmdFillBuffer(cmd, tb, 0, 256, 0);
   const VkImageAspectFlags C = VK_IMAGE_ASPECT_COLOR_BIT;
   const VkImage all[] = { srgb, packed, a8, vol };
   for (uint32_t i = 0; i < 4; i++)
      t24_general(cmd, all[i], C, 1);
   const VkImageSubresourceRange cr = { C, 0, 1, 0, 1 };
   CmdClearColorImage(cmd, a8, VK_IMAGE_LAYOUT_GENERAL, &(VkClearColorValue){ .float32 = { 1, 1, 1, 0.5f } }, 1, &cr);
   for (uint32_t i = 0; i < 4; i++)
      sb[i] = 10 * (i + 1);
   const VkImageSubresourceLayers c1 = { C, 0, 0, 1 };
   CmdCopyBufferToImage(cmd, src, vol, VK_IMAGE_LAYOUT_GENERAL, 1,
                        &(VkBufferImageCopy){ .imageSubresource = c1, .imageExtent = { 1, 1, 4 } });
   static const VkDescriptorType types[7] = {
      VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,
      VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
      VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
   };
   struct t37_pipe p;
   if (t37_compute(cs, cs_words, types, 7, &p))
      return 1;
   const VkImageLayout G = VK_IMAGE_LAYOUT_GENERAL;
   const VkDescriptorImageInfo ii[5] = { { VK_NULL_HANDLE, srgb_v, G }, { VK_NULL_HANDLE, packed_v, G },
                                         { sampler, a8_v, G }, { sampler, s2, G }, { VK_NULL_HANDLE, s3, G } };
   const VkDescriptorBufferInfo bi = { out, 0, 16 };
   VkWriteDescriptorSet wr[7];
   for (uint32_t i = 0; i < 7; i++)
      wr[i] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = p.set, .dstBinding = i,
                                      .descriptorCount = 1, .descriptorType = types[i] };
   wr[0].pTexelBufferView = &tbv;
   for (uint32_t i = 1; i < 6; i++)
      wr[i].pImageInfo = &ii[i - 1];
   wr[6].pBufferInfo = &bi;
   UpdateDescriptorSets(dev, 7, wr, 0, NULL);
   t37_dispatch(cmd, &p);
   CmdCopyBuffer(cmd, tb, out, 1, &(VkBufferCopy){ 0, 256, 4 });
   CmdCopyImageToBuffer(cmd, srgb, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 512, .imageSubresource = c1, .imageExtent = { 1, 1, 1 } });
   CmdCopyImageToBuffer(cmd, packed, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 768, .imageSubresource = c1, .imageExtent = { 2, 1, 1 } });
   CmdCopyImageToBuffer(cmd, vol, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 1024, .imageSubresource = c1, .imageExtent = { 1, 1, 4 } });
   CmdCopyImageToBuffer(cmd, a8, G, out, 1, &(VkBufferImageCopy){ .bufferOffset = 1280, .imageSubresource = c1, .imageExtent = { 1, 1, 1 } });
   return 0;
}

EXPORT int
wgt_misc(uint32_t scenario, const uint32_t *cs, uint32_t cs_words)
{
   if (!dev && init())
      return 1;
   PFN_vkCmdCopyBuffer CmdCopyBuffer = (PFN_vkCmdCopyBuffer)GetDeviceProcAddr(dev, "vkCmdCopyBuffer");
   PFN_vkCmdUpdateBuffer CmdUpdateBuffer = (PFN_vkCmdUpdateBuffer)GetDeviceProcAddr(dev, "vkCmdUpdateBuffer");
   PFN_vkCmdClearColorImage CmdClearColorImage =
      (PFN_vkCmdClearColorImage)GetDeviceProcAddr(dev, "vkCmdClearColorImage");
   PFN_vkCmdBlitImage CmdBlitImage = (PFN_vkCmdBlitImage)GetDeviceProcAddr(dev, "vkCmdBlitImage");
   const VkBufferUsageFlags both = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
   VkBuffer out;
   if (buffer(scenario == 3 || scenario == 4 ? 20000 : scenario == 7 ? 4098 : 4096,
              both | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_STORAGE_TEXEL_BUFFER_BIT |
                 VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, true, &out,
              (void **)&misc.map))
      return 1;
   if (!misc.fence) {
      const VkFenceCreateInfo fi = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
      CHECK(CreateFence(dev, &fi, NULL, &misc.fence));
   } else {
      CHECK(ResetFences(dev, 1, &misc.fence));
   }
   VkCommandPool pool;
   const VkCommandPoolCreateInfo cpo = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
   CHECK(CreateCommandPool(dev, &cpo, NULL, &pool));
   VkCommandBuffer cmd;
   const VkCommandBufferAllocateInfo cbi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                             .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                             .commandBufferCount = 1 };
   CHECK(AllocateCommandBuffers(dev, &cbi, &cmd));
   const VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
   CHECK(BeginCommandBuffer(cmd, &begin));
   if (scenario == 92 || scenario == 93)
      memset(misc.map, 0xee, 4096); /* not a fill: the other queue's copy may run first, if it is wrong */
   else if (scenario != 3 && scenario != 4)
      CmdFillBuffer(cmd, out, 0, VK_WHOLE_SIZE, 0xeeeeeeee);
   if (scenario == 0) {
      VkBuffer src, local;
      uint8_t *s;
      if (buffer(8192, both, true, &src, (void **)&s) || buffer(4096, both, false, &local, NULL))
         return 1;
      for (uint32_t i = 0; i < 8192; i++)
         s[i] = (uint8_t)(i * 7 + 3);
      uint8_t update[16];
      for (uint32_t i = 0; i < 16; i++)
         update[i] = (uint8_t)(0x40 + i);
      CmdCopyBuffer(cmd, src, out, 1, &(VkBufferCopy){ 1, 6, 13 });
      CmdFillBuffer(cmd, local, 0, 4096, 0x04030201);
      CmdUpdateBuffer(cmd, local, 16, 16, update);
      CmdCopyBuffer(cmd, local, out, 1, &(VkBufferCopy){ 17, 101, 10 });
      CmdFillBuffer(cmd, src, 4096, 16, 0x0d0c0b0a);
      CmdCopyBuffer(cmd, src, out, 1, &(VkBufferCopy){ 4097, 203, 7 });
      CmdCopyBuffer(cmd, src, out, 1, &(VkBufferCopy){ 8, 300, 64 });
      CmdCopyBuffer(cmd, src, out, 1, &(VkBufferCopy){ 2, 1001, 3001 });
   } else if (scenario == 1) {
      VkImage e5, v3;
      const VkImageUsageFlags usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
      if (misc_image(VK_FORMAT_E5B9G9R9_UFLOAT_PACK32, VK_IMAGE_TYPE_2D, 1, usage, &e5) ||
          misc_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_3D, 2, usage, &v3))
         return 1;
      const VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
      const VkImageSubresourceLayers layer = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
      misc_barrier(cmd, e5, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
      CmdClearColorImage(cmd, e5, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                         &(VkClearColorValue){ .float32 = { 1, 0.5f, 0.25f, 0 } }, 1, &all);
      misc_barrier(cmd, e5, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
      CmdCopyImageToBuffer(cmd, e5, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1,
                           &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 1 } });
      misc_barrier(cmd, v3, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
      CmdClearColorImage(cmd, v3, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                         &(VkClearColorValue){ .float32 = { 0, 0, 1, 1 } }, 1, &all);
      misc_barrier(cmd, v3, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
      CmdCopyImageToBuffer(cmd, v3, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 256, .imageSubresource = layer,
                                                 .imageExtent = { 4, 4, 2 } });
   } else if (scenario == 2) {
      VkImage v3, flat;
      VkBuffer src;
      uint32_t *s;
      if (misc_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_3D, 2,
                     VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, &v3) ||
          misc_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_2D, 1,
                     VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, &flat) ||
          buffer(128, both, true, &src, (void **)&s))
         return 1;
      for (uint32_t i = 0; i < 32; i++)
         s[i] = i < 16 ? 0xff0000ff : 0xff00ff00;
      const VkImageSubresourceLayers layer = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
      misc_barrier(cmd, v3, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
      CmdCopyBufferToImage(cmd, src, v3, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1,
                           &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 2 } });
      misc_barrier(cmd, v3, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
      misc_barrier(cmd, flat, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
      const VkImageBlit blit = { .srcSubresource = layer, .srcOffsets = { { 0, 0, 1 }, { 4, 4, 2 } },
                                 .dstSubresource = layer, .dstOffsets = { { 0, 0, 0 }, { 4, 4, 1 } } };
      CmdBlitImage(cmd, v3, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, flat, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &blit,
                   VK_FILTER_NEAREST);
      misc_barrier(cmd, flat, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
      CmdCopyImageToBuffer(cmd, flat, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1,
                           &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 1 } });
   } else if (scenario == 21) {
      PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
      PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
      VkImage img;
      if (misc_image(VK_FORMAT_R8G8B8A8_UNORM, VK_IMAGE_TYPE_2D, 1, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, &img))
         return 1;
      const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img,
                                         .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_R8G8B8A8_UNORM,
                                         .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
      VkImageView view;
      CHECK(CreateImageView(dev, &vi, NULL, &view));
      const VkQueryPoolCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                         .queryType = VK_QUERY_TYPE_OCCLUSION, .queryCount = 4 };
      CHECK(CreateQueryPool(dev, &qi, NULL, &misc21_pool));
      CmdResetQueryPool(cmd, misc21_pool, 0, 4);
      const VkRenderingAttachmentInfo att = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = view,
         .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
         .storeOp = VK_ATTACHMENT_STORE_OP_STORE };
      const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { 4, 4 } },
                                   .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &att };
      CmdBeginRendering(cmd, &ri);
      for (uint32_t k = 0; k < 4; k++) {
         CmdBeginQuery(cmd, misc21_pool, k, 0);
         CmdEndQuery(cmd, misc21_pool, k);
      }
      CmdEndRendering(cmd);
   } else if (scenario == 13 || scenario == 19) {
      if (buffer(4096, both, true, &misc13.src, (void **)&misc13.bytes))
         return 1;
      memset(misc13.bytes, 0x11, 64);
      CmdCopyBuffer(cmd, misc13.src, out, 1, &(VkBufferCopy){ 0, 0, 64 });
   } else if (scenario == 92 || scenario == 93) {
      if (buffer(4096, both, true, &misc13.src, (void **)&misc13.bytes))
         return 1;
      memset(misc13.bytes, 0x33, 64);
      CmdCopyBuffer(cmd, misc13.src, out, 1, &(VkBufferCopy){ 0, 0, 64 });
   } else if (scenario == 8) {
      PFN_vkDestroyPipeline DestroyPipeline = (PFN_vkDestroyPipeline)GetDeviceProcAddr(dev, "vkDestroyPipeline");
      PFN_vkDestroyPipelineCache DestroyPipelineCache =
         (PFN_vkDestroyPipelineCache)GetDeviceProcAddr(dev, "vkDestroyPipelineCache");
      PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
         (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
      VkShaderModule m;
      if (shader(cs, cs_words, &m))
         return 1;
      const VkDescriptorSetLayoutBinding bindings[2] = {
         { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
         { 1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 2, .pBindings = bindings };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      const float two = 2;
      const VkSpecializationMapEntry entry = { 0, 0, 4 };
      const VkSpecializationInfo spec = { 1, &entry, 4, &two };
      VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      const VkPipelineCacheCreateInfo pci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO };
      VkPipelineCache ca, cb;
      CHECK(CreatePipelineCache(dev, &pci, NULL, &ca));
      VkPipeline a, b, c;
      CHECK(CreateComputePipelines(dev, ca, 1, &ci, NULL, &a));
      size_t size = 0;
      CHECK(GetPipelineCacheData(dev, ca, &size, NULL));
      void *data = malloc(size);
      CHECK(GetPipelineCacheData(dev, ca, &size, data));
      const VkPipelineCacheCreateInfo pcb = { .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO,
                                              .initialDataSize = size, .pInitialData = data };
      CHECK(CreatePipelineCache(dev, &pcb, NULL, &cb));
      free(data);
      CHECK(CreateComputePipelines(dev, cb, 1, &ci, NULL, &b));
      DestroyPipeline(dev, a, NULL);
      DestroyPipelineCache(dev, ca, NULL);
      ci.stage.pSpecializationInfo = &spec;
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &c));
      VkImage depth;
      if (misc_image(VK_FORMAT_D32_SFLOAT, VK_IMAGE_TYPE_2D, 1,
                     VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, &depth))
         return 1;
      const VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = depth,
                                         .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_D32_SFLOAT,
                                         .subresourceRange = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 } };
      VkImageView view;
      CHECK(CreateImageView(dev, &vi, NULL, &view));
      const VkSamplerCreateInfo si = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO };
      VkSampler sampler;
      CHECK(CreateSampler(dev, &si, NULL, &sampler));
      const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 },
                                           { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 } };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 2, .pPoolSizes = ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      const VkDescriptorBufferInfo bi = { out, 0, VK_WHOLE_SIZE };
      const VkDescriptorImageInfo ii = { sampler, view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
      const VkWriteDescriptorSet w[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &ii },
      };
      UpdateDescriptorSets(dev, 2, w, 0, NULL);
      const VkImageSubresourceRange range = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 };
      const VkImageMemoryBarrier to_dst = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                            .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                            .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                                            .newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, .image = depth,
                                            .subresourceRange = range };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1,
                         &to_dst);
      CmdClearDepthStencilImage(cmd, depth, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                                &(VkClearDepthStencilValue){ .depth = 0.25f }, 1, &range);
      const VkImageMemoryBarrier to_read = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                             .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                             .dstAccessMask = VK_ACCESS_SHADER_READ_BIT,
                                             .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                                             .newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, .image = depth,
                                             .subresourceRange = range };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 0, NULL, 0, NULL,
                         1, &to_read);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, b);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
      CmdDispatch(cmd, 1, 1, 1);
      (void)c;
   } else if (scenario == 16) {
      PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
         (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
      PFN_vkCmdCopyImage CmdCopyImage = (PFN_vkCmdCopyImage)GetDeviceProcAddr(dev, "vkCmdCopyImage");
      const VkImageUsageFlags usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                                      VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;
      VkImage d32, d32b, d24;
      VkBuffer src;
      uint8_t *sb;
      if (misc_image(VK_FORMAT_D32_SFLOAT, VK_IMAGE_TYPE_2D, 1, usage, &d32) ||
          misc_image(VK_FORMAT_D32_SFLOAT, VK_IMAGE_TYPE_2D, 1, usage, &d32b) ||
          misc_image(VK_FORMAT_X8_D24_UNORM_PACK32, VK_IMAGE_TYPE_2D, 1, usage, &d24) ||
          buffer(4096, both, true, &src, (void **)&sb))
         return 1;
      const float part[4] = { 0.25f, 0.5f, 0.75f, 0.125f };
      memcpy(sb, part, sizeof(part));
      for (uint32_t i = 0; i < 16; i++)
         ((uint32_t *)(sb + 256))[i] = (i * 0x111111u + 7) & 0xffffff;
      const VkImageSubresourceRange range = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 };
      const VkImageSubresourceLayers layer = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 0, 1 };
      VkImage all[3] = { d32, d32b, d24 };
      for (uint32_t k = 0; k < 3; k++) {
         const VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                          .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                          .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                                          .newLayout = VK_IMAGE_LAYOUT_GENERAL, .image = all[k],
                                          .subresourceRange = range };
         CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL,
                            1, &b);
      }
      CmdClearDepthStencilImage(cmd, d32, VK_IMAGE_LAYOUT_GENERAL, &(VkClearDepthStencilValue){ 1.0f, 0 }, 1, &range);
      CmdClearDepthStencilImage(cmd, d32b, VK_IMAGE_LAYOUT_GENERAL, &(VkClearDepthStencilValue){ 0.0f, 0 }, 1, &range);
      /* Into part of D32, and the whole of D24. */
      CmdCopyBufferToImage(cmd, src, d32, VK_IMAGE_LAYOUT_GENERAL, 1,
                           &(VkBufferImageCopy){ .bufferRowLength = 2, .imageSubresource = layer,
                                                 .imageOffset = { 1, 1, 0 }, .imageExtent = { 2, 2, 1 } });
      CmdCopyBufferToImage(cmd, src, d24, VK_IMAGE_LAYOUT_GENERAL, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 256, .imageSubresource = layer,
                                                 .imageExtent = { 4, 4, 1 } });
      /* D32's part into D32b's corner. */
      CmdCopyImage(cmd, d32, VK_IMAGE_LAYOUT_GENERAL, d32b, VK_IMAGE_LAYOUT_GENERAL, 1,
                   &(VkImageCopy){ .srcSubresource = layer, .srcOffset = { 1, 1, 0 }, .dstSubresource = layer,
                                   .extent = { 2, 2, 1 } });
      CmdCopyImageToBuffer(cmd, d32, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                           &(VkBufferImageCopy){ .imageSubresource = layer, .imageExtent = { 4, 4, 1 } });
      CmdCopyImageToBuffer(cmd, d32, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 256, .imageSubresource = layer,
                                                 .imageOffset = { 1, 1, 0 }, .imageExtent = { 2, 2, 1 } });
      CmdCopyImageToBuffer(cmd, d24, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 512, .imageSubresource = layer,
                                                 .imageExtent = { 4, 4, 1 } });
      CmdCopyImageToBuffer(cmd, d32b, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 1024, .imageSubresource = layer,
                                                 .imageExtent = { 4, 4, 1 } });
      /* Into part of a stencil image (the worker's draws, a bit each). */
      VkImage s8;
      if (misc_image(VK_FORMAT_S8_UINT, VK_IMAGE_TYPE_2D, 1, usage, &s8))
         return 1;
      const uint8_t bytes[4] = { 0x5a, 0xa5, 0x01, 0xfe };
      memcpy(sb + 512, bytes, 4);
      const VkImageSubresourceRange srange = { VK_IMAGE_ASPECT_STENCIL_BIT, 0, 1, 0, 1 };
      const VkImageSubresourceLayers slayer = { VK_IMAGE_ASPECT_STENCIL_BIT, 0, 0, 1 };
      const VkImageMemoryBarrier sb0 = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                         .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                         .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED, .newLayout = VK_IMAGE_LAYOUT_GENERAL,
                                         .image = s8, .subresourceRange = srange };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1,
                         &sb0);
      CmdClearDepthStencilImage(cmd, s8, VK_IMAGE_LAYOUT_GENERAL, &(VkClearDepthStencilValue){ 0, 0x33 }, 1, &srange);
      CmdCopyBufferToImage(cmd, src, s8, VK_IMAGE_LAYOUT_GENERAL, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 512, .bufferRowLength = 2, .imageSubresource = slayer,
                                                 .imageOffset = { 1, 1, 0 }, .imageExtent = { 2, 2, 1 } });
      CmdCopyImageToBuffer(cmd, s8, VK_IMAGE_LAYOUT_GENERAL, out, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 2048, .imageSubresource = slayer,
                                                 .imageExtent = { 4, 4, 1 } });
   } else if (scenario == 15) {
      VkShaderModule m;
      if (shader(cs, cs_words, &m))
         return 1;
      const VkDescriptorSetLayoutBinding binding = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT,
                                                     NULL };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 1, .pBindings = &binding };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      VkPipeline pipelines[6];
      for (uint32_t k = 0; k < 6; k++) {
         const uint32_t value = k + 1;
         const VkSpecializationMapEntry entry = { 0, 0, 4 };
         const VkSpecializationInfo spec = { 1, &entry, 4, &value };
         const VkComputePipelineCreateInfo ci = {
            .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
            .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                       .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = m, .pName = "main",
                       .pSpecializationInfo = &spec },
         };
         CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipelines[k]));
      }
      const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 1, .pPoolSizes = &ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      const VkDescriptorBufferInfo bi = { out, 0, 16 };
      const VkWriteDescriptorSet w = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set,
                                       .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                       .pBufferInfo = &bi };
      UpdateDescriptorSets(dev, 1, &w, 0, NULL);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
                                   .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_SHADER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
      for (uint32_t round = 0; round < 3; round++)
         for (uint32_t k = 0; k < 6; k++) {
            CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                               VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0, NULL);
            CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipelines[k]);
            CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
            CmdDispatch(cmd, 1, 1, 1);
         }
   } else if (scenario == 22) {
      /* VK3 L7.2: a disjoint NV12 image (G8_B8R8_2PLANE_420, 4×4), its planes in memories of their own and uploaded
       * apart, sampled at each texel's centre through an immutable sampler with a YCbCr conversion (BT.709, narrow,
       * chroma at the midpoint, nearest): the result's 16 vec4s at `out`'s start (tests/venus/l7/ycbcr.comp). */
      PFN_vkCreateSamplerYcbcrConversion CreateConversion =
         (PFN_vkCreateSamplerYcbcrConversion)GetDeviceProcAddr(dev, "vkCreateSamplerYcbcrConversion");
      PFN_vkGetImageMemoryRequirements2 GetImageMemoryRequirements2 =
         (PFN_vkGetImageMemoryRequirements2)GetDeviceProcAddr(dev, "vkGetImageMemoryRequirements2");
      PFN_vkBindImageMemory2 BindImageMemory2 = (PFN_vkBindImageMemory2)GetDeviceProcAddr(dev, "vkBindImageMemory2");
      const VkFormat nv12 = VK_FORMAT_G8_B8R8_2PLANE_420_UNORM;
      VkShaderModule m;
      VkBuffer src;
      uint8_t *sb;
      if (shader(cs, cs_words, &m) || buffer(4096, both, true, &src, (void **)&sb))
         return 1;
      for (uint32_t i = 0; i < 16; i++)
         sb[i] = (uint8_t)(16 + i * 13);
      const uint8_t chroma[8] = { 60, 200, 128, 128, 200, 60, 90, 170 };
      memcpy(sb + 256, chroma, 8);
      const VkSamplerYcbcrConversionCreateInfo yci = {
         .sType = VK_STRUCTURE_TYPE_SAMPLER_YCBCR_CONVERSION_CREATE_INFO, .format = nv12,
         .ycbcrModel = VK_SAMPLER_YCBCR_MODEL_CONVERSION_YCBCR_709, .ycbcrRange = VK_SAMPLER_YCBCR_RANGE_ITU_NARROW,
         .xChromaOffset = VK_CHROMA_LOCATION_MIDPOINT, .yChromaOffset = VK_CHROMA_LOCATION_MIDPOINT,
         .chromaFilter = VK_FILTER_NEAREST,
      };
      VkSamplerYcbcrConversion conv;
      CHECK(CreateConversion(dev, &yci, NULL, &conv));
      const VkSamplerYcbcrConversionInfo with = { .sType = VK_STRUCTURE_TYPE_SAMPLER_YCBCR_CONVERSION_INFO,
                                                  .conversion = conv };
      const VkSamplerCreateInfo sci = {
         .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .pNext = &with, .magFilter = VK_FILTER_NEAREST,
         .minFilter = VK_FILTER_NEAREST, .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
         .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
      };
      VkSampler sampler;
      CHECK(CreateSampler(dev, &sci, NULL, &sampler));
      const VkImageCreateInfo ici = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = VK_IMAGE_CREATE_DISJOINT_BIT,
         .imageType = VK_IMAGE_TYPE_2D, .format = nv12, .extent = { 4, 4, 1 }, .mipLevels = 1, .arrayLayers = 1,
         .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
         .usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
      };
      VkImage img;
      CHECK(CreateImage(dev, &ici, NULL, &img));
      VkBindImageMemoryInfo binds[2];
      VkBindImagePlaneMemoryInfo planes[2];
      for (uint32_t p = 0; p < 2; p++) {
         const VkImageAspectFlagBits aspect = p ? VK_IMAGE_ASPECT_PLANE_1_BIT : VK_IMAGE_ASPECT_PLANE_0_BIT;
         const VkImagePlaneMemoryRequirementsInfo pri = {
            .sType = VK_STRUCTURE_TYPE_IMAGE_PLANE_MEMORY_REQUIREMENTS_INFO, .planeAspect = aspect };
         const VkImageMemoryRequirementsInfo2 ri = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_REQUIREMENTS_INFO_2,
                                                     .pNext = &pri, .image = img };
         VkMemoryRequirements2 req = { .sType = VK_STRUCTURE_TYPE_MEMORY_REQUIREMENTS_2 };
         GetImageMemoryRequirements2(dev, &ri, &req);
         VkDeviceMemory mem;
         if (memory_for(req.memoryRequirements, false, &mem, NULL))
            return 1;
         planes[p] = (VkBindImagePlaneMemoryInfo){ .sType = VK_STRUCTURE_TYPE_BIND_IMAGE_PLANE_MEMORY_INFO,
                                                   .planeAspect = aspect };
         binds[p] = (VkBindImageMemoryInfo){ .sType = VK_STRUCTURE_TYPE_BIND_IMAGE_MEMORY_INFO, .pNext = &planes[p],
                                             .image = img, .memory = mem };
      }
      CHECK(BindImageMemory2(dev, 2, binds));
      const VkImageViewCreateInfo vci = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .pNext = &with, .image = img,
         .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = nv12, .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 },
      };
      VkImageView view;
      CHECK(CreateImageView(dev, &vci, NULL, &view));
      const VkImageMemoryBarrier tb = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                        .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                        .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                                        .newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, .image = img,
                                        .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1,
                         &tb);
      const VkBufferImageCopy regions[2] = {
         { .bufferOffset = 0, .imageSubresource = { VK_IMAGE_ASPECT_PLANE_0_BIT, 0, 0, 1 }, .imageExtent = { 4, 4, 1 } },
         { .bufferOffset = 256, .imageSubresource = { VK_IMAGE_ASPECT_PLANE_1_BIT, 0, 0, 1 }, .imageExtent = { 2, 2, 1 } },
      };
      CmdCopyBufferToImage(cmd, src, img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 2, regions);
      const VkImageMemoryBarrier sbar = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                          .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                          .dstAccessMask = VK_ACCESS_SHADER_READ_BIT,
                                          .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                                          .newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, .image = img,
                                          .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 0, NULL, 0, NULL,
                         1, &sbar);
      const VkDescriptorSetLayoutBinding bindings[2] = {
         { 0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_COMPUTE_BIT, &sampler },
         { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 2, .pBindings = bindings };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      VkPipeline pipeline;
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
      const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 2 },
                                           { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 2, .pPoolSizes = ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      const VkDescriptorImageInfo ii = { .imageView = view, .imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
      const VkDescriptorBufferInfo bi = { out, 0, 256 };
      const VkWriteDescriptorSet w[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &ii },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
      };
      UpdateDescriptorSets(dev, 2, w, 0, NULL);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_SHADER_WRITE_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                         NULL);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
      CmdDispatch(cmd, 1, 1, 1);
   } else if (scenario == 14) {
      PFN_vkCreateBufferView CreateBufferView = (PFN_vkCreateBufferView)GetDeviceProcAddr(dev, "vkCreateBufferView");
      VkShaderModule m;
      VkBuffer src;
      uint8_t *sb;
      if (shader(cs, cs_words, &m) || buffer(4096, both | VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT, true, &src, (void **)&sb))
         return 1;
      for (uint32_t i = 0; i < 4096; i++)
         sb[i] = (uint8_t)(i * 7 + 3);
      VkDescriptorSetLayoutBinding bindings[6];
      for (uint32_t b = 0; b < 6; b++)
         bindings[b] = (VkDescriptorSetLayoutBinding){
            b, b < 4 ? VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER : b == 4 ? VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER
                                                                        : VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
            1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 6, .pBindings = bindings };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      VkPipeline pipeline;
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
      const VkDescriptorPoolSize ps[3] = { { VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 4 },
                                           { VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 1 },
                                           { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 3, .pPoolSizes = ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      /* The views: of `src` at 0, 256, 512, 768 (16 texels each), and of the result at 2048 (16 texels). */
      const VkFormat formats[5] = { VK_FORMAT_B8G8R8A8_UNORM, VK_FORMAT_R16_SINT, VK_FORMAT_A2B10G10R10_UINT_PACK32,
                                    VK_FORMAT_R8G8B8_SNORM, VK_FORMAT_R16G16B16A16_SFLOAT };
      const VkDeviceSize ranges[5] = { 64, 32, 64, 48, 128 };
      VkBufferView views[5];
      for (uint32_t b = 0; b < 5; b++) {
         const VkBufferViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO,
                                             .buffer = b < 4 ? src : out, .format = formats[b],
                                             .offset = b < 4 ? 256 * b : 2048, .range = ranges[b] };
         CHECK(CreateBufferView(dev, &vi, NULL, &views[b]));
      }
      const VkDescriptorBufferInfo bi = { out, 0, 2048 };
      const VkWriteDescriptorSet w[3] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 4,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, .pTexelBufferView = views },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 4, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, .pTexelBufferView = &views[4] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 5, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi },
      };
      UpdateDescriptorSets(dev, 3, w, 0, NULL);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                         NULL);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
      CmdDispatch(cmd, 1, 1, 1);
   } else if (scenario == 17 || scenario == 18 || (scenario >= 33 && scenario <= 35)) {
      PFN_vkCmdDispatchIndirect CmdDispatchIndirect =
         (PFN_vkCmdDispatchIndirect)GetDeviceProcAddr(dev, "vkCmdDispatchIndirect");
      VkShaderModule m;
      VkBuffer in;
      uint32_t *w;
      if (shader(cs, cs_words, &m) ||
          buffer(1024, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT |
                          VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, true, &in, (void **)&w))
         return 1;
      w[0] = 100;
      for (uint32_t i = 0; i < 4; i++)
         w[64 + i] = i + 1;
      w[128] = w[129] = w[130] = 1;
      const VkDescriptorSetLayoutBinding bindings[3] = {
         { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
         { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
         { 2, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 3, .pBindings = bindings };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      VkPipeline pipeline;
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
      const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1 },
                                           { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 2 } };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 2, .pPoolSizes = ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      /* VK4 T3: 33 the uniform in the result's memory (100 at 256), 34 the indirect arguments there (1, 1, 1 at 512),
       * 35 `a` there over the very words `b` writes (1, 2, 3, 4 at 0), each written by the submit. */
      if (scenario >= 33) {
         static const uint32_t k[1] = { 100 }, args[3] = { 1, 1, 1 }, a[4] = { 1, 2, 3, 4 };
         if (scenario == 33)
            CmdUpdateBuffer(cmd, out, 256, sizeof(k), k);
         else if (scenario == 34)
            CmdUpdateBuffer(cmd, out, 512, sizeof(args), args);
         else
            CmdUpdateBuffer(cmd, out, 0, sizeof(a), a);
      }
      const VkDescriptorBufferInfo bi[3] = { scenario == 33 ? (VkDescriptorBufferInfo){ out, 256, 16 }
                                                            : (VkDescriptorBufferInfo){ in, 0, 16 },
                                             scenario == 35 ? (VkDescriptorBufferInfo){ out, 0, 16 }
                                                            : (VkDescriptorBufferInfo){ in, 256, 16 },
                                             { out, 0, 16 } };
      const VkWriteDescriptorSet wr[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &bi[0] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 2,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[1] },
      };
      UpdateDescriptorSets(dev, 2, wr, 0, NULL);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT |
                                                    VK_ACCESS_UNIFORM_READ_BIT | VK_ACCESS_INDIRECT_COMMAND_READ_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL,
                         0, NULL);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
      if (scenario == 18 || scenario == 34)
         CmdDispatchIndirect(cmd, scenario == 18 ? in : out, 512);
      else
         CmdDispatch(cmd, 1, 1, 1);
   } else if ((scenario >= 24 && scenario <= 29) || scenario == 32 || scenario == 77 || scenario == 91 || scenario == 113) {
      if (l7a_misc(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 30 || scenario == 31) {
      if (l8a_misc(scenario, cmd, out))
         return 1;
   } else if (scenario == 36 || scenario == 37) {
      if (t10_misc(scenario, cmd, out))
         return 1;
   } else if (scenario == 38) {
      if (t4_misc(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 94) {
      if (t23_misc(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 95) {
      if (t24_misc(cmd, out))
         return 1;
   } else if (scenario == 96) {
      if (t30_misc(cmd, out))
         return 1;
   } else if (scenario == 97) {
      if (t31_misc(cmd, out))
         return 1;
   } else if (scenario == 98) {
      if (t32_misc(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 117) {
      if (t43_wrapped(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 118 || scenario == 119) {
      if (t43_mapped(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 122) {
      if (t43_layered(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 123) {
      if (t43_push_layers(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 124) {
      if (t44_fan_past(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 99) {
      if (t32_loop(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 100) {
      if (t32_ms(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 101) {
      if (t34_misc(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 102) {
      if (t37_flat(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 103) {
      if (t37_read_written(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 104) {
      if (t37_big_packed(cmd, out))
         return 1;
   } else if (scenario == 105) {
      if (t37_words_past(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 106) {
      if (t37_mismatched(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 107) {
      if (t37_uniform_tail(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 109) {
      if (t38_misc(cmd, out))
         return 1;
   } else if (scenario == 110) {
      if (t38_stores(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 111) {
      if (t39_resolves(cmd, out))
         return 1;
   } else if (scenario == 112) {
      if (t39_ms_bits(cmd, out))
         return 1;
   } else if (scenario == 114) {
      if (t40_dynamic(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 108) {
      if (t37_atomic_alias(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 41 || scenario == 42) {
      if (t11_misc(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 84) {
      if (g4_misc(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 85 || scenario == 90) {
      if (g4_views(cs, cs_words, cmd, out, scenario == 90))
         return 1;
   } else if (scenario == 86 || scenario == 87) {
      if (g4_limits(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 88 || scenario == 89) {
      static const VkFormat g5[3] = { VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8G8_UNORM, VK_FORMAT_R32_SFLOAT };
      static const VkFormat g7[3] = { VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_R8_UNORM, VK_FORMAT_R32_SFLOAT };
      if (g5_formatless(cs, cs_words, cmd, out, scenario == 88 ? g5 : g7))
         return 1;
   } else if (scenario == 39 || scenario == 43 || scenario == 116 || scenario == 120) {
      if (t7_addresses(cs, cs_words, cmd, pool, scenario == 43, scenario == 116 || scenario == 120))
         return 1;
   } else if (scenario == 115) {
      if (t41_regions(cs, cs_words, cmd, pool))
         return 1;
   } else if (scenario == 121) {
      if (t41_full(cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 53) {
      if (r4_resolve(cmd, out))
         return 1;
   } else if (scenario == 52 || (scenario >= 55 && scenario <= 59) || scenario == 63 || scenario == 64) {
      if (r4_misc(scenario, cmd, out))
         return 1;
   } else if (scenario == 76) {
      if (t7_inline(cs, cs_words, cmd, out, 4096))
         return 1;
   } else if ((scenario >= 70 && scenario <= 75) || (scenario >= 78 && scenario <= 83)) {
      if (r5_misc(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if (scenario >= 47 && scenario <= 49) {
      if (r3_misc(scenario, cmd, out))
         return 1;
   } else if (scenario == 50 || scenario == 51) {
      if (r3_feedback(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if ((scenario >= 44 && scenario <= 46) || scenario == 60 || scenario == 61) {
      if (r2_misc(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 40) {
      if (t7_inline(cs, cs_words, cmd, out, 16))
         return 1;
   } else if (scenario == 23) {
      /* More uniform buffers than WebGPU binds a stage (VK3 L7.4): the device's maximum, 13 or more. */
      PFN_vkGetPhysicalDeviceProperties GetProps =
         (PFN_vkGetPhysicalDeviceProperties)vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceProperties");
      VkPhysicalDevice pdev;
      uint32_t n = 1;
      CHECK(EnumeratePhysicalDevices(instance, &n, &pdev));
      VkPhysicalDeviceProperties props;
      GetProps(pdev, &props);
      if (props.limits.maxPerStageDescriptorUniformBuffers < 13) {
         snprintf(error, sizeof(error), "maxPerStageDescriptorUniformBuffers %u",
                  props.limits.maxPerStageDescriptorUniformBuffers);
         return 1;
      }
      VkShaderModule m;
      VkBuffer in;
      uint32_t *w;
      if (shader(cs, cs_words, &m) || buffer(4096, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, true, &in, (void **)&w))
         return 1;
      for (uint32_t i = 0; i < 13; i++)
         w[64 * i] = 100 + i;
      const VkDescriptorSetLayoutBinding bindings[2] = {
         { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 13, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
         { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 2, .pBindings = bindings };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPushConstantRange range = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 128 };
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl,
                                               .pushConstantRangeCount = 1, .pPushConstantRanges = &range };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      VkPipeline pipeline;
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
      const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 13 },
                                           { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 } };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 2, .pPoolSizes = ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      VkDescriptorBufferInfo bi[14];
      for (uint32_t i = 0; i < 13; i++)
         bi[i] = (VkDescriptorBufferInfo){ in, 256 * i, 16 };
      bi[13] = (VkDescriptorBufferInfo){ out, 0, 64 };
      const VkWriteDescriptorSet wr[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 13,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &bi[0] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[13] },
      };
      UpdateDescriptorSets(dev, 2, wr, 0, NULL);
      uint32_t push[32] = { 0 };
      push[31] = 5;
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_SHADER_WRITE_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                         NULL);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
      CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 128, push);
      CmdDispatch(cmd, 1, 1, 1);
   } else if (scenario == 12) {
      VkShaderModule m;
      if (shader(cs, cs_words, &m))
         return 1;
      const VkDescriptorSetLayoutBinding bindings[2] = {
         { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
         { 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 2, .pBindings = bindings };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      VkPipeline pipeline;
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
      const VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 2 };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 1, .pPoolSizes = &ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      const VkDescriptorBufferInfo bi[2] = { { out, 512, 16 }, { out, 0, 16 } };
      const VkWriteDescriptorSet w = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set,
                                       .descriptorCount = 2, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                       .pBufferInfo = bi };
      UpdateDescriptorSets(dev, 1, &w, 0, NULL);
      const uint32_t a[4] = { 1, 2, 3, 4 };
      CmdUpdateBuffer(cmd, out, 512, sizeof(a), a);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                         NULL);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
      CmdDispatch(cmd, 1, 1, 1);
   } else if (scenario == 11) {
      PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
      PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
      PFN_vkCmdClearDepthStencilImage CmdClearDepthStencilImage =
         (PFN_vkCmdClearDepthStencilImage)GetDeviceProcAddr(dev, "vkCmdClearDepthStencilImage");
      const VkImageAspectFlags both_aspects = VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT;
      VkImage img[2];
      VkImageView view[2];
      for (uint32_t k = 0; k < 2; k++) {
         const VkImageCreateInfo info = {
            .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D,
            .format = VK_FORMAT_D32_SFLOAT_S8_UINT, .extent = { 4, 4, 1 }, .mipLevels = 1, .arrayLayers = 1,
            .samples = k ? VK_SAMPLE_COUNT_1_BIT : VK_SAMPLE_COUNT_4_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
            .usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                     (k ? VK_IMAGE_USAGE_TRANSFER_SRC_BIT : 0),
         };
         CHECK(CreateImage(dev, &info, NULL, &img[k]));
         VkMemoryRequirements req;
         GetImageMemoryRequirements(dev, img[k], &req);
         VkDeviceMemory mem;
         if (memory_for(req, false, &mem, NULL))
            return 1;
         CHECK(BindImageMemory(dev, img[k], mem, 0));
         const VkImageViewCreateInfo vi = {
            .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img[k],
            .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_D32_SFLOAT_S8_UINT,
            .subresourceRange = { both_aspects, 0, 1, 0, 1 } };
         CHECK(CreateImageView(dev, &vi, NULL, &view[k]));
         const VkImageSubresourceRange range = { both_aspects, 0, 1, 0, 1 };
         VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                    .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                    .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
                                    .newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, .image = img[k],
                                    .subresourceRange = range };
         CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL,
                            1, &b);
         const VkClearDepthStencilValue v = k ? (VkClearDepthStencilValue){ 1.0f, 0x33 }
                                              : (VkClearDepthStencilValue){ 0.25f, 0x5a };
         CmdClearDepthStencilImage(cmd, img[k], VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &v, 1, &range);
         b.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
         b.dstAccessMask = VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_READ_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
         b.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
         b.newLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
         CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT, 0, 0, NULL,
                            0, NULL, 1, &b);
      }
      const VkRenderingAttachmentInfo att = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = view[0],
         .imageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL, .resolveMode = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT,
         .resolveImageView = view[1], .resolveImageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
         .loadOp = VK_ATTACHMENT_LOAD_OP_LOAD, .storeOp = VK_ATTACHMENT_STORE_OP_STORE };
      const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { 2, 2 } },
                                   .layerCount = 1, .pDepthAttachment = &att, .pStencilAttachment = &att };
      CmdBeginRendering(cmd, &ri);
      CmdEndRendering(cmd);
      const VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                       .srcAccessMask = VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT,
                                       .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
                                       .oldLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
                                       .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, .image = img[1],
                                       .subresourceRange = { both_aspects, 0, 1, 0, 1 } };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0,
                         NULL, 1, &b);
      CmdCopyImageToBuffer(cmd, img[1], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1,
                           &(VkBufferImageCopy){ .imageSubresource = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 0, 1 },
                                                 .imageExtent = { 4, 4, 1 } });
      CmdCopyImageToBuffer(cmd, img[1], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 256,
                                                 .imageSubresource = { VK_IMAGE_ASPECT_STENCIL_BIT, 0, 0, 1 },
                                                 .imageExtent = { 4, 4, 1 } });
   } else if (scenario == 9 || scenario == 10) {
      PFN_vkCmdBeginRendering CmdBeginRendering = (PFN_vkCmdBeginRendering)GetDeviceProcAddr(dev, "vkCmdBeginRendering");
      PFN_vkCmdEndRendering CmdEndRendering = (PFN_vkCmdEndRendering)GetDeviceProcAddr(dev, "vkCmdEndRendering");
      VkImage img[2];
      VkImageView view[2];
      for (uint32_t k = 0; k < 2; k++) {
         const VkImageCreateInfo info = {
            .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D,
            .format = VK_FORMAT_D32_SFLOAT_S8_UINT, .extent = { 4, 4, 1 }, .mipLevels = 1, .arrayLayers = 1,
            .samples = k ? VK_SAMPLE_COUNT_1_BIT : VK_SAMPLE_COUNT_4_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
            .usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | (k ? VK_IMAGE_USAGE_TRANSFER_SRC_BIT : 0),
         };
         CHECK(CreateImage(dev, &info, NULL, &img[k]));
         VkMemoryRequirements req;
         GetImageMemoryRequirements(dev, img[k], &req);
         VkDeviceMemory mem;
         if (memory_for(req, false, &mem, NULL))
            return 1;
         CHECK(BindImageMemory(dev, img[k], mem, 0));
         const VkImageViewCreateInfo vi = {
            .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img[k], .viewType = VK_IMAGE_VIEW_TYPE_2D,
            .format = VK_FORMAT_D32_SFLOAT_S8_UINT,
            .subresourceRange = { VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT, 0, 1, 0, 1 } };
         CHECK(CreateImageView(dev, &vi, NULL, &view[k]));
      }
      const VkRenderingAttachmentInfo att = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = view[0],
         .imageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL, .resolveMode = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT,
         .resolveImageView = view[1], .resolveImageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
         .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
         .storeOp = scenario == 10 ? VK_ATTACHMENT_STORE_OP_DONT_CARE : VK_ATTACHMENT_STORE_OP_STORE,
         .clearValue = { .depthStencil = { 0.25f, 0x5a } } };
      const VkRenderingInfo ri = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { 4, 4 } },
                                   .layerCount = 1, .pDepthAttachment = &att, .pStencilAttachment = &att };
      CmdBeginRendering(cmd, &ri);
      CmdEndRendering(cmd);
      const VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                                       .srcAccessMask = VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT,
                                       .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
                                       .oldLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
                                       .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, .image = img[1],
                                       .subresourceRange = { VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT, 0, 1, 0, 1 } };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0,
                         NULL, 1, &b);
      CmdCopyImageToBuffer(cmd, img[1], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1,
                           &(VkBufferImageCopy){ .imageSubresource = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 0, 1 },
                                                 .imageExtent = { 4, 4, 1 } });
      CmdCopyImageToBuffer(cmd, img[1], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out, 1,
                           &(VkBufferImageCopy){ .bufferOffset = 256,
                                                 .imageSubresource = { VK_IMAGE_ASPECT_STENCIL_BIT, 0, 0, 1 },
                                                 .imageExtent = { 4, 4, 1 } });
   } else if (scenario == 5) {
      PFN_vkFreeMemory FreeMemory = (PFN_vkFreeMemory)GetDeviceProcAddr(dev, "vkFreeMemory");
      const VkImageCreateInfo info = {
         .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = VK_FORMAT_R8G8B8A8_UNORM,
         .extent = { 4, 4, 1 }, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
         .tiling = VK_IMAGE_TILING_LINEAR, .usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT,
      };
      VkImage linear;
      CHECK(CreateImage(dev, &info, NULL, &linear));
      VkMemoryRequirements req;
      GetImageMemoryRequirements(dev, linear, &req);
      VkDeviceMemory mem;
      void *m;
      if (memory_for(req, true, &mem, &m))
         return 1;
      CHECK(BindImageMemory(dev, linear, mem, 0));
      FreeMemory(dev, mem, NULL);
      /* The next memory made at once, of the same size: the freed one's place. */
      VkDeviceMemory mem2;
      if (memory_for(req, true, &mem2, (void **)&misc.map))
         return 1;
      const VkBufferCreateInfo bi = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = req.size, .usage = both };
      VkBuffer b;
      CHECK(CreateBuffer(dev, &bi, NULL, &b));
      CHECK(BindBufferMemory(dev, b, mem2, 0));
      memset(misc.map, 0x5a, req.size);
      CmdFillBuffer(cmd, b, 0, VK_WHOLE_SIZE, 0x11111111);
   } else {
      VkShaderModule m;
      if (shader(cs, cs_words, &m))
         return 1;
      const VkDescriptorType type =
         scenario == 6 ? VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC : VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
      const VkDescriptorSetLayoutBinding binding = { 0, type, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
      const VkDescriptorSetLayoutCreateInfo dli = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                                    .bindingCount = 1, .pBindings = &binding };
      VkDescriptorSetLayout dsl;
      CHECK(CreateDescriptorSetLayout(dev, &dli, NULL, &dsl));
      const VkPushConstantRange range = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 128 };
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                               .setLayoutCount = 1, .pSetLayouts = &dsl,
                                               .pushConstantRangeCount = 1, .pPushConstantRanges = &range };
      VkPipelineLayout layout;
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &layout));
      const VkComputePipelineCreateInfo ci = {
         .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, .layout = layout,
         .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                    .module = m, .pName = "main" },
      };
      VkPipeline pipeline;
      CHECK(CreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, NULL, &pipeline));
      const VkDescriptorPoolSize ps = { type, 1 };
      const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                               .poolSizeCount = 1, .pPoolSizes = &ps };
      VkDescriptorPool dp;
      CHECK(CreateDescriptorPool(dev, &dpi, NULL, &dp));
      const VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                                .descriptorPool = dp, .descriptorSetCount = 1, .pSetLayouts = &dsl };
      VkDescriptorSet set;
      CHECK(AllocateDescriptorSets(dev, &dai, &set));
      const VkDescriptorBufferInfo bi = { out, 0, scenario == 6 ? 64 : VK_WHOLE_SIZE };
      const VkWriteDescriptorSet w = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set,
                                       .descriptorCount = 1, .descriptorType = type, .pBufferInfo = &bi };
      const uint32_t dynamic = 256;
      UpdateDescriptorSets(dev, 1, &w, 0, NULL);
      uint32_t push[32] = { 0 };
      if (scenario == 4) {
         VkCommandBuffer first;
         CHECK(AllocateCommandBuffers(dev, &cbi, &first));
         CHECK(BeginCommandBuffer(first, &begin));
         CmdBindPipeline(first, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
         CmdBindDescriptorSets(first, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
         CmdPushConstants(first, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 128, push);
         CmdDispatch(first, 1, 1, 1);
         CHECK(EndCommandBuffer(first));
         const VkSubmitInfo si = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                   .pCommandBuffers = &first };
         CHECK(QueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
      }
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, scenario == 6, &dynamic);
      VkQueryPool qp = VK_NULL_HANDLE;
      if (scenario == 20) {
         const VkQueryPoolCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                            .queryType = VK_QUERY_TYPE_OCCLUSION, .queryCount = 1 };
         CHECK(CreateQueryPool(dev, &qi, NULL, &qp));
         CmdResetQueryPool(cmd, qp, 0, 1);
         CmdBeginQuery(cmd, qp, 0, 0);
      }
      for (uint32_t k = 0; k < (scenario >= 6 ? 4 : 5000); k++) {
         push[28] = k;
         CmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 128, push);
         CmdDispatch(cmd, 1, 1, 1);
      }
      if (scenario == 20) {
         CmdEndQuery(cmd, qp, 0);
         CmdCopyQueryPoolResults(cmd, qp, 0, 1, out, 1024, 4, VK_QUERY_RESULT_WAIT_BIT);
      }
   }
   CHECK(EndCommandBuffer(cmd));
   if (scenario == 92 || scenario == 93) {
      if (two_queues(scenario, cmd, out))
         return 1;
      return 0;
   }
   if (scenario == 13 || scenario == 19) {
      PFN_vkCreateSemaphore CreateSemaphore = (PFN_vkCreateSemaphore)GetDeviceProcAddr(dev, "vkCreateSemaphore");
      PFN_vkSignalSemaphore SignalSemaphore = (PFN_vkSignalSemaphore)GetDeviceProcAddr(dev, "vkSignalSemaphore");
      const VkSemaphoreTypeCreateInfo type = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
                                               .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE };
      const VkSemaphoreCreateInfo sci = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, .pNext = &type };
      VkSemaphore sem;
      CHECK(CreateSemaphore(dev, &sci, NULL, &sem));
      const uint64_t one = 1;
      const VkTimelineSemaphoreSubmitInfo tsi = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
                                                  .waitSemaphoreValueCount = 1, .pWaitSemaphoreValues = &one };
      const VkPipelineStageFlags stage = VK_PIPELINE_STAGE_TRANSFER_BIT;
      const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &tsi, .waitSemaphoreCount = 1,
                                    .pWaitSemaphores = &sem, .pWaitDstStageMask = &stage, .commandBufferCount = 1,
                                    .pCommandBuffers = &cmd };
      if (scenario == 19) {
         /* The copy held; then a submit of a fence alone, which the test polls before it signals (wgt_misc_signal). */
         CHECK(QueueSubmit(queue, 1, &submit, VK_NULL_HANDLE));
         CHECK(QueueSubmit(queue, 0, NULL, misc.fence));
         misc13.sem = sem;
         return 0;
      }
      CHECK(QueueSubmit(queue, 1, &submit, misc.fence));
      memset(misc13.bytes, 0x22, 64);
      const VkSemaphoreSignalInfo signal = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = sem,
                                             .value = 1 };
      CHECK(SignalSemaphore(dev, &signal));
      return 0;
   }
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, misc.fence));
   if (scenario == 21) {
      DestroyQueryPool(dev, misc21_pool, NULL);
      misc.pool_refs = wg_submits_pool_refs((const void *)(uintptr_t)misc21_pool);
   }
   return 0;
}

EXPORT int
wgt_misc_pool_refs(void)
{
   return misc.pool_refs;
}

EXPORT uint8_t *
wgt_misc_map(void)
{
   return misc.map;
}

/* wg_shader.c's merge of stages that came with different programs: whether it refuses stages that disagree on a
 * resource and keeps those that agree (3; VK4 T37). */
EXPORT int
wgt_merge_refused(void)
{
   return wg_merge_refuses();
}

/* wg_shader.c's look at a shader store's counts: whether it refuses a count past its array. */
EXPORT int
wgt_info_refused(void)
{
   return !wg_counts_sane(0, 0, 0, 1000);
}

EXPORT int
wgt_misc_done(void)
{
   return misc.fence && GetFenceStatus(dev, misc.fence) == VK_SUCCESS;
}

/* Scenario 19's host signal: the source written 0x22, then the timeline's value 1 signalled. */
EXPORT int
wgt_misc_signal(void)
{
   PFN_vkSignalSemaphore SignalSemaphore = (PFN_vkSignalSemaphore)GetDeviceProcAddr(dev, "vkSignalSemaphore");
   memset(misc13.bytes, 0x22, 64);
   const VkSemaphoreSignalInfo signal = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = misc13.sem,
                                          .value = 1 };
   CHECK(SignalSemaphore(dev, &signal));
   return 0;
}
