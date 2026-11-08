#version 450
#extension GL_ARB_shader_viewport_layer_array : require
// VK4 T43's review, finding 3 (vk/driver/wg_test.c 123): draw i's point (its first vertex i) at texel (i % 32, i / 32)
// of a 32x32 target, in layer 0 of a layered pass, its colour the number pushed (at 124: past the immediates, 64 bytes
// in Chromium, so in the push buffer).
layout(push_constant) uniform P { layout(offset = 124) uint i; } p;
layout(location = 0) flat out uint v;
void main() {
  uint i = uint(gl_VertexIndex);
  gl_Position = vec4((float(i % 32u) + 0.5) / 16.0 - 1.0, (float(i / 32u) + 0.5) / 16.0 - 1.0, 0.5, 1.0);
  gl_PointSize = 1.0;
  gl_Layer = 0;
  v = p.i;
}
