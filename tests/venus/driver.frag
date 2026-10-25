#version 450
// tests/venus-driver.test.ts: the texture, or the uniform block's colour by its weight (alpha).
layout(set = 0, binding = 0) uniform U { vec4 tint; } u;
layout(set = 0, binding = 1) uniform sampler2D tex;
layout(location = 0) in vec2 vuv;
layout(location = 0) out vec4 o;
void main() { o = mix(texture(tex, vuv), vec4(u.tint.rgb, 1.0), u.tint.a); }
