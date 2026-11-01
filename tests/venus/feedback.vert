#version 450
// VK4 R3 (vk/driver/wg_test.c's feedback scenarios): a full-screen triangle.
void main() { gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0); }
