#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
#include "material.glsl"
#include "lit.glsl"
#include "varyings.glsl"
const float shininess = 5.0;
const float specularFactor = 0.3;
void main() {
  vec4 diffuseColor = texture(diffuse, v_texCoord);
  mat3 tangentToWorld = mat3(v_tangent, v_binormal, v_normal);
  vec4 normalSpec = texture(normalMap, v_texCoord.xy);
  vec4 reflection = texture(reflectionMap, v_texCoord.xy);
  vec3 tangentNormal = normalSpec.xyz - vec3(0.5, 0.5, 0.5);
  vec3 normal = normalize(tangentToWorld * tangentNormal);
  vec3 surfaceToLight = normalize(v_surfaceToLight);
  vec3 surfaceToView = normalize(v_surfaceToView);
  vec4 skyColor = texture(skybox, -reflect(surfaceToView, normal));
  vec3 halfVector = normalize(surfaceToLight + surfaceToView);
  vec4 litR = lit(dot(normal, surfaceToLight), dot(normal, halfVector), shininess);
  vec4 outColor = vec4(mix(skyColor, diffuseColor * litR.y + diffuseColor * g.ambient + litR.z * specularFactor * normalSpec.a,
                           1.0 - reflection.r).rgb, diffuseColor.a);
  fragColor = fog(outColor, v_position, diffuseColor.a);
}
