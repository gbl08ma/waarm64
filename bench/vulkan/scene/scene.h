// Ported from the WebGL Aquarium (WebGLSamples, Copyright 2009, Google Inc., BSD-3-Clause: LICENSE.aquarium beside
// this file; THIRD_PARTY.md).
// The Aquarium's frame as a list of commands that every arm turns into its own API's calls (render() in aquarium.js):
// the base group, the fish, the inner globe, the seaweed, the outside, the bubbles, the light rays and the outer globe,
// with the pipeline, the material and the object's uniforms each draw needs. The lasers are off, as the Aquarium's
// default is. Header-only, no libc (the wasm build has none).
#ifndef SCENE_H
#define SCENE_H

#include "pack.h"
#include "sim.h"

enum {
  PIPE_DIFFUSE, PIPE_DIFFUSE_NOFOG, PIPE_NORMALMAP, PIPE_REFLECTION, PIPE_FISH_NORMAL, PIPE_FISH_REFLECT,
  PIPE_SEAWEED, PIPE_INNER, PIPE_OUTER, PIPE_BUBBLE, PIPE_RAY, PIPE_COUNT
};

enum { CMD_PIPELINE, CMD_MATERIAL, CMD_DRAW_OBJECT, CMD_DRAW_FISH, CMD_DRAW_BUBBLES, CMD_DRAW_RAY };

// a, b: CMD_PIPELINE pipeline; CMD_MATERIAL material (a model's index, or MAT_BUBBLE/MAT_RAY past the models);
// CMD_DRAW_OBJECT model, object slot; CMD_DRAW_FISH model, fish (into the frame's fish), species;
// CMD_DRAW_BUBBLES set; CMD_DRAW_RAY ray.
typedef struct { uint32_t op, a, b, c; } SceneCmd;

enum { GROUP_BASE, GROUP_INNER, GROUP_SEAWEED, GROUP_OUTSIDE, GROUP_OUTER, GROUP_FISH };

typedef struct {
  int group, fog, pipeline;  // pipeline -1: by the model's textures
} SceneInfo;

static SceneInfo scene_info(const char *name) {
  SceneInfo i = {GROUP_BASE, 1, -1};
#define IS(s) pack_streq(name, s)
  if (IS("SmallFishA") || IS("MediumFishB")) { i.group = GROUP_FISH; i.pipeline = PIPE_FISH_REFLECT; }
  else if (IS("MediumFishA") || IS("BigFishA") || IS("BigFishB")) { i.group = GROUP_FISH; i.pipeline = PIPE_FISH_NORMAL; }
  else if (IS("EnvironmentBox") || IS("Skybox")) { i.group = GROUP_OUTSIDE; i.fog = 0; i.pipeline = PIPE_DIFFUSE_NOFOG; }
  else if (IS("SupportBeams")) { i.group = GROUP_OUTSIDE; i.fog = 0; }
  else if (IS("GlobeBase")) { i.fog = 0; i.pipeline = PIPE_DIFFUSE_NOFOG; }
  else if (IS("GlobeInner")) { i.group = GROUP_INNER; i.pipeline = PIPE_INNER; }
  else if (IS("GlobeOuter")) { i.group = GROUP_OUTER; i.pipeline = PIPE_OUTER; }
  else if (IS("SeaweedA") || IS("SeaweedB")) { i.group = GROUP_SEAWEED; i.pipeline = PIPE_SEAWEED; }
#undef IS
  return i;
}

static int scene_model_pipeline(const Pack *p, uint32_t model) {
  const PackModel *m = &p->models[model];
  SceneInfo info = scene_info(p->scenes[m->scene].name);
  if (info.pipeline >= 0) return info.pipeline;
  // As the Aquarium's Scene picks a program: a reflection map, a normal map, else diffuse. Without fog, only diffuse
  // occurs (SupportBeams).
  if (!info.fog) return PIPE_DIFFUSE_NOFOG;
  if (m->reflectionMap != PACK_NONE) return PIPE_REFLECTION;
  if (m->normalMap != PACK_NONE) return PIPE_NORMALMAP;
  return PIPE_DIFFUSE;
}

#define MAT_BUBBLE(p) ((p)->modelCount)
#define MAT_RAY(p) ((p)->modelCount + 1)

// Builds a frame: its commands into cmds (returns their number), the objects' uniforms into objects (one a slot), the
// fish into fish. cmds needs room for scene_max_commands(); objects for propCount; fish for sim->fishTotal.
static uint32_t scene_max_commands(const Pack *p, const Sim *s) {
  return 4 * (p->propCount * 4 + (uint32_t)s->fishTotal + 64) + 64;
}

typedef struct {
  SceneCmd *cmds;
  uint32_t n;
  int pipeline, material;
} SceneOut;

static void scene_emit(SceneOut *o, uint32_t op, uint32_t a, uint32_t b, uint32_t c) {
  if (op == CMD_PIPELINE) { if (o->pipeline == (int)a) return; o->pipeline = (int)a; }
  if (op == CMD_MATERIAL) { if (o->material == (int)a) return; o->material = (int)a; }
  SceneCmd *cmd = &o->cmds[o->n++];
  cmd->op = op; cmd->a = a; cmd->b = b; cmd->c = c;
}

// DrawGroup: every placed object of the group, each of its scene's models.
static void scene_group(const Pack *p, const Sim *s, int group, float specularFactor, SceneOut *o, SimObject *objects,
                        uint32_t *slot) {
  int ii = 0;
  for (uint32_t i = 0; i < p->propCount; i++) {
    const PackProp *prop = &p->props[i];
    if (scene_info(p->scenes[prop->scene].name).group != group) continue;
    sim_object(s, prop->world, ii, 50, specularFactor, &objects[*slot]);
    const PackScene *sc = &p->scenes[prop->scene];
    for (uint32_t m = sc->firstModel; m < sc->firstModel + sc->modelCount; m++) {
      scene_emit(o, CMD_PIPELINE, (uint32_t)scene_model_pipeline(p, m), 0, 0);
      scene_emit(o, CMD_MATERIAL, m, 0, 0);
      scene_emit(o, CMD_DRAW_OBJECT, m, *slot, 0);
    }
    ++*slot;
    ii++;
  }
}

static uint32_t scene_frame(const Pack *p, const Sim *s, SceneCmd *cmds, SimObject *objects, SimFish *fish) {
  SceneOut o = {cmds, 0, -1, -1};
  uint32_t slot = 0;
  scene_group(p, s, GROUP_BASE, 1, &o, objects, &slot);
  sim_fish(s, fish);
  uint32_t f = 0;
  for (int sp = 0; sp < SIM_SPECIES; sp++) {
    const PackScene *sc = &p->scenes[sp];  // the pack lists the five species first
    uint32_t m = sc->firstModel;
    for (int i = 0; i < s->fishCount[sp]; i++, f++) {
      scene_emit(&o, CMD_PIPELINE, (uint32_t)scene_model_pipeline(p, m), 0, 0);
      scene_emit(&o, CMD_MATERIAL, m, 0, 0);
      scene_emit(&o, CMD_DRAW_FISH, m, f, (uint32_t)sp);
    }
  }
  scene_group(p, s, GROUP_INNER, 1, &o, objects, &slot);
  scene_group(p, s, GROUP_SEAWEED, 1, &o, objects, &slot);
  scene_group(p, s, GROUP_OUTSIDE, 0, &o, objects, &slot);
  scene_emit(&o, CMD_PIPELINE, PIPE_BUBBLE, 0, 0);
  scene_emit(&o, CMD_MATERIAL, MAT_BUBBLE(p), 0, 0);
  for (uint32_t i = 0; i < SIM_BUBBLE_SETS; i++) scene_emit(&o, CMD_DRAW_BUBBLES, i, 0, 0);
  scene_emit(&o, CMD_PIPELINE, PIPE_RAY, 0, 0);
  scene_emit(&o, CMD_MATERIAL, MAT_RAY(p), 0, 0);
  for (uint32_t i = 0; i < SIM_LIGHT_RAYS; i++) scene_emit(&o, CMD_DRAW_RAY, i, 0, 0);
  scene_group(p, s, GROUP_OUTER, 1, &o, objects, &slot);
  return o.n;
}

// The light rays' plane (tdl's createPlane(1, 1, 1, 1) reoriented: x in [-0.5, 0.5], y in [0, 1], z 0), in the
// models' 14-float vertex format, and its indices.
static const float SCENE_RAY_VERTICES[4 * 14] = {
  -0.5f, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0,
  0.5f, 0, 0, 0, 0, -1, 1, 0, 0, 0, 0, 0, 0, 0,
  -0.5f, 1, 0, 0, 0, -1, 0, 1, 0, 0, 0, 0, 0, 0,
  0.5f, 1, 0, 0, 0, -1, 1, 1, 0, 0, 0, 0, 0, 0,
};
static const uint16_t SCENE_RAY_INDICES[6] = {0, 1, 2, 2, 1, 3};

#endif
