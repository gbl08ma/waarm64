// The worker stack that guest calls as host calls take in Chromium (XF, the review's finding 4): run from the repo
// root as `node bench/boot/results/m9-hostcalls/stack/run.ts [js-flags...]`, after scripts/build-wasm.sh; prints JSON.
// Each number is the deepest JS padding (pad() frames, ~80 B each in V8 on arm64) under which a run still fits.
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';

const exe = process.env.CHROMIUM ?? '/usr/bin/chromium';
const flags = process.argv.slice(2);
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: exe, args: flags.length ? ['--js-flags=' + flags.join(' ')] : [] });
try {
  const page = await browser.newPage();
  await page.goto(base + '/bench/boot/results/m9-hostcalls/stack/stack.html');
  const h = await page.waitForFunction(() => (window as never)['result'], null, { timeout: 400_000 });
  const chromium = execFileSync(exe, ['--version']).toString().trim();
  console.log(JSON.stringify({ chromium, flags, result: await h.jsonValue() }));
} finally {
  await browser.close();
  server.close();
}
