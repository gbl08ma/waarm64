#version 450
// VK4 T9: gl_HelperInvocation of the rasterizer's helpers (tests/wgsl.test.ts).
layout(location = 0) out vec4 c;
void main() { c = gl_HelperInvocation ? vec4(1.0) : vec4(0.0); }
