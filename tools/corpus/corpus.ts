// Golden-corpus format and harness records (docs/testing.md "The golden corpus"). The Rust comparator
// (core/tests/corpus.rs) reads the same text format and expands seeds the same way.

export const CODE = 0x100000n;
export const DATA = 0x200000n;
export const DATA_SIZE = 8192;
export const MAX_CODE = 1023;
export const FORMAT = "webpc-corpus 1";

const M64 = (1n << 64n) - 1n;

/** Register names in state order: x0..x30, sp, nzcv, fpcr, fpsr, v0..v31. */
export const REGS = [
  ...Array.from({ length: 31 }, (_, i) => `x${i}`),
  "sp",
  "nzcv",
  "fpcr",
  "fpsr",
  ...Array.from({ length: 32 }, (_, i) => `v${i}`),
];
const V0 = REGS.indexOf("v0");

export interface Test {
  name: string;
  code: number[];
  seed: bigint;
  /** Overrides applied after the seed expansion. */
  in: Map<string, bigint>;
  // Filled in by an oracle:
  out?: Map<string, bigint>;
  /** Changed memory: [address, bytes in address order]. */
  mem?: [bigint, Uint8Array][];
  exit?: string;
  notes: string[];
}

export interface State {
  regs: bigint[]; // REGS order
  mem: Uint8Array; // DATA_SIZE bytes at DATA
}

export function* splitmix64(seed: bigint): Generator<bigint> {
  let s = seed & M64;
  for (;;) {
    s = (s + 0x9e3779b97f4a7c15n) & M64;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    yield z ^ (z >> 31n);
  }
}

/**
 * Seed expansion: x0..x30, sp, nzcv (top 4 bits), then the data region as LE u64s,
 * then v0..v31 (low then high u64 each); fpcr and fpsr are 0. Then overrides.
 */
export function initialState(t: Pick<Test, "seed" | "in">): State {
  const g = splitmix64(t.seed);
  const next = () => g.next().value as bigint;
  const regs = REGS.map(() => 0n);
  for (let i = 0; i < 33; i++) regs[i] = next();
  regs[32] &= 0xf0000000n;
  const mem = new Uint8Array(DATA_SIZE);
  const dv = new DataView(mem.buffer);
  for (let i = 0; i < DATA_SIZE; i += 8) dv.setBigUint64(i, next(), true);
  for (let i = V0; i < REGS.length; i++) regs[i] = next() | (next() << 64n);
  for (const [k, v] of t.in) {
    const i = REGS.indexOf(k);
    if (i < 0) throw new Error(`unknown register ${k}`);
    regs[i] = v;
  }
  return { regs, mem };
}

// Harness records.

/** Registers in record layout: x0..x30, sp, nzcv/pstate, fpcr, fpsr as u64, then v0..v31 as 16 bytes. */
const REGS_SIZE = 35 * 8 + 32 * 16;

function putRegs(dv: DataView, at: number, regs: bigint[]) {
  regs.forEach((v, i) => {
    if (i < V0) dv.setBigUint64(at + 8 * i, v, true);
    else {
      const o = at + 8 * V0 + 16 * (i - V0);
      dv.setBigUint64(o, v & M64, true);
      dv.setBigUint64(o + 8, v >> 64n, true);
    }
  });
}

function getRegs(dv: DataView, at: number): bigint[] {
  return REGS.map((_, i) => {
    if (i < V0) return dv.getBigUint64(at + 8 * i, true);
    const o = at + 8 * V0 + 16 * (i - V0);
    return dv.getBigUint64(o, true) | (dv.getBigUint64(o + 8, true) << 64n);
  });
}

export function packInput(t: Test): Uint8Array {
  const s = initialState(t);
  const buf = new Uint8Array(8 + REGS_SIZE + DATA_SIZE + 4 * t.code.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x49435057, true);
  dv.setUint32(4, t.code.length, true);
  putRegs(dv, 8, s.regs);
  buf.set(s.mem, 8 + REGS_SIZE);
  t.code.forEach((w, i) => dv.setUint32(8 + REGS_SIZE + DATA_SIZE + 4 * i, w, true));
  return buf;
}

export const OUT_SIZE = 16 + 16 + REGS_SIZE + DATA_SIZE;

const SIGNALS: Record<number, string> = { 4: "sigill", 5: "sigtrap", 7: "sigbus", 11: "sigsegv" };

/** Fills t.out/mem/exit from one harness output record. */
export function applyOutput(t: Test, rec: Uint8Array): void {
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  if (dv.getUint32(0, true) !== 0x4f435057) throw new Error("bad output record");
  const signo = dv.getUint32(4, true);
  const siCode = dv.getUint32(8, true);
  const addr = dv.getBigUint64(16, true);
  const pc = dv.getBigUint64(24, true);
  const regs = getRegs(dv, 32);
  regs[32] &= 0xf0000000n; // pstate -> NZCV
  const mem = rec.subarray(32 + REGS_SIZE, 32 + REGS_SIZE + DATA_SIZE);

  const init = initialState(t);
  t.out = new Map();
  regs.forEach((v, i) => {
    if (v !== init.regs[i]) t.out!.set(REGS[i], v);
  });
  t.mem = [];
  for (let i = 0; i < DATA_SIZE; ) {
    if (mem[i] === init.mem[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < DATA_SIZE && mem[i] !== init.mem[i]) i++;
    t.mem.push([DATA + BigInt(start), mem.slice(start, i)]);
  }
  const off = pc - CODE;
  const end = BigInt(4 * t.code.length);
  if (signo === 5 && off === end) t.exit = "end";
  else {
    const name = SIGNALS[signo] ?? `sig${signo}`;
    t.exit = `${name} pc=+${off} code=${siCode}` + (signo === 7 || signo === 11 ? ` addr=${hex(addr)}` : "");
  }
}

// Text format.

const hex = (v: bigint) => `0x${v.toString(16)}`;
const hexBytes = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const regList = (m: Map<string, bigint>) =>
  [...m].map(([k, v]) => `${k}=` + (k[0] === "v" ? `0x${v.toString(16).padStart(32, "0")}` : hex(v))).join(" ");

export function formatFile(oracle: string, tests: Test[]): string {
  const lines = [FORMAT, `oracle ${oracle}`];
  for (const t of tests) {
    lines.push(`test ${t.name}`, `code ${t.code.map((w) => w.toString(16).padStart(8, "0")).join(" ")}`);
    lines.push(`seed ${t.seed.toString(16).padStart(16, "0")}`);
    if (t.in.size) lines.push(`in ${regList(t.in)}`);
    if (t.out?.size) lines.push(`out ${regList(t.out)}`);
    if (t.mem?.length) lines.push(`mem ${t.mem.map(([a, b]) => `${hex(a)}=${hexBytes(b)}`).join(" ")}`);
    lines.push(`exit ${t.exit}`);
    for (const n of t.notes) lines.push(`note ${n}`);
  }
  return lines.join("\n") + "\n";
}

const regMap = (words: string[]) =>
  new Map(
    words.map((w) => {
      const [k, v] = w.split("=");
      return [k, BigInt(v)] as [string, bigint];
    }),
  );

export function parseFile(text: string): { oracle: string; tests: Test[] } {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines[0] !== FORMAT) throw new Error(`expected "${FORMAT}"`);
  let oracle = "";
  const tests: Test[] = [];
  let t: Test | undefined;
  for (const line of lines.slice(1)) {
    const [key, ...w] = line.split(" ");
    if (key === "oracle") oracle = w.join(" ");
    else if (key === "test") tests.push((t = { name: w[0], code: [], seed: 0n, in: new Map(), notes: [] }));
    else if (!t) throw new Error(`"${key}" before any test`);
    else if (key === "code") t.code = w.map((x) => parseInt(x, 16));
    else if (key === "seed") t.seed = BigInt(`0x${w[0]}`);
    else if (key === "in") t.in = regMap(w);
    else if (key === "out") t.out = regMap(w);
    else if (key === "mem")
      t.mem = w.map((x) => {
        const [a, b] = x.split("=");
        return [BigInt(a), Uint8Array.from(b.match(/../g)!, (h) => parseInt(h, 16))];
      });
    else if (key === "exit") t.exit = w.join(" ");
    else if (key === "note") t.notes.push(w.join(" "));
    else throw new Error(`unknown key "${key}"`);
  }
  return { oracle, tests };
}
