#version 450
// A storage buffer this stage only reads, beside a storage image it writes (finding 4): read-only here, so that a vertex
// stage reading it too binds it.
layout(set = 0, binding = 0) buffer Scene { vec4 v[]; } scene;
layout(set = 0, binding = 1, r32ui) uniform writeonly uimage2D ids;
layout(location = 0) out vec4 o;
void main() {
  o = scene.v[int(gl_FragCoord.x) & 7];
  imageStore(ids, ivec2(gl_FragCoord.xy), uvec4(1));
}
