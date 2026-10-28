#version 450
// A terminated invocation leaves the loop whose only other way out it never takes (the out-of-context review of L4f,
// finding 6: run, not only compiled): it writes nothing, and it doesn't spin as a helper.
#extension GL_EXT_terminate_invocation : require
layout(location = 0) in vec4 c;
layout(location = 0) out vec4 o;
void main() {
  o = vec4(0);
  for (;;) {
    if (c.x > 0.5) terminateInvocation;
    o += c;
    if (c.x <= 0.5) break;
  }
}
