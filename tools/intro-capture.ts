// The introduction page's captures (INTRO-KICKOFF.md "Truth"): for a few small C functions, the AArch64 code clang
// made of one of their blocks, the block interpreter's micro-ops for it, the WebAssembly our JIT emitted for it and
// the machine code V8 made of that on this host. Everything is what the tools printed: nothing here is written by hand.
//
//   node tools/intro-capture.ts [--build-guest] [--steps N] [--list] [--baseline] [--keep] [--out web/intro-captures/blocks.json]
//
// - The guest: tools/intro-capture/*.c, compiled by clang for aarch64 (--build-guest, or when guest.bin is missing)
//   into tools/intro-capture/guest.bin and its listing guest.lst (llvm-objdump's, the compiler's command on its first
//   line). Both are committed, so every host captures the same guest code whatever its clang.
// - The run: guest.bin in a whole VM (one vCPU, deterministic, `VmConfig.jit` 1: the default policy) behind
//   bench/interp/vm-start.bin, which enters it at EL1 with the MMU on. Every module the core hands the host
//   (`new WebAssembly.Module` in web/jit-host.ts) is copied on its way: nothing in the core or the host changes.
// - Which wasm is for which instruction: the same run on the capture build of the core (Cargo feature `capture`,
//   target/capture/), whose modules end in a custom section of notes the emitter left at each guest instruction
//   (core/src/jit/wasm.rs `Code::note`). Without that section each module must be, byte for byte, the normal core's:
//   checked here, so the notes describe the modules the normal core made.
// - The text: `wasm-tools print --print-offsets` (docs/devenv.md: a dev-only tool).
// - The micro-ops: core/examples/uops.rs, the block interpreter's decoder built natively.
// - The machine code: the module compiled alone in a child Node with --print-wasm-code (--no-liftoff: TurboFan;
//   --liftoff --no-wasm-tier-up: Liftoff), its addresses reduced to offsets.
//
// A run adds this host's architecture to blocks.json and keeps the other's, as long as the wasm is the same (else
// the other host's code is for other wasm, and is dropped with a warning).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'build-guest': { type: 'boolean', default: false },
    steps: { type: 'string', default: '40000000' },
    list: { type: 'boolean', default: false },
    out: { type: 'string', default: 'web/intro-captures/blocks.json' },
    keep: { type: 'boolean', default: false },
    baseline: { type: 'boolean', default: false },
  },
});

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'tools/intro-capture');
const tmp = mkdtempSync(join(tmpdir(), 'intro-capture-'));
const sh = (cmd: string, argv: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, ...env },
    timeout: 1_500_000,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

/**
 * The snippets: a C file each, and the function in it whose compiled code is shown. Of that function's JIT functions
 * the capture takes the last one emitted that holds a loop (a region with an edge back to its head, which is what a
 * hot loop ends up as: docs/jit.md "Tier-up"), else the last one.
 */
const SNIPPETS = [
  { id: 'sum-loop', file: 'sum.c', fn: 'sum' },
  { id: 'move-point', file: 'move.c', fn: 'move' },
  { id: 'collatz-loop', file: 'collatz.c', fn: 'collatz' },
  { id: 'total-loop', file: 'total.c', fn: 'total' },
  { id: 'cap-loop', file: 'cap.c', fn: 'cap' },
];

// ---- the guest

const CFLAGS = ['--target=aarch64-linux-gnu', '-O2', '-fno-vectorize', '-fno-slp-vectorize', '-fno-unroll-loops', '-march=armv8-a'];
// What a guest with no libc and no loader needs besides: not in the page's compiler line.
const FREESTANDING = ['-ffreestanding', '-fno-stack-protector', '-fno-pie', '-Wall', '-Werror'];
/** Where vm-start.bin enters the guest (bench/interp/vm-start.S), and RAM's start. */
const RAM_BASE = 0x4000_0000;
const LOAD = 0x4021_0000;
const RAM = 16 << 20;

function buildGuest() {
  const version = /clang version (\S+)/.exec(sh('clang', ['--version']))?.[1];
  if (!version) throw new Error('clang --version: no version');
  const objs = ['main.c', ...SNIPPETS.map((s) => s.file)].map((f) => {
    const o = join(tmp, f.replace(/\.c$/, '.o'));
    sh('clang', [...CFLAGS, ...FREESTANDING, '-c', '-o', o, join(src, f)]);
    return o;
  });
  const elf = join(tmp, 'guest.elf');
  // bench/interp's layout: .text.start first, at BASE + 0x10000.
  sh('ld.lld', ['-static', '-T', 'bench/interp/guest.ld', `--defsym=BASE=${LOAD - 0x10000}`, '-o', elf, ...objs]);
  sh('llvm-objcopy', ['-O', 'binary', elf, join(src, 'guest.bin')]);
  const listing = sh('llvm-objdump', ['-d', elf]).replace(/^.*file format.*$/m, '').trim();
  writeFileSync(join(src, 'guest.lst'), `# clang ${version} ${CFLAGS.join(' ')}\n${listing}\n`);
}

type Insn = { addr: number; bytes: string; text: string };
/** guest.lst: the compiler's line, each instruction by address, and each function's range. */
function readListing() {
  const lines = readFileSync(join(src, 'guest.lst'), 'utf8').split('\n');
  const compiler = lines[0].replace(/^# /, '');
  const insns = new Map<number, Insn>();
  const fns = new Map<string, { start: number; end: number }>();
  let cur: { start: number; end: number } | undefined;
  for (const l of lines.slice(1)) {
    const f = /^([0-9a-f]+) <(.+)>:$/.exec(l);
    if (f) {
      cur = { start: parseInt(f[1], 16), end: parseInt(f[1], 16) };
      fns.set(f[2], cur);
      continue;
    }
    const m = /^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(.*)$/.exec(l);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    insns.set(addr, { addr, bytes: m[2], text: m[3].replace(/\s+/g, ' ').trim() });
    if (cur) cur.end = addr + 4;
  }
  return { compiler, insns, fns };
}

// ---- wasm modules

const NOTES = 'waarm64.notes';
// core/src/jit/wasm.rs `NOTE_*`.
const NOTE_INSN = 0, NOTE_TAIL = 1, NOTE_SLOW = 2, NOTE_SLOW_END = 3, NOTE_BLOCK = 4, NOTE_FUSED = 5;
type Note = { at: number; part: number; a: bigint; b: bigint };
type Fn = { index: number; name: string; body: number; notes: Note[] };

/** A module's defined functions (index, name, where the body starts in the file) with their notes, and the module without the notes' section. */
function parseModule(b: Uint8Array): { funcs: Fn[]; plain: Uint8Array } {
  let p = 8;
  const big = () => { let r = 0n, s = 0n, x; do { x = b[p++]; r |= BigInt(x & 0x7f) << s; s += 7n; } while (x & 0x80); return r; };
  const u = () => Number(big());
  const str = () => { const l = u(); p += l; return new TextDecoder().decode(b.subarray(p - l, p)); };
  let imports = 0;
  const bodies: number[] = [];
  const names = new Map<number, string>();
  const notes = new Map<number, Note[]>();
  let cut: [number, number] | undefined;
  while (p < b.length) {
    const at = p, id = b[p++], len = u(), end = p + len;
    if (id === 2) {
      for (let n = u(), i = 0; i < n; i++) {
        str(); str();
        const k = b[p++];
        if (k === 0) { imports++; u(); }
        else if (k === 1) { p++; const f = u(); u(); if (f & 1) u(); }
        else if (k === 2) { const f = u(); u(); if (f & 1) u(); }
        else if (k === 3) p += 2;
        else throw new Error(`import kind ${k}`);
      }
    } else if (id === 10) {
      for (let n = u(), i = 0; i < n; i++) { const l = u(); bodies.push(p); p += l; }
    } else if (id === 0) {
      const name = str();
      if (name === 'name') {
        while (p < end) {
          const sid = b[p++], sl = u(), se = p + sl;
          if (sid === 1) for (let n = u(), i = 0; i < n; i++) { const idx = u(); names.set(idx, str()); }
          p = se;
        }
      } else if (name === NOTES) {
        cut = [at, end];
        for (let n = u(), i = 0; i < n; i++) {
          const idx = u(), list: Note[] = [];
          for (let m = u(), j = 0; j < m; j++) { const off = u(), part = b[p++]; list.push({ at: off, part, a: big(), b: big() }); }
          notes.set(idx, list);
        }
      }
    }
    p = end;
  }
  const funcs = bodies.map((body, k) => ({ index: imports + k, name: names.get(imports + k) ?? '', body, notes: notes.get(imports + k) ?? [] }));
  const plain = cut ? new Uint8Array([...b.subarray(0, cut[0]), ...b.subarray(cut[1])]) : b;
  return { funcs, plain };
}

/** Runs the guest on `core` and returns the modules it handed the host, in order. */
async function modulesOf(core: string, steps: number): Promise<Uint8Array[]> {
  const { bootVm } = await import('../web/vm.ts');
  const seen: Uint8Array[] = [];
  const Real = WebAssembly.Module;
  // The host's `new WebAssembly.Module(bytes)` (web/jit-host.ts `install`), its bytes copied first.
  class Tap extends Real {
    constructor(bytes: BufferSource) {
      seen.push(new Uint8Array(ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer : bytes.slice(0) as ArrayBuffer));
      super(bytes);
    }
  }
  const start = readFileSync(join(root, 'bench/interp/vm-start.bin'));
  const guest = readFileSync(join(src, 'guest.bin'));
  const kernel = new Uint8Array(0x10000 + guest.length);
  kernel.set(start);
  kernel.set(guest, 0x10000);
  const vm = await bootVm(new Uint8Array(readFileSync(join(root, core))), { ramSize: RAM, kernel, cmdline: '', jit: 1 });
  new BigUint64Array(vm.memory.buffer, vm.cpu + 8, 1)[0] = 1n; // x1: vm-start.S turns the MMU on
  (WebAssembly as { Module: typeof WebAssembly.Module }).Module = Tap;
  try {
    for (let done = 0; done < steps; ) {
      const n = vm.run(Math.min(1_000_000, steps - done)).steps;
      if (n === 0) throw new Error(`the guest stopped at pc 0x${vm.pc().toString(16)}`);
      done += n;
    }
  } finally {
    (WebAssembly as { Module: typeof WebAssembly.Module }).Module = Real;
  }
  // main.c's ROUNDS: the guest got through its loop.
  const rounds = new BigUint64Array(vm.memory.buffer, vm.ram + 0x28_0000, 1)[0];
  if (rounds === 0n) throw new Error('the guest made no round');
  return seen;
}

// ---- text

const wasmTools = existsSync(join(homedir(), '.cargo/bin/wasm-tools')) ? join(homedir(), '.cargo/bin/wasm-tools') : 'wasm-tools';

/** wasm-tools' first line of function `index`: `(func $name (;index;) …`. */
const funcLine = (index: number) => new RegExp(`^\\(;@[0-9a-f]+\\s*;\\)\\s*\\(func [^(]*\\(;${index};\\)`);
const offsetOf = (line: string) => parseInt(/^\(;@([0-9a-f]+)\s*;\)/.exec(line)?.[1] ?? 'x', 16);

type WasmLine = {
  text: string;
  /** `sig`: the function's type and locals; `prologue`: before a block's first instruction; `body`; `exit`: after its last. */
  part: 'sig' | 'prologue' | 'body' | 'exit';
  /** The region's member a `prologue` or `exit` line is in (an index into the capture's `blocks`); a `body` line's is its instruction's (`guest[line.guest].block`). */
  block?: number;
  /** The guest instruction the emitter was at (an index into `guest`), and the last one if the line serves several. */
  guest?: number;
  guestTo?: number;
  /** In a slow arm: what runs when the fast path's check fails. */
  cold?: true;
};

/** Function `f` of the module at `path` as wasm-tools prints it, each line with what the notes say it was emitted for. */
function wasmLines(path: string, f: Fn, starts: number[]): WasmLine[] {
  const all = sh(wasmTools, ['print', '--print-offsets', path]).split('\n');
  const first = all.findIndex((l) => funcLine(f.index).test(l));
  if (first < 0) throw new Error(`function ${f.index} isn't in wasm-tools' text`);
  const out: WasmLine[] = [];
  const notes = [...f.notes];
  let k = 0, block = -1, at: { part: WasmLine['part']; guest?: number; guestTo?: number } = { part: 'prologue' };
  const slow: { from: number; to: number }[] = [];
  let indent = -1;
  for (let i = first; i < all.length; i++) {
    const m = /^\(;@([0-9a-f]+)\s*;\)(.*)$/.exec(all[i]);
    if (!m) throw new Error(`wasm-tools' line has no offset: ${all[i]}`);
    if (indent < 0) indent = m[2].search(/\S/);
    const text = m[2].slice(indent).trimEnd();
    if (text === ')') break; // the function's end
    if (i === first) {
      // Notes (and V8's positions) count from the body's first byte, which is where wasm-tools puts the function.
      if (parseInt(m[1], 16) !== f.body) throw new Error(`function ${f.index} is at ${m[1]}, its body at ${f.body.toString(16)}`);
      out.push({ text, part: 'sig' });
      continue;
    }
    if (/^\s*\(local /.test(text)) {
      out.push({ text, part: 'sig' });
      continue;
    }
    // A branch hint's line carries its place in the hints' section: it is for the `if` or `br_if` on the next line.
    const rel = (/^\s*\(@metadata\.code\.branch_hint /.test(text) ? offsetOf(all[i + 1]) : parseInt(m[1], 16)) - f.body;
    for (; k < notes.length && notes[k].at <= rel; k++) {
      const n = notes[k];
      if (n.part === NOTE_BLOCK) {
        block++;
        at = { part: 'prologue' };
      } else if (n.part === NOTE_INSN) at = { part: 'body', guest: starts[Number(n.a)] + Number(n.b) };
      else if (n.part === NOTE_FUSED) at = { ...at, guestTo: starts[Number(n.a)] + Number(n.b) };
      else if (n.part === NOTE_TAIL) at = { part: 'exit' };
      else if (n.part === NOTE_SLOW) slow.push({ from: starts[block] + Number(n.a), to: starts[block] + Number(n.b) });
      else if (n.part === NOTE_SLOW_END) slow.pop();
      else throw new Error(`note part ${n.part}`);
    }
    const s = slow.at(-1);
    out.push({
      text,
      part: at.part,
      ...(block >= 0 && at.part !== 'body' && { block }),
      ...(s ? { guest: s.from, ...(s.to !== s.from && { guestTo: s.to }), cold: true as const }
        : { ...(at.guest !== undefined && { guest: at.guest }), ...(at.guestTo !== undefined && { guestTo: at.guestTo }) }),
    });
  }
  return out;
}

// ---- V8's code

type HostLine = { offset: string; bytes: string; text: string; wasm?: number };
type HostCode = { compiler: string; lines: HostLine[] };

/** V8's code for function `name` of the module at `path`, compiled alone with `flags`; `positions`: each wasm line's offset in the body. */
function v8Code(path: string, name: string, flags: string[], positions: Map<number, number>): HostCode {
  // V8 prints the code as it compiles. The child is a one-line script, not a .ts file: Node's own wasm (its
  // TypeScript stripper) would be compiled and printed too, megabytes of it.
  const script = 'new WebAssembly.Module(require("node:fs").readFileSync(process.argv[1]))';
  const r = spawnSync(process.execPath, ['--print-wasm-code', '--no-wasm-lazy-compilation', ...flags, '-e', script, path], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`the compile failed (${r.status}): ${r.stderr.slice(-2000)}`);
  const rec = r.stdout.split('--- WebAssembly code ---').map((x) => x.split('--- End code ---')[0]).filter((x) => new RegExp(`^name: ${name}$`, 'm').test(x));
  if (rec.length !== 1) throw new Error(`${rec.length} codes for ${name} with ${flags.join(' ')}`);
  const text = rec[0];
  const tier = /^compiler: (.*)$/m.exec(text)?.[1] ?? '?';
  // V8's source positions: the wasm instruction (its offset in the body) a machine instruction is for, where it keeps one.
  const where = new Map<number, number>();
  for (const l of (/Source positions:\n.*\n([^]*?)\n\n/.exec(text)?.[1] ?? '').split('\n')) {
    const m = /^\s*([0-9a-f]+)\s+(\d+)\s*$/.exec(l);
    if (m) where.set(parseInt(m[1], 16), Number(m[2]));
  }
  const lines: HostLine[] = [];
  for (const l of text.split('\n')) {
    const m = /^0x[0-9a-f]+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const wasm = positions.get(where.get(parseInt(m[1], 16)) ?? -1);
    lines.push({
      offset: m[1],
      bytes: m[2],
      // Addresses differ every run: a branch keeps its target's offset (x64 `<+0x3f>`, arm64 `#+0x3f`), a call into
      // V8's jump table its note.
      text: m[3].replace(/0x[0-9a-f]{7,}\s+(<\+0x[0-9a-f]+>|\(jump table\))/g, '$1').replace(/\s+\(addr 0x[0-9a-f]+\)/g, '').replace(/\s+/g, ' ').trim(),
      ...(wasm !== undefined && { wasm }),
    });
  }
  if (lines.length === 0) throw new Error(`no instructions for ${name}`);
  return { compiler: `V8 ${process.versions.v8} ${tier} (Node ${process.version} ${flags.join(' ')})`, lines };
}

// ---- the capture

type Capture = {
  id: string;
  source: string;
  compiler: string;
  /** The JIT function's name: its head's VA and PA. */
  name: string;
  /** The region's members (guest blocks), in the order the function holds them. */
  blocks: { addr: string; length: number }[];
  guest: { addr: string; bytes: string; text: string; block: number }[];
  uops: { text: string; bytes: string; guest?: number }[];
  wasm: WasmLine[];
  host: { [arch in 'x64' | 'arm64']?: HostCode & { baseline?: HostCode } };
};
type Captures = { meta: { commit: string; date: string; node: string; v8: string; wasmTools: string; note: string }; blocks: Capture[] };

if (args['build-guest'] || !existsSync(join(src, 'guest.bin')) || !existsSync(join(src, 'guest.lst'))) buildGuest();
const listing = readListing();

const CORE = 'target/wasm32-unknown-unknown/release/waarm64_core.wasm';
const NOTED = 'target/capture/wasm32-unknown-unknown/release/waarm64_core.wasm';
if (!existsSync(join(root, CORE))) throw new Error(`${CORE} is missing: scripts/build-wasm.sh`);
console.error('building the capture core and the micro-op lister (target/capture/)');
sh('scripts/build-wasm.sh', ['-q', '--features', 'capture'], { CARGO_TARGET_DIR: 'target/capture' });
sh('cargo', ['build', '-q', '--release', '-p', 'waarm64-core', '--features', 'capture', '--example', 'uops'], { CARGO_TARGET_DIR: 'target/capture' });

const steps = Number(args.steps);
const plain = await modulesOf(CORE, steps);
const noted = (await modulesOf(NOTED, steps)).map(parseModule);
if (plain.length !== noted.length) throw new Error(`the cores made ${plain.length} and ${noted.length} modules`);
plain.forEach((m, k) => {
  if (Buffer.compare(m, noted[k].plain) !== 0) throw new Error(`module ${k} of the capture core isn't the normal core's`);
});
console.error(`${plain.length} modules, the same from both cores`);

type Found = { module: number; f: Fn; va: number; looped: boolean };
const found: Found[] = [];
noted.forEach((m, k) => {
  for (const f of m.funcs) {
    const n = /^0x([0-9a-f]+)_pa0x([0-9a-f]+)$/.exec(f.name);
    if (!n) continue;
    if (n[1] !== n[2]) throw new Error(`${f.name}: the guest runs where it's loaded (vm-start.S maps VA = PA)`);
    // A region with an edge back to its head opens with a `loop`; wasm-tools says so below.
    found.push({ module: k, f, va: parseInt(n[1], 16), looped: false });
  }
});
if (args.list) {
  for (const x of found) {
    const fn = [...listing.fns].find(([, r]) => x.va >= r.start && x.va < r.end)?.[0] ?? '?';
    const blocks = x.f.notes.filter((n) => n.part === NOTE_BLOCK).map((n) => `${(x.va + Number(BigInt.asIntN(64, n.a))).toString(16)}+${n.b}`);
    console.log(`module ${x.module} (${plain[x.module].length} bytes) ${x.f.name} in ${fn}: ${blocks.join(' ')}`);
  }
}

const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined;
if (!arch) throw new Error(`no captures on ${process.arch}`);
const out = resolve(root, args.out!);
const before: Captures | undefined = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
const blocks: Capture[] = [];
for (const s of SNIPPETS) {
  const range = listing.fns.get(s.fn);
  if (!range) throw new Error(`${s.fn} isn't in guest.lst`);
  const mine = found.filter((x) => x.va >= range.start && x.va < range.end);
  if (mine.length === 0) throw new Error(`no JIT function for ${s.fn}: more --steps?`);
  const paths = new Map<number, string>();
  const pathOf = (k: number) => {
    if (!paths.has(k)) {
      paths.set(k, join(tmp, `module-${k}.wasm`));
      writeFileSync(paths.get(k)!, plain[k]);
    }
    return paths.get(k)!;
  };
  const shape = (x: Found) => {
    const members = x.f.notes.filter((n) => n.part === NOTE_BLOCK).map((n) => ({ va: Number(BigInt.asUintN(64, BigInt(x.va) + n.a)), length: Number(n.b) }));
    const starts = members.map((_, j) => members.slice(0, j).reduce((a, m) => a + m.length, 0));
    return { members, starts, wasm: wasmLines(pathOf(x.module), x.f, starts) };
  };
  // The last loop, else the last function.
  let pick = mine.at(-1)!, got = shape(pick);
  for (const x of [...mine].reverse()) {
    const g = shape(x);
    if (g.wasm.some((l) => l.part === 'prologue' && /^\s*loop\b/.test(l.text))) {
      [pick, got] = [x, g];
      break;
    }
  }
  const { members, starts, wasm } = got;
  const guest = members.flatMap((m, j) =>
    Array.from({ length: m.length }, (_, k) => {
      const i = listing.insns.get(m.va + 4 * k);
      if (!i) throw new Error(`no instruction at 0x${(m.va + 4 * k).toString(16)} in guest.lst`);
      return { addr: i.addr.toString(16), bytes: i.bytes, text: i.text, block: j };
    }),
  );
  // The micro-ops: each member decoded as the block cache decodes it (key: PA | EL1 | MMU, as vm-start.S leaves the guest).
  const lister = join(root, 'target/capture/release/examples/uops');
  const dumped = sh(lister, [join(src, 'guest.bin'), (LOAD - RAM_BASE).toString(16), '3', ...members.map((m) => (m.va - RAM_BASE).toString(16))])
    .trim().split('\n').map((l) => JSON.parse(l) as { uops: { word: string; kind: string; d: number; n: number; m: number; x: string; imm: string; packed: string }[]; consts: string[] });
  const uops: Capture['uops'] = [];
  dumped.forEach((d, j) => {
    if (d.uops.length !== members[j].length) throw new Error(`${s.id}: the block interpreter's block ${j} has ${d.uops.length} micro-ops, the JIT's ${members[j].length} instructions`);
    d.uops.forEach((u, k) => {
      if (u.word !== guest[starts[j] + k].bytes) throw new Error(`${s.id}: micro-op ${k} of block ${j} is for ${u.word}`);
      uops.push({ text: `${u.kind} d=${u.d} n=${u.n} m=${u.m} x=${u.x} imm=${u.imm}`, bytes: u.packed, guest: starts[j] + k });
    });
    // The block's 64-bit constants, in the slots after its micro-ops.
    for (const c of d.consts) uops.push({ text: `constant ${c}`, bytes: BigInt(c).toString(16).padStart(16, '0').match(/../g)!.reverse().join('') });
  });
  // Each wasm line's offset in the body, for V8's source positions.
  const offsets = new Map<number, number>();
  {
    const all = sh(wasmTools, ['print', '--print-offsets', pathOf(pick.module)]).split('\n');
    const first = all.findIndex((l) => funcLine(pick.f.index).test(l));
    wasm.forEach((l, k) => {
      if (!l.text.includes('@metadata.code.branch_hint')) offsets.set(offsetOf(all[first + k]) - pick.f.body, k);
    });
  }
  const turbofan = v8Code(pathOf(pick.module), pick.f.name, ['--no-liftoff'], offsets);
  // Liftoff's code too with --baseline: twice TurboFan's size, so not by default.
  const baseline = args.baseline ? v8Code(pathOf(pick.module), pick.f.name, ['--liftoff', '--no-wasm-tier-up'], offsets) : undefined;
  const old = before?.blocks.find((b) => b.id === s.id);
  const same = old && JSON.stringify(old.wasm) === JSON.stringify(wasm);
  if (old && !same) console.error(`${s.id}: the wasm changed, the other host's code is dropped`);
  blocks.push({
    id: s.id,
    source: readFileSync(join(src, s.file), 'utf8'),
    compiler: listing.compiler,
    name: pick.f.name,
    blocks: members.map((m) => ({ addr: m.va.toString(16), length: m.length })),
    guest,
    uops,
    wasm,
    host: { ...(same ? old.host : {}), [arch]: { ...turbofan, ...(baseline && { baseline }) } },
  });
  console.error(`${s.id}: ${pick.f.name} (module ${pick.module}), ${guest.length} instructions in ${members.length} block(s), ${wasm.length} wasm lines, ${turbofan.lines.length} ${arch} instructions${baseline ? ` (${baseline.lines.length} in Liftoff)` : ''}`);
}

const dirty = sh('git', ['status', '--porcelain', '--', 'core', 'web/jit-host.ts', 'web/vm.ts', 'tools/intro-capture', 'tools/intro-capture.ts']).trim() !== '';
const captures: Captures = {
  meta: {
    commit: sh('git', ['rev-parse', '--short', 'HEAD']).trim() + (dirty ? '+changes' : ''),
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
    v8: process.versions.v8,
    wasmTools: sh(wasmTools, ['--version']).trim(),
    note: 'tools/intro-capture.ts; meta is the last run\'s, each host entry names the V8 that made it',
  },
  blocks,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(captures) + '\n');
console.error(`${args.out}: ${readFileSync(out).length} bytes`);
if (args.keep) console.error(`kept ${tmp}: ${readdirSync(tmp).join(' ')}`);
else rmSync(tmp, { recursive: true });
