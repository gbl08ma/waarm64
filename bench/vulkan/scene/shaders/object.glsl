// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
layout(set = 2, binding = 0, std140) uniform Object {
  mat4 world;
  mat4 worldInverseTranspose;
  vec4 params;  // time, shininess, specularFactor
} o;
