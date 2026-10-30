#version 450
// tests/venus-driver.test.ts (passes: pullGroups): the vertex's colour, in a stage with a set 0 (a uniform block it
// reads) and no set 1, so that its pipeline's pulled vertices take group 1.
layout(set = 0, binding = 0) uniform U { vec4 c; } u;
layout(location = 0) flat in vec4 col;
layout(location = 0) out vec4 o;
void main() { o = u.c.a < -1.0 ? vec4(0.0) : vec4(col.rgb, 1.0); }
