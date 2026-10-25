#version 450
#include "common.glsl"
// The toolkit's quads: instances in pixels, mapped to clip space by the frame's viewProjection.
layout(location = 0) in vec4 rect;
layout(location = 1) in vec4 uv;
layout(location = 2) in vec4 color;
layout(location = 0) out vec2 v_texCoord;
layout(location = 1) out vec4 v_color;
layout(location = 2) out vec2 v_local;   // pixels from the quad's corner
layout(location = 3) out vec4 v_shape;   // size, radius, border
const vec2 corners[4] = vec2[](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(1, 1));
void main() {
  vec2 c = corners[gl_VertexIndex];
  v_texCoord = mix(uv.xy, uv.zw, c);
  v_color = color;
  v_local = c * rect.zw;
  v_shape = vec4(rect.zw, uv.xy);
  gl_Position = g.viewProjection * vec4(rect.xy + c * rect.zw, 0, 1);
}
