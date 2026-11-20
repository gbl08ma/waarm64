// The introduction's guest in headless Firefox (the dev VM's own, never the user's: CLAUDE.md "Browsers"): whether
// bench/demo/intro.html's guest runs there, and when its first picture, its shell (a key ends the tour) and a command's
// answer came, ms from the navigation. Firefox isn't a supported browser: this checks a first visit doesn't fail badly.
//   node bench/demo/intro-firefox.ts [--runs 3] [--out <file>]
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { firefox } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { summarize } from '../stats.ts';

const { values: args } = parseArgs({ options: { runs: { type: 'string', default: '3' }, out: { type: 'string' } } });
type Intro = { can: boolean; guest?: { send(s: string): void }; marks: Record<string, number>; text(): string; ended(): string | undefined };
const server: Server = await startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await firefox.launch({
  channel: 'moz-firefox',
  executablePath: '/usr/bin/firefox',
  headless: true,
  env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', MOZ_HEADLESS: '1' },
});
const runs: { screen?: number; shell?: number; command?: number; formats?: Record<string, boolean>; error?: string }[] = [];
try {
  for (let n = 0; n < Number(args.runs); n++) {
    const ctx = await browser.newContext(); // a fresh profile's cache
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const run: (typeof runs)[number] = {};
    try {
      await page.goto(`${base}/bench/demo/intro.html`);
      const intro = () => (window as unknown as { __intro?: Intro }).__intro;
      await page.waitForFunction(() => (window as unknown as { __intro?: Intro }).__intro, null, { timeout: 30_000 });
      if (!(await page.evaluate(`(${intro})().can`))) throw new Error("this browser can't run the guest (the page falls back)");
      const until = (what: string) =>
        page.waitForFunction(
          (what) => {
            const i = (window as unknown as { __intro: Intro }).__intro;
            if (i.ended()) throw new Error(`the guest ended: ${i.ended()}`);
            return what === 'screen' ? i.marks.screen : new RegExp(what).test(i.text()) && performance.now();
          },
          what,
          { timeout: 60_000, polling: 10 },
        ).then((h) => h.jsonValue() as Promise<number>);
      run.screen = Math.round(await until('screen'));
      await page.evaluate(() => (window as unknown as { __intro: Intro }).__intro.guest!.send(' '));
      run.shell = Math.round(await until('waarm64;shell\\x07[^]*~ # '));
      await page.evaluate(() => (window as unknown as { __intro: Intro }).__intro.guest!.send('echo ok-$((6*7))\n'));
      run.command = Math.round(await until('ok-42'));
      // What a page could decompress without code of its own.
      run.formats = await page.evaluate(() => Object.fromEntries(['gzip', 'deflate-raw', 'brotli', 'zstd'].map((f) => {
        try { new DecompressionStream(f as CompressionFormat); return [f, true]; } catch { return [f, false]; }
      })));
    } catch (e) {
      run.error = `${String(e).slice(0, 400)}${errors.length ? ` [page errors: ${errors.join('; ').slice(0, 400)}]` : ''}`;
    }
    runs.push(run);
    console.log(JSON.stringify(run));
    await ctx.close();
  }
} finally {
  const version = browser.version();
  await browser.close();
  await new Promise((r) => server.close(r));
  const ok = runs.filter((r) => !r.error);
  const metric = (f: (r: (typeof runs)[number]) => number | undefined) => (ok.length ? summarize(ok.map((r) => f(r)!)) : undefined);
  const result = { schema: 1, kind: 'intro-firefox', date: new Date().toISOString(), browser: { name: 'Firefox', version, headless: true }, runs, failed: runs.length - ok.length, summary: { screen_ms: metric((r) => r.screen), shell_ms: metric((r) => r.shell), command_ms: metric((r) => r.command) } };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(JSON.stringify(result.summary), version);
}
