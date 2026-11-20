// The "why" of the introduction's captured code (IntroTranslate.svelte; docs/frontend.md "The captures"): notes placed
// between the lines of the WebAssembly and of the host's machine code, saying what a run of lines is for. The code is
// the capture's; the notes are ours, and each is placed by a rule that reads the capture: a register's load by its
// offset in the processor's state, a TLB check by the slow arm beside it, a bounds check by its three instructions.
// A rule that doesn't find its shape places nothing (tests/intro-notes.test.ts holds the rules to the committed
// captures). The words are the catalog's (`intro:IntroTranslate.why.*`), by `kind`.
import type { Capture, HostArch } from './captures.ts';

export type WhyKind =
  | 'sig'
  | 'pc'
  | 'regs'
  | 'loop'
  | 'tlb'
  | 'hit'
  | 'miss'
  | 'flags'
  | 'again'
  | 'back'
  | 'pcBack'
  | 'chain'
  | 'ret'
  | 'hostEntry'
  | 'hostRegs'
  | 'hostLoop'
  | 'hostTlb'
  | 'hostGray'
  | 'hostBounds'
  | 'hostExit'
  | 'hostChain'
  | 'hostRare'
  | 'hostSlow';
/** A note: what it says (`kind`), and the guest registers it names. */
export type Why = { kind: WhyKind; regs?: string[] };
/** Notes by the index of the line they stand before. */
export type Notes = Map<number, Why[]>;

/** The `Cpu`'s fields the emitted code reads at fixed offsets (core/src/jit/emit.rs): x0 to x30 and SP, 8 bytes each, then the PC and the flags. */
const PC = 256;
const NZCV = 264;
const regAt = (offset: number) => (offset % 8 || offset > 248 ? undefined : offset === 248 ? 'sp' : `x${offset / 8}`); // i18n-ignore

const add = (notes: Notes, at: number, why: Why) => {
  const list = notes.get(at);
  if (list) list.push(why);
  else notes.set(at, [why]);
};
const isLoop = (text: string | undefined) => /^\s*loop\b/.test(text ?? '');

/** The WebAssembly's lines, read by the rules. */
class Wasm {
  readonly notes: Notes = new Map();
  readonly #c: Capture;
  constructor(c: Capture) {
    this.#c = c;
  }
  get length() {
    return this.#c.wasm.length;
  }
  text(i: number) {
    return this.#c.wasm[i]?.text.trim() ?? '';
  }
  part(i: number) {
    return this.#c.wasm[i]?.part;
  }
  cold(i: number) {
    return !!this.#c.wasm[i]?.cold;
  }
  /** `local.get 0`, a load at an offset of the processor's state, a local: the offset, if line `i` starts one. */
  stateLoad(i: number) {
    const m = /^i64\.load(?: offset=(\d+))?$/.exec(this.text(i + 1));
    return this.text(i) === 'local.get 0' && m && /^local\.set \d+$/.test(this.text(i + 2))
      ? Number(m.at(1) ?? 0)
      : undefined;
  }
  /** The register line `i` starts a store of (`local.get 0`, a local, a store at the register's offset), if it does. */
  stored(i: number) {
    const m = /^i64\.store(?: offset=(\d+))?$/.exec(this.text(i + 2));
    return this.text(i) === 'local.get 0' && /^local\.get \d+$/.test(this.text(i + 1)) && m
      ? regAt(Number(m.at(1) ?? 0))
      : undefined;
  }
  /** Back from line `i`, inside what leaves the block, to the line after the nearest one that `stop` holds of. */
  back(i: number, stop: (text: string) => boolean) {
    while (i > 0 && this.part(i - 1) === 'exit' && !stop(this.text(i - 1))) i--;
    return i;
  }
  note(at: number, why: Why) {
    add(this.notes, at, why);
  }
}

/** Before the first instruction: the program counter, the registers (one note, at the first's load), the loop. */
function prologueNotes(c: Capture, w: Wasm) {
  const loaded: string[] = [];
  let loadedAt: number | undefined;
  c.wasm.forEach((l, i) => {
    if (l.part !== 'prologue') return;
    const offset = w.stateLoad(i);
    const reg = offset === undefined ? undefined : regAt(offset);
    if (offset === PC) w.note(i, { kind: 'pc' });
    else if (reg && !loaded.includes(reg)) {
      loaded.push(reg);
      loadedAt ??= i;
    }
    if (isLoop(l.text)) w.note(i, { kind: 'loop' });
  });
  if (loadedAt !== undefined) w.note(loadedAt, { kind: 'regs', regs: loaded });
}

/**
 * An instruction's own lines: a memory access is a TLB check, its hit and its slow arm; else the flags' store. Returns
 * each access's check (its lines, from where the address is shifted to pick its entry to the check's branch).
 */
function bodyNotes(c: Capture, w: Wasm) {
  const probes = new Map<number, [number, number]>();
  const byGuest = new Map<number, number[]>();
  c.wasm.forEach((l, i) => {
    if (l.part === 'body' && l.guest !== undefined) byGuest.set(l.guest, [...(byGuest.get(l.guest) ?? []), i]);
  });
  for (const [g, lines] of byGuest) {
    const first = lines.at(0);
    const miss = lines.find((i) => w.cold(i));
    const branch = lines.find((i) => !w.cold(i) && /^if\b/.test(w.text(i)));
    if (first === undefined) continue;
    if (miss !== undefined && branch !== undefined && branch < miss) {
      w.note(first, { kind: 'tlb' });
      w.note(branch + 1, { kind: 'hit' });
      w.note(miss, { kind: 'miss' });
      const shift = lines.find(
        (i) => !w.cold(i) && w.text(i) === 'i64.shr_u' && /^i64\.const \d+$/.test(w.text(i - 1)),
      );
      probes.set(g, [shift === undefined ? first : shift - 2, branch]);
    } else if (lines.some((i) => w.text(i) === `i64.store offset=${NZCV}`)) w.note(first, { kind: 'flags' });
  }
  return probes;
}

/** The next block's lookup, from the `if` that guards it (after an `i32.eqz`) to its call at `call`. */
function chainFrom(w: Wasm, call: number): [number, number] {
  for (let k = call; k > call - 48 && k > 0 && w.part(k) === 'exit' && w.text(k) !== 'return'; k--)
    if (/^if\b/.test(w.text(k)) && w.text(k - 1) === 'i32.eqz') return [k + 1, call];
  return [call, call];
}

/** A run of registers stored from line `i` on: the registers, and the run's last line. */
function storedRun(w: Wasm, i: number): [string[], number] | undefined {
  const first = w.stored(i);
  if (!first) return undefined;
  const regs = [first];
  for (let next = w.stored(i + 3); next; next = w.stored(i + 3)) {
    regs.push(next);
    i += 3;
  }
  return [regs, i + 2];
}

/** Leaving the block: the registers and the program counter stored, the loop's own branch, the next block, the return. */
function exitNotes(w: Wasm) {
  let chain: [number, number] | undefined;
  let lastReturn: number | undefined;
  for (let i = 0; i < w.length; i++) {
    if (w.part(i) !== 'exit') continue;
    const text = w.text(i);
    const run = storedRun(w, i);
    if (run) {
      w.note(i, { kind: 'back', regs: run[0] });
      i = run[1];
    } else if (text === `i64.store offset=${PC}`)
      w.note(Math.max(0, w.back(i, (t) => t === 'local.get 0') - 1), { kind: 'pcBack' });
    else if (text === 'i32.ge_u' && w.text(i - 2) === 'local.get 2' && /^i32\.const \d+$/.test(w.text(i - 1)) && !chain)
      w.note(i - 2, { kind: 'again' });
    else if (text.startsWith('return_call_indirect')) {
      chain = chainFrom(w, i);
      w.note(chain[0], { kind: 'chain' });
    } else if (text === 'return') lastReturn = i;
  }
  if (lastReturn !== undefined)
    w.note(
      w.back(lastReturn, (t) => /^(end|i64\.store)\b/.test(t)),
      { kind: 'ret' },
    );
  return chain;
}

/** The WebAssembly's notes, and where the next block's lookup and each memory access's check are (for the host's). */
export function wasmNotes(c: Capture): {
  notes: Notes;
  chain?: [number, number];
  probes: Map<number, [number, number]>;
} {
  const w = new Wasm(c);
  if (c.wasm[0]?.part === 'sig') w.note(0, { kind: 'sig' });
  prologueNotes(c, w);
  const probes = bodyNotes(c, w);
  const chain = exitNotes(w);
  return { notes: w.notes, chain, probes };
}

/** The host's lines for one processor, read by the rules. */
class Host {
  readonly notes: Notes = new Map();
  readonly lines: NonNullable<Capture['host'][HostArch]>['lines'];
  readonly #c: Capture;
  readonly #arch: HostArch;
  readonly #offsets: Map<number, number>;
  constructor(c: Capture, arch: HostArch) {
    this.#c = c;
    this.#arch = arch;
    this.lines = c.host[arch]?.lines ?? [];
    this.#offsets = new Map(this.lines.map((h, i) => [parseInt(h.offset, 16), i]));
  }
  text(i: number) {
    return this.lines[i]?.text ?? '';
  }
  /** The WebAssembly line V8 ties line `i` to, if it does. */
  from(i: number) {
    const at = this.lines[i]?.wasm;
    return at === undefined ? undefined : this.#c.wasm[at];
  }
  /** A branch, a call through a register or a return: where a run of lines ends. */
  isBranch(i: number) {
    return this.#arch === 'x64'
      ? /^(j[a-z]+ |ret)/.test(this.text(i))
      : /^(b(\.[a-z]+)?|bl?r|ret|cbn?z|tbn?z)\b/.test(this.text(i));
  }
  /** The line a branch at `i` leads to (x86-64 prints the address, AArch64 the distance). */
  target(i: number) {
    const x = /<\+0x([0-9a-f]+)>/.exec(this.text(i));
    if (x?.[1]) return this.#offsets.get(parseInt(x[1], 16));
    const a = /#([+-])0x([0-9a-f]+)$/.exec(this.text(i));
    const here = parseInt(this.lines[i]?.offset ?? '0', 16);
    return a?.[2] ? this.#offsets.get(here + (a[1] === '-' ? -1 : 1) * parseInt(a[2], 16)) : undefined;
  }
  /**
   * Where the lines that lead up to line `i` start: back over what has no WebAssembly line of its own, to the last
   * branch, `most` lines at most (what computes an address before its access).
   */
  runStart(i: number, most = 2) {
    const least = i - most;
    while (
      i > least &&
      i > 0 &&
      this.lines[i - 1]?.wasm === undefined &&
      !this.isBranch(i - 1) &&
      !this.notes.has(i - 1)
    )
      i--;
    return i;
  }
  /** The first line from `after` on tied to a WebAssembly line that passes `test`, or -1. */
  first(test: (at: number) => boolean, after = 0) {
    return this.lines.findIndex((h, i) => i >= after && h.wasm !== undefined && test(h.wasm));
  }
  note(at: number, why: Why) {
    add(this.notes, at, why);
  }
}

/** V8's check at each turn of a loop: a branch, before line `main`, to a rare path that comes from the `loop` line. */
function loopCheck(h: Host, main: number) {
  for (let i = 1; i < main; i++) {
    const to = h.isBranch(i) ? h.target(i) : undefined;
    if (to !== undefined && to >= main && isLoop(h.from(to)?.text)) return h.note(i - 1, { kind: 'hostLoop' });
  }
}

/**
 * On Linux, V8 on AArch64 checks a store's bounds itself: the size less the access's end, a compare, a branch. A note at
 * the first; returns the lines of every check and of the store it guards.
 */
function boundsChecks(h: Host, main: number) {
  const checked = new Set<number>();
  for (let i = 0; i + 2 < main; i++) {
    const size = /^sub (x\d+), x\d+, #0x[0-9a-f]+ \(\d+\)$/.exec(h.text(i))?.[1];
    if (!size || !new RegExp(`^cmp x\\d+, ${size}$`).test(h.text(i + 1)) || !h.text(i + 2).startsWith('b.hs '))
      continue;
    if (!checked.size) h.note(i, { kind: 'hostBounds' });
    for (const k of [i, i + 1, i + 2, i + 3]) checked.add(k);
  }
  return checked;
}

/** What stays unlit after an instruction's own access: a run of six lines or more that V8 ties to nothing. */
function unlitRuns(h: Host, main: number, checked: Set<number>) {
  const free = (i: number) => h.lines[i]?.wasm === undefined && !h.notes.has(i) && !checked.has(i);
  for (let i = 1; i < main; i++) {
    const before = h.from(i - 1);
    if (!free(i) || before?.part !== 'body' || before.cold) continue;
    let end = i;
    while (end < main && free(end)) end++;
    if (end - i >= 6) h.note(i, { kind: 'hostGray' });
    i = end;
  }
}

/** The ways out of the block in the code that normally runs (before line `main`): its stores, and the next block's lookup. */
function wayOut(c: Capture, h: Host, main: number) {
  const { notes: wasm, chain } = wasmNotes(c);
  const inMain = (i: number) => i > 0 && i < main;
  const stored = [...wasm]
    .filter(([, list]) => list.some((n) => n.kind === 'back' || n.kind === 'pcBack'))
    .map(([at]) => at);
  const exit = h.first((at) => c.wasm[at]?.part === 'exit' && stored.some((s) => at >= s && at <= s + 2));
  if (inMain(exit)) h.note(h.runStart(exit), { kind: 'hostExit' });
  const next = chain ? h.first((at) => at >= chain[0] && at <= chain[1]) : -1;
  if (inMain(next)) h.note(h.runStart(next), { kind: 'hostChain' });
}

/** The host's notes for `arch`. V8 ties a line to a WebAssembly line only for loads, stores and calls: the rules go by those, and by where branches lead. */
export function hostNotes(c: Capture, arch: HostArch): Notes {
  const h = new Host(c, arch);
  if (!h.lines.length) return h.notes;
  const part = (at: number) => c.wasm[at]?.part;
  // V8's preamble, up to the first line that comes from the WebAssembly.
  h.note(0, { kind: 'hostEntry' });
  const regs = h.first((at) => part(at) === 'prologue' && !isLoop(c.wasm[at]?.text));
  if (regs > 0) h.note(h.runStart(regs), { kind: 'hostRegs' });
  // The rare paths: V8 puts them last, and the first are its own checks' calls (the stack's, which comes from the
  // function's first line, or a loop's, which comes from the `loop` line).
  const rare = h.first((at) => part(at) === 'sig' || isLoop(c.wasm[at]?.text));
  const main = rare < 0 ? h.lines.length : rare;
  loopCheck(h, main);
  // A TLB check: the first host line of each instruction's check.
  for (const [start, end] of wasmNotes(c).probes.values()) {
    const i = h.first((at) => at >= start && at <= end);
    if (i > 0 && i < main) h.note(h.runStart(i, 6), { kind: 'hostTlb' });
  }
  const checked = arch === 'arm64' ? boundsChecks(h, main) : new Set<number>();
  wayOut(c, h, main);
  if (rare > 0) {
    h.note(rare, { kind: 'hostRare' });
    const slow = h.first((at) => !!c.wasm[at]?.cold, rare);
    if (slow > 0) h.note(h.runStart(slow, 6), { kind: 'hostSlow' });
  }
  unlitRuns(h, main, checked);
  return h.notes;
}
