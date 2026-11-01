#version 450
// VK4 R5 (the review's C7): every inter-stage variable beside a clip distance, past what WebGPU takes.
layout(location = 0) out vec4 v[16];
void main() {
  for (int i = 0; i < 16; i++) v[i] = vec4(float(i));
  gl_ClipDistance[0] = 1.0;
  gl_Position = vec4(0.0);
}
