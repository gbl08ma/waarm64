#version 450
// tests/venus-driver.test.ts (passes: flat*): driver.vert's quad, each vertex's uv a flat colour (vk/driver/wg_test.c's
// wgt_flat: the provoking vertex).
layout(push_constant) uniform P { vec4 off; } pc;
layout(location = 0) in vec3 pos;
layout(location = 1) in vec2 uv;
layout(location = 0) flat out vec4 col;
void main() { gl_Position = vec4(pos + pc.off.xyz, 1.0); col = vec4(uv, 0.0, 1.0); }
