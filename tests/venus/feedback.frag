#version 450
// VK4 R3: an input attachment of the pass's image written out.
layout(input_attachment_index = 0, set = 0, binding = 0) uniform subpassInput i;
layout(location = 0) out vec4 c;
void main() { c = subpassLoad(i); }
