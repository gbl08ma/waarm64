#version 450
// OpTerminateInvocation (finding 11): the invocation must leave a loop whose only exit it is (vtn adds no jump).
#extension GL_EXT_terminate_invocation : require
layout(location = 0) in vec4 c;
layout(location = 0) out vec4 o;
void main() {
  o = vec4(0);
  for (;;) {
    if (c.x > 0.5) terminateInvocation;
    o += c;
  }
}
