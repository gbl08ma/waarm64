#version 450
// tests/venus-driver.test.ts (passes: angleUniforms): ANGLE's ES3 layout of uniform buffers (VK3 L7b, the review of
// L7.4-L7.5's finding 9): its default block a dynamic uniform buffer of the stage's own (set 0), 12 blocks the vertex
// stage alone sees (set 1, bindings 0 to 11), a full-screen triangle carrying their sum.
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
layout(location = 0) flat out uint sum;
void main() {
  uint s = dflt.k;
  s += u0.k + u1.k + u2.k + u3.k + u4.k + u5.k + u6.k + u7.k + u8.k + u9.k + u10.k + u11.k;
  sum = s;
  gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0);
}
