// VK0's scene for the WebGPU pages (bench/vulkan/REPORT.md, arms 2 and 3): the same simulation and draw order as the
// native arms (sim.c, scene.h, toolkit.h), built to wasm without libc by bench/vulkan/webgpu/build.sh. The page copies
// the pack's tables in (vk0_head), calls vk0_init and then vk0_frame once a frame, and reads the frame's commands,
// uniforms, fish, bubble sets, light rays and toolkit quads out of this module's memory.
#include "../scene/scene.h"
#include "../scene/sim.h"
#include "../scene/toolkit.h"

#define EXPORT(name) __attribute__((export_name(#name)))
#define MAX_FISH 50000
#define MAX_QUADS 20000
#define MAX_CMDS (4 * (SIM_MAX_PROPS * 4 + MAX_FISH + 64) + 64)

void *memcpy(void *d, const void *s, unsigned long n) {
  unsigned char *a = d;
  const unsigned char *b = s;
  while (n--) *a++ = *b++;
  return d;
}

void *memset(void *d, int c, unsigned long n) {
  unsigned char *a = d;
  while (n--) *a++ = (unsigned char)c;
  return d;
}

static Sim sim;
static Pack pack;
static Toolkit tk;
static int toolkitMode;
static uint8_t head[1 << 16];
static SceneCmd cmds[MAX_CMDS];
static SimObject objects[SIM_MAX_PROPS];
static SimFish fish[MAX_FISH];
static ToolkitQuad quads[MAX_QUADS];
static uint8_t fishRecords[MAX_FISH * 256];
static uint8_t tkPixels[TK_TEXTURE_SIZE * TK_TEXTURE_SIZE * 4];

EXPORT(vk0_head) uint8_t *vk0_head(void) { return head; }

// 0 on success.
EXPORT(vk0_init) int vk0_init(uint32_t headSize, int fishTotal, int toolkit, int width, int height) {
  if (pack_parse(&pack, head, headSize) || pack.propCount > SIM_MAX_PROPS || fishTotal > MAX_FISH) return -1;
  toolkitMode = toolkit > 0;
  if (toolkitMode) {
    toolkit_init(&tk, toolkit, width, height);
    if (tk.count > MAX_QUADS) return -1;
  }
  sim_init(&sim, toolkitMode ? 0 : fishTotal, width, height);
  return 0;
}

// Steps to the next frame; returns its number of commands.
EXPORT(vk0_frame) uint32_t vk0_frame(void) {
  sim_step(&sim);
  if (toolkitMode) return toolkit_frame(&tk, &sim, cmds, quads);
  return scene_frame(&pack, &sim, cmds, objects, fish);
}

EXPORT(vk0_cmds) SceneCmd *vk0_cmds(void) { return cmds; }
EXPORT(vk0_objects) SimObject *vk0_objects(void) { return objects; }
EXPORT(vk0_object_count) uint32_t vk0_object_count(void) { return pack.propCount; }
EXPORT(vk0_fish) SimFish *vk0_fish(void) { return fish; }
EXPORT(vk0_fish_count) int vk0_fish_count(int species) { return sim.fishCount[species]; }
EXPORT(vk0_species) SimSpecies *vk0_species(void) { return sim.species; }
EXPORT(vk0_globals) SimGlobals *vk0_globals(void) { return &sim.globals; }
EXPORT(vk0_bubbles) SimBubble *vk0_bubbles(void) { return sim.bubbles; }
EXPORT(vk0_bubble_sets) SimBubbleSet *vk0_bubble_sets(void) { return sim.bubbleSets; }
EXPORT(vk0_light_rays) SimLightRay *vk0_light_rays(void) { return sim.lightRays; }
EXPORT(vk0_quads) ToolkitQuad *vk0_quads(void) { return quads; }
EXPORT(vk0_quad_count) int vk0_quad_count(void) { return tk.count; }
EXPORT(vk0_pipeline) int vk0_pipeline(uint32_t model) { return scene_model_pipeline(&pack, model); }

// The frame's fish as the WebGPU pages bind them: each fish's 32 bytes and its species' 16, every `stride` bytes (48 for
// a storage buffer, 256 for dynamic uniform offsets). Returns the records.
EXPORT(vk0_fish_records) uint8_t *vk0_fish_records(uint32_t stride) {
  uint32_t f = 0;
  for (int sp = 0; sp < SIM_SPECIES; sp++)
    for (int i = 0; i < sim.fishCount[sp]; i++, f++) {
      memcpy(fishRecords + f * stride, &fish[f], sizeof(SimFish));
      memcpy(fishRecords + f * stride + sizeof(SimFish), &sim.species[sp], sizeof(SimSpecies));
    }
  return fishRecords;
}

EXPORT(vk0_tk_texture) uint8_t *vk0_tk_texture(uint32_t index) {
  toolkit_texture(index, tkPixels);
  return tkPixels;
}

EXPORT(vk0_ray_vertices) const float *vk0_ray_vertices(void) { return SCENE_RAY_VERTICES; }
EXPORT(vk0_ray_indices) const uint16_t *vk0_ray_indices(void) { return SCENE_RAY_INDICES; }
