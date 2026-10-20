// codesize.ts <dir> [every] [tier]: compiles every `every`-th module of <dir> (m<n>.wasm) eagerly in a child Node
// under one tier (liftoff, default, or turbofan) with --print-wasm-code, and sums V8's instruction sizes.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [dir, every = '1', tier = 'liftoff', child] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => /^m\d+\.wasm$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).filter((_, i) => i % Number(every) === 0);
if (child === 'child') {
  for (const f of files) new WebAssembly.Module(readFileSync(`${dir}/${f}`));
} else {
  let wasm = 0;
  for (const f of files) wasm += readFileSync(`${dir}/${f}`).length;
  const flags = ['--no-wasm-lazy-compilation', '--print-wasm-code', tier === 'liftoff' ? '--liftoff-only' : '--no-liftoff', '--single-threaded'];
  const p = spawn(process.execPath, [...flags, new URL('compile-child.mjs', import.meta.url).pathname, dir, every], { stdio: ['ignore', 'pipe', 'inherit'] });
  let code = 0, funcs = 0;
  const rl = createInterface({ input: p.stdout });
  rl.on('line', (l) => {
    const m = l.match(/^Instructions \(size = (\d+)\)/);
    if (m) { code += Number(m[1]); funcs++; }
  });
  p.on('close', () => console.log(`${dir}: ${files.length} modules, ${wasm} wasm bytes, ${funcs} functions, ${code} ${tier} code bytes`));
}
