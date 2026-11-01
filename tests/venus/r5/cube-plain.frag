#version 450
// VK4 R5's review (B2): a cube of one level both compared and sampled plainly: bound as its faces, each op by its sampler.
layout(set = 0, binding = 0) uniform textureCube t;
layout(set = 0, binding = 2) uniform samplerShadow a;
layout(set = 0, binding = 3) uniform sampler s;
layout(location = 0) out vec4 c;
void main() {
  const vec4 d = vec4(1.0, 0.0, 0.0, 0.5);
  c = vec4(texture(samplerCubeShadow(t, a), d), texture(samplerCube(t, s), d.xyz).r, 0.0, 1.0);
}
