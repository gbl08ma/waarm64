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
int wgt_misc_done(void);
int wgt_misc_signal(void);
int wgt_misc_pool_refs(void);
int wgt_fits(uint32_t scenario, const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words);
int wgt_samples(const uint32_t *vs, uint32_t vs_words, const uint32_t *fs, uint32_t fs_words);
/* wg_cmd.c: the pending submits' references to a query pool (destroyed or not). */
int wg_submits_pool_refs(const void *pool);
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
FN(CmdCopyQueryPoolResults);

static VkInstance instance;
static VkDevice dev;
static VkQueue queue;
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
   const VkDeviceQueueCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1,
                                        .pQueuePriorities = &priority };
   /* wgt_import's: dma-buf memory and the LINEAR modifier. */
   const char *exts[] = { "VK_KHR_external_memory_fd", "VK_EXT_external_memory_dma_buf",
                          "VK_EXT_image_drm_format_modifier", "VK_EXT_provoking_vertex", "VK_EXT_transform_feedback" };
   const VkDeviceCreateInfo di = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1,
                                   .pQueueCreateInfos = &qi, .enabledExtensionCount = 5,
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
   DLOAD(CmdBeginQuery); DLOAD(CmdEndQuery); DLOAD(CmdCopyQueryPoolResults);
   GetDeviceQueue(dev, 0, 0, &queue);
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
 * word, the sample counts and features below, NV12's queries, then maxPushDescriptors (last); NULL with wgt_error(). Its own instance: the
 * device's caps are read when the instance enumerates it. */
EXPORT const uint32_t *
wgt_caps(void)
{
   static uint32_t out[30];
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
 */
static struct {
   VkPipeline pipeline[4];
   VkBuffer vb, ib, args;
   uint8_t *map;
   uint32_t scenario;
   VkPipelineLayout sets2;
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
   if (pull.scenario == 1) {
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[0]);
      CmdBindVertexBuffers(cmd, 0, 1, &pull.vb, &zero);
      CmdDraw(cmd, 6, 1, 0, 7);
      CmdPushConstants(cmd, scene.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, off[1]);
      CmdDraw(cmd, 6, 1, 0, 9);
   } else if (pull.scenario == 2) {
      const VkViewport quarter[3] = { { 0, 0, 32, 32, 0, 1 }, { 32, 0, 32, 32, 0, 1 }, { 0, 32, 32, 32, 0, 1 } };
      const uint32_t offsets[2] = { 0, 0 };
      const VkDescriptorSet sets[2] = { scene.set, scene.set };
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pull.sets2, 0, 2, sets, 2, offsets);
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
      memcpy(args, (uint32_t[4]){ 6, 1, 0, 0 }, 16);
      VkDescriptorSetLayout layouts[2] = { scene.set_layout, scene.set_layout };
      const VkPushConstantRange range = { VK_SHADER_STAGE_VERTEX_BIT, 0, 16 };
      const VkPipelineLayoutCreateInfo pli = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 2,
                                               .pSetLayouts = layouts, .pushConstantRangeCount = 1,
                                               .pPushConstantRanges = &range };
      CHECK(CreatePipelineLayout(dev, &pli, NULL, &pull.sets2));
   }
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
      gpi.pStages = own;
      CHECK(CreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpi, NULL, &pull.pipeline[i]));
   }
   if (scenario == 3) {
      for (uint32_t i = 0; i < 4; i++)
         pull_stride7(1024 * i + i, i == 0 ? PULL_RED : i == 1 ? PULL_GREEN : i == 2 ? PULL_YELLOW : 0xffffffffu);
   } else {
      pull_stride7(0, PULL_RED);
      /* The indexed draw's base vertex of 3: its quad from the fourth stride. */
      for (uint32_t i = 0; i < 6; i++) {
         const uint32_t at = 8192 + (scenario == 2 ? 0 : 2 + 8 * 3) + 8 * i, green = PULL_GREEN;
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
 * reads it: M's word 0 2430 (a pass's draws read copies taken at its start, and a barrier ends that scope). Each
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
      { mask & 4 ? sc.m : sc.n, 256, 16 }, { mask & 8 ? sc.m : sc.n, 512, 16 }, { sc.m, 0, 16 },
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
   if (!Bind || !Begin || !End) {
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
   const VkDeviceSize zero = 0, size = scenario == 1 ? 160 : 1024, counter_at = 2048;
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
   if (scenario == 3) {
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
   if (scenario == 7)
      EndRendering(cmd);
   else
      CmdEndRenderPass(cmd);
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
   } else if (scenario == 4 || scenario == 5) {
      if (!scene.pipeline) {
         snprintf(error, sizeof(error), "wgt_run first");
         return 1;
      }
      VkImage depth;
      VkImageView dview;
      if (image(VK_FORMAT_D32_SFLOAT, 64, 64, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
                VK_IMAGE_ASPECT_DEPTH_BIT, &depth, &dview))
         return 1;
      VkQueryPool qp = VK_NULL_HANDLE;
      if (scenario == 5) {
         const VkQueryPoolCreateInfo qi = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO,
                                            .queryType = VK_QUERY_TYPE_OCCLUSION, .queryCount = 3 };
         CHECK(CreateQueryPool(dev, &qi, NULL, &qp));
         CmdResetQueryPool(cmd, qp, 0, 3);
      }
      VkRenderingAttachmentInfo d = {
         .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = dview,
         .imageLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
         .storeOp = VK_ATTACHMENT_STORE_OP_STORE, .clearValue = { .depthStencil = { scenario == 5 ? 1.0f : 0.75f, 0 } } };
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
      CmdDrawIndexed(cmd, 6, 1, 0, 0, 0);
      if (scenario == 5)
         CmdEndQuery(cmd, qp, 2);
      CmdEndRendering(cmd);
      if (scenario == 5)
         CmdCopyQueryPoolResults(cmd, qp, 0, 3, lo.query, 0, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
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
 * 24: texel-many.comp (8 storage buffers, at 256i of `out`, and 3 uniform texel buffers of R32_UINT, 100, 200, 300):
 *     WebGPU's storage buffers 11, past SwiftShader's 10 (the L6b-L7.3 review's finding 2): refused at pipeline
 *     creation, `out` untouched; or, where the adapter has 11, (100, 200, 300)[i % 3] + i at 256i.
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
   if (scenario == 24) {
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
      mode = scenario == 27 || scenario == 32 ? 0 : scenario == 29 ? 1 : 2;
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
                                        { VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 4 },
                                        { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 8 },
                                        { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 4 },
                                        { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 2 },
                                        { VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 4 } };
   const VkDescriptorPoolSize ps2 = { VK_DESCRIPTOR_TYPE_SAMPLER, 2 };
   VkDescriptorPoolSize all[7];
   memcpy(all, ps, sizeof(ps));
   all[6] = ps2;
   const VkDescriptorPoolCreateInfo dpi = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1,
                                            .poolSizeCount = 7, .pPoolSizes = all };
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

   if (scenario == 24) {
      VkBuffer src;
      uint32_t *w;
      if (buffer(1024, both | VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT, true, &src, (void **)&w))
         return 1;
      VkBufferView views[3];
      for (uint32_t i = 0; i < 3; i++) {
         w[64 * i] = 100 * (i + 1);
         const VkBufferViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO, .buffer = src,
                                             .format = VK_FORMAT_R32_UINT, .offset = 256 * i, .range = 16 };
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

/* VK4 T7: inline uniform blocks (tests/venus/inline.comp): a template update running from one block into the next, then
 * the set copied, the copy dispatched. */
static int
t7_inline(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkBuffer out)
{
   PFN_vkCreateDescriptorUpdateTemplate CreateDescriptorUpdateTemplate =
      (PFN_vkCreateDescriptorUpdateTemplate)GetDeviceProcAddr(dev, "vkCreateDescriptorUpdateTemplate");
   PFN_vkUpdateDescriptorSetWithTemplate UpdateDescriptorSetWithTemplate =
      (PFN_vkUpdateDescriptorSetWithTemplate)GetDeviceProcAddr(dev, "vkUpdateDescriptorSetWithTemplate");
   const VkDescriptorSetLayoutBinding bindings[3] = {
      { 0, VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, 16, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
      { 1, VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, 16, VK_SHADER_STAGE_COMPUTE_BIT, NULL },
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
   const VkDescriptorPoolSize ps[2] = { { VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK, 64 },
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

/* VK4 R2's dispatches in one host-visible memory (`out`, 4 KiB; tests/venus/):
 * 44 (two-reads.comp, the review's R4): `a` and `b` read-only, both at [1024, 1056) (1, 2, 3, 4), `o` at [0, 32).
 * 45 (two-writes.comp): two writable bindings of [256, 320).
 * 46 (two-writes.comp): two writable bindings, [256, 768) and [512, 1024). */
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
   return dispatch_with(cs, cs_words, cmd, scenario == 44 ? 3 : 2, types, scenario == 44 ? reads : scenario == 45 ? same : over);
}

/* VK4 T7: device addresses (tests/venus/address.comp). A device-local memory filled and a submit later the address
 * buffer grown past it; then a dispatch reading it through a pointer, writing a host-visible memory through a pointer
 * and through a storage buffer descriptor of that memory, which would alias the pointers' binding. With `uniform` (VK4
 * R2, the review's R1; address-ubo.comp): the shader adds a uniform buffer of that memory at 2048 too, whose shadow is
 * only read while the descriptor's is written, in one usage scope. */
static int
t7_addresses(const uint32_t *cs, uint32_t cs_words, VkCommandBuffer cmd, VkCommandPool pool, bool uniform)
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
   const VkDescriptorBufferInfo bi[2] = { { host, 1024, 16 }, { host, 2048, 16 } };
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
   if (scenario != 3 && scenario != 4)
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
   } else if ((scenario >= 24 && scenario <= 29) || scenario == 32) {
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
   } else if (scenario == 41 || scenario == 42) {
      if (t11_misc(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 39 || scenario == 43) {
      if (t7_addresses(cs, cs_words, cmd, pool, scenario == 43))
         return 1;
   } else if (scenario >= 44 && scenario <= 46) {
      if (r2_misc(scenario, cs, cs_words, cmd, out))
         return 1;
   } else if (scenario == 40) {
      if (t7_inline(cs, cs_words, cmd, out))
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
