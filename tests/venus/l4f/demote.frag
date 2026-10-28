#version 450
// A demoted invocation is a helper (finding 11): helperInvocationEXT() true after demote.
#extension GL_EXT_demote_to_helper_invocation : require
layout(location = 0) in vec4 c;
layout(location = 0) out vec4 o;
void main() {
  if (c.y > 0.5) demote;
  o = vec4(helperInvocationEXT() ? 1.0 : 0.0);
}
