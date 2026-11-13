// VK0's scene in Vulkan (bench/vulkan/REPORT.md, arms 1 and 5, and the guest's lavapipe of arm 4): the WebGL Aquarium
// (sim.h, scene.h) drawn the way Vulkan programs draw. Command buffers re-recorded every frame, two frames in flight,
// the frame's uniforms in host-visible memory with their descriptor set updated every frame, the placed objects'
// uniforms at dynamic offsets, the fish's in push constants, fog as a specialization constant, one render pass a frame.
// It draws offscreen (no window, no swapchain), so every arm measures the same thing: frames drawn, not presented.
//
//   vk --pack aquarium.pack --shaders dir [--fish N] [--toolkit N] [--width W --height H] [--msaa 1|4]
//      [--warmup F] [--samples S] [--frames F] [--dump FRAME:out.ppm [--thumb WxH]] [--json out.json] [--label s] [--device i]
//
// Measures S samples of F frames each after the warm-up: the wall time a frame (frames complete at a steady rate, two
// in flight), the process's CPU time a frame (the driver's threads included) and the GPU's time a frame (timestamps
// around the frame's commands, where the queue has them). --dump renders frames 0..FRAME and writes FRAME's pixels;
// --thumb WxH also prints them block-averaged (dump.h).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <vulkan/vulkan.h>

#include "pack.h"
#include "scene.h"
#include "sim.h"
#include "toolkit.h"
#include "dump.h"

#define CHECK(x)                                                                    \
  do {                                                                              \
    VkResult r_ = (x);                                                              \
    if (r_ != VK_SUCCESS) {                                                         \
      fprintf(stderr, "%s:%d: %s failed: %d\n", __FILE__, __LINE__, #x, (int)r_);   \
      exit(1);                                                                      \
    }                                                                               \
  } while (0)

#define FRAMES_IN_FLIGHT 2
#define OBJECT_STRIDE 256
#define MAX_SAMPLES 256

static VkInstance instance;
static VkPhysicalDevice phys;
static VkPhysicalDeviceProperties props;
static VkPhysicalDeviceMemoryProperties memProps;
static VkDevice device;
static VkQueue queue;
static uint32_t queueFamily;
static VkCommandPool uploadPool;

typedef struct {
  VkBuffer buffer;
  VkDeviceMemory memory;
  void *map;
  VkDeviceSize size;
} Buffer;

typedef struct {
  VkImage image;
  VkDeviceMemory memory;
  VkImageView view;
} Image;

static double now_s(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

static double cpu_s(void) {
  struct timespec t;
  clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

static uint32_t memory_type(uint32_t bits, VkMemoryPropertyFlags want) {
  for (uint32_t i = 0; i < memProps.memoryTypeCount; i++)
    if ((bits & (1u << i)) && (memProps.memoryTypes[i].propertyFlags & want) == want) return i;
  fprintf(stderr, "no memory type for %x\n", want);
  exit(1);
}

static Buffer buffer_new(VkDeviceSize size, VkBufferUsageFlags usage, VkMemoryPropertyFlags mem) {
  Buffer b = {0};
  b.size = size;
  VkBufferCreateInfo bi = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size, .usage = usage};
  CHECK(vkCreateBuffer(device, &bi, NULL, &b.buffer));
  VkMemoryRequirements req;
  vkGetBufferMemoryRequirements(device, b.buffer, &req);
  VkMemoryAllocateInfo ai = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
                             .memoryTypeIndex = memory_type(req.memoryTypeBits, mem)};
  CHECK(vkAllocateMemory(device, &ai, NULL, &b.memory));
  CHECK(vkBindBufferMemory(device, b.buffer, b.memory, 0));
  if (mem & VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT) CHECK(vkMapMemory(device, b.memory, 0, size, 0, &b.map));
  return b;
}

static Buffer staging_new(VkDeviceSize size) {
  return buffer_new(size, VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                    VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
}

static void buffer_free(Buffer *b) {
  if (b->map) vkUnmapMemory(device, b->memory);
  vkDestroyBuffer(device, b->buffer, NULL);
  vkFreeMemory(device, b->memory, NULL);
}

static VkCommandBuffer one_time_begin(void) {
  VkCommandBufferAllocateInfo ai = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = uploadPool,
                                    .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
  VkCommandBuffer cb;
  CHECK(vkAllocateCommandBuffers(device, &ai, &cb));
  VkCommandBufferBeginInfo bi = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                 .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  CHECK(vkBeginCommandBuffer(cb, &bi));
  return cb;
}

static void one_time_end(VkCommandBuffer cb) {
  CHECK(vkEndCommandBuffer(cb));
  VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb};
  CHECK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
  CHECK(vkQueueWaitIdle(queue));
  vkFreeCommandBuffers(device, uploadPool, 1, &cb);
}

static Buffer device_buffer(const void *data, VkDeviceSize size, VkBufferUsageFlags usage) {
  Buffer b = buffer_new(size, usage | VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
  Buffer s = staging_new(size);
  memcpy(s.map, data, size);
  VkCommandBuffer cb = one_time_begin();
  VkBufferCopy c = {0, 0, size};
  vkCmdCopyBuffer(cb, s.buffer, b.buffer, 1, &c);
  one_time_end(cb);
  buffer_free(&s);
  return b;
}

static void barrier(VkCommandBuffer cb, VkImage image, VkImageLayout from, VkImageLayout to, uint32_t mips,
                    uint32_t layers, VkImageAspectFlags aspect, VkAccessFlags srcAccess, VkAccessFlags dstAccess,
                    VkPipelineStageFlags srcStage, VkPipelineStageFlags dstStage) {
  VkImageMemoryBarrier b = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .srcAccessMask = srcAccess, .dstAccessMask = dstAccess,
                            .oldLayout = from, .newLayout = to, .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
                            .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .image = image,
                            .subresourceRange = {aspect, 0, mips, 0, layers}};
  vkCmdPipelineBarrier(cb, srcStage, dstStage, 0, 0, NULL, 0, NULL, 1, &b);
}

static Image image_new(VkFormat format, uint32_t w, uint32_t h, uint32_t mips, uint32_t layers, VkSampleCountFlagBits samples,
                       VkImageUsageFlags usage, VkImageAspectFlags aspect) {
  Image im = {0};
  VkImageCreateInfo ci = {VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .flags = layers == 6 ? VK_IMAGE_CREATE_CUBE_COMPATIBLE_BIT : 0,
                          .imageType = VK_IMAGE_TYPE_2D, .format = format, .extent = {w, h, 1}, .mipLevels = mips,
                          .arrayLayers = layers, .samples = samples, .tiling = VK_IMAGE_TILING_OPTIMAL, .usage = usage,
                          .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED};
  CHECK(vkCreateImage(device, &ci, NULL, &im.image));
  VkMemoryRequirements req;
  vkGetImageMemoryRequirements(device, im.image, &req);
  // A transient attachment gets lazily allocated memory where the device has it (a tiled GPU keeps it in tile memory).
  uint32_t type = UINT32_MAX;
  if (usage & VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT)
    for (uint32_t i = 0; i < memProps.memoryTypeCount; i++)
      if ((req.memoryTypeBits & (1u << i)) && (memProps.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT)) {
        type = i;
        break;
      }
  if (type == UINT32_MAX) type = memory_type(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
  VkMemoryAllocateInfo ai = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size, .memoryTypeIndex = type};
  CHECK(vkAllocateMemory(device, &ai, NULL, &im.memory));
  CHECK(vkBindImageMemory(device, im.image, im.memory, 0));
  VkImageViewCreateInfo vi = {VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = im.image,
                              .viewType = layers == 6 ? VK_IMAGE_VIEW_TYPE_CUBE : VK_IMAGE_VIEW_TYPE_2D, .format = format,
                              .subresourceRange = {aspect, 0, mips, 0, layers}};
  CHECK(vkCreateImageView(device, &vi, NULL, &im.view));
  return im;
}

// A texture from the pack: every level and layer uploaded through one staging buffer.
static Image texture_new(const Pack *p, uint32_t index) {
  const PackTexture *t = &p->textures[index];
  Image im = image_new(VK_FORMAT_R8G8B8A8_UNORM, t->width, t->height, t->mips, t->layers, VK_SAMPLE_COUNT_1_BIT,
                       VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, VK_IMAGE_ASPECT_COLOR_BIT);
  Buffer s = staging_new(t->size);
  memcpy(s.map, p->data + t->offset, t->size);
  VkCommandBuffer cb = one_time_begin();
  barrier(cb, im.image, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, t->mips, t->layers,
          VK_IMAGE_ASPECT_COLOR_BIT, 0, VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
          VK_PIPELINE_STAGE_TRANSFER_BIT);
  VkBufferImageCopy regions[16];
  for (uint32_t l = 0; l < t->mips; l++) {
    uint32_t w = t->width >> l, h = t->height >> l;
    regions[l] = (VkBufferImageCopy){.bufferOffset = pack_level_offset(t, l),
                                     .imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, l, 0, t->layers},
                                     .imageExtent = {w ? w : 1, h ? h : 1, 1}};
  }
  vkCmdCopyBufferToImage(cb, s.buffer, im.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, t->mips, regions);
  barrier(cb, im.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, t->mips, t->layers,
          VK_IMAGE_ASPECT_COLOR_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT,
          VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT);
  one_time_end(cb);
  buffer_free(&s);
  return im;
}

static VkShaderModule shader(const char *dir, const char *name) {
  char path[1024];
  snprintf(path, sizeof path, "%s/%s.spv", dir, name);
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "can't open %s\n", path); exit(1); }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint32_t *code = malloc((size_t)n);
  if (fread(code, 1, (size_t)n, f) != (size_t)n) exit(1);
  fclose(f);
  VkShaderModuleCreateInfo ci = {VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, .codeSize = (size_t)n, .pCode = code};
  VkShaderModule m;
  CHECK(vkCreateShaderModule(device, &ci, NULL, &m));
  free(code);
  return m;
}

typedef enum { BLEND_NONE, BLEND_ALPHA, BLEND_ADD } Blend;

typedef struct {
  const char *vs, *fs;
  int fog, cull, depthWrite;
  Blend blend;
  int input;  // 0: the models' vertices; 1: the bubbles' instances; 2: the toolkit's instances
} PipeDesc;

static VkPipeline pipeline_new(const char *dir, PipeDesc d, VkPipelineLayout layout, VkRenderPass pass,
                               VkSampleCountFlagBits samples) {
  VkShaderModule vs = shader(dir, d.vs), fs = shader(dir, d.fs);
  VkBool32 fog = (VkBool32)d.fog;
  VkSpecializationMapEntry entry = {0, 0, sizeof fog};
  VkSpecializationInfo spec = {1, &entry, sizeof fog, &fog};
  VkPipelineShaderStageCreateInfo stages[2] = {
    {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vs, .pName = "main"},
    {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fs,
     .pName = "main", .pSpecializationInfo = &spec},
  };
  VkVertexInputBindingDescription binding;
  VkVertexInputAttributeDescription attrs[5];
  uint32_t nattrs;
  if (d.input == 0) {
    binding = (VkVertexInputBindingDescription){0, 14 * 4, VK_VERTEX_INPUT_RATE_VERTEX};
    static const uint32_t offs[5] = {0, 3, 6, 8, 11}, comps[5] = {3, 3, 2, 3, 3};
    for (uint32_t i = 0; i < 5; i++)
      attrs[i] = (VkVertexInputAttributeDescription){i, 0, comps[i] == 3 ? VK_FORMAT_R32G32B32_SFLOAT : VK_FORMAT_R32G32_SFLOAT,
                                                     offs[i] * 4};
    nattrs = 5;
  } else if (d.input == 1) {
    binding = (VkVertexInputBindingDescription){0, sizeof(SimBubble), VK_VERTEX_INPUT_RATE_INSTANCE};
    for (uint32_t i = 0; i < 4; i++) attrs[i] = (VkVertexInputAttributeDescription){i, 0, VK_FORMAT_R32G32B32A32_SFLOAT, i * 16};
    nattrs = 4;
  } else {
    binding = (VkVertexInputBindingDescription){0, sizeof(ToolkitQuad), VK_VERTEX_INPUT_RATE_INSTANCE};
    for (uint32_t i = 0; i < 3; i++) attrs[i] = (VkVertexInputAttributeDescription){i, 0, VK_FORMAT_R32G32B32A32_SFLOAT, i * 16};
    nattrs = 3;
  }
  VkPipelineVertexInputStateCreateInfo vi = {VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
                                             .vertexBindingDescriptionCount = 1, .pVertexBindingDescriptions = &binding,
                                             .vertexAttributeDescriptionCount = nattrs, .pVertexAttributeDescriptions = attrs};
  VkPipelineInputAssemblyStateCreateInfo ia = {VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                                               .topology = d.input == 0 ? VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST
                                                                        : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP};
  VkPipelineViewportStateCreateInfo vp = {VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
                                          .scissorCount = 1};
  // GL's conventions throughout: the viewport is flipped (negative height), so GL's counter-clockwise front faces stay.
  VkPipelineRasterizationStateCreateInfo rs = {VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                                               .polygonMode = VK_POLYGON_MODE_FILL,
                                               .cullMode = d.cull ? VK_CULL_MODE_BACK_BIT : VK_CULL_MODE_NONE,
                                               .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE, .lineWidth = 1};
  VkPipelineMultisampleStateCreateInfo ms = {VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                                             .rasterizationSamples = samples};
  VkPipelineDepthStencilStateCreateInfo ds = {VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO,
                                              .depthTestEnable = d.input != 2, .depthWriteEnable = d.depthWrite,
                                              .depthCompareOp = VK_COMPARE_OP_LESS};
  VkPipelineColorBlendAttachmentState cba = {.colorWriteMask = 0xf};
  if (d.blend != BLEND_NONE) {
    cba.blendEnable = VK_TRUE;
    cba.srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
    cba.dstColorBlendFactor = d.blend == BLEND_ADD ? VK_BLEND_FACTOR_ONE : VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
    cba.colorBlendOp = VK_BLEND_OP_ADD;
    cba.srcAlphaBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
    cba.dstAlphaBlendFactor = cba.dstColorBlendFactor;
    cba.alphaBlendOp = VK_BLEND_OP_ADD;
  }
  VkPipelineColorBlendStateCreateInfo cb = {VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                                            .attachmentCount = 1, .pAttachments = &cba};
  VkDynamicState dyn[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
  VkPipelineDynamicStateCreateInfo dy = {VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO, .dynamicStateCount = 2,
                                         .pDynamicStates = dyn};
  VkGraphicsPipelineCreateInfo ci = {VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
                                     .pVertexInputState = &vi, .pInputAssemblyState = &ia, .pViewportState = &vp,
                                     .pRasterizationState = &rs, .pMultisampleState = &ms, .pDepthStencilState = &ds,
                                     .pColorBlendState = &cb, .pDynamicState = &dy, .layout = layout, .renderPass = pass};
  VkPipeline pipe;
  CHECK(vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &ci, NULL, &pipe));
  vkDestroyShaderModule(device, vs, NULL);
  vkDestroyShaderModule(device, fs, NULL);
  return pipe;
}

static const PipeDesc PIPES[PIPE_COUNT] = {
  [PIPE_DIFFUSE] = {"object.vert", "diffuse.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_DIFFUSE_NOFOG] = {"object.vert", "diffuse.frag", 0, 1, 1, BLEND_NONE, 0},
  [PIPE_NORMALMAP] = {"object.vert", "normalmap.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_REFLECTION] = {"object.vert", "reflection.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_FISH_NORMAL] = {"fish.vert", "fishnormal.frag", 1, 1, 1, BLEND_ALPHA, 0},
  [PIPE_FISH_REFLECT] = {"fish.vert", "fishreflect.frag", 1, 1, 1, BLEND_ALPHA, 0},
  [PIPE_SEAWEED] = {"seaweed.vert", "seaweed.frag", 1, 1, 1, BLEND_ALPHA, 0},
  [PIPE_INNER] = {"object.vert", "inner.frag", 1, 1, 1, BLEND_NONE, 0},
  [PIPE_OUTER] = {"object.vert", "outer.frag", 0, 1, 1, BLEND_ALPHA, 0},
  [PIPE_BUBBLE] = {"bubble.vert", "bubble.frag", 0, 0, 0, BLEND_ADD, 1},
  [PIPE_RAY] = {"ray.vert", "ray.frag", 0, 0, 0, BLEND_ADD, 0},
};

static const PipeDesc TK_PIPES[TK_PIPE_COUNT] = {
  [TK_PIPE_TEXTURE] = {"tk.vert", "tktexture.frag", 0, 0, 0, BLEND_ALPHA, 2},
  [TK_PIPE_COLOR] = {"tk.vert", "tkcolor.frag", 0, 0, 0, BLEND_ALPHA, 2},
  [TK_PIPE_ROUNDED] = {"tk.vert", "tkrounded.frag", 0, 0, 0, BLEND_ALPHA, 2},
};

static void usage(void) {
  fprintf(stderr, "usage: vk --pack file --shaders dir [--fish N | --toolkit N] [--width W] [--height H] [--msaa 1|4]\n"
                  "          [--warmup F] [--samples S] [--frames F] [--dump FRAME:file.ppm] [--json file] [--label s] [--device i]\n");
  exit(2);
}

static int cmp_double(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}

static void stats(double *v, int n, double *median, double *iqr) {
  double s[MAX_SAMPLES];
  memcpy(s, v, n * sizeof *v);
  qsort(s, n, sizeof *s, cmp_double);
  *median = n % 2 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  *iqr = s[(3 * n) / 4] - s[n / 4];
}

static void json_array(FILE *f, const char *name, double *v, int n) {
  fprintf(f, "\"%s\": [", name);
  for (int i = 0; i < n; i++) fprintf(f, "%s%.4f", i ? ", " : "", v[i]);
  fprintf(f, "]");
}

int main(int argc, char **argv) {
  const char *packPath = NULL, *shaderDir = NULL, *dumpPath = NULL, *jsonPath = NULL, *label = "";
  int fishTotal = 1000, toolkit = 0, width = 1920, height = 1080, msaa = 1, warmup = 60, samples = 10, frames = 60;
  int dumpFrame = -1, thumbW = 0, thumbH = 0, deviceIndex = -1;
  for (int i = 1; i < argc; i += 2) {  // every option takes a value
    const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!v) usage();
    if (!strcmp(a, "--pack")) packPath = v;
    else if (!strcmp(a, "--shaders")) shaderDir = v;
    else if (!strcmp(a, "--fish")) fishTotal = atoi(v);
    else if (!strcmp(a, "--toolkit")) toolkit = atoi(v);
    else if (!strcmp(a, "--width")) width = atoi(v);
    else if (!strcmp(a, "--height")) height = atoi(v);
    else if (!strcmp(a, "--msaa")) msaa = atoi(v);
    else if (!strcmp(a, "--warmup")) warmup = atoi(v);
    else if (!strcmp(a, "--samples")) samples = atoi(v);
    else if (!strcmp(a, "--frames")) frames = atoi(v);
    else if (!strcmp(a, "--json")) jsonPath = v;
    else if (!strcmp(a, "--label")) label = v;
    else if (!strcmp(a, "--device")) deviceIndex = atoi(v);
    else if (!strcmp(a, "--thumb")) {
      thumbW = atoi(v);
      const char *c = strchr(v, 'x');
      thumbH = c ? atoi(c + 1) : 0;
    } else if (!strcmp(a, "--dump")) {
      dumpFrame = atoi(v);
      const char *c = strchr(v, ':');
      if (!c) usage();
      dumpPath = c + 1;
    } else usage();
  }
  if (!packPath || !shaderDir || (msaa != 1 && msaa != 4) || samples > MAX_SAMPLES || samples < 1) usage();

  Pack pack;
  {
    FILE *f = fopen(packPath, "rb");
    if (!f) { fprintf(stderr, "can't open %s\n", packPath); return 1; }
    fseek(f, 0, SEEK_END);
    size_t n = (size_t)ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *data = malloc(n);
    if (!data || fread(data, 1, n, f) != n || pack_parse(&pack, data, n)) { fprintf(stderr, "bad pack %s\n", packPath); return 1; }
    fclose(f);
  }

  // The instance and the device. KosmicKrisp and MoltenVK are portability drivers: enumerate them.
  uint32_t nExt = 0;
  vkEnumerateInstanceExtensionProperties(NULL, &nExt, NULL);
  VkExtensionProperties *exts = calloc(nExt, sizeof *exts);
  vkEnumerateInstanceExtensionProperties(NULL, &nExt, exts);
  const char *instExts[1];
  uint32_t nInstExts = 0;
  VkInstanceCreateFlags instFlags = 0;
  for (uint32_t i = 0; i < nExt; i++)
    if (!strcmp(exts[i].extensionName, VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME)) {
      instExts[nInstExts++] = VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME;
      instFlags |= VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
    }
  free(exts);
  VkApplicationInfo app = {VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "waarm64-vk0-aquarium",
                           .apiVersion = VK_API_VERSION_1_1};
  VkInstanceCreateInfo ici = {VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .flags = instFlags, .pApplicationInfo = &app,
                              .enabledExtensionCount = nInstExts, .ppEnabledExtensionNames = instExts};
  CHECK(vkCreateInstance(&ici, NULL, &instance));
  uint32_t nPhys = 0;
  vkEnumeratePhysicalDevices(instance, &nPhys, NULL);
  VkPhysicalDevice physs[16];
  if (nPhys > 16) nPhys = 16;
  vkEnumeratePhysicalDevices(instance, &nPhys, physs);
  if (!nPhys) { fprintf(stderr, "no Vulkan device\n"); return 1; }
  phys = physs[0];
  for (uint32_t i = 0; i < nPhys; i++) {  // the first discrete or integrated GPU unless one is named
    VkPhysicalDeviceProperties pp;
    vkGetPhysicalDeviceProperties(physs[i], &pp);
    if (deviceIndex < 0 && (pp.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU || pp.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU)) {
      phys = physs[i];
      break;
    }
  }
  if (deviceIndex >= 0 && (uint32_t)deviceIndex < nPhys) phys = physs[deviceIndex];
  vkGetPhysicalDeviceProperties(phys, &props);
  vkGetPhysicalDeviceMemoryProperties(phys, &memProps);
  VkPhysicalDeviceDriverProperties driverProps = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES};
  VkPhysicalDeviceProperties2 props2 = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &driverProps};
  vkGetPhysicalDeviceProperties2(phys, &props2);
  uint32_t nq = 0;
  vkGetPhysicalDeviceQueueFamilyProperties(phys, &nq, NULL);
  VkQueueFamilyProperties qf[16];
  if (nq > 16) nq = 16;
  vkGetPhysicalDeviceQueueFamilyProperties(phys, &nq, qf);
  queueFamily = UINT32_MAX;
  for (uint32_t i = 0; i < nq; i++)
    if (qf[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) { queueFamily = i; break; }
  if (queueFamily == UINT32_MAX) { fprintf(stderr, "no graphics queue\n"); return 1; }
  int timestamps = qf[queueFamily].timestampValidBits > 0 && props.limits.timestampPeriod > 0;
  // A portability driver needs VK_KHR_portability_subset enabled when it lists it.
  uint32_t nDevExt = 0;
  vkEnumerateDeviceExtensionProperties(phys, NULL, &nDevExt, NULL);
  VkExtensionProperties *dexts = calloc(nDevExt, sizeof *dexts);
  vkEnumerateDeviceExtensionProperties(phys, NULL, &nDevExt, dexts);
  const char *devExts[1];
  uint32_t nDevExts = 0;
  for (uint32_t i = 0; i < nDevExt; i++)
    if (!strcmp(dexts[i].extensionName, "VK_KHR_portability_subset")) devExts[nDevExts++] = "VK_KHR_portability_subset";
  free(dexts);
  float prio = 1;
  VkDeviceQueueCreateInfo qci = {VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = queueFamily,
                                 .queueCount = 1, .pQueuePriorities = &prio};
  VkDeviceCreateInfo dci = {VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1, .pQueueCreateInfos = &qci,
                            .enabledExtensionCount = nDevExts, .ppEnabledExtensionNames = devExts};
  CHECK(vkCreateDevice(phys, &dci, NULL, &device));
  vkGetDeviceQueue(device, queueFamily, 0, &queue);
  VkCommandPoolCreateInfo upci = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = queueFamily};
  CHECK(vkCreateCommandPool(device, &upci, NULL, &uploadPool));
  fprintf(stderr, "device: %s (%s %s)\n", props.deviceName, driverProps.driverName, driverProps.driverInfo);

  // The render target: colour (multisampled with a resolve when --msaa 4) and depth.
  VkSampleCountFlagBits samplesBit = msaa == 4 ? VK_SAMPLE_COUNT_4_BIT : VK_SAMPLE_COUNT_1_BIT;
  VkFormat colorFormat = VK_FORMAT_R8G8B8A8_UNORM, depthFormat = VK_FORMAT_D32_SFLOAT;
  Image color = image_new(colorFormat, (uint32_t)width, (uint32_t)height, 1, 1, VK_SAMPLE_COUNT_1_BIT,
                          VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT, VK_IMAGE_ASPECT_COLOR_BIT);
  Image colorMs = {0};
  if (msaa == 4)
    colorMs = image_new(colorFormat, (uint32_t)width, (uint32_t)height, 1, 1, samplesBit,
                        VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT, VK_IMAGE_ASPECT_COLOR_BIT);
  Image depth = image_new(depthFormat, (uint32_t)width, (uint32_t)height, 1, 1, samplesBit,
                          VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT, VK_IMAGE_ASPECT_DEPTH_BIT);
  VkAttachmentDescription atts[3] = {
    {.format = colorFormat, .samples = samplesBit, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
     .storeOp = msaa == 4 ? VK_ATTACHMENT_STORE_OP_DONT_CARE : VK_ATTACHMENT_STORE_OP_STORE,
     .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE, .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
     .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
     .finalLayout = msaa == 4 ? VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL : VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL},
    {.format = depthFormat, .samples = samplesBit, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
     .storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
     .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
     .finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL},
    {.format = colorFormat, .samples = VK_SAMPLE_COUNT_1_BIT, .loadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
     .storeOp = VK_ATTACHMENT_STORE_OP_STORE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
     .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
     .finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL},
  };
  VkAttachmentReference colorRef = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
  VkAttachmentReference depthRef = {1, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
  VkAttachmentReference resolveRef = {2, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
  VkSubpassDescription sub = {.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
                              .pColorAttachments = &colorRef, .pResolveAttachments = msaa == 4 ? &resolveRef : NULL,
                              .pDepthStencilAttachment = &depthRef};
  // The frame before wrote the same attachments; wait for its writes (and the dump's copy) before clearing them.
  VkSubpassDependency dep = {VK_SUBPASS_EXTERNAL, 0,
                             VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT |
                                 VK_PIPELINE_STAGE_TRANSFER_BIT,
                             VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT | VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT,
                             VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT |
                                 VK_ACCESS_TRANSFER_READ_BIT,
                             VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT, 0};
  VkRenderPassCreateInfo rpci = {VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = msaa == 4 ? 3 : 2,
                                 .pAttachments = atts, .subpassCount = 1, .pSubpasses = &sub, .dependencyCount = 1,
                                 .pDependencies = &dep};
  VkRenderPass pass;
  CHECK(vkCreateRenderPass(device, &rpci, NULL, &pass));
  VkImageView fbViews[3] = {msaa == 4 ? colorMs.view : color.view, depth.view, color.view};
  VkFramebufferCreateInfo fci = {VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = pass,
                                 .attachmentCount = msaa == 4 ? 3 : 2, .pAttachments = fbViews,
                                 .width = (uint32_t)width, .height = (uint32_t)height, .layers = 1};
  VkFramebuffer fb;
  CHECK(vkCreateFramebuffer(device, &fci, NULL, &fb));

  // Descriptor set layouts: the frame's, a material's, an object's (dynamic). Push constants for the fish, the
  // bubble sets and the light rays.
  VkDescriptorSetLayoutBinding frameB[2] = {
    {0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, NULL},
    {1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL},
  };
  VkDescriptorSetLayoutBinding matB[3] = {
    {0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL},
    {1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL},
    {2, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, NULL},
  };
  VkDescriptorSetLayoutBinding objB = {0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1,
                                       VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, NULL};
  VkDescriptorSetLayout setLayouts[3];
  VkDescriptorSetLayoutCreateInfo dl0 = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 2, .pBindings = frameB};
  VkDescriptorSetLayoutCreateInfo dl1 = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 3, .pBindings = matB};
  VkDescriptorSetLayoutCreateInfo dl2 = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &objB};
  CHECK(vkCreateDescriptorSetLayout(device, &dl0, NULL, &setLayouts[0]));
  CHECK(vkCreateDescriptorSetLayout(device, &dl1, NULL, &setLayouts[1]));
  CHECK(vkCreateDescriptorSetLayout(device, &dl2, NULL, &setLayouts[2]));
  VkPushConstantRange pcr = {VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, 80};
  VkPipelineLayoutCreateInfo plci = {VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 3,
                                     .pSetLayouts = setLayouts, .pushConstantRangeCount = 1, .pPushConstantRanges = &pcr};
  VkPipelineLayout layout;
  CHECK(vkCreatePipelineLayout(device, &plci, NULL, &layout));

  // Samplers: the scene's textures repeat with trilinear filtering (tdl's power-of-two textures); the skybox clamps.
  VkSamplerCreateInfo sci = {VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = VK_FILTER_LINEAR,
                             .minFilter = VK_FILTER_LINEAR, .mipmapMode = VK_SAMPLER_MIPMAP_MODE_LINEAR,
                             .addressModeU = VK_SAMPLER_ADDRESS_MODE_REPEAT, .addressModeV = VK_SAMPLER_ADDRESS_MODE_REPEAT,
                             .addressModeW = VK_SAMPLER_ADDRESS_MODE_REPEAT, .maxLod = VK_LOD_CLAMP_NONE};
  VkSampler repeat, clampS;
  CHECK(vkCreateSampler(device, &sci, NULL, &repeat));
  sci.addressModeU = sci.addressModeV = sci.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
  CHECK(vkCreateSampler(device, &sci, NULL, &clampS));

  // The pipelines.
  VkPipeline pipes[(int)PIPE_COUNT > (int)TK_PIPE_COUNT ? (int)PIPE_COUNT : (int)TK_PIPE_COUNT];
  uint32_t npipes = toolkit ? TK_PIPE_COUNT : PIPE_COUNT;
  double tPipes = now_s();
  for (uint32_t i = 0; i < npipes; i++)
    pipes[i] = pipeline_new(shaderDir, toolkit ? TK_PIPES[i] : PIPES[i], layout, pass, samplesBit);
  tPipes = now_s() - tPipes;

  // Textures and materials.
  Image *textures = calloc(pack.textureCount, sizeof *textures);
  uint32_t nMaterials = toolkit ? TK_TEXTURES : pack.modelCount + 2;
  VkDescriptorPoolSize poolSizes[3] = {
    {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, FRAMES_IN_FLIGHT},
    {VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, FRAMES_IN_FLIGHT + 3 * nMaterials},
    {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, FRAMES_IN_FLIGHT},
  };
  VkDescriptorPoolCreateInfo dpci = {VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
                                     .maxSets = 2 * FRAMES_IN_FLIGHT + nMaterials, .poolSizeCount = 3, .pPoolSizes = poolSizes};
  VkDescriptorPool dpool;
  CHECK(vkCreateDescriptorPool(device, &dpci, NULL, &dpool));
  VkDescriptorSet *materials = calloc(nMaterials, sizeof *materials);
  int skyboxTex = pack_texture(&pack, "skybox");
  textures[skyboxTex] = texture_new(&pack, (uint32_t)skyboxTex);
  Image tkTextures[TK_TEXTURES];
  for (uint32_t m = 0; m < nMaterials; m++) {
    VkDescriptorSetAllocateInfo dai = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dpool,
                                       .descriptorSetCount = 1, .pSetLayouts = &setLayouts[1]};
    CHECK(vkAllocateDescriptorSets(device, &dai, &materials[m]));
    VkImageView views[3];
    VkSampler sampler = repeat;
    if (toolkit) {
      uint8_t *px = malloc(TK_TEXTURE_SIZE * TK_TEXTURE_SIZE * 4);
      toolkit_texture(m, px);
      PackTexture t = {.width = TK_TEXTURE_SIZE, .height = TK_TEXTURE_SIZE, .layers = 1, .mips = 1, .offset = 0,
                       .size = TK_TEXTURE_SIZE * TK_TEXTURE_SIZE * 4};
      Pack one = {.data = px, .textures = &t};
      tkTextures[m] = texture_new(&one, 0);
      free(px);
      views[0] = views[1] = views[2] = tkTextures[m].view;
      sampler = clampS;
    } else {
      uint32_t tex[3];
      if (m < pack.modelCount) {
        const PackModel *pm = &pack.models[m];
        tex[0] = pm->diffuse;
        tex[1] = pm->normalMap != PACK_NONE ? pm->normalMap : pm->diffuse;
        tex[2] = pm->reflectionMap != PACK_NONE ? pm->reflectionMap : pm->diffuse;
      } else {
        tex[0] = tex[1] = tex[2] = (uint32_t)pack_texture(&pack, m == MAT_BUBBLE(&pack) ? "bubble" : "lightray");
        sampler = clampS;
      }
      for (int k = 0; k < 3; k++) {
        if (!textures[tex[k]].view) textures[tex[k]] = texture_new(&pack, tex[k]);
        views[k] = textures[tex[k]].view;
      }
    }
    VkDescriptorImageInfo ii[3];
    VkWriteDescriptorSet w[3];
    for (int k = 0; k < 3; k++) {
      ii[k] = (VkDescriptorImageInfo){sampler, views[k], VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
      w[k] = (VkWriteDescriptorSet){VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = materials[m], .dstBinding = (uint32_t)k,
                                    .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
                                    .pImageInfo = &ii[k]};
    }
    vkUpdateDescriptorSets(device, 3, w, 0, NULL);
  }

  // Geometry: every model's vertices and indices in one buffer each, the light ray's plane last; the bubbles'
  // constants. The toolkit's quads are instances in a per-frame buffer.
  uint64_t vbytes = sizeof SCENE_RAY_VERTICES, ibytes = sizeof SCENE_RAY_INDICES;
  for (uint32_t m = 0; m < pack.modelCount; m++) {
    vbytes += pack.models[m].vertexCount * 56ull;
    ibytes += (pack.models[m].indexCount * 2ull + 3) & ~3ull;
  }
  uint8_t *vdata = malloc(vbytes), *idata = calloc(1, ibytes);
  uint32_t *firstIndex = calloc(pack.modelCount + 1, sizeof *firstIndex);
  int32_t *baseVertex = calloc(pack.modelCount + 1, sizeof *baseVertex);
  uint64_t vo = 0, io = 0;
  for (uint32_t m = 0; m <= pack.modelCount; m++) {
    const void *v = m < pack.modelCount ? pack.data + pack.models[m].vertexOffset : (const void *)SCENE_RAY_VERTICES;
    const void *ix = m < pack.modelCount ? pack.data + pack.models[m].indexOffset : (const void *)SCENE_RAY_INDICES;
    uint32_t nv = m < pack.modelCount ? pack.models[m].vertexCount : 4, ni = m < pack.modelCount ? pack.models[m].indexCount : 6;
    memcpy(vdata + vo, v, nv * 56ull);
    memcpy(idata + io, ix, ni * 2ull);
    baseVertex[m] = (int32_t)(vo / 56);
    firstIndex[m] = (uint32_t)(io / 2);
    vo += nv * 56ull;
    io += (ni * 2ull + 3) & ~3ull;
  }
  Buffer vbuf = device_buffer(vdata, vbytes, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT);
  Buffer ibuf = device_buffer(idata, ibytes, VK_BUFFER_USAGE_INDEX_BUFFER_BIT);
  free(vdata);
  free(idata);
  Sim sim;
  sim_init(&sim, toolkit ? 0 : fishTotal, width, height);
  Buffer bubbleBuf = device_buffer(sim.bubbles, sizeof sim.bubbles, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT);

  // Per frame in flight: the frame's uniforms, the objects' uniforms, the toolkit's instances, the descriptor sets,
  // a command pool and buffer, a fence and two timestamps.
  uint32_t objectSlots = pack.propCount;
  Toolkit tk = {0};
  if (toolkit) toolkit_init(&tk, toolkit, width, height);
  struct {
    Buffer globals, objects, quads;
    VkDescriptorSet frameSet, objectSet;
    VkCommandPool pool;
    VkCommandBuffer cb;
    VkFence fence;
    int pending;
  } fr[FRAMES_IN_FLIGHT];
  VkQueryPool queries = VK_NULL_HANDLE;
  if (timestamps) {
    VkQueryPoolCreateInfo qpci = {VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, .queryType = VK_QUERY_TYPE_TIMESTAMP,
                                  .queryCount = 2 * FRAMES_IN_FLIGHT};
    CHECK(vkCreateQueryPool(device, &qpci, NULL, &queries));
  }
  for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
    VkMemoryPropertyFlags hv = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    fr[i].globals = buffer_new(sizeof(SimGlobals), VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, hv);
    fr[i].objects = buffer_new(objectSlots * OBJECT_STRIDE, VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT, hv);
    if (toolkit) fr[i].quads = buffer_new(tk.count * sizeof(ToolkitQuad), VK_BUFFER_USAGE_VERTEX_BUFFER_BIT, hv);
    VkDescriptorSetAllocateInfo dai = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dpool,
                                       .descriptorSetCount = 1, .pSetLayouts = &setLayouts[0]};
    CHECK(vkAllocateDescriptorSets(device, &dai, &fr[i].frameSet));
    dai.pSetLayouts = &setLayouts[2];
    CHECK(vkAllocateDescriptorSets(device, &dai, &fr[i].objectSet));
    VkDescriptorBufferInfo obi = {fr[i].objects.buffer, 0, sizeof(SimObject)};
    VkWriteDescriptorSet w = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = fr[i].objectSet, .dstBinding = 0,
                              .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC,
                              .pBufferInfo = &obi};
    vkUpdateDescriptorSets(device, 1, &w, 0, NULL);
    VkCommandPoolCreateInfo cpci = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
                                    .flags = VK_COMMAND_POOL_CREATE_TRANSIENT_BIT, .queueFamilyIndex = queueFamily};
    CHECK(vkCreateCommandPool(device, &cpci, NULL, &fr[i].pool));
    VkCommandBufferAllocateInfo cai = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = fr[i].pool,
                                       .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
    CHECK(vkAllocateCommandBuffers(device, &cai, &fr[i].cb));
    VkFenceCreateInfo fci2 = {VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    CHECK(vkCreateFence(device, &fci2, NULL, &fr[i].fence));
    fr[i].pending = 0;
  }
  uint32_t maxCmds = scene_max_commands(&pack, &sim);
  if (toolkit && maxCmds < (uint32_t)tk.widgets * 12 + 16) maxCmds = (uint32_t)tk.widgets * 12 + 16;
  SceneCmd *cmds = malloc(maxCmds * sizeof *cmds);
  SimObject *objects = calloc(objectSlots ? objectSlots : 1, sizeof *objects);
  SimFish *fish = calloc(fishTotal > 0 ? (size_t)fishTotal : 1, sizeof *fish);

  int total = dumpFrame >= 0 ? dumpFrame + 1 : warmup + samples * frames;
  double wall[MAX_SAMPLES], cpu[MAX_SAMPLES], gpu[MAX_SAMPLES];
  double gpuSum = 0;
  int gpuCount = 0;
  double tSample = 0, cSample = 0;
  uint64_t draws = 0, pushBytes = 0, uploadBytes = 0;
  for (int frame = 0; frame < total; frame++) {
    int slot = frame % FRAMES_IN_FLIGHT;
    if (fr[slot].pending) {
      CHECK(vkWaitForFences(device, 1, &fr[slot].fence, VK_TRUE, UINT64_MAX));
      CHECK(vkResetFences(device, 1, &fr[slot].fence));
      if (timestamps) {
        uint64_t ts[2];
        if (vkGetQueryPoolResults(device, queries, (uint32_t)slot * 2, 2, sizeof ts, ts, sizeof ts[0],
                                  VK_QUERY_RESULT_64_BIT) == VK_SUCCESS && frame > warmup) {
          gpuSum += (ts[1] - ts[0]) * props.limits.timestampPeriod * 1e-6;
          gpuCount++;
        }
      }
    }
    // The samples: frames [warmup + k*frames, warmup + (k+1)*frames), timed from when the frame before the first
    // could start to when the frame before the next sample's first could.
    if (frame >= warmup && dumpFrame < 0 && (frame - warmup) % frames == 0) {
      int k = (frame - warmup) / frames;
      double t = now_s(), c = cpu_s();
      if (k > 0) {
        wall[k - 1] = (t - tSample) * 1000 / frames;
        cpu[k - 1] = (c - cSample) * 1000 / frames;
        gpu[k - 1] = gpuCount ? gpuSum / gpuCount : 0;
      }
      tSample = t;
      cSample = c;
      gpuSum = 0;
      gpuCount = 0;
    }

    // The frame's data, written into this slot's memory.
    sim_step(&sim);
    // A dump draws only its frame: the frames before it change nothing but the simulation's state.
    if (dumpFrame >= 0 && frame < dumpFrame) continue;
    uint32_t ncmds;
    if (toolkit) {
      ncmds = toolkit_frame(&tk, &sim, cmds, (ToolkitQuad *)fr[slot].quads.map);
      uploadBytes += tk.count * sizeof(ToolkitQuad);
    } else {
      ncmds = scene_frame(&pack, &sim, cmds, objects, fish);
      for (uint32_t i = 0; i < objectSlots; i++) memcpy((uint8_t *)fr[slot].objects.map + i * OBJECT_STRIDE, &objects[i], sizeof *objects);
      uploadBytes += objectSlots * OBJECT_STRIDE;
    }
    memcpy(fr[slot].globals.map, &sim.globals, sizeof sim.globals);
    uploadBytes += sizeof sim.globals;
    VkDescriptorBufferInfo gbi = {fr[slot].globals.buffer, 0, sizeof(SimGlobals)};
    VkDescriptorImageInfo sky = {clampS, textures[skyboxTex].view, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
    VkWriteDescriptorSet fw[2] = {
      {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = fr[slot].frameSet, .dstBinding = 0, .descriptorCount = 1,
       .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &gbi},
      {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = fr[slot].frameSet, .dstBinding = 1, .descriptorCount = 1,
       .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &sky},
    };
    vkUpdateDescriptorSets(device, 2, fw, 0, NULL);

    // Record.
    CHECK(vkResetCommandPool(device, fr[slot].pool, 0));
    VkCommandBuffer cb = fr[slot].cb;
    VkCommandBufferBeginInfo cbi = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
    CHECK(vkBeginCommandBuffer(cb, &cbi));
    if (timestamps) {
      vkCmdResetQueryPool(cb, queries, (uint32_t)slot * 2, 2);
      vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, queries, (uint32_t)slot * 2);
    }
    VkClearValue clears[3] = {{.color = {{0, 0.8f, 1, 1}}}, {.depthStencil = {1, 0}}, {.color = {{0, 0, 0, 0}}}};
    if (toolkit) clears[0].color = (VkClearColorValue){{0.96f, 0.96f, 0.96f, 1}};
    VkRenderPassBeginInfo rbi = {VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = pass, .framebuffer = fb,
                                 .renderArea = {{0, 0}, {(uint32_t)width, (uint32_t)height}},
                                 .clearValueCount = msaa == 4 ? 3 : 2, .pClearValues = clears};
    vkCmdBeginRenderPass(cb, &rbi, VK_SUBPASS_CONTENTS_INLINE);
    VkViewport viewport = {0, (float)height, (float)width, -(float)height, 0, 1};
    VkRect2D scissor = {{0, 0}, {(uint32_t)width, (uint32_t)height}};
    vkCmdSetViewport(cb, 0, 1, &viewport);
    vkCmdSetScissor(cb, 0, 1, &scissor);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &fr[slot].frameSet, 0, NULL);
    VkDeviceSize zero = 0;
    if (toolkit) vkCmdBindVertexBuffers(cb, 0, 1, &fr[slot].quads.buffer, &zero);
    else vkCmdBindIndexBuffer(cb, ibuf.buffer, 0, VK_INDEX_TYPE_UINT16);
    int boundInput = -1;  // which vertex buffer is bound: the models' or the bubbles'
    for (uint32_t i = 0; i < ncmds; i++) {
      const SceneCmd *c = &cmds[i];
      switch (c->op) {
      case CMD_PIPELINE:
        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipes[c->a]);
        if (!toolkit) {
          int input = c->a == PIPE_BUBBLE;
          if (input != boundInput) {
            vkCmdBindVertexBuffers(cb, 0, 1, input ? &bubbleBuf.buffer : &vbuf.buffer, &zero);
            boundInput = input;
          }
        }
        break;
      case CMD_MATERIAL:
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 1, 1, &materials[c->a], 0, NULL);
        break;
      case CMD_DRAW_OBJECT: {
        uint32_t off = c->b * OBJECT_STRIDE;
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 2, 1, &fr[slot].objectSet, 1, &off);
        vkCmdDrawIndexed(cb, pack.models[c->a].indexCount, 1, firstIndex[c->a], baseVertex[c->a], 0);
        draws++;
        break;
      }
      case CMD_DRAW_FISH: {
        struct { SimFish f; SimSpecies k; } pc = {fish[c->b], sim.species[c->c]};
        vkCmdPushConstants(cb, layout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, 44, &pc);
        vkCmdDrawIndexed(cb, pack.models[c->a].indexCount, 1, firstIndex[c->a], baseVertex[c->a], 0);
        draws++;
        pushBytes += 44;
        break;
      }
      case CMD_DRAW_BUBBLES:
        vkCmdPushConstants(cb, layout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, 16, sim.bubbleSets[c->a].world);
        vkCmdDraw(cb, 4, SIM_BUBBLES, 0, 0);
        draws++;
        pushBytes += 16;
        break;
      case CMD_DRAW_RAY:
        vkCmdPushConstants(cb, layout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT, 0, 80, &sim.lightRays[c->a]);
        vkCmdDrawIndexed(cb, 6, 1, firstIndex[pack.modelCount], baseVertex[pack.modelCount], 0);
        draws++;
        pushBytes += 80;
        break;
      case CMD_TK_DRAW:
        vkCmdDraw(cb, 4, c->b, 0, c->a);
        draws++;
        break;
      }
    }
    vkCmdEndRenderPass(cb);
    if (timestamps) vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, queries, (uint32_t)slot * 2 + 1);
    CHECK(vkEndCommandBuffer(cb));
    VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb};
    CHECK(vkQueueSubmit(queue, 1, &si, fr[slot].fence));
    fr[slot].pending = 1;
  }
  // The last sample ends when its frames are done.
  CHECK(vkQueueWaitIdle(queue));
  if (dumpFrame < 0) {
    wall[samples - 1] = (now_s() - tSample) * 1000 / frames;
    cpu[samples - 1] = (cpu_s() - cSample) * 1000 / frames;
    gpu[samples - 1] = gpuCount ? gpuSum / gpuCount : 0;
  }

  if (dumpPath) {  // the last frame's pixels, top row first, as a PPM
    Buffer rb = staging_new((VkDeviceSize)width * height * 4);
    VkCommandBuffer cb = one_time_begin();
    VkBufferImageCopy region = {.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1},
                                .imageExtent = {(uint32_t)width, (uint32_t)height, 1}};
    vkCmdCopyImageToBuffer(cb, color.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, rb.buffer, 1, &region);
    one_time_end(cb);
    dump_frame(dumpPath, rb.map, width, height, thumbW, thumbH);
    buffer_free(&rb);
    fprintf(stderr, "frame %d -> %s\n", dumpFrame, dumpPath);
  } else {
    double wm, wi, cm, ci, gm, gi;
    stats(wall, samples, &wm, &wi);
    stats(cpu, samples, &cm, &ci);
    stats(gpu, samples, &gm, &gi);
    int measured = total;
    fprintf(stderr, "%s %s: %.3f ms a frame (IQR %.3f), CPU %.3f ms, GPU %.3f ms, %.0f draws a frame\n", label,
            toolkit ? "toolkit" : "aquarium", wm, wi, cm, gm, (double)draws / measured);
    if (jsonPath) {
      FILE *f = fopen(jsonPath, "w");
      fprintf(f, "{\"arm\": \"vulkan\", \"label\": \"%s\", \"device\": \"%s\", \"driver\": \"%s\", \"driverInfo\": \"%s\", ",
              label, props.deviceName, driverProps.driverName, driverProps.driverInfo);
      fprintf(f, "\"apiVersion\": \"%u.%u.%u\", ", VK_API_VERSION_MAJOR(props.apiVersion), VK_API_VERSION_MINOR(props.apiVersion),
              VK_API_VERSION_PATCH(props.apiVersion));
      fprintf(f, "\"scene\": \"%s\", \"fish\": %d, \"quads\": %d, \"width\": %d, \"height\": %d, \"msaa\": %d, ",
              toolkit ? "toolkit" : "aquarium", toolkit ? 0 : fishTotal, toolkit, width, height, msaa);
      fprintf(f, "\"warmup\": %d, \"frames\": %d, \"pipelineMs\": %.3f, ", warmup, frames, tPipes * 1000);
      fprintf(f, "\"drawsPerFrame\": %.1f, \"uploadBytesPerFrame\": %.0f, \"pushBytesPerFrame\": %.0f, ",
              (double)draws / measured, (double)uploadBytes / measured, (double)pushBytes / measured);
      fprintf(f, "\"frameMs\": {\"median\": %.4f, \"iqr\": %.4f}, \"cpuMs\": {\"median\": %.4f, \"iqr\": %.4f}, ", wm, wi, cm, ci);
      fprintf(f, "\"gpuMs\": {\"median\": %.4f, \"iqr\": %.4f}, ", gm, gi);
      json_array(f, "frameSamples", wall, samples);
      fprintf(f, ", ");
      json_array(f, "cpuSamples", cpu, samples);
      fprintf(f, ", ");
      json_array(f, "gpuSamples", gpu, samples);
      fprintf(f, "}\n");
      fclose(f);
    }
  }
  vkDeviceWaitIdle(device);
  return 0;
}
