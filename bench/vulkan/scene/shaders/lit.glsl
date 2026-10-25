// Ported from the WebGL Aquarium's shaders (aquarium.html; Copyright 2009, Google Inc., BSD-3-Clause:
// ../LICENSE.aquarium).
// The Aquarium's lighting and fog (lightColor and specular are 1 there).
layout(constant_id = 0) const bool FOG = true;

vec4 lit(float l, float h, float m) {
  return vec4(1.0, max(l, 0.0), (l > 0.0) ? pow(max(0.0, h), m) : 0.0, 1.0);
}

vec4 fog(vec4 outColor, vec4 position, float alpha) {
  if (!FOG) return outColor;
  return mix(outColor, vec4(g.fogColor.rgb, alpha),
             clamp(pow(position.z / position.w, g.fogParams.x) * g.fogParams.y - g.fogParams.z, 0.0, 1.0));
}
