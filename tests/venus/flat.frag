#version 450
// tests/venus-driver.test.ts (passes: flat*): the provoking vertex's colour.
layout(location = 0) flat in vec4 col;
layout(location = 0) out vec4 o;
void main() { o = col; }
