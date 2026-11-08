#version 450
// The review of VK4 R5 to R7 (B4): four bind groups taken, so vertex bindings are pulled in group 3 (VK4 T44; refused
// before, not invalid).
layout(set = 0, binding = 0) uniform texture2D t0;
layout(set = 1, binding = 0) uniform texture2D t1;
layout(set = 2, binding = 0) uniform texture2D t2;
layout(set = 3, binding = 0) uniform texture2D t3;
layout(set = 0, binding = 3) uniform sampler s;
layout(location = 0) flat in vec4 v;
layout(location = 0) out vec4 c;
void main() {
  c = v + texture(sampler2D(t0, s), vec2(0.5)) + texture(sampler2D(t1, s), vec2(0.5)) + texture(sampler2D(t2, s), vec2(0.5)) + texture(sampler2D(t3, s), vec2(0.5));
}
