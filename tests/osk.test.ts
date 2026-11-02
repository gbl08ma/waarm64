// The on-screen keyboard's keys (web/app/osk.ts): its layout, and pointers on its keys as a real keyboard's downs and
// ups: each pointer holds its key, fingers chord, a modifier tapped alone is latched for the next key (or until tapped
// again), one held alone or with another key is released when let go.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEIGHT, HOLD_MS, keyOf, KEYS, legends, MODIFIERS, OskKeys, WIDTH, type ModifierMode } from '../web/app/osk.ts';

/** An `OskKeys` on a clock the test moves, and what it sent (`+code` down, `-code` up). */
function keyboard(mode: ModifierMode = 'next') {
  let now = 0;
  const sent: string[] = [];
  const k = new OskKeys((code, down) => sent.push(`${down ? '+' : '-'}${code}`), mode, () => now);
  const take = () => sent.splice(0);
  return { k, take, wait: (ms: number) => { now += ms; } };
}

test('the layout: 104 keys, every one a key the guest knows, none overlapping, all inside', async () => {
  assert.equal(KEYS.length, 104);
  assert.equal(new Set(KEYS.map((k) => k.code)).size, 104);
  const { codeOf } = await import('../web/input.ts');
  for (const k of KEYS) {
    assert.ok(codeOf(k.code) !== undefined, `${k.code}: a Linux keycode`);
    assert.ok(k.x >= 0 && k.y >= 0 && k.x + k.w <= WIDTH && k.y + k.h <= HEIGHT, `${k.code} inside`);
  }
  for (const a of KEYS) for (const b of KEYS) {
    if (a === b) continue;
    const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    assert.ok(apart, `${a.code} and ${b.code} overlap`);
  }
  for (const m of MODIFIERS) assert.ok(KEYS.some((k) => k.code === m), m);
  assert.deepEqual(legends('Digit1'), { top: '!', main: '1' });
  assert.deepEqual(legends('KeyQ'), { main: 'Q' });
  assert.equal(legends('Enter'), undefined);
  assert.equal(keyOf('KeyA', false), 'a');
  assert.equal(keyOf('KeyA', true), 'A');
  assert.equal(keyOf('Digit2', true), '@');
  assert.equal(keyOf('ArrowUp', false), 'ArrowUp');
  assert.equal(keyOf('NumpadEnter', false), 'Enter');
});

test('a key is held by its pointer, down to up; two fingers on two keys chord as their touches go', () => {
  const { k, take } = keyboard();
  k.press(1, 'KeyA');
  assert.deepEqual(take(), ['+KeyA']);
  assert.equal(k.state('KeyA'), 'held');
  k.release(1);
  assert.deepEqual(take(), ['-KeyA']);
  assert.equal(k.state('KeyA'), undefined);
  // Interleaved: A down, B down, A up, B up.
  k.press(1, 'KeyA');
  k.press(2, 'KeyB');
  k.release(1);
  k.release(2);
  assert.deepEqual(take(), ['+KeyA', '+KeyB', '-KeyA', '-KeyB']);
  // Two fingers on one key: one down, one up when the last lifts.
  k.press(1, 'Space');
  k.press(2, 'Space');
  k.release(1);
  assert.deepEqual(take(), ['+Space']);
  k.release(2);
  assert.deepEqual(take(), ['-Space']);
  // A pointer released twice (pointerup, then pointercancel) or never pressed: nothing.
  k.release(2);
  k.release(9);
  assert.deepEqual(take(), []);
});

test('a modifier tapped alone is latched until the next key is released; tapped again before it, it is let go', () => {
  const { k, take } = keyboard('next');
  // Ctrl+Alt+F1 by taps: Ctrl and Alt stay down until F1 is released.
  k.press(1, 'ControlLeft'); k.release(1);
  k.press(1, 'AltLeft'); k.release(1);
  assert.deepEqual(take(), ['+ControlLeft', '+AltLeft']);
  assert.equal(k.state('ControlLeft'), 'latched');
  k.press(1, 'F1');
  k.release(1);
  assert.deepEqual(take(), ['+F1', '-F1', '-AltLeft', '-ControlLeft']);
  assert.equal(k.state('ControlLeft'), undefined);
  // Ctrl tapped twice: deselected.
  k.press(1, 'ControlLeft'); k.release(1);
  k.press(1, 'ControlLeft'); k.release(1);
  assert.deepEqual(take(), ['+ControlLeft', '-ControlLeft']);
  // Latched Shift with two letters held together: released after the last one.
  k.press(1, 'ShiftLeft'); k.release(1);
  k.press(1, 'KeyA');
  k.press(2, 'KeyB');
  k.release(1);
  assert.deepEqual(take(), ['+ShiftLeft', '+KeyA', '+KeyB', '-KeyA']);
  assert.deepEqual(k.mods(), { shift: true, ctrl: false, alt: false, meta: false });
  k.release(2);
  assert.deepEqual(take(), ['-KeyB', '-ShiftLeft']);
});

test('a modifier held with another key, or alone past HOLD_MS, is released when let go', () => {
  const { k, take, wait } = keyboard('next');
  // Ctrl held by one finger, C tapped by another: Ctrl goes up when its finger lifts.
  k.press(1, 'ControlLeft');
  k.press(2, 'KeyC');
  k.release(2);
  assert.deepEqual(take(), ['+ControlLeft', '+KeyC', '-KeyC']);
  k.release(1);
  assert.deepEqual(take(), ['-ControlLeft']);
  assert.equal(k.state('ControlLeft'), undefined);
  // Shift held alone a while (a game's run): released, not latched.
  k.press(1, 'ShiftLeft');
  wait(HOLD_MS + 1);
  k.release(1);
  assert.deepEqual(take(), ['+ShiftLeft', '-ShiftLeft']);
  assert.equal(k.state('ShiftLeft'), undefined);
});

test('a modifier pressed while a key is held is held with it, not latched; a key typed elsewhere ends a latch', () => {
  const { k, take } = keyboard('toggle');
  k.press(1, 'Space');
  k.press(2, 'ShiftLeft');
  k.release(2);
  assert.deepEqual(take(), ['+Space', '+ShiftLeft', '-ShiftLeft']);
  assert.equal(k.state('ShiftLeft'), undefined);
  k.release(1);
  take();
  // A click elsewhere (the screen) while a finger holds Ctrl: Ctrl-click, released when the finger lifts.
  k.press(1, 'ControlLeft');
  k.used();
  k.release(1);
  assert.deepEqual(take(), ['+ControlLeft', '-ControlLeft']);
  // The physical keyboard's key: the end of a latch in the `next` mode, nothing in the `toggle` one.
  k.press(1, 'ControlLeft'); k.release(1);
  k.typed('KeyC');
  assert.equal(k.state('ControlLeft'), 'latched');
  k.mode = 'next';
  k.typed('ShiftLeft');
  assert.equal(k.state('ControlLeft'), 'latched', 'a modifier typed is no next key');
  k.typed('KeyC');
  assert.deepEqual(take(), ['+ControlLeft', '-ControlLeft']);
  assert.equal(k.state('ControlLeft'), undefined);
});

test('the toggle mode: a tapped modifier stays down through keys until tapped again', () => {
  const { k, take } = keyboard('toggle');
  k.press(1, 'ControlLeft'); k.release(1);
  k.press(1, 'KeyC'); k.release(1);
  k.press(1, 'KeyV'); k.release(1);
  assert.deepEqual(take(), ['+ControlLeft', '+KeyC', '-KeyC', '+KeyV', '-KeyV']);
  assert.equal(k.state('ControlLeft'), 'latched');
  k.press(1, 'ControlLeft'); k.release(1);
  assert.deepEqual(take(), ['-ControlLeft']);
});

test('releaseAll lets everything go, held keys then latched modifiers; forget sends nothing', () => {
  const { k, take } = keyboard();
  k.press(1, 'AltLeft'); k.release(1);
  k.press(1, 'KeyA');
  take();
  k.releaseAll();
  assert.deepEqual(take(), ['-KeyA', '-AltLeft']);
  k.release(1); // its pointer lifts later: nothing
  assert.deepEqual(take(), []);
  k.press(1, 'AltLeft'); k.release(1);
  take();
  k.forget();
  assert.deepEqual(take(), []);
  assert.equal(k.state('AltLeft'), undefined);
});
