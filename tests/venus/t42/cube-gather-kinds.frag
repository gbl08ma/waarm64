#version 450
// VK4 T42: the other cube gathers that were refused: a shadow cube's, and an integer cube's that the stage also samples
// (its binding then its faces).
layout(set = 0, binding = 0) uniform samplerCubeShadow sh;
layout(set = 0, binding = 1) uniform isamplerCube ic;
layout(location = 0) in vec3 dir;
layout(location = 0) out vec4 o;
void main() {
  o = textureGather(sh, dir, 0.5) + vec4(textureGather(ic, dir, 1)) + vec4(texture(ic, dir)) + vec4(texture(sh, vec4(dir, 0.5)));
}
