#version 450
// VK4's backlog easy wins (vk/driver/wg_test.c 132): one separate LINEAR sampler (binding 2) samples a 2x1 RGBA8
// texture of 0 and 255 (binding 0: a quarter of the way, 0.25) and a D32 view cleared to 0.75 (binding 1): the depth
// view's nearest twin of the sampler for it alone (split: wg_shader.c), the texture filtered.
layout(set = 0, binding = 0) uniform texture2D color;
layout(set = 0, binding = 1) uniform texture2D depth;
layout(set = 0, binding = 2) uniform sampler s;
layout(location = 0) out vec4 o;
void main() {
  o = vec4(textureLod(sampler2D(color, s), vec2(0.375, 0.5), 0.0).r, textureLod(sampler2D(depth, s), vec2(0.5), 0.0).r, 0.0, 1.0);
}
