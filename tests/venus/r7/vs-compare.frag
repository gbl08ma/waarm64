#version 450
layout(set = 0, binding = 0) uniform texture2D t;
layout(set = 0, binding = 3) uniform sampler s;
layout(location = 0) flat in float compared;
layout(location = 0) out vec4 c;
void main() { c = vec4(compared, texture(sampler2D(t, s), vec2(0.5)).r, 0.0, 1.0); }
