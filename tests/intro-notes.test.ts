// The notes of the introduction's code viewer (web/app/intro/notes.ts; docs/frontend.md "The captures") over the
// committed captures: each rule finds its shape where the capture has it, a note names the registers the lines after
// it really load or store, the host's notes say what holds for that processor (bounds checks on AArch64 as captured on
// Linux, none on x86-64), and every kind has its words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Captures, HostArch } from '../web/app/intro/captures.ts';
import { hostNotes, wasmNotes, type WhyKind } from '../web/app/intro/notes.ts';

const { blocks } = JSON.parse(readFileSync(new URL('../web/intro-captures/blocks.json', import.meta.url), 'utf8')) as Captures;
const catalog = JSON.parse(readFileSync(new URL('../web/messages/en/intro.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const text = (c: (typeof blocks)[number], i: number) => c.wasm[i]?.text.trim() ?? '';

test("the WebAssembly's notes: the function, the registers by their offsets, a TLB check with its hit and its miss, the way out", () => {
  for (const c of blocks) {
    const { notes, probes } = wasmNotes(c);
    const kinds = [...notes.values()].flat().map((n) => n.kind);
    const at = (kind: WhyKind) => [...notes].filter(([, list]) => list.some((n) => n.kind === kind)).map(([i]) => i);
    assert.deepEqual(at('sig'), [0], `${c.id}: the function's note`);
    assert.equal(at('pc').length, 1, `${c.id}: the program counter is loaded once`);
    assert.equal(text(c, at('pc')[0]! + 1), 'i64.load offset=256');
    assert.equal(at('ret').length, 1, `${c.id}: one note for the return`);
    assert.ok(kinds.includes('back'), `${c.id}: registers are stored on the way out`);
    // The registers a note names are those the lines after it move, each a `local.get 0`, an access at 8 × its number, a local.
    for (const [i, list] of notes)
      for (const n of list) {
        if (n.kind !== 'regs' && n.kind !== 'back') continue;
        assert.ok(n.regs?.length, `${c.id}: a note of registers names some`);
        assert.equal(new Set(n.regs).size, n.regs.length, `${c.id}: a register named twice`);
        const first = Number(/^x(\d+)$/.exec(n.regs[0]!)?.[1]) * 8;
        assert.equal(text(c, i), 'local.get 0');
        assert.equal(text(c, i + (n.kind === 'regs' ? 1 : 2)), `i64.${n.kind === 'regs' ? 'load' : 'store'}${first ? ` offset=${first}` : ''}`, `${c.id}: line ${i} moves ${n.regs[0]}`);
      }
    // An instruction with a slow arm has the three notes of a memory access, in the order of its lines.
    const cold = new Set(c.wasm.filter((l) => l.cold).map((l) => l.guest));
    assert.equal(probes.size, cold.size, `${c.id}: a TLB check for each instruction with a slow arm`);
    assert.equal(at('tlb').length, cold.size);
    assert.equal(at('hit').length, cold.size);
    assert.equal(at('miss').length, cold.size);
    for (const i of at('miss')) assert.ok(c.wasm[i]?.cold && !c.wasm[i - 1]?.cold, `${c.id}: the miss's note starts the slow arm`);
    for (const i of at('hit')) assert.match(text(c, i - 1), /^if\b/, `${c.id}: the hit's note follows the check's branch`);
    for (const i of at('chain')) assert.ok(c.wasm.slice(i).findIndex((l) => /return_call_indirect/.test(l.text)) < 48, `${c.id}: the next block's note is near its call`);
    for (const [i] of notes) assert.ok(i >= 0 && i < c.wasm.length);
  }
});

test("the host's notes: V8's preamble, the registers, the rare paths; bounds checks on AArch64 (Linux) and none on x86-64", () => {
  for (const c of blocks)
    for (const arch of ['x64', 'arm64'] as HostArch[]) {
      const lines = c.host[arch]?.lines;
      if (!lines) continue;
      const notes = hostNotes(c, arch);
      const at = (kind: WhyKind) => [...notes].filter(([, list]) => list.some((n) => n.kind === kind)).map(([i]) => i);
      const where = `${c.id} ${arch}`;
      assert.deepEqual(at('hostEntry'), [0], where);
      assert.equal(at('hostRegs').length, 1, `${where}: the registers' loads`);
      assert.equal(at('hostRare').length, 1, `${where}: where the rare paths start`);
      const rare = at('hostRare')[0]!;
      for (const [i, list] of notes) {
        assert.ok(i >= 0 && i < lines.length);
        assert.equal(new Set(list.map((n) => n.kind)).size, list.length, `${where}: a note twice before line ${i}`);
        for (const n of list) if (n.kind !== 'hostRare' && n.kind !== 'hostSlow') assert.ok(i < rare, `${where}: ${n.kind} among the rare paths`);
      }
      // What the note says of bounds checks is what the code has: a compare with the memory's size before a store.
      const checks = lines.filter((l, i) => /^sub x\d+, x\d+, #0x/.test(l.text) && /^cmp /.test(lines[i + 1]?.text ?? '') && /^b\.hs /.test(lines[i + 2]?.text ?? '')).length;
      if (arch === 'arm64') {
        assert.ok(checks > 0, `${where}: the capture has bounds checks`);
        assert.equal(at('hostBounds').length, 1, `${where}: said once, at the first`);
        assert.match(lines[at('hostBounds')[0]! + 3]?.text ?? '', /^str /, `${where}: the check guards a store`);
      } else {
        assert.equal(at('hostBounds').length, 0, `${where}: no bounds check to explain`);
      }
      // A loop's check is said where a branch leads to the path V8 ties to the `loop` line.
      const loops = c.wasm.some((l) => /^\s*loop\b/.test(l.text));
      assert.equal(at('hostLoop').length, loops ? 1 : 0, `${where}: a loop's check`);
      // An unlit run's note stands before lines that light for no instruction.
      for (const i of at('hostGray')) for (let k = i; k < i + 6; k++) assert.equal(lines[k]?.wasm, undefined, `${where}: line ${k} has a WebAssembly line of its own`);
    }
});

test('every kind of note has its words', () => {
  const kinds = new Set<string>();
  for (const c of blocks) {
    for (const list of wasmNotes(c).notes.values()) for (const n of list) kinds.add(n.kind);
    for (const arch of ['x64', 'arm64'] as HostArch[]) for (const list of hostNotes(c, arch).values()) for (const n of list) kinds.add(n.kind === 'hostEntry' || n.kind === 'hostRegs' ? `${n.kind}.${arch}` : n.kind);
  }
  for (const k of kinds) assert.ok(`IntroTranslate.why.${k}` in catalog, `no words for ${k}`);
  // And the captures show every kind the viewer has words for: a kind no capture shows is a rule that stopped matching.
  const worded = Object.keys(catalog).filter((k) => k.startsWith('IntroTranslate.why.')).map((k) => k.slice('IntroTranslate.why.'.length));
  assert.deepEqual(worded.filter((k) => !kinds.has(k)), [], 'kinds with words that no capture shows');
});
