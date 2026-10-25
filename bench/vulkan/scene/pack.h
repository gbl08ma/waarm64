// Reading the scene's asset pack (bench/vulkan/assets.ts writes it; the layout is described there). Header-only, no
// libc: the caller reads the whole file into memory and the tables point into it.
#ifndef PACK_H
#define PACK_H

#include <stddef.h>
#include <stdint.h>

#define PACK_NONE 0xffffffffu

typedef struct {
  char name[32];
  uint32_t width, height, layers, mips;
  uint64_t offset, size;
} PackTexture;

typedef struct {
  char name[32];
  uint32_t firstModel, modelCount, reserved[2];
} PackScene;

typedef struct {
  uint32_t scene, vertexCount, indexCount, diffuse, normalMap, reflectionMap;
  uint64_t vertexOffset, indexOffset;
  float min[3], max[3];
} PackModel;

#pragma pack(push, 4)
typedef struct {
  uint32_t scene;
  float world[16];
} PackProp;
#pragma pack(pop)

typedef struct {
  uint8_t *data;
  size_t size;
  uint32_t textureCount, sceneCount, modelCount, propCount;
  PackTexture *textures;
  PackScene *scenes;
  PackModel *models;
  PackProp *props;
} Pack;

_Static_assert(sizeof(PackTexture) == 64, "texture entry");
_Static_assert(sizeof(PackScene) == 48, "scene entry");
_Static_assert(sizeof(PackModel) == 64, "model entry");
_Static_assert(sizeof(PackProp) == 68, "prop entry");

static int pack_streq(const char *a, const char *b) {
  while (*a && *a == *b) { a++; b++; }
  return *a == *b;
}

// Points the tables into data (the whole file, kept alive by the caller). 0 on success.
static int pack_parse(Pack *p, uint8_t *data, size_t size) {
  p->data = data;
  p->size = size;
  uint32_t *h = (uint32_t *)data;
  if (size < 32 || data[0] != 'A' || data[1] != 'Q' || data[2] != 'P' || data[3] != '1' || h[1] != 1) return -1;
  p->textureCount = h[2];
  p->sceneCount = h[3];
  p->modelCount = h[4];
  p->propCount = h[5];
  uint8_t *at = data + 32;
  p->textures = (PackTexture *)at; at += p->textureCount * sizeof(PackTexture);
  p->scenes = (PackScene *)at; at += p->sceneCount * sizeof(PackScene);
  p->models = (PackModel *)at; at += p->modelCount * sizeof(PackModel);
  p->props = (PackProp *)at;
  return 0;
}

static int pack_scene(const Pack *p, const char *name) {
  for (uint32_t i = 0; i < p->sceneCount; i++)
    if (pack_streq(p->scenes[i].name, name)) return (int)i;
  return -1;
}

static int pack_texture(const Pack *p, const char *name) {
  for (uint32_t i = 0; i < p->textureCount; i++)
    if (pack_streq(p->textures[i].name, name)) return (int)i;
  return -1;
}

// Bytes of one level (all its layers) and where it starts in the texture's data.
static uint64_t pack_level_offset(const PackTexture *t, uint32_t level) {
  uint64_t o = 0;
  for (uint32_t l = 0; l < level; l++) {
    uint32_t w = t->width >> l, h = t->height >> l;
    o += (uint64_t)(w ? w : 1) * (h ? h : 1) * 4 * t->layers;
  }
  return o;
}

#endif
