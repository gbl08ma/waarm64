#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
#include "material.glsl"
#include "object.glsl"
#include "varyings.glsl"
void main() {
  vec4 diffuseColor = texture(diffuse, v_texCoord);
  mat3 tangentToWorld = mat3(v_tangent, v_binormal, v_normal);
  vec4 normalSpec = texture(normalMap, v_texCoord.xy);
  vec4 reflection = texture(reflectionMap, v_texCoord.xy);
  vec3 tangentNormal = normalSpec.xyz - vec3(0.5, 0.5, 0.5);
  vec3 normal = normalize(tangentToWorld * tangentNormal);
  vec3 surfaceToView = normalize(v_surfaceToView);
  vec4 skyColor = texture(skybox, -reflect(surfaceToView, normal));
  vec3 fudge = skyColor.rgb * vec3(1.1);
  float bright = min(1.0, fudge.r * fudge.g * fudge.b);
  vec4 reflectColor = mix(vec4(skyColor.rgb, bright), diffuseColor, 1.0 - reflection.r);
  float r = abs(dot(surfaceToView, normal));
  fragColor = vec4(mix(skyColor, reflectColor, (r + 0.3) * reflection.r).rgb, 1.0 - r);
}
