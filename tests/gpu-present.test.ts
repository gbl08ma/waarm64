// The presenter's cursor messages (web/gpu-present.ts): what the page turns into the canvas's CSS cursor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasPresenter, type DisplayToPage } from '../web/gpu-present.ts';

function rig() {
  const sent: DisplayToPage[] = [];
  const ctx = { putImageData() {}, fillRect() {} };
  const canvas = { width: 0, height: 0, getContext: (type: string) => (type === '2d' ? ctx : null) } as unknown as OffscreenCanvas;
  const port = { postMessage: (m: DisplayToPage) => sent.push(m) } as unknown as MessagePort;
  return { hooks: canvasPresenter(canvas, port), sent };
}

test('presenter: the cursor goes to the page when its image or hotspot changes, its moves as positions', () => {
  const { hooks, sent } = rig();
  const img = new Uint8Array(64 * 64 * 4).fill(7);
  hooks.cursor!(img, 3, 4, 10, 10);
  hooks.cursor!(img, 3, 4, 50, 60); // a move
  hooks.cursor!(img, 3, 4, 50, 60); // not a move
  hooks.cursor!(img, 3, 4, 51, 61);
  assert.deepEqual(sent.map((m) => m.type), ['cursor', 'cursor-at', 'cursor-at']);
  const m = sent[0] as Extract<DisplayToPage, { type: 'cursor' }>;
  assert.deepEqual([m.hotX, m.hotY, m.x, m.y, (m.image as ArrayBuffer).byteLength, new Uint8Array(m.image as ArrayBuffer)[0]], [3, 4, 10, 10, 64 * 64 * 4, 7]);
  assert.deepEqual(sent[2], { type: 'cursor-at', x: 51, y: 61 });
  img.fill(0); // the message holds a copy
  assert.equal(new Uint8Array(m.image as ArrayBuffer)[0], 7);
  hooks.cursor!(img, 5, 4, 51, 61); // another hotspot
  assert.equal(sent.length, 4);
  assert.equal(sent[3].type, 'cursor');
});

test('presenter: hidden by the guest (null) and never set (undefined, after a reset) differ', () => {
  const { hooks, sent } = rig();
  hooks.cursor!(null, 0, 0, 0, 0);
  hooks.cursor!(null, 0, 0, 9, 9); // a hidden cursor's move: nothing to draw
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { image: unknown }).image, null);
  hooks.cursorReset!();
  assert.equal(sent.length, 2);
  assert.equal((sent[1] as { image: unknown }).image, undefined);
});
