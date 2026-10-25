#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
layout(push_constant, std430) uniform Ray { mat4 world; vec4 colorMult; } ray;
layout(location = 0) in vec4 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 texCoord;
layout(location = 0) out vec2 v_texCoord;
void main() {
  v_texCoord = texCoord;
  gl_Position = g.viewProjectionNoRotation * ray.world * position;
}
