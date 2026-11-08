#version 450
// tests/venus-driver.test.ts (passes: angleUniformsPulled; the review of VK4 T44 to T46, finding 3): l7b/angle-ubo.vert
// (ANGLE's ES3 layout: a dynamic uniform buffer and 12 blocks, 13 uniform buffers in the stage) with a vertex input
// WebGPU's vertex buffers refuse (a uint at byte 2 of an instance binding with a divisor of 2), pulled from storage:
// the pull's two uniform buffers past the stage's.
layout(set = 0, binding = 0) uniform D { uint k; } dflt;
layout(set = 1, binding = 0) uniform U0 { uint k; } u0;
layout(set = 1, binding = 1) uniform U1 { uint k; } u1;
layout(set = 1, binding = 2) uniform U2 { uint k; } u2;
layout(set = 1, binding = 3) uniform U3 { uint k; } u3;
layout(set = 1, binding = 4) uniform U4 { uint k; } u4;
layout(set = 1, binding = 5) uniform U5 { uint k; } u5;
layout(set = 1, binding = 6) uniform U6 { uint k; } u6;
layout(set = 1, binding = 7) uniform U7 { uint k; } u7;
layout(set = 1, binding = 8) uniform U8 { uint k; } u8;
layout(set = 1, binding = 9) uniform U9 { uint k; } u9;
layout(set = 1, binding = 10) uniform U10 { uint k; } u10;
layout(set = 1, binding = 11) uniform U11 { uint k; } u11;
layout(location = 0) in uint extra;
layout(location = 0) flat out uint sum;
void main() {
  uint s = dflt.k + extra;
  s += u0.k + u1.k + u2.k + u3.k + u4.k + u5.k + u6.k + u7.k + u8.k + u9.k + u10.k + u11.k;
  sum = s;
  gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0);
}
