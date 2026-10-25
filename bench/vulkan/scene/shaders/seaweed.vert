#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
#include "object.glsl"
layout(location = 0) in vec4 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 texCoord;
layout(location = 0) out vec4 v_position;
layout(location = 1) out vec2 v_texCoord;
layout(location = 2) out vec3 v_tangent;
layout(location = 3) out vec3 v_binormal;
layout(location = 4) out vec3 v_normal;
layout(location = 5) out vec3 v_surfaceToLight;
layout(location = 6) out vec3 v_surfaceToView;
void main() {
  vec3 toCamera = normalize(g.viewInverse[3].xyz - o.world[3].xyz);
  vec3 yAxis = vec3(0, 1, 0);
  vec3 xAxis = cross(yAxis, toCamera);
  mat4 newWorld = mat4(vec4(xAxis, 0), vec4(yAxis, 0), vec4(xAxis, 0), o.world[3]);
  v_texCoord = texCoord;
  vec4 p = position + vec4(sin(o.params.x * 0.5) * pow(position.y * 0.07, 2.0) * 1.0, -4, 0, 0);
  v_position = (g.viewProjection * newWorld) * p;
  v_normal = (newWorld * vec4(normal, 0)).xyz;
  v_surfaceToLight = g.lightWorldPos.xyz - (o.world * position).xyz;
  v_surfaceToView = (g.viewInverse[3] - (o.world * position)).xyz;
  v_tangent = vec3(0);
  v_binormal = vec3(0);
  gl_Position = v_position;
}
