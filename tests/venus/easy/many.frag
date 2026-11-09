#version 450
// VK4's backlog easy wins (vk/driver/wg_test.c 133, with easy/many.vert): the fragment stage's 8 uniform buffers, 15
// samplers and 15 textures (zeros), then a D32 view cleared to 0.75 and a LINEAR sampler, resources 77 and 78 of the
// program: the variant's masks of unfilterable views past the first 64 (the sampler its nearest twin).
layout(set = 0, binding = 3) uniform U { vec4 v; } u[8];
layout(set = 0, binding = 4) uniform sampler s[15];
layout(set = 0, binding = 5) uniform texture2D t[15];
layout(set = 0, binding = 6) uniform texture2D depth;
layout(set = 0, binding = 7) uniform sampler linear;
layout(location = 0) in float sum;
layout(location = 0) out vec4 o;
void main() {
  float x = sum;
  for (int i = 0; i < 8; i++) x += u[i].v.x;
  for (int i = 0; i < 15; i++) x += textureLod(sampler2D(t[i], s[i]), vec2(0.5), 0.0).x;
  o = vec4(x, textureLod(sampler2D(depth, linear), vec2(0.5), 0.0).r, 0.0, 1.0);
}
