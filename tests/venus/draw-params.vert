#version 460
// tests/venus-driver.test.ts (passes: drawParams): a quad from the vertex's index less its base, in the quarter
// pc.off.xy puts it at (moved down by the base vertex 30: the first two draws' push constants are the same); its flat colour the draw's parameters (vk/driver/wg_test.c's wgt_draw_params; VK3 L7.5): the
// base vertex and base instance in red and green, 200 + the draw's index in blue, alpha 1 where the vertex's and
// instance's indices less their bases are the quad's (0.5 otherwise).
layout(push_constant) uniform P { vec4 off; } pc;
layout(location = 0) flat out vec4 col;
const vec2 corner[6] = vec2[](vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 0), vec2(1, 1), vec2(0, 1));
void main() {
  int k = gl_VertexIndex - gl_BaseVertex;
  gl_Position = vec4(pc.off.xy + vec2(0.0, gl_BaseVertex == 30 ? 1.05 : 0.0) + corner[clamp(k, 0, 5)] * 0.9, 0.5, 1.0);
  bool right = k >= 0 && k < 6 && gl_InstanceIndex == gl_BaseInstance;
  col = vec4(float(gl_BaseVertex) / 255.0, float(gl_BaseInstance) / 255.0, float(200 + gl_DrawID) / 255.0, right ? 1.0 : 0.5);
}
