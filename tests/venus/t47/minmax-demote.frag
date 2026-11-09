#version 450
#extension GL_EXT_demote_to_helper_invocation : require
// tests/wgsl.test.ts (the review of VK4 T47-T49, finding 2): half the fragments demoted, then an unsigned atomic min
// and max on a buffer that also takes signed atomics (each a compare-exchange loop on an atomic<i32>), and a
// compare-exchange of 0 (a loop of its own: WGSL's may fail spuriously). Where the backend has no demote of its own,
// Tint guards each atomic after it with the invocation's flag (DemoteToHelper): a demoted invocation's atomic does
// nothing and returns zeros, `exchanged` false, and a loop that waited for `exchanged` never ended.
layout(set = 0, binding = 0) buffer B { int s; uint u; uint v; int w; } b;
layout(location = 0) out vec4 o;
void main() {
  if ((int(gl_FragCoord.x) & 1) == 0) demote;
  atomicMax(b.s, 0);
  atomicMin(b.u, 7u);
  atomicMax(b.v, 1u);
  atomicCompSwap(b.w, 0, 1);
  o = vec4(1.0);
}
