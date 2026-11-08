#version 450
// VK4 T43's review, finding 3 (vk/driver/wg_test.c 123): the draw's number as bytes, (i & 255, i >> 8, 0, 255).
layout(location = 0) flat in uint v;
layout(location = 0) out vec4 o;
void main() { o = vec4(float(v & 255u), float(v >> 8), 0.0, 255.0) / 255.0; }
