#version 450
// tests/wgsl.test.ts (VK3 L7a, the binding review's finding 4): 8 textures and 9 samplers indexed apart, 72
// texture-sampler pairs (each texture with each sampler), more than the 64 the translator used to record.
layout(set = 0, binding = 0) uniform texture2D t[8];
layout(set = 0, binding = 1) uniform sampler s[9];
layout(location = 0) in vec2 uv;
layout(location = 1) flat in ivec2 k;
layout(location = 0) out vec4 o;
void main() { o = texture(sampler2D(t[k.x], s[k.y]), uv); }
