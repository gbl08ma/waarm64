// compile-child.mjs <dir> <every>: compiles every `every`-th module m<n>.wasm of <dir> (plain JS: a .ts child would
// load Node's type stripper, whose own wasm --print-wasm-code prints too).
import { readdirSync, readFileSync } from 'node:fs';
const [dir, every] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => /^m\d+\.wasm$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).filter((_, i) => i % Number(every) === 0);
for (const f of files) new WebAssembly.Module(readFileSync(`${dir}/${f}`));
