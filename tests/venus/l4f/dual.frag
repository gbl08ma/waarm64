#version 450
// Dual-source blending (the out-of-context review of the translator, finding 3): location 0's two sources.
layout(location = 0) in vec4 c;
layout(location = 0, index = 0) out vec4 a;
layout(location = 0, index = 1) out vec4 b;
void main() { a = c; b = c.wzyx; }
