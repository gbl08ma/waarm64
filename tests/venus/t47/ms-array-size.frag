#version 450
// tests/wgsl.test.ts (VK4 T47, vkd3d's test_multisample_array_texture): a multisampled array's size and a texel of
// it, which WGSL can't ask of the texture_multisampled_2d it's bound as (its first layer): a stage Tint compiles.
layout(set = 0, binding = 0) uniform sampler2DMSArray t;
layout(location = 0) out uvec4 o;
void main() { o = uvec4(textureSize(t), textureSamples(t)) + uvec4(texelFetch(t, ivec3(0, 0, 1), 2)); }
