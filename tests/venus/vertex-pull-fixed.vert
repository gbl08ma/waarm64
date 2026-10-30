#version 450
// tests/venus-driver.test.ts (passes: pullGroups): vertex-pull.vert without push constants (the viewport places the
// quad), whose group 3 would have every pipeline's groups set again.
layout(location = 0) in vec2 pos;
layout(location = 1) in vec4 colour;
layout(location = 0) flat out vec4 col;
void main() {
  gl_Position = vec4(pos * 2.0 - 1.0, 0.5, 1.0);
  col = colour;
}
