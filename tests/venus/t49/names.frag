#version 450
// VK4 T49: dEQP-VK.ubo.single_basic_type.scalar.u8vec4.both's fragment stage (its compare as dEQP writes it). The
// byte at offset 0 (`t1`) is read once by a copy (`t2`, inlined as `t1`), and that copy's use is named `t12`: the
// copy's text found inside `t12` took it for a second use, and `t12` became `t22`, a name never declared.
#extension GL_EXT_shader_8bit_storage : enable
#extension GL_EXT_shader_explicit_arithmetic_types : enable
#extension GL_EXT_scalar_block_layout : enable
layout(set = 0, binding = 0, scalar) uniform Block { uint8_t padding; u8vec4 var; } block;
layout(location = 0) in mediump float v_vtxResult;
layout(location = 0) out mediump vec4 dEQP_FragColor;
mediump float compare_u8vec4(highp uvec4 a, highp uvec4 b) { return a == b ? 1.0 : 0.0; }
mediump float compare_uint8_t(highp uint a, highp uint b) { return a == b ? 1.0 : 0.0; }
void main() {
  mediump float result = 1.0;
  result *= compare_uint8_t(uint(block.padding), 0u);
  result *= compare_u8vec4(uvec4(block.var), uvec4(0u, 0u, 0u, 0u));
  dEQP_FragColor = vec4(1.0, v_vtxResult, result, 1.0);
}
