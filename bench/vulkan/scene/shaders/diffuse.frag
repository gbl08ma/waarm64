#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
#include "material.glsl"
#include "object.glsl"
#include "lit.glsl"
#include "varyings.glsl"
void main() {
  vec4 diffuseColor = texture(diffuse, v_texCoord);
  vec3 normal = normalize(v_normal);
  vec3 surfaceToLight = normalize(v_surfaceToLight);
  vec3 surfaceToView = normalize(v_surfaceToView);
  vec3 halfVector = normalize(surfaceToLight + surfaceToView);
  vec4 litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), o.params.y);
  vec4 outColor = vec4((diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * o.params.z).rgb, diffuseColor.a);
  fragColor = fog(outColor, v_position, diffuseColor.a);
}
