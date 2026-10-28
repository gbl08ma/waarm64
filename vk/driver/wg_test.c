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
int wgt_pass(uint32_t scenario);
const uint8_t *wgt_pass_pixels(void);
int wgt_pass_done(void);
const uint64_t *wgt_pass_query(void);
int wgt_misc(uint32_t scenario, const uint32_t *cs, uint32_t cs_words);
uint8_t *wgt_misc_map(void);
int wgt_misc_done(void);
int wgt_misc_signal(void);

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

static int
memory_for(VkMemoryRequirements req, bool host, VkDeviceMemory *out, void **map)
{
   const VkMemoryAllocateInfo info = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
                                       .memoryTypeIndex = host ? 1 : 0 };
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
                          "VK_EXT_image_drm_format_modifier" };
   const VkDeviceCreateInfo di = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1,
                                   .pQueueCreateInfos = &qi, .enabledExtensionCount = 3,
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
 * word; NULL with wgt_error(). Its own instance: the device's caps are read when the instance enumerates it. */
EXPORT const uint32_t *
wgt_caps(void)
{
   static uint32_t out[24];
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
   destroy(inst, NULL);
   return out;
}

/* bench/vulkan/costs.ts (VK2's costs: a pipeline's, a submit's): after wgt_run, one submit drawing its quad into its
 * render pass. `variant` 0 binds wgt_run's pipeline; any other makes a pipeline anew with `fs` (a fragment shader whose
 * specialization constant 0 is `variant`, so its WGSL is new: translated, compiled and made from nothing) in its place.
 * wgt_draw_done then says when the submit's fence signalled. */
static VkFence draw_fence;
static VkShaderModule draw_fs;
static VkPipeline last;

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
      at += size;
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
 * 20: as 7 (4,096 bytes) inside an occlusion query begun and ended outside a render pass, its result copied to
 *    [1024, 1028): v[k] at [0, 16) and 1 there (passing; the L5-L6a review's finding 3: the query's write was recorded
 *    with the compute pass open, which invalidated the submit).
 * 19: as 13's copy, held for its wait, then a submit of nothing but a fence (vkQueueSubmit(queue, 0, NULL, fence), as
 *    Mesa's vkQueueWaitIdle): the fence unsignalled until the host's signal (`wgt_misc_signal`), and the copy 0x22 (the
 *    L5-L6a review's finding 1: such a submit went ahead of held ones, its fence saying they were done).
 */
static struct {
   VkFence fence;
   uint8_t *map;
} misc;
static struct {
   VkBuffer src;
   uint8_t *bytes;
   VkSemaphore sem;
} misc13;

static int
misc_image(VkFormat format, VkImageType type, uint32_t depth, VkImageUsageFlags usage, VkImage *out)
{
   const VkImageCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = type, .format = format, .extent = { 4, 4, depth },
      .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
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
              both | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_STORAGE_TEXEL_BUFFER_BIT, true, &out,
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
   } else if (scenario == 17 || scenario == 18) {
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
      const VkDescriptorBufferInfo bi[3] = { { in, 0, 16 }, { in, 256, 16 }, { out, 0, 16 } };
      const VkWriteDescriptorSet wr[2] = {
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
           .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &bi[0] },
         { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 2,
           .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi[1] },
      };
      UpdateDescriptorSets(dev, 2, wr, 0, NULL);
      const VkMemoryBarrier mb = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                                   .dstAccessMask = VK_ACCESS_SHADER_WRITE_BIT };
      CmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0,
                         NULL);
      CmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
      CmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, layout, 0, 1, &set, 0, NULL);
      if (scenario == 18)
         CmdDispatchIndirect(cmd, in, 512);
      else
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
   return 0;
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
