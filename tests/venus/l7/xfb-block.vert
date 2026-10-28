#version 450
// tests/wgsl.test.ts (VK3 L7.4): a block of a matrix and an array captured by transform feedback, each column and
// element at its own offset (words 0-1, 2-3, 4, 5 of the vertex's record).
layout(location = 0) in vec4 a;
layout(xfb_buffer = 0, xfb_stride = 48) out;
layout(location = 0, xfb_buffer = 0, xfb_offset = 0) out Block { mat2 var; float arr[2]; } blk;
void main() { gl_Position = a; blk.var = mat2(a.x, a.y, a.z, a.w); blk.arr[0] = a.x * 2.0; blk.arr[1] = a.y * 3.0; }
