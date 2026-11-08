#version 450
// VK4 T44's warm-up (vk/driver/wg_test.c 124): (192, 64, 128, 255) as bytes, beside an RG32_SFLOAT image loaded and
// stored (its words: WebGPU has no read-write rg32float), whose view may be past maxStorageBufferBindingSize.
layout(set = 0, binding = 0, rg32f) uniform image2D img;
layout(location = 0) out vec4 o;
void main() {
  imageStore(img, ivec2(1, 1), imageLoad(img, ivec2(0, 0)) + vec4(1.0));
  o = vec4(192.0, 64.0, 128.0, 255.0) / 255.0;
}
