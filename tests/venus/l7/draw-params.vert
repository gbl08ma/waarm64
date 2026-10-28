#version 460
// tests/wgsl.test.ts (VK3 L7.5): the draw's parameters read from the push buffer past the push constants.
layout(push_constant) uniform P { vec4 off; } pc;
layout(location = 0) flat out uvec4 o;
void main() {
  gl_Position = vec4(pc.off.xy, 0.0, 1.0);
  o = uvec4(gl_VertexIndex - gl_BaseVertex, gl_InstanceIndex - gl_BaseInstance, gl_DrawID, 0);
}
