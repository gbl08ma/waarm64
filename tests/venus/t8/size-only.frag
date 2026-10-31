#version 450
// VK4 T8: an integer texture only asked its size and levels: its binding is still an integer texture's.
layout(set = 0, binding = 0) uniform usampler2D img;
layout(location = 0) out vec4 c;
void main() { c = vec4(textureSize(img, 0), textureQueryLevels(img), 1.0); }
