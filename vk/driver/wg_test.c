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
   uint32_t w, h;
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
   DLOAD(GetPipelineCacheData);
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
 * tiling features of R16_SFLOAT, R16_UNORM, B10G11R11_UFLOAT_PACK32, R32_SFLOAT, and vendorID; NULL with wgt_error(). Its own
 * instance: the device's caps are read when the instance enumerates it. */
EXPORT const uint32_t *
wgt_caps(void)
{
   static uint32_t out[16];
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

EXPORT int
wgt_draw(const uint32_t *fs, uint32_t fs_words, uint32_t variant)
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
      if (shader(fs, fs_words, &draw_fs))
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
   VkPipeline pipeline = scene.pipeline;
   if (variant) {
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
   CHECK(EndCommandBuffer(cmd));
   const VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                                 .pCommandBuffers = &cmd };
   CHECK(QueueSubmit(queue, 1, &submit, draw_fence));
   /* Freed at the next draw, once this one is done. */
   last = variant ? pipeline : VK_NULL_HANDLE;
   return 0;
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
