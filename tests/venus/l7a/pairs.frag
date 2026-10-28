#version 450
// tests/wgsl.test.ts (VK3 L7a, the binding review's finding 4): 12 textures and 12 samplers indexed apart, 144
// texture-sampler pairs (each texture with each sampler), past what the translator records (WGSL_MAX_PAIRS): a stage
// that fails saying so, not one whose pairs past the cap the driver never sees.
layout(set = 0, binding = 0) uniform texture2D t[12];
layout(set = 0, binding = 1) uniform sampler s[12];
layout(location = 0) in vec2 uv;
layout(location = 1) flat in ivec2 k;
layout(location = 0) out vec4 o;
void main() { o = texture(sampler2D(t[k.x], s[k.y]), uv); }
