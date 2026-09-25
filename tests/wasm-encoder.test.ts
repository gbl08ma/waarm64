import assert from 'node:assert/strict';
import { test } from 'node:test';
import { I32, ModuleBuilder, op, sleb, uleb } from '../bench/spike/wasm.ts';

test('leb128', () => {
  assert.deepEqual(uleb(0), [0]);
  assert.deepEqual(uleb(624485), [0xe5, 0x8e, 0x26]);
  assert.deepEqual(sleb(-1), [0x7f]);
  assert.deepEqual(sleb(63), [0x3f]);
  assert.deepEqual(sleb(64), [0xc0, 0x00]);
  assert.deepEqual(sleb(-123456), [0xc0, 0xbb, 0x78]);
  assert.deepEqual(sleb(-(2n ** 63n)), [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f]);
});

test('builder emits a runnable module', () => {
  const m = new ModuleBuilder();
  const t = m.type([I32, I32], [I32]);
  m.exportFunc('add', m.func(t, [], [...op.localGet(0), ...op.localGet(1), ...op.i32Add]));
  const { add } = new WebAssembly.Instance(new WebAssembly.Module(m.bytes())).exports as { add: (a: number, b: number) => number };
  assert.equal(add(2, 40), 42);
});

test('multi-memory and memory64 encodings validate', () => {
  const m = new ModuleBuilder();
  m.importMemory('env', 'a', { min: 1 });
  m.importMemory('env', 'b', { min: 1, max: 2, shared: true, memory64: true });
  const t = m.type([], [I32]);
  m.func(t, [], [...op.i64Const(0), ...op.i32Load(0, 1)]);
  assert.ok(WebAssembly.validate(m.bytes()));
});
