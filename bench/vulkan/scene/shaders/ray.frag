#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
layout(push_constant, std430) uniform Ray { mat4 world; vec4 colorMult; } ray;
layout(set = 1, binding = 0) uniform sampler2D colorMap;
layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;
void main() {
  fragColor = texture(colorMap, v_texCoord) * ray.colorMult;
}
