#version 450
// VK4 R5 (the review's C3): one sampler gathers an integer texture and filters a float one.
layout(set = 0, binding = 0) uniform utexture2D i;
layout(set = 0, binding = 1) uniform texture2D f;
layout(set = 0, binding = 3) uniform sampler s;
layout(location = 0) out vec4 c;
void main() {
  c = vec4(float(textureGather(usampler2D(i, s), vec2(0.5)).x), texture(sampler2D(f, s), vec2(0.5)).r, 0.0, 1.0);
}
