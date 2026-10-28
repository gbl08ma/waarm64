#version 450
// tests/venus-driver.test.ts (samples: VK3 L8a, the track-end review's finding 3): in a pass without attachments, each
// invocation (one a sample: gl_SampleID) sets its sample's bit of o[0] and counts itself in o[1].
layout(set = 0, binding = 0) buffer Out { uint o[]; } o;
void main() {
  atomicOr(o.o[0], 1u << uint(gl_SampleID));
  atomicAdd(o.o[1], 1u);
}
