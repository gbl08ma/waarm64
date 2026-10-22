// Chromium in the guest showing older frames (graphics.md §24; dev-only, not in tests): the desktop image with Chromium
// (images/arch/desktop.sh), sway on 3D, and Chromium in kiosk mode on a page that plays sintel-silent.webm (decoded on
// the host through webpc-va) beside a frame counter drawn as two rows of 16 black or white blocks: row A the frame's
// number, row B the number over 16 (a region damaged once every 16 frames). The host watches the screen through
// Chromium's screencast and counts, over PHASE_S seconds, the frames where A went back (an older frame shown) and those
// where B isn't A over 16 (two regions of one frame from different times: what a lost partial redraw leaves).
//   node bench/gpu/chromium-flicker.ts <image.qcow2> [outdir]
// VIRGL_GPU the page's `?gpu=` (default `virgl`); CR_FLAGS more flags for the guest's Chromium (e.g.
// `--ui-disable-partial-swap`); WARM_S seconds after the counter first shows (20), PHASE_S the phase (30).
import { mkdirSync, writeFileSync } from 'node:fs';
import { GUEST_USER, openSession } from './guest-session.ts';

const HOME = `/home/${GUEST_USER}`;
const image = process.argv[2];
if (!image) throw new Error('usage: node bench/gpu/chromium-flicker.ts <image.qcow2> [outdir]');
const gpu = process.env.VIRGL_GPU ?? 'virgl';
const out = process.argv[3] ?? new URL(`../results/local/chromium-flicker/${gpu.replace(/,/g, '-')}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const WARM_S = Number(process.env.WARM_S ?? 20), PHASE_S = Number(process.env.PHASE_S ?? 30);
/** The guest's screen (the session's default size): the page is fullscreen on it. */
const GW = 1376, GH = 762;
/** Where the rows' blocks are on the guest's screen: block k of a row at x = 20 + 80k, 64 px square. */
const ROW_A = 40, ROW_B = 200, BLOCKS = 16;

const PAGE = `<!doctype html><html><head><style>
body { margin: 0; background: #808080; overflow: hidden; }
.row { position: absolute; left: 0; }
.row div { position: absolute; top: 0; width: 64px; height: 64px; }
video { position: absolute; left: 300px; top: 300px; width: 640px; filter: saturate(1.6) contrast(1.1); }
.spin { position: absolute; left: 1050px; top: 400px; width: 100px; height: 100px; background: #c33; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
<div class="row" id="a" style="top: ${ROW_A}px"></div><div class="row" id="b" style="top: ${ROW_B}px"></div>
<video src="file://${HOME}/media/sintel-silent.webm" autoplay muted loop></video><div class="spin"></div>
<script>
const blocks = (row) => Array.from({ length: ${BLOCKS} }, (_, k) => { const d = document.createElement('div'); d.style.left = (20 + 80 * k) + 'px'; row.appendChild(d); return d; });
const A = blocks(document.getElementById('a')), B = blocks(document.getElementById('b'));
const paint = (row, v) => row.forEach((d, k) => { d.style.background = (v >> (${BLOCKS - 1} - k)) & 1 ? '#fff' : '#000'; });
let n = 0;
const frame = () => { n = (n + 1) & 0xffff; paint(A, n); paint(B, n >> 4); requestAnimationFrame(frame); };
requestAnimationFrame(frame);
</script></body></html>
`;

const s = await openSession({ gpu, image, out, query: process.env.QUERY });
const { page, log, pasteSerial, rootShell, run } = s;
const results: Record<string, unknown> = { gpu, chromium: s.browser.version(), gl: s.gl, flags: process.env.CR_FLAGS ?? '' };
await rootShell();
await pasteSerial(`cat > ${HOME}/flicker.html <<'EOF'\n${PAGE}EOF`);
results.info = await run(`chown ${GUEST_USER}: ${HOME}/flicker.html; pacman -Q chromium mesa sway 2>&1 | tr "\\n" " "`);
log('info', results.info);
results.sway = await s.startSway('gles2');
log('sway', results.sway);
await run(s.asUser(`swaymsg exec 'chromium --no-first-run --password-store=basic --user-data-dir=/tmp/crflicker --autoplay-policy=no-user-gesture-required --kiosk ${process.env.CR_FLAGS ?? ''} file://${HOME}/flicker.html > /tmp/chromium.log 2>&1' >/dev/null`));
const t0 = Date.now();

// The screen through the screencast: each frame decoded in a page of its own, the blocks' centres read.
const box = await page.locator('#screen').boundingBox();
if (!box) throw new Error('no #screen');
const at = (gx: number, gy: number) => [Math.round(box.x + ((gx + 0.5) * box.width) / GW), Math.round(box.y + ((gy + 0.5) * box.height) / GH)];
const points = [ROW_A, ROW_B].flatMap((y) => Array.from({ length: BLOCKS }, (_, k) => at(20 + 80 * k + 32, y + 32)));
const decoder = await s.browser.newPage();
type Read = { a: number; b: number; clean: boolean };
const read = (jpeg: string) => decoder.evaluate(async ([b64, pts, n]) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const img = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const c = new OffscreenCanvas(img.width, img.height).getContext('2d', { willReadFrequently: true })!;
  c.drawImage(img, 0, 0);
  let a = 0, b = 0, clean = true;
  pts.forEach(([x, y], k) => {
    const [r, g, bl] = c.getImageData(x, y, 1, 1).data;
    const l = (r + g + bl) / 3;
    if (l > 60 && l < 195) clean = false; // not a block's black or white: the counter isn't on the screen
    const bit = l >= 128 ? 1 : 0;
    if (k < n) a = (a << 1) | bit;
    else b = (b << 1) | bit;
  });
  return { a, b, clean };
}, [jpeg, points, BLOCKS] as const) as Promise<Read>;

const cdp = await page.context().newCDPSession(page);
const frames: { t: number; r: Read }[] = [];
let decoding = Promise.resolve();
cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
  void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  const t = Date.now();
  decoding = decoding.then(async () => { frames.push({ t, r: await read(f.data) }); });
});
const vp = page.viewportSize()!;
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });

// Chromium's start: until the counter shows and moves.
for (;;) {
  await page.waitForTimeout(2000);
  const last = frames.slice(-5);
  if (last.length === 5 && last.every((f) => f.r.clean) && last[4].r.a !== last[0].r.a) break;
  if (Date.now() - t0 > 600_000) {
    await page.screenshot({ path: `${out}/start-timeout.png` });
    throw new Error(`the counter never showed (${out}/start-timeout.png)`);
  }
}
results.startS = (Date.now() - t0) / 1000;
log('chromium up', results.startS, 's');
await page.waitForTimeout(WARM_S * 1000);
await s.display();
frames.length = 0;
await page.waitForTimeout(PHASE_S * 1000);
await decoding;
const d = await s.display();
await page.screenshot({ path: `${out}/screen.png` });
await cdp.send('Page.stopScreencast');

// Back: A less than the most A shown so far (mod 2^16, within half the range). Split: B isn't A over 16.
const seen = frames.filter((f) => f.r.clean);
let back = 0, split = 0, maxBack = 0, top = seen[0]?.r.a ?? 0;
const examples: string[] = [];
for (const { r } of seen) {
  const behind = (top - r.a) & 0xffff;
  if (behind > 0 && behind < 0x8000) {
    back++;
    maxBack = Math.max(maxBack, behind);
    if (examples.length < 10) examples.push(`back ${behind}: A ${r.a} after ${top}`);
  } else top = r.a;
  if (r.b !== r.a >> 4) {
    split++;
    if (examples.length < 10) examples.push(`split: A ${r.a} (over 16: ${r.a >> 4}), B ${r.b}`);
  }
}
Object.assign(results, { frames: frames.length, clean: seen.length, counted: seen.length ? ((seen.at(-1)!.r.a - seen[0].r.a) & 0xffff) : 0, back, maxBack, split, examples, display: d, log: await run('grep -i -c -E "error|fail" /tmp/chromium.log') });
log(JSON.stringify({ frames: results.frames, clean: seen.length, counted: results.counted, back, maxBack, split, video: d.renderer?.video }));
writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
await s.close();
