#version 450
// VK4 T32 (vk/driver/wg_test.c 99): a feedback loop. The left half adds 0.25 to red of what layer 0 (the attachment)
// holds at the texel; the right half shows layer 1 (sampled past the attachment's layer).
layout(set = 0, binding = 0) uniform sampler2DArray t;
layout(location = 0) out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = p.x < 8 ? texelFetch(t, ivec3(p, 0), 0) + vec4(0.25, 0.0, 0.0, 0.0) : texelFetch(t, ivec3(p, 1), 0);
}
