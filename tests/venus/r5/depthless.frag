#version 450
// VK4 R5 (the review's C1): writes depth, drawn in a pass without one, its sampler first plain and then a border's.
layout(set = 0, binding = 0) uniform texture2D t;
layout(set = 0, binding = 2) uniform sampler s;
layout(location = 0) out vec4 c;
void main() {
  c = texture(sampler2D(t, s), vec2(2.0));
  gl_FragDepth = 0.5;
}
