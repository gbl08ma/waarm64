#version 450
// VK4 T48 (vk/driver/wg_test.c 128): integer outputs past their attachments' ranges, clamped to them (Direct3D's;
// vkd3d's test_output_merger_logic_op writes 0xffffffff into RGBA8_UINT).
layout(location = 0) out uvec4 a; // R8G8B8A8_UINT
layout(location = 1) out ivec4 b; // R16G16_SINT
layout(location = 2) out uvec4 c; // A2B10G10R10_UINT_PACK32
layout(location = 3) out uvec4 d; // R32_UINT: as written
layout(push_constant) uniform P { uint big; } p;
void main() {
  a = uvec4(p.big, 300u, 7u, 256u);
  b = ivec4(-70000, 70000, 0, 0);
  c = uvec4(2000u, 5u, 1023u, 9u);
  d = uvec4(p.big, 0u, 0u, 0u);
}
