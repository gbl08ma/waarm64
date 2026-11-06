#version 450
// VK4 T24: a shadow sample whose offset is a push constant, translated without a sampler key (tests/wgsl.test.ts):
// its texture must stay bound, as the keyed variants bind it (dEQP-VK's textureprojlodoffset_pcoffset sampler2dshadow).
#extension GL_EXT_texture_offset_non_const : require
layout(set = 0, binding = 0) uniform sampler2DShadow s;
layout(push_constant) uniform PC { ivec2 off; } pc;
layout(location = 0) in vec4 uv;
layout(location = 0) out vec4 c;
void main() { c = vec4(textureProjLodOffset(s, uv, 1.0, pc.off)); }
