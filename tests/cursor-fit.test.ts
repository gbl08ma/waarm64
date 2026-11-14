// The guest's cursor kept in the page's view (web/app/areas/cursor-fit.ts): the cursor list the page makes, put through
// Chromium's rule as Chromium 156 has it (blink's EventHandler::SelectCursor: an image cursor whose box, the pointer
// less the hotspot and the image's size in device pixels, isn't inside the visual viewport is skipped for the list's
// next entry), at every device pixel up to each edge, at whole and fractional densities. Chromium's own pick is
// observed in tests/page-cursor.test.ts; headless Chromium can't emulate a fractional device scale factor as a screen
// has it (Playwright's emulation leaves the layout in CSS pixels), so the densities are checked here. Pure, ~1 s.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUT_STEP, cursorBox, cursorCuts, cutImage, type CursorBox, type CutImage } from '../web/app/areas/cursor-fit.ts';

const DPRS = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];

// Chromium's rule for one image of the list (`dpr` the screen's scale and the image-set's density, the pointer at
// device pixel (px, py) of a viewport of vw×vh device pixels): the hotspot in whole CSS pixels scaled by the density,
// the image's size in device pixels, rounded down, both inside.
function chromiumShows(im: CutImage, px: number, py: number, vw: number, vh: number, dpr: number) {
  if (Math.ceil(im.width / dpr) > 128 || Math.ceil(im.height / dpr) > 128) return false;
  const [hx, hy] = [Math.round(Math.trunc(im.cssHotX) * dpr), Math.round(Math.trunc(im.cssHotY) * dpr)];
  const [x, y] = [px - hx, py - hy];
  const [w, h] = [Math.floor((im.width / dpr) * dpr), Math.floor((im.height / dpr) * dpr)];
  return x >= 0 && y >= 0 && x + w <= vw && y + h <= vh;
}
// The first image of the list Chromium shows, the list made with the pointer at device pixel (lx, ly).
function pick(box: CursorBox, dpr: number, vw: number, vh: number, lx: number, ly: number, px: number, py: number) {
  const view = { x: 0, y: 0, width: vw / dpr, height: vh / dpr };
  const list = cursorCuts(box, { x: lx / dpr, y: ly / dpr }, view, dpr).map((c) => cutImage(box, c, dpr));
  return list.find((im) => chromiumShows(im, px, py, vw, vh, dpr));
}

const boxes = (dpr: number): CursorBox[] => {
  const size = Math.min(128, Math.round(64 * dpr));
  const k = size / 64;
  return [
    { width: size, height: size, hotX: 0, hotY: 0 }, // a full image, the hotspot at its corner
    { width: size, height: size, hotX: Math.round(3 * k), hotY: Math.round(4 * k) },
    { width: Math.ceil(24 * k) + 1, height: Math.ceil(24 * k) + 1, hotX: Math.round(5 * k), hotY: Math.round(5 * k) }, // a 24-pixel arrow, trimmed
    { width: Math.ceil(32 * k), height: Math.ceil(32 * k), hotX: Math.round(16 * k), hotY: Math.round(16 * k) }, // a crosshair
  ];
};

test('the cursor stays shown up to every edge, at the hotspot, cut only by what reaches past the edge', () => {
  for (const dpr of DPRS)
    for (const box of boxes(dpr))
      for (const [vw, vh] of [[Math.round(1366 * dpr), Math.round(700 * dpr)], [1707, 961]]) {
        const what = (p: string) => `dpr ${dpr}, cursor ${JSON.stringify(box)}, view ${vw}×${vh}, pointer ${p}`;
        const along = (px: number, py: number, from: [number, number]) => {
          const im = pick(box, dpr, vw, vh, from[0], from[1], px, py);
          assert.ok(im, `no image shown: ${what(`${px},${py}, the list made at ${from}`)}`);
          // The pointer is at the cursor's hotspot: its device pixel is the drawn cursor's hotspot.
          const [hx, hy] = [Math.round(im.cssHotX * dpr), Math.round(im.cssHotY * dpr)];
          if (hx - im.padX + im.cut.left !== box.hotX || hy - im.padY + im.cut.top !== box.hotY)
            assert.fail(`hotspot off: ${what(`${px},${py}`)}: ${JSON.stringify(im)}`);
          return im;
        };
        const ys = [Math.floor(vh / 2)];
        const xs = [Math.floor(vw / 2)];
        for (let p = 0; p < vw; p++) {
          for (const y of [...ys, 0, vh - 1]) {
            const im = along(p, y, [p, y]);
            // Cut no more than a step (and the pixel to spare) short of the edge it would reach past.
            const right = p - Math.round(im.cssHotX * dpr) + im.width;
            if (im.cut.right && right < vw - CUT_STEP - 2) assert.fail(`cut early: ${what(`${p},${y}`)}: ends at ${right}`);
            // Moving at up to 4 CSS pixels a move, the list made at the last move still has one shown.
            if (p >= 4 * dpr) along(p, y, [Math.round(p - 4 * dpr), y]);
            if (p + 4 * dpr < vw) along(p, y, [Math.round(p + 4 * dpr), y]);
          }
        }
        for (let p = 0; p < vh; p++)
          for (const x of [...xs, 0, vw - 1]) {
            const im = along(x, p, [x, p]);
            const bottom = p - Math.round(im.cssHotY * dpr) + im.height;
            if (im.cut.bottom && bottom < vh - CUT_STEP - 2) assert.fail(`cut early: ${what(`${x},${p}`)}: ends at ${bottom}`);
            if (p >= 4 * dpr) along(x, p, [x, Math.round(p - 4 * dpr)]);
          }
      }
});

test('away from the edges the cursor is whole, and with the pointer unknown', () => {
  for (const dpr of DPRS) {
    const box = boxes(dpr)[1];
    const view = { x: 0, y: 0, width: 1000, height: 800 };
    assert.deepEqual(cursorCuts(box, { x: 500, y: 400 }, view, dpr), [{ left: 0, top: 0, right: 0, bottom: 0 }]);
    assert.deepEqual(cursorCuts(box, undefined, view, dpr), [{ left: 0, top: 0, right: 0, bottom: 0 }]);
  }
});

test("the drawn cursor's box ends where its drawing does", () => {
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 12; x++) rgba[(y * 64 + x) * 4 + 3] = 255;
  assert.deepEqual(cursorBox(rgba, 1, 1, 64), { width: 12, height: 20, hotX: 1, hotY: 1 });
  assert.deepEqual(cursorBox(rgba, 1, 1, 128), { width: 24, height: 40, hotX: 2, hotY: 2 });
  assert.deepEqual(cursorBox(rgba, 1, 1, 80), { width: 16, height: 26, hotX: 1, hotY: 1 }, 'smoothed: a pixel for the bleed');
  assert.deepEqual(cursorBox(rgba, 30, 2, 64), { width: 31, height: 20, hotX: 30, hotY: 2 }, 'the hotspot inside');
  assert.deepEqual(cursorBox(new Uint8ClampedArray(64 * 64 * 4), 0, 0, 64), { width: 1, height: 1, hotX: 0, hotY: 0 });
});
