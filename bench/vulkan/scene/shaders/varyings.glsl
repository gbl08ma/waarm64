// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
layout(location = 0) in vec4 v_position;
layout(location = 1) in vec2 v_texCoord;
layout(location = 2) in vec3 v_tangent;
layout(location = 3) in vec3 v_binormal;
layout(location = 4) in vec3 v_normal;
layout(location = 5) in vec3 v_surfaceToLight;
layout(location = 6) in vec3 v_surfaceToView;
layout(location = 0) out vec4 fragColor;
