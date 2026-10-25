// The shader step of arm 3's prototype, and question D's harness (bench/vulkan/REPORT.md): SPIR-V to WGSL as our
// translator would do it at pipeline creation. Per pipeline stage (a module with its specialization values):
//   1. spirv-opt: the specialization constants frozen to the pipeline's values (naga 30 has no OpSpecConstantOp),
//      combined image-samplers split into an image and a sampler (WebGPU has no combined ones);
//   2. the bindings renumbered (our patch of the SPIR-V): Vulkan's binding b becomes 2b, a split sampler 2b+1;
//   3. naga: SPIR-V to WGSL, twice: Vulkan's clip space kept, and adjusted (y negated) for positive-height viewports
//      (push constants come out as immediates: replay.ts keeps them or makes them a uniform);
//   4. spirv-cross --reflect: the bindings' kinds and texture dimensions, the push constants' size.
// Each step is timed (natively; question D also wants them in wasm).
// The translations are keyed by the module's SPIR-V hash and its specialization (a pipeline cache's key), so any
// capture of the same program finds them: scene-shaders.json, committed, is the scene's (the NVIDIA desktop's script
// has no naga).
//   node bench/vulkan/translate/shaders.ts <trace dir> [naga binary]   -> <trace dir>/shaders.json, shaders-timing.json
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OP_DECORATE = 71, OP_VARIABLE = 59, OP_TYPE_POINTER = 32, OP_TYPE_SAMPLER = 26, DECORATION_BINDING = 33;

/** Renumbers a module's bindings: b -> 2b, a sampler's b -> 2b + 1 (its split image keeps 2b). */
export function renumberBindings(spv: Uint8Array): Uint8Array {
  const w = new Uint32Array(spv.buffer.slice(spv.byteOffset, spv.byteOffset + spv.byteLength));
  const pointee = new Map<number, number>(), samplerTypes = new Set<number>(), varType = new Map<number, number>();
  const bindings: number[] = [];  // word offsets of Binding decorations
  for (let i = 5; i < w.length;) {
    const n = w[i] >>> 16, op = w[i] & 0xffff;
    if (op === OP_TYPE_SAMPLER) samplerTypes.add(w[i + 1]);
    else if (op === OP_TYPE_POINTER) pointee.set(w[i + 1], w[i + 3]);
    else if (op === OP_VARIABLE) varType.set(w[i + 2], w[i + 1]);
    else if (op === OP_DECORATE && w[i + 2] === DECORATION_BINDING) bindings.push(i);
    i += n;
  }
  for (const i of bindings) {
    const v = w[i + 1];
    const sampler = samplerTypes.has(pointee.get(varType.get(v) ?? -1) ?? -1);
    w[i + 3] = w[i + 3] * 2 + (sampler ? 1 : 0);
  }
  return new Uint8Array(w.buffer);
}

const DIM: Record<string, GPUTextureViewDimension> = { '2D': '2d', Cube: 'cube', '2DArray': '2d-array', '3D': '3d' };

export function translate(spv: Uint8Array, spec: { id: number; value: number }[], naga: string, dir: string) {
  const t: Record<string, number> = {};
  const inF = join(dir, 'in.spv'), optF = join(dir, 'opt.spv'), wgslF = join(dir, 'out.wgsl');
  writeFileSync(inF, spv);
  const specArg = spec.map((s) => `${s.id}:${s.value}`).join(' ');
  let a = performance.now();
  const opt = spawnSync('spirv-opt', [...(specArg ? ['--set-spec-const-default-value', specArg] : []), '--freeze-spec-const',
    '--fold-spec-const-op-composite', '--split-combined-image-sampler', inF, '-o', optF], { encoding: 'utf8' });
  t.spirvOptMs = performance.now() - a;
  if (opt.status !== 0) throw new Error(`spirv-opt: ${opt.stderr}`);
  a = performance.now();
  const renumbered = renumberBindings(new Uint8Array(readFileSync(optF)));
  t.renumberMs = performance.now() - a;
  writeFileSync(optF, renumbered);
  // Two forms: Vulkan's clip space kept (a program that flips its viewport, as GL ports do: WebGPU's own convention)
  // and adjusted (naga negates y: a positive-height viewport). replay.ts picks one by the viewport's sign.
  a = performance.now();
  const n = spawnSync(naga, ['--keep-coordinate-space', optF, wgslF], { encoding: 'utf8' });
  t.nagaMs = performance.now() - a;
  if (n.status !== 0) throw new Error(`naga: ${n.stderr}`);
  const wgsl = readFileSync(wgslF, 'utf8');
  const nf = spawnSync(naga, [optF, wgslF], { encoding: 'utf8' });
  if (nf.status !== 0) throw new Error(`naga: ${nf.stderr}`);
  const wgslFlipped = readFileSync(wgslF, 'utf8');
  a = performance.now();
  const r = spawnSync('spirv-cross', [optF, '--reflect'], { encoding: 'utf8' });
  t.reflectMs = performance.now() - a;
  if (r.status !== 0) throw new Error(`spirv-cross: ${r.stderr.slice(0, 300)}`);
  const refl = JSON.parse(r.stdout) as Json;
  const types = refl.types ?? {};
  const bindings: Json[] = [];
  for (const u of refl.ubos ?? []) bindings.push({ set: u.set, binding: u.binding / 2, kind: 'uniform' });
  for (const u of refl.ssbos ?? []) bindings.push({ set: u.set, binding: u.binding / 2, kind: 'storage' });
  for (const im of refl.separate_images ?? []) bindings.push({ set: im.set, binding: im.binding / 2, kind: 'texture', dimension: DIM[im.type?.match(/texture(\w+)/)?.[1] ?? '2D'] ?? '2d', sampleType: 'float' });
  for (const s of refl.separate_samplers ?? []) bindings.push({ set: s.set, binding: (s.binding - 1) / 2, kind: 'sampler' });
  const pc = (refl.push_constants ?? [])[0];
  let pushBytes = 0;
  if (pc) {
    // The highest byte the shader reads of its push-constant block: its members' ends.
    const ty = types[pc.type];
    for (const m of ty?.members ?? []) {
      const size = (m.type === 'mat4' ? 64 : m.type === 'vec4' ? 16 : m.type === 'vec3' ? 12 : m.type === 'vec2' ? 8 : 4) * (m.array?.[0] ?? 1);
      pushBytes = Math.max(pushBytes, (m.offset ?? 0) + size);
    }
  }
  const entry = /@(?:vertex|fragment)\s+fn\s+(\w+)/.exec(wgsl)?.[1] ?? 'main';
  return { meta: { wgsl, wgslFlipped, entry, bindings, pushBytes }, timing: t, wgslBytes: wgsl.length, spvBytes: spv.length };
}

if (import.meta.main) {
  const dir = process.argv[2];
  const naga = process.argv[3] ?? join(process.env.HOME ?? '', '.cargo/bin/naga');
  if (!dir) throw new Error('usage: shaders.ts <trace dir> [naga]');
  const setup = JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8')) as Json;
  const tmp = mkdtempSync(join(tmpdir(), 'vk0-shaders-'));
  const out: Record<string, unknown> = {}, timing: Json[] = [];
  try {
    for (const p of Object.values(setup.pipelines as Record<string, Json>)) {
      for (const st of p.stages as Json[]) {
        const key = `${setup.shaders[st.module].hash}:${(st.spec as { id: number; value: number }[]).map((s) => `${s.id}=${s.value}`).join(',')}`;
        if (out[key]) continue;
        const spv = new Uint8Array(readFileSync(join(dir, setup.shaders[st.module].spv)));
        const r = translate(spv, st.spec, naga, tmp);
        out[key] = r.meta;
        timing.push({ key, stage: st.stage, spvBytes: r.spvBytes, wgslBytes: r.wgslBytes, ...r.timing });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(join(dir, 'shaders.json'), JSON.stringify(out));
  writeFileSync(join(dir, 'shaders-timing.json'), JSON.stringify(timing, null, 1));
  const sum = (k: string) => timing.reduce((s, x) => s + x[k], 0);
  console.log(`${timing.length} stages translated: spirv-opt ${sum('spirvOptMs').toFixed(0)} ms, naga ${sum('nagaMs').toFixed(0)} ms, reflection ${sum('reflectMs').toFixed(0)} ms (processes included)`);
}
