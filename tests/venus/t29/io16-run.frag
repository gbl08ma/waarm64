#version 450
// VK4 T29: a 16-bit input and output (storageInputOutput16) run: tests/wgsl.test.ts's runFragment gives location 0
// the pixel centre's (u, v, 0, 1); its halves are worked on as 32-bit floats (no shader-f16 needed).
#extension GL_EXT_shader_explicit_arithmetic_types_float16 : require
#extension GL_EXT_shader_16bit_storage : require
layout(location = 0) in f16vec4 uv;
layout(location = 0) out f16vec4 o;
void main() {
  vec4 f = vec4(uv);
  o = f16vec4(f.y * 0.5, f.x * 0.5, f.z, f.w);
}
