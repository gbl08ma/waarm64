#version 450
// interpolateAtOffset and interpolateAtSample (VK3 L7b, the review of L6b-L7.3's finding 1: sampleRateShading, which
// the device advertises, brings SPIR-V's InterpolationFunction): perspective, linear and flat inputs, a constant and a
// dynamic offset and sample.
layout(location = 0) in vec4 a;
layout(location = 1) noperspective in vec2 d;
layout(location = 2) flat in vec4 f;
layout(location = 0) out vec4 o;
layout(push_constant) uniform P { vec2 off; int s; } p;
void main() {
  o = interpolateAtOffset(a, vec2(0.25, -0.125)) + interpolateAtOffset(a, p.off) + interpolateAtSample(d, p.s).xyxy +
      interpolateAtSample(a, 2) + interpolateAtOffset(f, p.off);
}
