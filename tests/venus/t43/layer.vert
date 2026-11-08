#version 450
#extension GL_ARB_shader_viewport_layer_array : require
// VK4 T43's review, findings 2 and 4 (vk/driver/wg_test.c 122): feedback.vert's full-screen triangle (a fan's fourth
// vertex on its first: its second triangle empty) in layer 1 of a layered pass.
void main() {
  gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0);
  gl_Layer = 1;
}
