#version 450
// tests/venus-driver.test.ts (VK4 T33, vertexPipelineStoresAndAtomics): scope.vert's triangle from a vertex stage that
// writes storage: each vertex's value plus its index at word 1 + its index, the vertices counted at word 4 by an
// atomic (vk/driver/wg_test.c's wgt_scope, mask 256: the binding 32 bytes).
layout(location = 0) in vec2 pos;
layout(location = 1) in uint val;
layout(set = 0, binding = 1) buffer R { uint r[]; } rs;
layout(location = 0) flat out uint v;
void main() {
  gl_Position = vec4(pos, 0, 1);
  rs.r[1 + gl_VertexIndex] = val + uint(gl_VertexIndex);
  atomicAdd(rs.r[4], 1u);
  v = val + rs.r[0];
}
