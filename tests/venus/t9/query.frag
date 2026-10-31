#version 450
#extension GL_ARB_texture_query_lod : enable
layout(set = 0, binding = 0) uniform isampler2D tex;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 c;
void main() { c = textureQueryLod(tex, uv).xyxy; }
