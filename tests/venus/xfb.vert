#version 450
// tests/venus-driver.test.ts (passes: xfb*): each vertex's position and (u, v, gl_VertexIndex, 7) captured by transform
// feedback, 32 bytes a vertex (vk/driver/wg_test.c's wgt_xfb).
layout(location = 0) in vec3 pos;
layout(location = 1) in vec2 uv;
layout(xfb_buffer = 0, xfb_stride = 32) out gl_PerVertex { layout(xfb_offset = 0) vec4 gl_Position; };
layout(location = 0, xfb_buffer = 0, xfb_offset = 16) out vec4 v;
void main() { gl_Position = vec4(pos, 1.0); v = vec4(uv, float(gl_VertexIndex), 7.0); }
