// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
layout(push_constant, std430) uniform Fish {
  vec3 worldPosition;
  float scale;
  vec3 nextPosition;
  float time;
  float fishLength;
  float fishWaveLength;
  float fishBendAmount;
} f;
