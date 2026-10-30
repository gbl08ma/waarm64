#version 450
// tests/venus-driver.test.ts (passes: pullGroups): the vertex's colour, in a stage reading a uniform block of set 0 as
// vertex-pull0.frag does (their programs' group 0 the same, so nothing but pulling rebinds their groups) and one of
// set 1: its program has a bind group where vertex-pull0.frag's pipeline puts its pulled vertices.
layout(set = 0, binding = 0) uniform U { vec4 c; } u;
layout(set = 1, binding = 0) uniform V { vec4 c; } v;
layout(location = 0) flat in vec4 col;
layout(location = 0) out vec4 o;
void main() { o = u.c.a + v.c.a < -2.0 ? vec4(0.0) : vec4(col.rgb, 1.0); }
