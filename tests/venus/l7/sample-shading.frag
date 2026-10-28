#version 450
// A fragment stage at the sample rate (VK3 L7.1): its pipeline's sampleShadingEnable, or its read of gl_SampleID
// (-DSAMPLE_ID): inputs not at the centroid at their sample, and WGSL's sample_index read.
layout(location = 0) in vec4 a;
layout(location = 1) centroid in vec4 b;
layout(location = 2) flat in uint c;
layout(location = 3) noperspective in vec2 d;
layout(location = 0) out vec4 o;
void main() {
#ifdef SAMPLE_ID
  o = a * float(gl_SampleID) + b + vec4(c) + d.xyxy;
#else
  o = a + b + vec4(c) + d.xyxy;
#endif
}
