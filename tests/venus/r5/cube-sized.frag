#version 450
#extension GL_EXT_texture_shadow_lod : require
// VK4 R5 (the review's C5): a shadow cube sampled at a LOD the shader works out, so from its faces, through one sampler
// and, with no key of its own, another: each by its own compare op.
layout(set = 0, binding = 0) uniform textureCube t;
layout(set = 0, binding = 2) uniform samplerShadow a;
layout(set = 0, binding = 3) uniform samplerShadow b;
layout(location = 0) flat in int size;
layout(location = 0) out vec4 c;
void main() {
  const vec4 d = vec4(1.0, 0.0, 0.0, 0.5);
  float lod = gl_FragCoord.x < 1000.0 ? 1.0 : 0.0;
  c = vec4(textureLod(samplerCubeShadow(t, a), d, lod), texture(samplerCubeShadow(t, b), d), float(size) / 255.0, 1.0);
}
