#version 450
// VK4 T43's review, finding 9 (vk/driver/wg_test.c 119): dual-source outputs, (192, 64, 128, 255) as bytes and a
// second colour of zeros (the blend's dst factor: the first colour alone), behind a map of the attachments' locations.
layout(location = 0, index = 0) out vec4 c;
layout(location = 0, index = 1) out vec4 s;
void main() {
  c = vec4(192.0, 64.0, 128.0, 255.0) / 255.0;
  s = vec4(0.0);
}
