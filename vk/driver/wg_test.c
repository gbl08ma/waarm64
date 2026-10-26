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
FN(CmdDispatch); FN(CmdFillBuffer); FN(CreateFence); FN(GetFenceStatus); FN(QueueSubmit);

static VkInstance instance;
static VkDevice dev;
static VkQueue queue;
static VkFence fence;
static uint8_t *pixels, *storage, *filled;
static char error[256];

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
   const VkDeviceCreateInfo di = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1,
                                   .pQueueCreateInfos = &qi };
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
   DLOAD(QueueSubmit);
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
   const VkVertexInputBindingDescription vb = { 0, 20, VK_VERTEX_INPUT_RATE_VERTEX };
   const VkVertexInputAttributeDescription va[2] = { { 0, 0, VK_FORMAT_R32G32B32_SFLOAT, 0 },
                                                     { 1, 0, VK_FORMAT_R32G32_SFLOAT, 12 } };
   const VkPipelineVertexInputStateCreateInfo vis = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, .vertexBindingDescriptionCount = 1,
      .pVertexBindingDescriptions = &vb, .vertexAttributeDescriptionCount = 2, .pVertexAttributeDescriptions = va };
   const VkPipelineInputAssemblyStateCreateInfo ias = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
      .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
   const VkPipelineViewportStateCreateInfo vps = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
                                                   .viewportCount = 1, .scissorCount = 1 };
   /* Culling back faces, the front clockwise: what the scene draws is clockwise on the screen. */
   const VkPipelineRasterizationStateCreateInfo rs = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, .polygonMode = VK_POLYGON_MODE_FILL,
      .cullMode = VK_CULL_MODE_BACK_BIT, .frontFace = VK_FRONT_FACE_CLOCKWISE, .lineWidth = 1 };
   const VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                                     .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
   const VkPipelineDepthStencilStateCreateInfo ds = {
      .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO, .depthTestEnable = VK_TRUE,
      .depthWriteEnable = VK_TRUE, .depthCompareOp = VK_COMPARE_OP_LESS };
   const VkPipelineColorBlendAttachmentState cba = { .colorWriteMask = 0xf };
   const VkPipelineColorBlendStateCreateInfo cbs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                                     .attachmentCount = 1, .pAttachments = &cba };
   const VkDynamicState dyn[2] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
   const VkPipelineDynamicStateCreateInfo dys = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
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
