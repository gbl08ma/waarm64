#version 450
// VK4 T29: 16-bit inputs and outputs (storageInputOutput16), a fragment stage's.
#extension GL_EXT_shader_explicit_arithmetic_types_float16 : require
#extension GL_EXT_shader_explicit_arithmetic_types_int16 : require
#extension GL_EXT_shader_16bit_storage : require
layout(location = 0) in f16vec4 color;
layout(location = 1) flat in uint16_t tag;
layout(location = 0) out f16vec4 o;
layout(location = 1) out uint16_t t;
void main() {
  o = color;
  t = tag;
}
