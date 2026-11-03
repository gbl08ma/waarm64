// Ported from the WebGL Aquarium (WebGLSamples, Copyright 2009, Google Inc., BSD-3-Clause: LICENSE.aquarium beside
// this file; THIRD_PARTY.json).
// VK0's scene (bench/vulkan/REPORT.md): the WebGL Aquarium's simulation, shared by every arm so each draws the same
// frames: the native Vulkan scene (vk.c), the GLES port (gles.c) and, compiled to wasm, the WebGPU pages. Ported from
// aquarium.js (WebGLSamples, BSD-3-Clause, THIRD_PARTY.json): the camera, the fish paths, the bubbles and the light rays.
// Time advances a fixed 1/60 s a frame, and sin, cos and the random numbers are our own, so a frame index gives the
// same numbers on every platform. No libc: the wasm build has none.
#ifndef SIM_H
#define SIM_H

#include <stdint.h>

#define SIM_SPECIES 5          // SmallFishA, MediumFishA, MediumFishB, BigFishA, BigFishB (the pack's scenes 0-4)
#define SIM_BUBBLE_SETS 10     // g_numBubbleSets
#define SIM_BUBBLES 100        // particles in a set
#define SIM_LIGHT_RAYS 5
#define SIM_MAX_PROPS 128

// The per-frame uniforms (std140: every member a multiple of 16 bytes). 288 bytes.
typedef struct {
  float viewProjection[16];
  float viewInverse[16];
  float viewProjectionNoRotation[16];  // the light rays'
  float lightWorldPos[4];
  float ambient[4];
  float fogColor[4];
  float fogParams[4];    // power, mult, offset, 0
  float innerParams[4];  // refractionFudge, eta, tankColorFudge, 0
  float clock[4];        // the clock, the frame index, 0, 0
} SimGlobals;

// One fish (std140-compatible: vec3 + float, twice). 32 bytes.
typedef struct {
  float worldPosition[3];
  float scale;
  float nextPosition[3];
  float time;
} SimFish;

// A species' constants (the Aquarium's constUniforms).
typedef struct {
  float fishLength, fishWaveLength, fishBendAmount, pad;
} SimSpecies;

// One placed object: world and its inverse transpose, and its parameters. 144 bytes; 256 apart in a dynamic buffer.
typedef struct {
  float world[16];
  float worldInverseTranspose[16];
  float params[4];  // time, shininess, specularFactor, 0
} SimObject;

// A bubble set: where it was triggered and when.
typedef struct {
  float world[4];  // translation x, y, z; the trigger time
} SimBubbleSet;

// A bubble's constants (one per particle of a set; the sets share them). 64 bytes.
typedef struct {
  float positionStartTime[4];
  float velocityStartSize[4];
  float accelerationEndSize[4];
  float lifeTimeSpin[4];  // lifeTime, spinStart, spinSpeed, 0
} SimBubble;

// A light ray: its world matrix and colour multiplier.
typedef struct {
  float world[16];
  float colorMult[4];
} SimLightRay;

typedef struct {
  // Settings.
  int fishTotal;
  int width, height;
  // Derived at init.
  int fishCount[SIM_SPECIES];
  SimSpecies species[SIM_SPECIES];
  SimBubble bubbles[SIM_BUBBLES];
  // Per frame.
  uint32_t frame;
  float clock, eyeClock;
  SimGlobals globals;
  SimBubbleSet bubbleSets[SIM_BUBBLE_SETS];
  SimLightRay lightRays[SIM_LIGHT_RAYS];
  // Internal state.
  uint32_t rng;            // the scene's own random numbers (Math.random's role)
  float bubbleTimer;
  int bubbleIndex;
  float rayTimer[SIM_LIGHT_RAYS], rayDuration[SIM_LIGHT_RAYS], rayRot[SIM_LIGHT_RAYS], rayX[SIM_LIGHT_RAYS];
} Sim;

void sim_init(Sim *s, int fishTotal, int width, int height);
// Advances to the next frame (the first call gives frame 0) and fills globals, bubbleSets and lightRays.
void sim_step(Sim *s);
// The fish of every species for the current frame, species after species (fishCount[i] each), into out.
void sim_fish(const Sim *s, SimFish *out);
// A placed object's uniforms for the current frame: index is its place in its group (the Aquarium's `clock + ii`).
void sim_object(const Sim *s, const float world[16], int index, float shininess, float specularFactor, SimObject *out);

float sim_sin(float x);
float sim_cos(float x);

#endif
