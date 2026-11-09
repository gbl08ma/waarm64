#version 450
// tests/wgsl.test.ts (the review of VK4 T47-T49, finding 1): one barycentric at a sample (NIR's CSE merges the two
// interpolateAtSample's) read by two loads with a store to the register its sample index reads between them. Each load
// reads the input at the sample the barycentric names, not at one computed from the register's later value.
layout(location = 0) in vec4 v;
layout(location = 1) in vec4 w;
layout(location = 0) out vec4 o;
layout(set = 0, binding = 0) uniform U { int n; } u;
void main() {
  vec4 acc = vec4(0);
  int s = 0;
  for (int i = 0; i < u.n; i++) {
#ifdef ALIAS
    int k = s;
#else
    int k = (s + 1) & 3;
#endif
    acc += interpolateAtSample(v, k);
    s = s * 5 + int(acc.x);
    acc += interpolateAtSample(w, k);
  }
  o = acc;
}
