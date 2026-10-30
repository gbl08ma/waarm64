#version 450
// tests/venus-driver.test.ts (usage scopes, VK4 T3): a full-screen triangle whose vertices carry 1000, and a read-only
// storage word (200) passed on (vk/driver/wg_test.c's wgt_scope).
layout(location = 0) in vec2 pos;
layout(location = 1) in uint val;
layout(set = 0, binding = 1) readonly buffer R { uint r[]; } rs;
layout(location = 0) flat out uint v;
void main() { gl_Position = vec4(pos, 0, 1); v = val + rs.r[0]; }
