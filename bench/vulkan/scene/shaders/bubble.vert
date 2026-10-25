#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
layout(push_constant, std430) uniform Set { vec4 world; } set;  // translation, trigger time
layout(location = 0) in vec4 positionStartTime;
layout(location = 1) in vec4 velocityStartSize;
layout(location = 2) in vec4 accelerationEndSize;
layout(location = 3) in vec4 lifeTimeSpin;
layout(location = 0) out vec2 v_texCoord;
layout(location = 1) out float v_percentLife;
const vec2 corners[4] = vec2[](vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(-0.5, 0.5), vec2(0.5, 0.5));
void main() {
  vec2 uv = corners[gl_VertexIndex];
  float lifeTime = lifeTimeSpin.x;
  float localTime = g.clock.x - set.world.w - positionStartTime.w;
  float percentLife = localTime / lifeTime;
  float size = mix(velocityStartSize.w, accelerationEndSize.w, percentLife);
  size = (percentLife < 0.0 || percentLife > 1.0) ? 0.0 : size;
  vec3 center = velocityStartSize.xyz * localTime + accelerationEndSize.xyz * localTime * localTime +
                positionStartTime.xyz + set.world.xyz;
  vec3 x = g.viewInverse[0].xyz, y = g.viewInverse[1].xyz;
  vec3 p = center + (x * uv.x + y * uv.y) * size;
  v_texCoord = uv + 0.5;
  v_percentLife = percentLife;
  gl_Position = g.viewProjection * vec4(p, 1);
}
