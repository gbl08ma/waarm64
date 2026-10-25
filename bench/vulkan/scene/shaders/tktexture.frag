#version 450
#include "material.glsl"
#include "tkvaryings.glsl"
void main() {
  fragColor = texture(diffuse, v_texCoord) * v_color;
}
