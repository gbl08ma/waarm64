#version 450
// VK4 T43's review, finding 1 (vk/driver/wg_test.c 117): a stage reading gl_FrontFacing, whose `main` the fragment
// wrapper (wg_shader.c `post_text`) and the attachments' reads (`dst_text`) call: (192, 64, 128, 255) as bytes where
// front-facing, blue where not.
layout(location = 0) out vec4 o;
void main() { o = gl_FrontFacing ? vec4(192.0, 64.0, 128.0, 255.0) / 255.0 : vec4(0.0, 0.0, 1.0, 1.0); }
