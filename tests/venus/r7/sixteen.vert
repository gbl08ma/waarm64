#version 450
// VK4 R7: an attribute from each of Vulkan's 16 bindings, past WebGPU's 8 vertex buffers: 1/16 each, the last two
// bindings' apart.
layout(location = 0) in float a0;
layout(location = 1) in float a1;
layout(location = 2) in float a2;
layout(location = 3) in float a3;
layout(location = 4) in float a4;
layout(location = 5) in float a5;
layout(location = 6) in float a6;
layout(location = 7) in float a7;
layout(location = 8) in float a8;
layout(location = 9) in float a9;
layout(location = 10) in float a10;
layout(location = 11) in float a11;
layout(location = 12) in float a12;
layout(location = 13) in float a13;
layout(location = 14) in float a14;
layout(location = 15) in float a15;
layout(location = 0) flat out vec4 c;
void main() {
  c = vec4(a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9 + a10 + a11 + a12 + a13 + a14 + a15, a15 * 8.0, a8 * 4.0, 1.0);
  gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0);
}
