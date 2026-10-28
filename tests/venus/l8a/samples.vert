#version 450
// tests/venus-driver.test.ts (samples: VK3 L8a): a triangle over the whole of a 4×4 render area.
void main() { gl_Position = vec4(vec2(gl_VertexIndex & 1, gl_VertexIndex >> 1) * 4.0 - 1.0, 0.0, 1.0); }
