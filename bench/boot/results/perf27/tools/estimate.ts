// estimate.ts capture (PERF loop 27: a diagnostic core's counts; else as perf26/tools/locals.ts)
// locals.ts capture <core.wasm> <outdir> alpine|user|fp: runs a guest under the JIT in Node and writes every JIT
// module to <outdir>/m<n>.wasm. locals.ts sum <dir>...: per function, its declared locals and Liftoff's zero-fill
// (V8 14.x-15.x, liftoff-compiler.cc SpillLocalsInitially: more than 12 locals besides the parameters, or any that
// isn't i32/i64; FillStackSlotsWithZero on arm64: up to 96 bytes straight stp/str, past that a loop of 4-byte stores).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'capture') {
  const [core, out, guest] = args;
  mkdirSync(out, { recursive: true });
  let n = 0, total = 0;
  const M = WebAssembly.Module;
  (WebAssembly as { Module: unknown }).Module = function (bytes: Uint8Array) {
    const b = new Uint8Array(bytes as unknown as ArrayBuffer);
    if (b.length < 4 << 20) { writeFileSync(`${out}/m${n}.wasm`, b); total += b.length; }
    n++;
    return new M(bytes as unknown as BufferSource);
  } as unknown;
  Object.setPrototypeOf(WebAssembly.Module, M);
  (WebAssembly.Module as unknown as { prototype: unknown }).prototype = M.prototype;
  const coreBytes = readFileSync(core);
  if (guest === 'fp') {
    const inst = WebAssembly.instantiate;
    (WebAssembly as { instantiate: unknown }).instantiate = (b: BufferSource, i: WebAssembly.Imports) => inst((b as Uint8Array).byteLength > 4 << 20 ? coreBytes : b, i);
    const suite = await import('../../../../interp/suite.ts');
    const g = await suite.setup('guest-fp.bin', suite.JIT_DEFAULT);
    for (let done = 0; done < 300e6;) done += g.run(10_000_000);
  } else {
    const { DISTROS, guestDevices, runToPowerOff, testDevices } = await import('../../../../../web/vm.ts');
    const IMAGES = new URL('../../../../../target/images/', import.meta.url);
    const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
    const a = DISTROS.alpine;
    const o = { ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: guest === 'user' ? guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href) : testDevices(new URL(a.disk, IMAGES).href), framebuffer: { width: 640, height: 480 } };
    const r = await runToPowerOff(coreBytes, { ...o, jit: 1 }, 40e9);
    const j = r.stats.jit, M = 1e6, d = (x: number) => Math.floor(x / M), m = (x: number) => x % M;
    console.log(`calls of filled functions ${j.flagsStored}; fill turns run ${j.flagsElided}, with sharing ${j.condDirect} (${(100 * (1 - j.condDirect / j.flagsElided)).toFixed(1)}% fewer)`);
  }
  console.log(`${guest}: ${n} modules, ${total} bytes`);
  process.exit(0);
} else {
  const T: Record<number, string> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' };
  for (const dir of args) {
    const s = { fns: 0, locals: 0, zf: 0, zfCount: 0, zfV128: 0, zfFloatOnly: 0, hasFloat: 0, loop: 0, straight: 0, turns: 0, bytes: 0, at13to16: 0, floatLocals: 0 };
    for (const f of readdirSync(dir)) {
      const b = readFileSync(`${dir}/${f}`);
      let p = 8;
      const leb = () => { let r = 0, sh = 0, x; do { x = b[p++]; r |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80); return r >>> 0; };
      while (p < b.length) {
        const id = b[p++], size = leb(), end = p + size;
        if (id === 10) {
          const n = leb();
          for (let i = 0; i < n; i++) {
            const bs = leb(), bend = p + bs;
            const groups = leb();
            const c: Record<string, number> = {};
            for (let g = 0; g < groups; g++) { const k = leb(); const t = T[b[p++]] ?? '?'; c[t] = (c[t] ?? 0) + k; }
            const cnt = Object.values(c).reduce((x, y) => x + y, 0);
            const fl = (c.f32 ?? 0) + (c.f64 ?? 0), v = c.v128 ?? 0;
            s.fns++; s.locals += cnt; s.floatLocals += fl;
            if (fl) s.hasFloat++;
            const zf = cnt > 12 || fl > 0 || v > 0;
            if (zf) {
              s.zf++;
              if (cnt > 12) s.zfCount++;
              else if (v) s.zfV128++;
              else s.zfFloatOnly++;
              const bytes = (cnt - v) * 8 + v * 16;
              s.bytes += bytes;
              if (bytes <= 96) s.straight++; else { s.loop++; s.turns += bytes / 4; }
            }
            if (cnt >= 13 && cnt <= 16 && !fl && !v) s.at13to16++;
            p = bend;
          }
        }
        p = end;
      }
    }
    const pc = (x: number) => `${(100 * x / s.fns).toFixed(1)}%`;
    console.log(`${dir}: ${s.fns} functions, ${(s.locals / s.fns).toFixed(2)} locals each; zero-filled ${s.zf} (${pc(s.zf)}): >12 locals ${s.zfCount}, ≤12 with a v128 ${s.zfV128}, ≤12 with only f32/f64 non-integer ${s.zfFloatOnly}; with f32/f64 locals ${s.hasFloat} (${s.floatLocals} locals); straight fills ${s.straight}, loops ${s.loop} (${(s.turns / Math.max(1, s.loop)).toFixed(1)} turns each, ${(s.turns / s.fns).toFixed(2)} a function); integer-only at 13-16 ${pc(s.at13to16)}`);
  }
}
