#version 450
// tests/venus-driver.test.ts (passes: angleUniforms): the fragment stage's half of angle-ubo.vert's layout: its own
// dynamic default block (set 0, binding 1) and 12 blocks it alone sees (set 1, bindings 12 to 23).
layout(set = 0, binding = 1) uniform D { uint k; } dflt;
layout(set = 1, binding = 12) uniform U0 { uint k; } u0;
layout(set = 1, binding = 13) uniform U1 { uint k; } u1;
layout(set = 1, binding = 14) uniform U2 { uint k; } u2;
layout(set = 1, binding = 15) uniform U3 { uint k; } u3;
layout(set = 1, binding = 16) uniform U4 { uint k; } u4;
layout(set = 1, binding = 17) uniform U5 { uint k; } u5;
layout(set = 1, binding = 18) uniform U6 { uint k; } u6;
layout(set = 1, binding = 19) uniform U7 { uint k; } u7;
layout(set = 1, binding = 20) uniform U8 { uint k; } u8;
layout(set = 1, binding = 21) uniform U9 { uint k; } u9;
layout(set = 1, binding = 22) uniform U10 { uint k; } u10;
layout(set = 1, binding = 23) uniform U11 { uint k; } u11;
layout(location = 0) flat in uint sum;
layout(location = 0) out vec4 o;
void main() {
  uint s = dflt.k;
  s += u0.k + u1.k + u2.k + u3.k + u4.k + u5.k + u6.k + u7.k + u8.k + u9.k + u10.k + u11.k;
  o = vec4(float(sum) / 255.0, float(s) / 255.0, 0.0, 1.0);
}
