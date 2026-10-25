// VK1 step 1: the wasm build of spike.c (bench/vulkan/nir/build.sh) loaded with the few WASI calls it imports
// stubbed (no files, no environment; the clock is performance.now()), for Node (run.ts) and Chromium (page.ts) alike.

export interface StageResult {
  rc: number;          // 0, or the phase that failed (1 spirv_to_nir, 2 nir_to_msl)
  ms: number[];        // spirv_to_nir, the passes, nir_to_msl
  totalMs: number;     // the call, timed from outside
  outLen: number;
  hash: number;        // FNV-1a of the MSL (or of the error text)
  error?: string;
  text?: string;       // the MSL, when asked for
}

export interface Spike {
  run(words: Uint8Array, stage: number, flags: number, text?: boolean): StageResult;
  memoryBytes(): number;
}

// Mesa's stage numbers (mesa_shader_stage), from a dump's name 0x<hash>.<ext>.spv.
export const STAGES = ['vert', 'tesc', 'tese', 'geom', 'frag', 'comp'];
export const stageOf = (name: string) => STAGES.findIndex((s) => name.includes(`.${s}.`));

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

export async function loadSpike(module: WebAssembly.Module): Promise<Spike> {
  let memory: WebAssembly.Memory;
  const dv = () => new DataView(memory.buffer);
  const EBADF = 8, ENOSYS = 52;
  const wasi = {
    clock_time_get: (_id: number, _precision: bigint, out: number) => {
      dv().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
      return 0;
    },
    fd_write: (fd: number, iovs: number, n: number, written: number) => {
      let len = 0, text = '';
      for (let i = 0; i < n; i++) {
        const p = dv().getUint32(iovs + i * 8, true), l = dv().getUint32(iovs + i * 8 + 4, true);
        text += new TextDecoder().decode(new Uint8Array(memory.buffer, p, l));
        len += l;
      }
      if (fd === 2 && text.trim()) console.error(`[spike] ${text.trimEnd()}`);
      dv().setUint32(written, len, true);
      return 0;
    },
    fd_close: () => 0,
    fd_fdstat_get: () => EBADF,
    fd_fdstat_set_flags: () => ENOSYS,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_read: () => EBADF,
    fd_seek: () => EBADF,
    path_open: () => ENOSYS,
    proc_exit: (code: number) => { throw new Error(`proc_exit(${code})`); },
  };
  // Emscripten's standalone build (build.sh emscripten) also tells the embedder when memory grows.
  const env = { emscripten_notify_memory_growth: () => {} };
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi, env });
  const e = instance.exports as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory; _initialize: () => void };
  memory = e.memory;
  e._initialize();
  e.spike_init();
  return {
    run(words, stage, flags, text = false) {
      const p = e.spike_alloc(words.length);
      new Uint8Array(memory.buffer, p, words.length).set(words);
      const t0 = performance.now();
      const rc = e.spike_run(p, words.length >> 2, stage, flags);
      const totalMs = performance.now() - t0;
      e.spike_free(p);
      const ns = new BigUint64Array(memory.buffer, e.spike_phase_ns(), 3);
      const outLen = e.spike_result_len();
      const out = new Uint8Array(memory.buffer, e.spike_result(), outLen);
      return { rc, ms: [...ns].map((v) => Number(v) / 1e6), totalMs, outLen, hash: fnv1a(out),
        error: rc ? new TextDecoder().decode(out) : undefined, text: text ? new TextDecoder().decode(out) : undefined };
    },
    memoryBytes: () => memory.buffer.byteLength,
  };
}

export interface Pass { name: string; stage: number; results: StageResult[] }

// The protocol every arm runs: each stage once (cold: the module's code still tiering up), then `reps` more times
// in rounds over all of them; a stage's warm time is the median of its rounds.
// FLAG_MSL runs nir_to_msl too; FLAG_NIR returns the NIR after the passes instead (the builds' check).
export const FLAG_MSL = 1, FLAG_NIR = 2;
export function runAll(spike: Spike, stages: { name: string; words: Uint8Array }[], reps: number, flags = FLAG_MSL): Pass[] {
  const passes: Pass[] = stages.map((s) => ({ name: s.name, stage: stageOf(s.name), results: [] }));
  for (let r = 0; r <= reps; r++) {
    stages.forEach((s, i) => passes[i].results.push(spike.run(s.words, passes[i].stage, flags)));
  }
  return passes;
}

// The NIR each stage reaches, hashed: run after the timed rounds.
export const nirHashes = (spike: Spike, stages: { name: string; words: Uint8Array }[]) =>
  stages.map((s) => spike.run(s.words, stageOf(s.name), FLAG_NIR).hash);
