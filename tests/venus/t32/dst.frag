#version 450
// VK4 T32 (vk/driver/wg_test.c 98): a colour whose bytes in RGBA8 are exact, (192, 64, 128, 255).
layout(location = 0) out vec4 o;
void main() { o = vec4(192.0, 64.0, 128.0, 255.0) / 255.0; }
