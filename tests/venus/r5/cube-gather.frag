#version 450
#extension GL_EXT_texture_shadow_lod : require
// VK4 R5 (the review's C6): what wgsl_sampler.c can't do of a shadow cube sampled from its faces: refused, not drawn
// with a module that doesn't match its layout.
layout(set = 0, binding = 0) uniform textureCube t;
layout(set = 0, binding = 2) uniform samplerShadow a;
layout(location = 0) out vec4 c;
void main() {
  const vec4 d = vec4(1.0, 0.0, 0.0, 0.5);
  float lod = gl_FragCoord.x < 1000.0 ? 1.0 : 0.0;
  c = textureGather(samplerCubeShadow(t, a), d.xyz, 0.5) + textureLod(samplerCubeShadow(t, a), d, lod);
}
