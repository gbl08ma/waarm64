// Driving a guest's serial console from a Playwright page whose `window.harness` has
// `output()`, `error()` and `send(text)` (tests/browser/tailnet.html, netguest.html).
import type { Page } from 'playwright-core';

const harness = <T>(page: Page, f: string) => page.evaluate(`window.harness.${f}`) as Promise<T>;
export const output = (page: Page) => harness<string>(page, 'output()');

/** Waits until the serial output (from `from`) matches; on failure says why, with `context()`'s extra words. */
export async function shows(page: Page, re: RegExp, ms: number, from = 0, context: () => Promise<string> = async () => '') {
  const deadline = Date.now() + ms;
  for (;;) {
    const out = (await output(page)).slice(from);
    const m = re.exec(out);
    if (m) return m;
    const err = await harness<string | undefined>(page, 'error()');
    if (err) throw new Error(`the machine worker failed: ${err}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}${await context()}; the serial output ends: ${out.slice(-1500)}`);
    await page.waitForTimeout(250);
  }
}

/**
 * Runs a shell command on the serial console; resolves with its output. The markers are built by
 * the shell (`$((40+2))`), so the echoed command line never matches them, only what ran (bash
 * echoes the second line after the first has run, so the output can't be cut by the echo).
 */
export async function run(page: Page, cmd: string, ms = 60_000, context?: () => Promise<string>) {
  const from = (await output(page)).length;
  await page.evaluate((c) => (window as never as { harness: { send(s: string): void } }).harness.send(c), `echo __BEGIN$((40+2))__; ${cmd}\necho __END$((40+2))__\n`);
  await shows(page, /__END42__\r?\n/, ms, from, context);
  const out = (await output(page)).slice(from).replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  return out.slice(out.lastIndexOf('__BEGIN42__\n') + 12, out.lastIndexOf('__END42__'));
}

/**
 * Logs root in on the serial console (Debian's `login.noauth`): waits for the prompt, then for a shell. A guest
 * restored from a booted-Debian fixture (tests/debian-fixture.ts) then takes the host's time: its clock stood still
 * since the fixture was made.
 */
export async function loginRoot(page: Page, loginMs = 240_000, context?: () => Promise<string>) {
  await shows(page, /\S+ login: /, loginMs, 0, context);
  await page.evaluate(() => (window as never as { harness: { send(s: string): void } }).harness.send('root\n'));
  await shows(page, /root@\S+:~# /, 60_000, 0, context);
  if (await page.evaluate(() => (window as never as { harness: { restored?(): boolean } }).harness.restored?.() ?? false)) {
    await run(page, `date -u -s @${(Date.now() / 1000).toFixed(3)} > /dev/null`, 30_000, context);
  }
}
