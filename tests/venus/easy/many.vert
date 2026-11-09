#version 450
// VK4's backlog easy wins (vk/driver/wg_test.c 133, with easy/many.frag): a program of 79 resources, the vertex
// stage's 8 uniform buffers, 15 samplers and 15 textures (all zeros) read into its output; a full-screen triangle.
layout(set = 0, binding = 0) uniform U { vec4 v; } u[8];
layout(set = 0, binding = 1) uniform sampler s[15];
layout(set = 0, binding = 2) uniform texture2D t[15];
layout(location = 0) out float sum;
void main() {
  float x = 0.0;
  for (int i = 0; i < 8; i++) x += u[i].v.x;
  for (int i = 0; i < 15; i++) x += textureLod(sampler2D(t[i], s[i]), vec2(0.5), 0.0).x;
  sum = x;
  gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0);
}
