#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
#include "object.glsl"
layout(location = 0) in vec4 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 texCoord;
layout(location = 3) in vec3 tangent;
layout(location = 4) in vec3 binormal;
layout(location = 0) out vec4 v_position;
layout(location = 1) out vec2 v_texCoord;
layout(location = 2) out vec3 v_tangent;
layout(location = 3) out vec3 v_binormal;
layout(location = 4) out vec3 v_normal;
layout(location = 5) out vec3 v_surfaceToLight;
layout(location = 6) out vec3 v_surfaceToView;
void main() {
  v_texCoord = texCoord;
  v_position = g.viewProjection * o.world * position;
  v_normal = (o.worldInverseTranspose * vec4(normal, 0)).xyz;
  v_surfaceToLight = g.lightWorldPos.xyz - (o.world * position).xyz;
  v_surfaceToView = (g.viewInverse[3] - (o.world * position)).xyz;
  v_binormal = (o.worldInverseTranspose * vec4(binormal, 0)).xyz;
  v_tangent = (o.worldInverseTranspose * vec4(tangent, 0)).xyz;
  gl_Position = v_position;
}
