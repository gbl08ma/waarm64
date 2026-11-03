// Ported from the WebGL Aquarium (WebGLSamples, Copyright 2009, Google Inc., BSD-3-Clause: LICENSE.aquarium beside
// this file; THIRD_PARTY.json).
// The Aquarium's simulation (sim.h). Constants and formulas from aquarium.js and aquarium-common.js (WebGLSamples,
// BSD-3-Clause): the default view ("g_ui" sliders), the fish table, the bubbles' emitter and the light rays.
#include "sim.h"

#define PI 3.14159265358979323846

// The view: the Aquarium's slider defaults.
#define TARGET_HEIGHT 0.0f
#define TARGET_RADIUS 88.0f
#define EYE_HEIGHT 38.0f
#define EYE_RADIUS 69.0f
#define EYE_SPEED 0.06f
#define FIELD_OF_VIEW 64.0f
#define FISH_HEIGHT_RANGE 1.0f
#define FISH_HEIGHT 25.0f
#define FISH_SPEED 0.124f
#define FISH_OFFSET 0.52f
#define FISH_X_CLOCK 1.0f
#define FISH_Y_CLOCK 0.556f
#define FISH_Z_CLOCK 1.0f
#define FISH_TAIL_SPEED 1.0f
#define LIGHT_RAY_Y 50.0f
#define DT (1.0f / 60.0f)

static const struct {
  float speed, speedRange, radius, radiusRange, tailSpeed, heightOffset, heightRange;
  SimSpecies k;
} FISH[SIM_SPECIES] = {
  {1, 1.5f, 30, 25, 10, 0, 16, {10, 1, 2, 0}},        // SmallFishA
  {1, 2, 10, 20, 1, 0, 16, {10, -2, 2, 0}},           // MediumFishA
  {0.5f, 4, 10, 20, 3, -8, 5, {10, -2, 2, 0}},        // MediumFishB
  {0.5f, 0.5f, 50, 3, 1.5f, 0, 16, {10, -1, 0.5f, 0}},  // BigFishA
  {0.5f, 0.5f, 45, 3, 1, 0, 16, {10, -0.7f, 0.3f, 0}},  // BigFishB
};

static double reduce(double x) {  // to [-pi, pi]
  double k = __builtin_floor(x / (2 * PI) + 0.5);
  return x - k * (2 * PI);
}

static double sin_d(double x) {
  x = reduce(x);
  // Fold to [-pi/2, pi/2], where the series converges fast.
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  double x2 = x * x, term = x, sum = x;
  for (int n = 1; n < 10; n++) {
    term *= -x2 / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

float sim_sin(float x) { return (float)sin_d(x); }
float sim_cos(float x) { return (float)sin_d((double)x + PI / 2); }

static float rnd(uint32_t *seed) {  // tdl.math.pseudoRandom's generator, in exact 32-bit arithmetic
  *seed = 134775813u * *seed + 1u;
  return (float)(*seed * (1.0 / 4294967296.0));
}

static float sqrtf_(float x) { return __builtin_sqrtf(x); }

static void normalize3(float v[3]) {
  float l = sqrtf_(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (l > 0.00001f) { v[0] /= l; v[1] /= l; v[2] /= l; }
}

static void cross3(float d[3], const float a[3], const float b[3]) {
  float x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  d[0] = x; d[1] = y; d[2] = z;
}

// tdl's row-major product: d = a * b.
static void mul(float d[16], const float a[16], const float b[16]) {
  float t[16];
  for (int i = 0; i < 4; i++)
    for (int j = 0; j < 4; j++)
      t[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
  for (int i = 0; i < 16; i++) d[i] = t[i];
}

static void inverse(float d[16], const float m[16]) {
  float inv[16];
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  float det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  float r = det != 0 ? 1.0f / det : 0;
  for (int i = 0; i < 16; i++) d[i] = inv[i] * r;
}

static void transpose(float d[16], const float m[16]) {
  float t[16];
  for (int i = 0; i < 4; i++)
    for (int j = 0; j < 4; j++) t[i * 4 + j] = m[j * 4 + i];
  for (int i = 0; i < 16; i++) d[i] = t[i];
}

static void identity(float d[16]) {
  for (int i = 0; i < 16; i++) d[i] = (i % 5) == 0;
}

static void translation(float d[16], float x, float y, float z) {
  identity(d);
  d[12] = x; d[13] = y; d[14] = z;
}

static void scaling(float d[16], float x, float y, float z) {
  identity(d);
  d[0] = x; d[5] = y; d[10] = z;
}

static void rotation_z(float d[16], float a) {
  identity(d);
  float c = sim_cos(a), s = sim_sin(a);
  d[0] = c; d[1] = s; d[4] = -s; d[5] = c;
}

static void camera_look_at(float d[16], const float eye[3], const float target[3], const float up[3]) {
  float vz[3] = {eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]}, vx[3], vy[3];
  normalize3(vz);
  cross3(vx, up, vz);
  normalize3(vx);
  cross3(vy, vz, vx);
  for (int i = 0; i < 3; i++) { d[i] = vx[i]; d[4 + i] = vy[i]; d[8 + i] = vz[i]; d[12 + i] = eye[i]; }
  d[3] = d[7] = d[11] = 0; d[15] = 1;
}

static void frustum(float d[16], float l, float r, float b, float t, float n, float f) {
  float dx = r - l, dy = t - b, dz = n - f;
  for (int i = 0; i < 16; i++) d[i] = 0;
  d[0] = 2 * n / dx;
  d[5] = 2 * n / dy;
  d[8] = (l + r) / dx;
  d[9] = (t + b) / dy;
  d[10] = f / dz;
  d[11] = -1;
  d[14] = n * f / dz;
}

static void init_light_ray(Sim *s, int i) {
  s->rayDuration[i] = 1 + rnd(&s->rng) * 1;  // g_lightRayDurationMin + random * g_lightRayDurationRange
  s->rayTimer[i] = s->rayDuration[i];
  float r = rnd(&s->rng);
  s->rayRot[i] = r * 1.0f;    // g_lightRayRotRange
  s->rayX[i] = (r - 0.5f) * 20;  // g_lightRayPosRange
}

void sim_init(Sim *s, int fishTotal, int width, int height) {
  char *p = (char *)s;
  for (unsigned i = 0; i < sizeof *s; i++) p[i] = 0;
  s->fishTotal = fishTotal;
  s->width = width;
  s->height = height;
  s->rng = 12345;
  s->frame = (uint32_t)-1;
  // The Aquarium's split: big fish first, then medium, the rest small (initialize() in aquarium.js).
  int left = fishTotal;
  int big = fishTotal < 100 ? 1 : 2;
  int medium = fishTotal < 1000 ? fishTotal / 10 : fishTotal < 10000 ? 80 : 160;
  for (int i = 3; i < 5; i++) { int n = left < big ? left : big; s->fishCount[i] = n; left -= n; }
  for (int i = 1; i < 3; i++) { int n = left < medium ? left : medium; s->fishCount[i] = n; left -= n; }
  s->fishCount[0] = left;
  for (int i = 0; i < SIM_SPECIES; i++) s->species[i] = FISH[i].k;
  // The bubbles' emitter (setupBubbles): 100 particles, lifeTime 40, sizes 0.01+0.01r to 0.4+0.2r, rising.
  uint32_t seed = 777;
  for (int i = 0; i < SIM_BUBBLES; i++) {
    SimBubble *b = &s->bubbles[i];
    float pm[3];
    for (int c = 0; c < 3; c++) pm[c] = rnd(&seed) * 2 - 1;
    b->positionStartTime[0] = pm[0] * 0.1f;
    b->positionStartTime[1] = -2 + pm[1] * 2;
    b->positionStartTime[2] = pm[2] * 0.1f;
    b->positionStartTime[3] = 0;
    for (int c = 0; c < 3; c++) pm[c] = rnd(&seed) * 2 - 1;
    b->velocityStartSize[0] = pm[0] * 0.05f;
    b->velocityStartSize[1] = 0;
    b->velocityStartSize[2] = pm[2] * 0.05f;
    b->velocityStartSize[3] = 0.01f + rnd(&seed) * 0.01f;
    b->accelerationEndSize[0] = 0;
    b->accelerationEndSize[1] = 0.05f + (rnd(&seed) * 2 - 1) * 0.02f;
    b->accelerationEndSize[2] = 0;
    b->accelerationEndSize[3] = 0.4f + rnd(&seed) * 0.2f;
    b->lifeTimeSpin[0] = 40;
  }
  for (int i = 0; i < SIM_BUBBLE_SETS; i++) s->bubbleSets[i].world[3] = -1000;  // never triggered
  for (int i = 0; i < SIM_LIGHT_RAYS; i++) init_light_ray(s, i);
}

void sim_step(Sim *s) {
  s->frame++;
  if (s->frame > 0) {
    s->clock += DT;
    s->eyeClock += DT * EYE_SPEED;
  }
  float elapsed = s->frame > 0 ? DT : 0;
  for (int i = 0; i < SIM_LIGHT_RAYS; i++) {
    s->rayTimer[i] -= elapsed;
    if (s->rayTimer[i] < 0) init_light_ray(s, i);
  }
  s->bubbleTimer -= elapsed;
  if (s->bubbleTimer < 0) {
    s->bubbleTimer = 2 + rnd(&s->rng) * 8;
    float radius = rnd(&s->rng) * 50, angle = rnd(&s->rng) * (float)(PI * 2);
    SimBubbleSet *b = &s->bubbleSets[s->bubbleIndex];
    b->world[0] = sim_sin(angle) * radius;
    b->world[1] = 0;
    b->world[2] = sim_cos(angle) * radius;
    b->world[3] = s->clock;
    s->bubbleIndex = (s->bubbleIndex + 1) % SIM_BUBBLE_SETS;
  }

  // The camera (setToCameraLookAt, renderMono).
  SimGlobals *g = &s->globals;
  float eye[3] = {sim_sin(s->eyeClock) * EYE_RADIUS, EYE_HEIGHT, sim_cos(s->eyeClock) * EYE_RADIUS};
  float target[3] = {sim_sin(s->eyeClock + (float)PI) * TARGET_RADIUS, TARGET_HEIGHT, sim_cos(s->eyeClock + (float)PI) * TARGET_RADIUS};
  float up[3] = {0, 1, 0};
  float proj[16], view[16], t0[16], t1[16];
  float nearZ = 1, farZ = 25000, aspect = (float)s->width / (float)s->height;
  float half = (float)(FIELD_OF_VIEW * PI / 180 * 0.5);
  float top = sim_sin(half) / sim_cos(half) * nearZ;
  frustum(proj, aspect * -top, aspect * top, -top, top, nearZ, farZ);
  camera_look_at(g->viewInverse, eye, target, up);
  inverse(view, g->viewInverse);
  mul(g->viewProjection, view, proj);
  translation(t1, view[12], view[13], view[14]);
  mul(g->viewProjectionNoRotation, t1, proj);
  // The light: 20 along the view's x axis and 30 along its y from the eye (eyePosition, as aquarium.js has it).
  for (int i = 0; i < 3; i++) g->lightWorldPos[i] = eye[i] + g->viewInverse[i] * 20 + g->viewInverse[4 + i] * 30;
  g->lightWorldPos[3] = 1;
  g->ambient[0] = 0.22f; g->ambient[1] = 0.25f; g->ambient[2] = 0.39f; g->ambient[3] = 0;
  g->fogColor[0] = 0.54f; g->fogColor[1] = 0.86f; g->fogColor[2] = 1.0f; g->fogColor[3] = 1;
  g->fogParams[0] = 14.5f; g->fogParams[1] = 1.66f; g->fogParams[2] = 0.53f; g->fogParams[3] = 0;
  g->innerParams[0] = 3; g->innerParams[1] = 1; g->innerParams[2] = 0.8f; g->innerParams[3] = 0;
  g->clock[0] = s->clock; g->clock[1] = (float)s->frame; g->clock[2] = 0; g->clock[3] = 0;

  // The light rays (scaled 10, -100, 10 below a rotation and a translation).
  for (int i = 0; i < SIM_LIGHT_RAYS; i++) {
    float lerp = s->rayTimer[i] / s->rayDuration[i];
    float y = LIGHT_RAY_Y + EYE_HEIGHT;
    y = y < 70 ? 70 : y > 120 ? 120 : y;
    float r[16], tr[16], sc[16];
    rotation_z(r, s->rayRot[i] + lerp * 0.2f);
    translation(tr, s->rayX[i], y, 0);
    mul(t0, r, tr);
    scaling(sc, 10, -100, 10);
    mul(s->lightRays[i].world, sc, t0);
    s->lightRays[i].colorMult[0] = s->lightRays[i].colorMult[1] = s->lightRays[i].colorMult[2] = 1;
    s->lightRays[i].colorMult[3] = sim_sin(lerp * (float)PI);
  }
}

void sim_fish(const Sim *s, SimFish *out) {
  uint32_t seed = 0;  // math.resetPseudoRandom() at the top of every frame
  for (int sp = 0; sp < SIM_SPECIES; sp++) {
    float baseClock = s->clock * FISH_SPEED;
    float height = FISH_HEIGHT + FISH[sp].heightOffset;
    float heightRange = FISH_HEIGHT_RANGE * FISH[sp].heightRange;
    float tailSpeed = FISH[sp].tailSpeed * FISH_TAIL_SPEED;
    for (int i = 0; i < s->fishCount[sp]; i++) {
      float fishClock = baseClock + i * FISH_OFFSET;
      float speed = FISH[sp].speed + rnd(&seed) * FISH[sp].speedRange;
      float scale = 1.0f + rnd(&seed) * 1;
      float xRadius = FISH[sp].radius + rnd(&seed) * FISH[sp].radiusRange;
      float yRadius = 2.0f + rnd(&seed) * heightRange;
      float zRadius = FISH[sp].radius + rnd(&seed) * FISH[sp].radiusRange;
      float speedClock = fishClock * speed;
      float xClock = speedClock * FISH_X_CLOCK, yClock = speedClock * FISH_Y_CLOCK, zClock = speedClock * FISH_Z_CLOCK;
      out->worldPosition[0] = sim_sin(xClock) * xRadius;
      out->worldPosition[1] = sim_sin(yClock) * yRadius + height;
      out->worldPosition[2] = sim_cos(zClock) * zRadius;
      out->nextPosition[0] = sim_sin(xClock - 0.04f) * xRadius;
      out->nextPosition[1] = sim_sin(yClock - 0.01f) * yRadius + height;
      out->nextPosition[2] = sim_cos(zClock - 0.04f) * zRadius;
      out->scale = scale;
      float t = (s->clock + i) * tailSpeed * speed;
      out->time = t - __builtin_floorf(t / (float)(PI * 2)) * (float)(PI * 2);
      out++;
    }
  }
}

void sim_object(const Sim *s, const float world[16], int index, float shininess, float specularFactor, SimObject *out) {
  float inv[16];
  for (int i = 0; i < 16; i++) out->world[i] = world[i];
  inverse(inv, world);
  transpose(out->worldInverseTranspose, inv);
  out->params[0] = s->clock + index;
  out->params[1] = shininess;
  out->params[2] = specularFactor;
  out->params[3] = 0;
}
