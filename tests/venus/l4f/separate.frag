#version 450
// Texture and sampler arrays indexed apart (finding 8): every texture with every sampler.
layout(set = 0, binding = 0) uniform texture2D t[4];
layout(set = 0, binding = 1) uniform sampler s[2];
layout(push_constant) uniform P { int i, j; } p;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 o;
void main() { o = texture(sampler2D(t[p.i], s[p.j]), uv); }
