#version 450
// tests/wgsl.test.ts (VK4 T47, vkd3d's test_atomic_instructions hung SwiftShader): signed and unsigned atomic min and
// max on one buffer in a fragment stage, whose quad's helper invocations run the unsigned ones' compare-exchange loop
// too. A helper's compare-exchange writes nothing (SwiftShader returns 0 for its old value), so a loop that loads the
// word again each time (9 here) never exchanged: the GPU's queue hung.
layout(set = 0, binding = 0) buffer B { int s; uint u; uint v; } b;
layout(location = 0) out vec4 o;
void main() {
  atomicMax(b.s, 0);
  atomicMin(b.u, 0xffffffffu);
  atomicMax(b.v, 1u);
  o = vec4(1.0);
}
