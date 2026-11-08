#version 450
// VK4 T43's review, finding 8 (vk/driver/wg_test.c 118): location 0 red at alpha 0.25 (its coverage a quarter of the
// samples, alpha to one making it 1), location 1 green; the pipeline's map swaps them (location 0 at attachment 1).
layout(location = 0) out vec4 a;
layout(location = 1) out vec4 b;
void main() {
  a = vec4(1.0, 0.0, 0.0, 0.25);
  b = vec4(0.0, 1.0, 0.0, 1.0);
}
