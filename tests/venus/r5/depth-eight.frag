#version 450
// VK4 R5 (the review's C7): depth written beside every colour location, drawn in a pass without depth.
layout(location = 0) out vec4 c;
layout(location = 1) out vec4 c1;
layout(location = 2) out vec4 c2;
layout(location = 3) out vec4 c3;
layout(location = 4) out vec4 c4;
layout(location = 5) out vec4 c5;
layout(location = 6) out vec4 c6;
layout(location = 7) out vec4 c7;
void main() {
  c = vec4(1.0, 0.0, 0.0, 1.0);
  c1 = c2 = c3 = c4 = c5 = c6 = c7 = vec4(0.0);
  gl_FragDepth = 0.5;
}
