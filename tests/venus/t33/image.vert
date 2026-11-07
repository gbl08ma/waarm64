#version 450
// tests/wgsl.test.ts (VK4 T33): a vertex stage whose only write is a storage image's (dEQP-VK's buffer_device_address
// vertex cases write their results so).
layout(r32ui, set = 0, binding = 0) uniform writeonly uimage2D img;
void main() {
  imageStore(img, ivec2(gl_VertexIndex % 8, gl_VertexIndex / 8), uvec4(1));
  gl_PointSize = 1.0;
}
