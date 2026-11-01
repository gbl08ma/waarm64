#version 450
// VK4 R5 (the review's C5): a full-screen triangle whose stage only asks the size of a cube the fragment stage samples
// from its faces.
layout(set = 0, binding = 0) uniform textureCube t;
layout(set = 0, binding = 3) uniform sampler s;
layout(location = 0) flat out int size;
void main() {
  size = textureSize(samplerCube(t, s), 0).x;
  gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0);
}
