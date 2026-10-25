// The GLES port's shaders (gles.c; bench/vulkan/REPORT.md arm 4): the scene's GLSL 450 (shaders/) rewritten as GLSL ES
// 3.00 the way a GL program declares them: the includes inlined, uniform blocks without sets and bindings (gles.c binds
// them by name), samplers as plain uniforms, the push constants as plain uniforms (a fish's 48 bytes as three vec4s,
// set with one glUniform4fv), fog a #define instead of a specialization constant, varyings matched by name.
//   node bench/vulkan/scene/gles-shaders.ts <out dir>
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./shaders/', import.meta.url));

function inline(src: string): string {
  return src.replace(/^#include "([^"]+)"$/gm, (_, f: string) => inline(readFileSync(join(DIR, f), 'utf8')));
}

export function toEs(name: string, src: string): string {
  const vertex = name.endsWith('.vert');
  let s = inline(src).replace(/^#version 450\n/, '');
  s = s.replace(/layout\(set = \d+, binding = \d+, std140\) uniform/g, 'layout(std140) uniform');
  s = s.replace(/layout\(set = \d+, binding = \d+\) uniform/g, 'uniform');
  s = s.replace('layout(constant_id = 0) const bool FOG = true;', '#ifdef NOFOG\nconst bool FOG = false;\n#else\nconst bool FOG = true;\n#endif');
  // The fish's push constants: three vec4s and a struct built from them.
  s = s.replace(/layout\(push_constant, std430\) uniform Fish \{[^}]*\} f;/s,
    'uniform vec4 fishData[3];\nstruct FishT { vec3 worldPosition; float scale; vec3 nextPosition; float time; float fishLength; float fishWaveLength; float fishBendAmount; };\n' +
    '#define f FishT(fishData[0].xyz, fishData[0].w, fishData[1].xyz, fishData[1].w, fishData[2].x, fishData[2].y, fishData[2].z)');
  s = s.replace(/layout\(push_constant, std430\) uniform Set \{ vec4 world; \} set;/, 'uniform vec4 setWorld;').replace(/\bset\.world\b/g, 'setWorld');
  s = s.replace(/layout\(push_constant, std430\) uniform Ray \{ mat4 world; vec4 colorMult; \} ray;/, 'uniform mat4 rayWorld;\nuniform vec4 rayColorMult;')
    .replace(/\bray\.world\b/g, 'rayWorld').replace(/\bray\.colorMult\b/g, 'rayColorMult');
  s = s.replace(/\bgl_VertexIndex\b/g, 'gl_VertexID');
  // Varyings by name: drop the locations of the vertex shader's outputs and the fragment shader's inputs.
  s = vertex ? s.replace(/layout\(location = \d+\) out /g, 'out ') : s.replace(/layout\(location = \d+\) in /g, 'in ');
  if (/push_constant|constant_id|binding =/.test(s)) throw new Error(`${name}: left untranslated`);
  return `#version 300 es\nprecision highp float;\nprecision highp int;\n${s}`;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: gles-shaders.ts <out dir>');
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(DIR)) if (/\.(vert|frag)$/.test(f)) writeFileSync(join(out, f), toEs(f, readFileSync(join(DIR, f), 'utf8')));
}
