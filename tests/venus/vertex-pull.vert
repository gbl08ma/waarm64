#version 460
// tests/venus-driver.test.ts (passes: pull*; vk/driver/wg_test.c's wgt_pull): a quad's corner and colour from vertex
// attributes WebGPU's vertex buffers can't take, placed by the push constants; blue the draw's base instance where it
// isn't 0.
layout(push_constant) uniform P { vec4 off; } pc;
layout(location = 0) in vec2 pos;
layout(location = 1) in vec4 colour;
layout(location = 0) flat out vec4 col;
void main() {
  gl_Position = vec4(pc.off.xy + pos * 0.9, 0.5, 1.0);
  col = colour;
  if (gl_BaseInstance == 7 || gl_BaseInstance == 9) col.b = float(gl_BaseInstance) / 255.0;
}
