#version 450
// tests/venus-driver.test.ts (fits: inputAttachments; VK3 L7a, the binding review's finding 6): 16 sampled images and
// an input attachment, within Vulkan's limits as the device advertises them (maxPerStageDescriptorSampledImages 16,
// maxPerStageDescriptorInputAttachments 4 apart), 17 of WebGPU's 16 textures a stage: refused, not invalid.
layout(set = 0, binding = 0) uniform sampler2D t[16];
layout(input_attachment_index = 0, set = 0, binding = 1) uniform subpassInput ia;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 o;
void main() {
  vec4 c = subpassLoad(ia);
  for (int i = 0; i < 16; i++) c += texture(t[i], uv);
  o = c;
}
