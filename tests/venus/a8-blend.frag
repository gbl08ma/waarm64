#version 450
// VK4's backlog easy wins (vk/driver/wg_test.c 131): an A8_UNORM attachment blended, its alpha 0.25 (its colour
// ones, which A8 has no channel of).
layout(location = 0) out vec4 o;
void main() { o = vec4(1.0, 1.0, 1.0, 0.25); }
