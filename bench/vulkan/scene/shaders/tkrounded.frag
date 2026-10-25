#version 450
#include "tkvaryings.glsl"
// A rounded rectangle with a border, antialiased by its distance field (GSK's rounded-rect operations).
void main() {
  vec2 size = v_shape.xy;
  float radius = v_shape.z, border = v_shape.w;
  vec2 q = abs(v_local - size * 0.5) - (size * 0.5 - radius);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  float inside = clamp(0.5 - d, 0.0, 1.0);
  float edge = clamp(0.5 - abs(d + border * 0.5) + border * 0.5, 0.0, 1.0);
  vec3 rgb = mix(v_color.rgb, vec3(0.75, 0.76, 0.8), edge);
  fragColor = vec4(rgb, v_color.a * inside);
}
