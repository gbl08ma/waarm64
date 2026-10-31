#version 450
// VK4 T9: gl_ClipDistance read by a fragment stage (tests/wgsl.test.ts): each slot at a free location.
in float gl_ClipDistance[5];
layout(location = 0) in vec4 a;
layout(location = 0) out vec4 c;
void main() { c = a * gl_ClipDistance[1] + vec4(gl_ClipDistance[4]); }
