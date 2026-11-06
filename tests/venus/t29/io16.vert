#version 450
// VK4 T29: 16-bit inputs and outputs (storageInputOutput16): vertex attributes and varyings widened to 32 bits.
#extension GL_EXT_shader_explicit_arithmetic_types_float16 : require
#extension GL_EXT_shader_explicit_arithmetic_types_int16 : require
#extension GL_EXT_shader_16bit_storage : require
layout(location = 0) in f16vec4 pos;
layout(location = 1) in i16vec2 id;
layout(location = 0) out f16vec4 color;
layout(location = 1) flat out uint16_t tag;
void main() {
  gl_Position = vec4(pos);
  color = f16vec4(pos.yxzw);
  tag = uint16_t(id.x + id.y);
}
