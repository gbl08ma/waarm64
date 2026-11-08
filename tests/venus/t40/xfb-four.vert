#version 450
#extension GL_ARB_shader_draw_parameters : require
// tests/venus-driver.test.ts (transform feedback: xfbFourGroups; VK4 T40): xfb.vert's records, its vertex stage reading
// a draw parameter (gl_BaseInstance, 0 here): the push buffer in group 3, four bind groups, and the capture's compute
// pass had none left (refused, vkd3d's test_vertex_id among them). Its bindings join a copy of group 3 now.
layout(location = 0) in vec3 pos;
layout(location = 1) in vec2 uv;
layout(xfb_buffer = 0, xfb_stride = 32) out gl_PerVertex { layout(xfb_offset = 0) vec4 gl_Position; };
layout(location = 0, xfb_buffer = 0, xfb_offset = 16) out vec4 v;
void main() { gl_Position = vec4(pos, 1.0); v = vec4(uv, float(gl_VertexIndex + gl_BaseInstanceARB), 7.0); }
