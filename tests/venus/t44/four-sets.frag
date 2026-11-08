#version 450
// VK4 T44 (vk/driver/wg_test.c's wgt_pull, scenario 5): the vertex's colour, in a stage reading a uniform block of
// each of sets 0 to 3, so its program has four groups, none free for pulled vertices.
layout(set = 0, binding = 0) uniform U0 { vec4 c; } u0;
layout(set = 1, binding = 0) uniform U1 { vec4 c; } u1;
layout(set = 2, binding = 0) uniform U2 { vec4 c; } u2;
layout(set = 3, binding = 0) uniform U3 { vec4 c; } u3;
layout(location = 0) flat in vec4 col;
layout(location = 0) out vec4 o;
void main() { o = u0.c.a + u1.c.a + u2.c.a + u3.c.a < -4.0 ? vec4(0.0) : vec4(col.rgb, 1.0); }
