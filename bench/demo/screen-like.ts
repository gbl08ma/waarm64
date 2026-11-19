// Whether a desktop demo's screen shows what its template saw (DEMO loop 12): the page's screen (`#screen`, as the
// visitor sees it, at any scale) against the template's thumbnail (bench/demo/make-template.ts: the screen's top at
// 16:10, 480×300), both cut the same way and shrunk to 32×20 grey levels; the mean difference of a level, 0–255. A
// black screen or the firmware's console is far off (tens); the desktop resumed is near (a clock, a cursor: a few).
import type { Page } from 'playwright-core';

/** The thumbnail's mean grey difference from the screen now; Infinity while the screen has no size. */
export async function screenDiff(page: Page, thumb: Uint8Array): Promise<number> {
  const box = await page.locator('#screen').boundingBox().catch(() => null);
  if (!box || box.width < 64 || box.height < 40) return Infinity;
  // The guest's screen alone, as the thumbnail was taken: the page's layers over it hidden.
  const shot = (await page.locator('#screen').screenshot({ timeout: 10_000, style: '#screen-frame > :not(#screen) { visibility: hidden !important; }' })).toString('base64');
  return page.evaluate(
    async ([shot, thumb]) => {
      const grey = async (b64: string, crop: boolean) => {
        const img = await createImageBitmap(await (await fetch(`data:image/${crop ? 'png' : 'webp'};base64,${b64}`)).blob());
        const w = crop ? Math.min(img.width, Math.round((img.height * 16) / 10)) : img.width;
        const h = crop ? (w * 10) / 16 : img.height;
        const c = new OffscreenCanvas(32, 20).getContext('2d')!;
        c.drawImage(img, 0, 0, w, h, 0, 0, 32, 20);
        const px = c.getImageData(0, 0, 32, 20).data;
        const out: number[] = [];
        for (let i = 0; i < px.length; i += 4) out.push((px[i] + px[i + 1] + px[i + 2]) / 3);
        return out;
      };
      const [a, b] = await Promise.all([grey(shot, true), grey(thumb, false)]);
      return a.reduce((n, x, i) => n + Math.abs(x - b[i]), 0) / a.length;
    },
    [shot, Buffer.from(thumb).toString('base64')] as const,
  );
}

/** Mean grey difference under which the screen counts as the template's (measured: DEMO loop 12, bench/demo/REPORT.md). */
export const LIKE = 12;

/** Waits until the screen looks like the thumbnail (`screenDiff` under `LIKE`); throws with the last difference. */
export async function untilLike(page: Page, thumb: Uint8Array, ms: number, every = 250): Promise<number> {
  let d = Infinity;
  for (const end = Date.now() + ms; (d = await screenDiff(page, thumb).catch(() => Infinity)) >= LIKE; await page.waitForTimeout(every))
    if (Date.now() > end) throw new Error(`the screen never looked like the template's (its difference ${d.toFixed(1)}, under ${LIKE} wanted)`);
  return d;
}
