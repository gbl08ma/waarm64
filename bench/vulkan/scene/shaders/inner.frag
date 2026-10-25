#version 450
// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
#include "common.glsl"
#include "material.glsl"
#include "object.glsl"
#include "lit.glsl"
#include "varyings.glsl"
void main() {
  float fudge = g.innerParams.z;
  vec4 diffuseColor = texture(diffuse, v_texCoord) + vec4(fudge, fudge, fudge, 1);
  mat3 tangentToWorld = mat3(v_tangent, v_binormal, v_normal);
  vec4 normalSpec = texture(normalMap, v_texCoord.xy);
  vec4 refraction = texture(reflectionMap, v_texCoord.xy);
  vec3 tangentNormal = normalSpec.xyz - vec3(0.5, 0.5, 0.5);
  tangentNormal = normalize(tangentNormal + vec3(0, 0, g.innerParams.x));
  vec3 normal = normalize(tangentToWorld * tangentNormal);
  vec3 surfaceToView = normalize(v_surfaceToView);
  vec3 refractionVec = refract(surfaceToView, normal, g.innerParams.y);
  vec4 skyColor = texture(skybox, refractionVec);
  vec4 outColor = vec4(mix(skyColor * diffuseColor, diffuseColor, refraction.r).rgb, diffuseColor.a);
  fragColor = fog(outColor, v_position, diffuseColor.a);
}
