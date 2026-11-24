// web/input.ts on a faked DOM, the parts that don't need a browser: the element's box as the pointer reads it
// (`boxCache`: read once, read again after anything that can move or resize it, its observers let go at detach), and a
// focus loss (the element's blur and the window's, one after the other) releasing once.
import assert from 'node:assert/strict';
import { test } from 'node:test';

type Fake = { window: EventTarget; document: EventTarget; observers: FakeObserver[] };
class FakeObserver {
  static all: FakeObserver[] = [];
  observed: unknown[] = [];
  f: () => void;
  constructor(f: () => void) {
    this.f = f;
    FakeObserver.all.push(this);
  }
  observe(t: unknown) {
    this.observed.push(t);
  }
  disconnect() {
    this.observed = [];
  }
}

/** Runs `f` with a faked `window`, `document` and `ResizeObserver`, then puts the real ones back. */
async function withDom(f: (dom: Fake) => Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, ResizeObserver: g.ResizeObserver };
  FakeObserver.all = [];
  const dom: Fake = {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { pointerLockElement: null, hidden: false }),
    observers: FakeObserver.all,
  };
  Object.assign(g, { window: dom.window, document: dom.document, ResizeObserver: FakeObserver });
  try {
    await f(dom);
  } finally {
    Object.assign(g, saved);
  }
}

/** An element whose box is `box`, counting its layout reads, under `parent`. */
const element = (box: { left: number; top: number; width: number; height: number }, parent?: unknown) => {
  const el: EventTarget & { reads: number; parentElement: unknown; getBoundingClientRect(): typeof box; setPointerCapture(): void } = Object.assign(new EventTarget(), {
    reads: 0,
    parentElement: parent ?? null,
    getBoundingClientRect() {
      el.reads++;
      return { ...box };
    },
    setPointerCapture() {},
  });
  return el;
};

test("web/input.ts's box: read once, again after a resize (the element's or its ancestors'), a scroll, the window's resize, fullscreen or stale(); nothing watched after detach", async () => {
  await withDom(async ({ window, document, observers }) => {
    const { boxCache } = await import('../web/input.ts');
    const grand = { parentElement: null };
    const parent = { parentElement: grand };
    const box = { left: 10, top: 20, width: 100, height: 50 };
    const el = element(box, parent);
    const c = boxCache(el as unknown as HTMLElement);
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].observed, [el, parent, grand], 'the element and what positions it');
    assert.equal(c.get().left, 10);
    c.get();
    assert.equal(el.reads, 1, 'one layout read for two moves');
    const stales: [string, () => void][] = [
      ['ResizeObserver', () => observers[0].f()],
      ['window resize', () => window.dispatchEvent(new Event('resize'))],
      ['scroll', () => window.dispatchEvent(new Event('scroll'))],
      ['fullscreenchange', () => document.dispatchEvent(new Event('fullscreenchange'))],
      ['stale()', () => c.stale()],
    ];
    for (const [what, f] of stales) {
      const before: number = el.reads;
      box.left += 1;
      f();
      assert.equal(c.get().left, box.left, `${what}: the new box`);
      c.get();
      assert.equal(el.reads, before + 1, `${what}: read again once`);
    }
    c.detach();
    assert.deepEqual(observers[0].observed, [], 'the observer let go');
    c.get();
    const before = el.reads;
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('fullscreenchange'));
    c.get();
    assert.equal(el.reads, before, 'no listeners left after detach');
  });
});

test('web/input.ts reads the box again when a pointer enters or presses (the element may have moved unobserved: a transform)', async () => {
  await withDom(async () => {
    const { attachInput } = await import('../web/input.ts');
    const box = { left: 0, top: 0, width: 100, height: 100 };
    const el = element(box);
    const moves: number[][][] = [];
    const tablet = { postMessage: (m: number[][]) => moves.push(m) } as unknown as MessagePort;
    const input = attachInput(el as unknown as HTMLElement, { tablet });
    const ev = (type: string, x: number, buttons = 0) =>
      el.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: 50, buttons, pointerType: 'mouse', pointerId: 1, movementX: 0, movementY: 0 }));
    ev('pointerenter', 50);
    ev('pointermove', 50);
    ev('pointermove', 60);
    assert.equal(el.reads, 1, 'one read across the moves');
    box.left = 50; // moved without resizing
    ev('pointerdown', 100, 1);
    assert.equal(moves.at(-1)![0][2], Math.round(0.5 * 32767), 'the click at the moved box');
    assert.deepEqual(moves.at(-1)!.at(-1), [0, 0, 0], 'SYN last');
    assert.equal(el.reads, 2);
    input.detach();
  });
});

test("web/input.ts: a focus loss (the element's blur, then the window's) releases once; a blur with nothing held releases nothing", async () => {
  await withDom(async ({ window }) => {
    const { attachInput } = await import('../web/input.ts');
    const el = element({ left: 0, top: 0, width: 100, height: 100 });
    const keys: number[][][] = [];
    const keyboard = { postMessage: (m: number[][]) => keys.push(m) } as unknown as MessagePort;
    const usb: string[] = [];
    const input = attachInput(el as unknown as HTMLElement, {
      keyboard,
      text: { live: () => true, send: () => {}, usb: (code) => (usb.push(code), false) },
    });
    let released = 0;
    input.onRelease(() => released++);
    const key = (type: string, code: string) =>
      el.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, key: code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false }));
    key('keydown', 'KeyA');
    el.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('blur'));
    assert.equal(released, 1, 'onRelease once');
    assert.deepEqual(usb, [''], "the USB keyboard's release once");
    assert.equal(keys.length, 2, 'A down, A up');
    el.dispatchEvent(new Event('blur'));
    assert.equal(released, 1, 'nothing held: nothing released');
    input.release();
    assert.equal(released, 2, 'release() releases whatever is held');
    input.detach();
  });
});
