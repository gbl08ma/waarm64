#version 450
// tests/venus-driver.test.ts: a vertex placed by push constants, its uv passed on.
layout(push_constant) uniform P { vec4 off; } pc;
layout(location = 0) in vec3 pos;
layout(location = 1) in vec2 uv;
layout(location = 0) out vec2 vuv;
void main() { gl_Position = vec4(pos + pc.off.xyz, 1.0); vuv = uv; }
