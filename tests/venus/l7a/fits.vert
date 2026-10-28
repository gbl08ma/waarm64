#version 450
// tests/venus-driver.test.ts (fits: VK3 L7a): a vertex stage for wgt_fits's fragment stages.
layout(location = 0) out vec2 uv;
void main() { uv = vec2(gl_VertexIndex & 1, gl_VertexIndex >> 1); gl_Position = vec4(uv, 0.0, 1.0); }
