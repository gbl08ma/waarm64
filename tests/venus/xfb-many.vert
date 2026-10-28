#version 450
// tests/venus-driver.test.ts (transform feedback: xfbMany; VK3 L7a, the binding review's finding 1): four buffers
// captured from six vertex bindings, more storage buffers than WebGPU's 8 to 10 a stage were each a binding of the
// capture's compute pass (vk/driver/wg_test.c's wgt_xfb scenario 4): position from binding 0, one float from each of
// bindings 1 to 5 (the scene's vertex's y, z, u, v and x), 16 bytes a vertex in each buffer.
layout(location = 0) in vec3 pos;
layout(location = 1) in float a1;
layout(location = 2) in float a2;
layout(location = 3) in float a3;
layout(location = 4) in float a4;
layout(location = 5) in float a5;
layout(xfb_buffer = 0, xfb_stride = 16) out gl_PerVertex { layout(xfb_offset = 0) vec4 gl_Position; };
layout(location = 0, xfb_buffer = 1, xfb_offset = 0, xfb_stride = 16) out vec4 v1;
layout(location = 1, xfb_buffer = 2, xfb_offset = 0, xfb_stride = 16) out vec4 v2;
layout(location = 2, xfb_buffer = 3, xfb_offset = 0, xfb_stride = 16) out vec4 v3;
void main() {
  gl_Position = vec4(pos, 1.0);
  v1 = vec4(a1, a2, a3, 0.0);
  v2 = vec4(a4, a5, float(gl_VertexIndex), 0.0);
  v3 = vec4(7.0, 8.0, 9.0, 10.0);
}
