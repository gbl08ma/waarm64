#version 450
layout(set = 0, binding = 0) uniform sampler2D tex;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 c;
void main() { c = textureOffset(tex, uv, ivec2(-8, 7)) + texelFetchOffset(tex, ivec2(uv), 0, ivec2(1, 2)); }
