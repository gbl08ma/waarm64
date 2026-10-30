#version 450
// tests/venus-driver.test.ts (usage scopes, VK4 T3): the vertex stage's sum and a uniform (30) written to a storage
// buffer's first word by every fragment: 1230 (vk/driver/wg_test.c's wgt_scope).
layout(location = 0) flat in uint v;
layout(set = 0, binding = 0) uniform U { uint k; } u;
layout(set = 0, binding = 2) buffer O { uint b[]; } o;
layout(location = 0) out vec4 c;
void main() { o.b[0] = v + u.k; c = vec4(1); }
