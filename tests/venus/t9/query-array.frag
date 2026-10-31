#version 450
#extension GL_ARB_texture_query_lod : enable
// VK4 T9: textureQueryLod's coordinate has no layer, and a cube array's size is its first two channels.
layout(set = 0, binding = 0) uniform sampler2DArray a;
layout(set = 0, binding = 1) uniform samplerCubeArray b;
layout(set = 0, binding = 2) uniform usampler1DArray c;
layout(location = 0) in vec3 uv;
layout(location = 0) out vec4 o;
void main() { o = vec4(textureQueryLod(a, uv.xy), textureQueryLod(b, uv)) + textureQueryLod(c, uv.x).xxyy; }
