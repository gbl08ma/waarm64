#version 450
// gl_SampleMaskIn at the pixel rate and at the sample rate (SAMPLE_ID, or the pipeline's sample shading): at the sample
// rate an invocation's mask is its own sample's bit, which the translator makes it (D3D12 gave every covered sample:
// dEQP-VK's multisample_shader_builtin.sample_mask.bit_count at 4 samples). tests/wgsl.test.ts.
layout(location = 0) out vec4 o;
void main() {
#ifdef SAMPLE_ID
  o = vec4(float(bitCount(gl_SampleMaskIn[0])), float(gl_SampleID), 0.0, 1.0);
#else
  o = vec4(float(bitCount(gl_SampleMaskIn[0])), 0.0, 0.0, 1.0);
#endif
}
