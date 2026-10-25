#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
layout(set = 1, binding = 0) uniform sampler2D colorMap;
layout(location = 0) in vec2 v_texCoord;
layout(location = 1) in float v_percentLife;
layout(location = 0) out vec4 fragColor;
void main() {
  // The emitter's colour ramp: opaque, then fading out over the last fifth; colorMult (0.7, 0.8, 1, 1).
  float alpha = clamp((1.0 - v_percentLife) * 5.0, 0.0, 1.0);
  fragColor = texture(colorMap, v_texCoord) * vec4(0.7, 0.8, 1.0, alpha);
}
