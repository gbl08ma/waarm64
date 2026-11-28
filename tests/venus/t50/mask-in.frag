#version 450
// VK4 T50: gl_SampleMaskIn, which has the pipeline's sample mask (Metal's coverage doesn't: the driver's `wg_smask`).
layout(location = 0) out uvec4 o;
void main() {
  o = uvec4(uint(gl_SampleMaskIn[0]), 0u, 0u, 1u);
}
