#version 450
// The review of VK4 R5 to R7 (B6): the vertex stage compares what the fragment stage samples plainly.
layout(set = 0, binding = 0) uniform texture2D t;
layout(set = 0, binding = 2) uniform samplerShadow a;
layout(location = 0) flat out float compared;
void main() {
  compared = textureLod(sampler2DShadow(t, a), vec3(0.5, 0.5, 0.5), 0.0);
  gl_Position = vec4(gl_VertexIndex == 1 ? 3.0 : -1.0, gl_VertexIndex == 2 ? 3.0 : -1.0, 0.5, 1.0);
}
