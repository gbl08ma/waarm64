#version 450
// VK4 T44's warm-up (vk/driver/wg_test.c 124): a fan's quad of the left half of the target (vertices 0 to 3) or the
// right half (4 to 7), corners in fan order.
void main() {
  const int c = gl_VertexIndex & 3;
  const float x0 = gl_VertexIndex >= 4 ? 0.0 : -1.0;
  gl_Position = vec4(c == 1 || c == 2 ? x0 + 1.0 : x0, c >= 2 ? 1.0 : -1.0, 0.5, 1.0);
}
