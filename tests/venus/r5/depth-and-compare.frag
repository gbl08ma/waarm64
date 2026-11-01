#version 450
// VK4 R5 (the review's C2): one depth texture sampled with and without comparison in a stage, and the plain sampler
// shared with a float texture, which it must still filter.
layout(set = 0, binding = 0) uniform texture2D t;
layout(set = 0, binding = 1) uniform texture2D f;
layout(set = 0, binding = 2) uniform samplerShadow sc;
layout(set = 0, binding = 3) uniform sampler s;
layout(location = 0) out vec4 c;
void main() {
  const vec2 uv = vec2(0.5);
  float compared = texture(sampler2DShadow(t, sc), vec3(uv, 0.5));
  float biased = texture(sampler2D(t, s), uv, 1.0).r;
  float level = textureLod(sampler2D(t, s), uv, 0.0).r;
  float grad = textureGrad(sampler2D(t, s), uv, vec2(0.1), vec2(0.1)).r;
  c = vec4(compared, biased, (level + grad) / 2.0, texture(sampler2D(f, s), uv).r);
}
