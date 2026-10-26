#version 450
// bench/vulkan/costs.ts: tests/venus/driver.frag with a specialization constant in its colour, so each value is a
// shader of its own (new WGSL), as a program's pipelines are.
layout(constant_id = 0) const float k = 0.0;
layout(set = 0, binding = 0) uniform U { vec4 tint; } u;
layout(set = 0, binding = 1) uniform sampler2D tex;
layout(location = 0) in vec2 vuv;
layout(location = 0) out vec4 o;
void main() { o = mix(texture(tex, vuv), vec4(u.tint.rgb, 1.0), u.tint.a) * (1.0 - k * 1e-7); }
