// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
// What every shader of the scene shares (sim.h's layouts): set 0 is the frame's (its uniforms, updated every frame,
// and the skybox), set 1 a material's three textures, set 2 an object's uniforms at a dynamic offset.
layout(set = 0, binding = 0, std140) uniform Globals {
  mat4 viewProjection;
  mat4 viewInverse;
  mat4 viewProjectionNoRotation;
  vec4 lightWorldPos;
  vec4 ambient;
  vec4 fogColor;
  vec4 fogParams;    // power, mult, offset
  vec4 innerParams;  // refractionFudge, eta, tankColorFudge
  vec4 clock;
} g;
layout(set = 0, binding = 1) uniform samplerCube skybox;
