#version 450
// VK4 T43's review, findings 2 and 4 (vk/driver/wg_test.c 122): (192, 64, 128, 255) as bytes, or with `read` the input
// attachment (the pass's own colour attachment) as BGRA.
layout(constant_id = 0) const int read = 0;
layout(input_attachment_index = 0, set = 0, binding = 0) uniform subpassInput i;
layout(location = 0) out vec4 o;
void main() { o = read != 0 ? subpassLoad(i).bgra : vec4(192.0, 64.0, 128.0, 255.0) / 255.0; }
