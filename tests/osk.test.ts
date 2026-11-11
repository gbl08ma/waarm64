// The on-screen keyboard's keys (web/app/osk.ts): its layout, and pointers on its keys as a real keyboard's downs and
// ups: each pointer holds its key, fingers chord, a modifier tapped alone is latched for the next key (or until tapped
// again), one held alone or with another key is released when let go, the last key held repeats; the layouts' keys and
// legends for each keymap.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventOf, HOLD_MS, keyOf, legends, MODIFIERS, OskKeys, REPEAT_DELAY_MS, REPEAT_MS, type ModifierMode, type Mods } from '../web/app/osk.ts';
import { autoLayout, COMPACT_BELOW, IME_KEYS, letterRows, COMPACT_HEIGHT, COMPACT_WIDTH, fullKeys, HEIGHT, keymapOf, KEYS, layoutOf, pages, PAGES, WIDTH, type Key } from '../web/app/osk-layout.ts';
import { KEYMAPS } from '../web/app/keymaps.ts';

/** An `OskKeys` on a clock the test moves (its timers too), and what it sent (`+code` down, `-code` up, `*code` a repeat). */
function keyboard(mode: ModifierMode = 'next') {
  let now = 0;
  const sent: string[] = [];
  const timers = new Map<number, { at: number; f: () => void }>();
  let next = 0;
  const clock = { set: (f: () => void, ms: number) => (timers.set(++next, { at: now + ms, f }), next), clear: (id: unknown) => void timers.delete(id as number) };
  const k = new OskKeys((code, down, repeat) => sent.push(`${repeat ? '*' : down ? '+' : '-'}${code}`), mode, () => now, clock);
  const take = () => sent.splice(0);
  /** Moves the clock by `ms`, firing the timers due on the way, in order. */
  const wait = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].f();
    }
    now = end;
  };
  return { k, take, wait, pending: () => timers.size };
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

/** Asserts that keys `ks` don't overlap. */
function apart(ks: Key[]) {
  for (const a of ks) for (const b of ks) {
    if (a === b) continue;
    const ok = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    assert.ok(ok, `${a.code} and ${b.code} overlap`);
  }
}

test('the compact layout: pages of 10u by 5, full, every key of the full layout on one, Shift, Ctrl and Alt on several', () => {
  assert.deepEqual(PAGES.map((p) => p.id), ['main', 'symbols', 'fn', 'keypad']);
  const all = new Set<string>();
  for (const p of PAGES) {
    assert.equal(new Set(p.keys.map((k) => k.code)).size, p.keys.length, `${p.id}: a key once`);
    for (const k of p.keys) {
      assert.ok(k.x >= 0 && k.y >= 0 && k.x + k.w <= COMPACT_WIDTH + 1e-9 && k.y + k.h <= COMPACT_HEIGHT, `${p.id} ${k.code} inside`);
      all.add(k.code);
    }
    apart(p.keys);
    // Each row reaches the right edge, or a key short of it (the arrows' inverted T).
    for (let y = 0; y < COMPACT_HEIGHT; y++) {
      const right = Math.max(...p.keys.filter((k) => k.y <= y && y < k.y + k.h).map((k) => k.x + k.w));
      assert.ok(right >= COMPACT_WIDTH - 1 - 1e-9, `${p.id} row ${y} reaches the edge: ${right}`);
    }
  }
  assert.deepEqual([...all].sort(), KEYS.map((k) => k.code).sort());
  for (const c of ['ShiftLeft', 'ControlLeft', 'AltLeft', 'Backspace', 'Escape', 'Tab']) {
    assert.ok(PAGES.filter((p) => p.keys.some((k) => k.code === c)).length >= 3, `${c} on three pages at least`);
  }
});

test('every layout: the full keyboard with its extra keys, none overlapping; the compact pages hold the same keys', async () => {
  const { codeOf } = await import('../web/input.ts');
  const ids = Object.keys(KEYMAPS);
  const { KEYBOARD_LAYOUTS } = await import('../web/app/keyboard.ts');
  assert.deepEqual(ids.sort(), KEYBOARD_LAYOUTS.map((l) => l.id).sort(), 'a keymap for every layout the setting offers (node tools/osk-keymaps.ts)');
  for (const id of ids) {
    const map = keymapOf(id);
    const full = fullKeys(map);
    apart(full);
    for (const k of full) {
      assert.ok(codeOf(k.code) !== undefined, `${id} ${k.code}: a Linux keycode`);
      assert.ok(k.x >= 0 && k.x + k.w <= WIDTH + 1e-9 && k.y + k.h <= HEIGHT, `${id} ${k.code} inside`);
    }
    const extra = [...['IntlBackslash', 'IntlRo', 'IntlYen'].filter((c) => map[c]), ...(map.IntlYen ? IME_KEYS : [])];
    assert.equal(full.length, 104 + extra.length, id);
    const all = new Set<string>();
    for (const p of pages(map)) {
      apart(p.keys);
      for (const k of p.keys) {
        assert.ok(k.x >= 0 && k.x + k.w <= COMPACT_WIDTH + 1e-9 && k.y + k.h <= COMPACT_HEIGHT, `${id} ${p.id} ${k.code} inside`);
        all.add(k.code);
      }
    }
    assert.deepEqual([...all].sort(), full.map((k) => k.code).sort(), id);
    // Each page's rows reach its right edge (a key short of it at most: the arrows' inverted T), and the letters' page
    // holds every key whose unshifted character is a letter with a capital.
    for (const p of pages(map)) for (let y = 0; y < COMPACT_HEIGHT; y++) {
      const right = Math.max(...p.keys.filter((k) => k.y <= y && y < k.y + k.h).map((k) => k.x + k.w));
      assert.ok(right >= COMPACT_WIDTH - 1 - 1e-9, `${id} ${p.id} row ${y}: ${right}`);
    }
    const main = new Set(pages(map)[0].keys.map((k) => k.code));
    for (const k of full) {
      const c = map[k.code]?.[0];
      if (c && /^\p{Ll}$/u.test(c) && c.toUpperCase().toLowerCase() === c) assert.ok(main.has(k.code), `${id} ${k.code} (${c}) on the letters' page`);
    }
    // Every character key has a legend (JIS's Backquote, Hankaku/Zenkaku, none).
    for (const k of full) if (!MODIFIERS.has(k.code) && /^(Key|Digit|Intl)/.test(k.code)) assert.ok(legends(k.code, map)?.main, `${id} ${k.code}`);
  }
  assert.deepEqual(fullKeys(keymapOf('us')).map((k) => k.code), KEYS.map((k) => k.code));
  assert.equal(keymapOf(undefined), keymapOf('us'));
  assert.equal(keymapOf('nonesuch'), keymapOf('us'));
  assert.ok(fullKeys(keymapOf('de')).some((k) => k.code === 'IntlBackslash'));
  assert.ok(fullKeys(keymapOf('jp')).some((k) => k.code === 'IntlYen'));
  assert.ok(fullKeys(keymapOf('br')).some((k) => k.code === 'IntlRo'));
  assert.ok(!fullKeys(keymapOf('us-dvorak')).some((k) => k.code === 'IntlBackslash'));
});

test('the compact letters\' page per layout: German\'s Ü, Ö and Ä beside the letters, Turkish\'s Ö and Ç beside M; JIS\'s input-method keys', () => {
  const us = letterRows(keymapOf('us'));
  assert.deepEqual(us.map((r) => r.length), [10, 10, 10, 7]);
  assert.equal(us[2].at(-1), 'Semicolon');
  const de = letterRows(keymapOf('de'));
  assert.deepEqual(de[1].slice(-1), ['BracketLeft']);
  assert.deepEqual(de[2].slice(-3), ['KeyL', 'Semicolon', 'Quote']);
  assert.deepEqual(de[0].length, 10, 'ß (no capital) stays with the symbols');
  assert.deepEqual(letterRows(keymapOf('tr'))[3].slice(-2), ['Comma', 'Period']);
  assert.deepEqual(letterRows(keymapOf('hu'))[2].slice(-2), ['Quote', 'Backslash'], 'ISO\'s Backslash on the home row');
  assert.deepEqual(letterRows(keymapOf('hu'))[3][0], 'IntlBackslash');
  assert.deepEqual(letterRows(keymapOf('fr'))[2].slice(-2), ['Semicolon', 'Quote']);
  const de2 = pages(keymapOf('de'));
  const sym = de2.find((p) => p.id === 'symbols')!.keys.map((k) => k.code);
  assert.ok(!sym.includes('Quote') && !sym.includes('BracketLeft') && sym.includes('Minus') && sym.includes('IntlBackslash'));
  // JIS: Muhenkan left of Space, Henkan and Katakana/Hiragana right; on the symbols' page compact. None elsewhere.
  const jp = fullKeys(keymapOf('jp')).filter((k) => k.y === 5.5).map((k) => k.code);
  assert.deepEqual(jp.slice(0, 11), ['ControlLeft', 'MetaLeft', 'AltLeft', 'NonConvert', 'Space', 'Convert', 'KanaMode', 'AltRight', 'MetaRight', 'ContextMenu', 'ControlRight']);
  assert.equal(fullKeys(keymapOf('jp')).find((k) => k.code === 'ArrowLeft')!.x, KEYS.find((k) => k.code === 'ArrowLeft')!.x);
  for (const c of IME_KEYS) assert.ok(pages(keymapOf('jp')).find((p) => p.id === 'symbols')!.keys.some((k) => k.code === c), c);
  for (const id of Object.keys(KEYMAPS)) if (id !== 'jp') assert.ok(!fullKeys(keymapOf(id)).some((k) => IME_KEYS.includes(k.code)), id);
  assert.equal(eventOf('Convert', { shift: false, ctrl: false, alt: false, meta: false, altGr: false }, keymapOf('jp')).key, 'Convert');
});

test('a layout\'s legends and characters: German, French, Dvorak; AltGr as the right Alt where a key has a third level', () => {
  const de = keymapOf('de'), fr = keymapOf('fr'), dv = keymapOf('us-dvorak');
  assert.deepEqual(legends('KeyY', de), { main: 'Z', alt: '←' });
  assert.deepEqual(legends('KeyQ', de), { main: 'Q', alt: '@' });
  assert.deepEqual(legends('Semicolon', de), { main: 'Ö', alt: '˝' });
  assert.deepEqual(legends('Digit7', de), { top: '/', main: '7', alt: '{' });
  assert.deepEqual(legends('IntlBackslash', de), { top: '>', main: '<', alt: '|' });
  assert.deepEqual(legends('Digit1', fr), { top: '1', main: '&', alt: '¹' });
  assert.deepEqual(legends('KeyQ', fr), { main: 'A', alt: 'æ' });
  assert.equal(keyOf('KeyY', false, de), 'z');
  assert.equal(keyOf('Semicolon', true, de), 'Ö');
  assert.equal(keyOf('KeyQ', false, de, true), '@');
  assert.equal(keyOf('KeyE', false, de, true), '€');
  assert.equal(keyOf('KeyS', false, dv), 'o');
  assert.equal(keyOf('Numpad5', true, de), '5');
  assert.equal(keyOf('NumpadEnter', false, de), 'Enter');
  assert.equal(keyOf('Space', false, de), ' ');
  const m = (o: Partial<Mods>): Mods => ({ shift: false, ctrl: false, alt: false, meta: false, altGr: false, ...o });
  assert.deepEqual(eventOf('KeyQ', m({ altGr: true }), de), { key: '@', ctrlKey: false, altKey: false, metaKey: false });
  // A key without a third level, or a layout without any (US): the right Alt is Alt.
  assert.deepEqual(eventOf('KeyX', m({ altGr: true }), keymapOf('us')), { key: 'x', ctrlKey: false, altKey: true, metaKey: false });
  assert.deepEqual(eventOf('KeyA', m({ alt: true, shift: true }), de), { key: 'A', ctrlKey: false, altKey: true, metaKey: false });
});

test('the last key held repeats after REPEAT_DELAY_MS, every REPEAT_MS; a modifier doesn\'t; a release or another key stops it', () => {
  const { k, take, wait, pending } = keyboard();
  k.press(1, 'KeyA');
  wait(REPEAT_DELAY_MS - 1);
  assert.deepEqual(take(), ['+KeyA']);
  wait(1 + 2 * REPEAT_MS);
  assert.deepEqual(take(), ['*KeyA', '*KeyA', '*KeyA']);
  // Another key pressed: it repeats, the first stops.
  k.press(2, 'KeyB');
  wait(REPEAT_DELAY_MS);
  assert.deepEqual(take(), ['+KeyB', '*KeyB']);
  k.release(2);
  wait(REPEAT_DELAY_MS * 2);
  assert.deepEqual(take(), ['-KeyB']);
  k.release(1);
  assert.deepEqual(take(), ['-KeyA']);
  assert.equal(pending(), 0);
  // A modifier held alone doesn't repeat; a key held with it does.
  k.press(1, 'ShiftLeft');
  wait(REPEAT_DELAY_MS * 2);
  assert.deepEqual(take(), ['+ShiftLeft']);
  k.press(2, 'Digit1');
  wait(REPEAT_DELAY_MS);
  k.releaseAll();
  assert.deepEqual(take(), ['+Digit1', '*Digit1', '-Digit1', '-ShiftLeft']);
  assert.equal(pending(), 0);
  k.press(1, 'KeyC');
  k.forget();
  assert.equal(pending(), 0);
});

test('the layout chosen: compact below the threshold, forced either way', () => {
  assert.equal(autoLayout(COMPACT_BELOW - 1), 'compact');
  assert.equal(autoLayout(COMPACT_BELOW), 'full');
  assert.equal(layoutOf(400, undefined), 'compact');
  assert.equal(layoutOf(400, 'full'), 'full');
  assert.equal(layoutOf(1400, 'compact'), 'compact');
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
  assert.deepEqual(k.mods(), { shift: true, ctrl: false, alt: false, meta: false, altGr: false });
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
