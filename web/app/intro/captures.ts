// The introduction's captured code (web/intro-captures/blocks.json, written by tools/intro-capture.ts: real guest
// blocks, the block interpreter's micro-ops for them, the WebAssembly our JIT emitted and the machine code V8 made of
// it): its shape, its load (when the deep dive opens: the file is an asset of the page's build, fetched then), and the rows
// the code panes draw (web/app/ui/CodePane.svelte). Nothing here is drawn by hand: a row is a line of the capture.
import type { CodeRow } from '../ui/code-pane.ts';

type WasmLine = {
  text: string;
  /** The function's head, what runs before a block's first instruction, an instruction's code, what leaves a block. */
  part: 'sig' | 'prologue' | 'body' | 'exit';
  block?: number;
  /** The guest instruction (an index into `guest`) the line was emitted for; with `guestTo`, the last of a span. */
  guest?: number;
  guestTo?: number;
  /** In a slow arm: the helper's call when the fast path's check fails. */
  cold?: true;
};
type HostLine = { offset: string; bytes: string; text: string; wasm?: number };
export type HostArch = 'x64' | 'arm64';
export type Capture = {
  id: string;
  /** The C the guest code was compiled from, and the compiler's line. */
  source: string;
  compiler: string;
  guest: { addr: string; bytes: string; text: string; block: number }[];
  uops: { text: string; bytes: string; guest?: number }[];
  wasm: WasmLine[];
  host: Partial<Record<HostArch, { compiler: string; lines: HostLine[] }>>;
};
export type Captures = { meta: { commit: string; date: string }; blocks: Capture[] };

/** The captures' file: an asset of the build under its hashed name, data and not a script. */
const CAPTURES = new URL('../../intro-captures/blocks.json', import.meta.url).href;

/** The captures, fetched once (a failed fetch is tried again by the next call). */
let loaded: Promise<Captures> | undefined;
export function loadCaptures(): Promise<Captures> {
  loaded ??= fetch(CAPTURES)
    .then((r) => {
      if (!r.ok) throw new Error(`${CAPTURES}: ${r.status}`);
      return r.json() as Promise<Captures>;
    })
    .catch((e: unknown) => {
      loaded = undefined;
      throw e;
    });
  return loaded;
}

/** The guest's instructions: the address, then the instruction. A region's later blocks start after a gap. */
export const guestRows = (c: Capture): CodeRow[] =>
  c.guest.map((g, i) => ({ gutter: g.addr, text: g.text, group: i, gap: i > 0 && g.block !== c.guest[i - 1]?.block }));

/** The block interpreter's micro-ops: their 8 bytes, then their fields. A constant's slot belongs to no instruction. */
export const uopRows = (c: Capture): CodeRow[] =>
  c.uops.map((u) => ({ gutter: u.bytes, text: u.text, group: u.guest }));

/** What a fold of the WebAssembly holds, for its label. */
export type FoldKind = 'prologue' | 'slow' | 'exit';
export type WasmItem = CodeRow | { fold: FoldKind; rows: CodeRow[]; group?: number };

/**
 * The emitted function's lines: an instruction's own code as rows, and what surrounds it folded (what runs before a
 * block's first instruction, a slow arm, what leaves a block). The indentation the function's nesting gives every
 * line is kept: it is the text as wasm-tools prints it.
 */
export function wasmItems(c: Capture): WasmItem[] {
  const items: WasmItem[] = [];
  const kind = (l: WasmLine): FoldKind | undefined =>
    l.part === 'prologue' ? 'prologue' : l.part === 'exit' ? 'exit' : l.cold ? 'slow' : undefined;
  let run: { fold: FoldKind; rows: CodeRow[]; group?: number; line: WasmLine } | undefined;
  for (const l of c.wasm) {
    const row: CodeRow = { text: l.text, group: l.part === 'body' ? l.guest : undefined };
    const k = kind(l);
    if (!k) {
      run = undefined;
      items.push(row);
    } else if (run?.fold === k && run.line.block === l.block && run.line.guest === l.guest) run.rows.push(row);
    else {
      run = { fold: k, rows: [row], group: k === 'slow' ? l.guest : undefined, line: l };
      items.push(run);
    }
  }
  return items;
}

/**
 * The lines of `c`'s function that light for instruction `g`: its own rows and its slow arm's fold (`wasmItems` gives a
 * line to the instruction it starts at, so a count by spans would say more lines than are lit).
 */
export const wasmLinesOf = (c: Capture, g: number) => c.wasm.filter((l) => l.part === 'body' && l.guest === g).length;

/**
 * The host's machine code: the offset, then the instruction. V8 says which wasm instruction a load, a store or a call
 * came from, and no more: only those lines belong to a guest instruction.
 */
export function hostRows(c: Capture, arch: HostArch): CodeRow[] {
  return (c.host[arch]?.lines ?? []).map((h) => {
    const from = h.wasm === undefined ? undefined : c.wasm[h.wasm];
    return { gutter: h.offset, text: h.text, group: from?.part === 'body' && !from.cold ? from.guest : undefined };
  });
}

/** The bytes of the host's code for `c`. */
export const hostBytes = (c: Capture, arch: HostArch) =>
  (c.host[arch]?.lines ?? []).reduce((n, h) => n + h.bytes.length / 2, 0);
