#version 450
// A fragment stage's storage buffers (tests/wgsl.test.ts, VK3 L5b): the ones it only reads stay read-only (its usage
// scope is the render pass, where vertex stages read storage read-only), the one it writes is read_write.
layout(set = 0, binding = 0) readonly buffer Pos { vec4 p[]; } pos;
layout(set = 0, binding = 1) buffer Colours { vec4 c[]; } colours;
layout(set = 0, binding = 2) buffer Hits { uint n[]; } hits;
layout(location = 0) out vec4 o;
void main() {
  o = colours.c[int(gl_FragCoord.x) & 3] + pos.p[0];
  atomicAdd(hits.n[0], 1u);
}
