// The guest's OS and its clean power-off and restart on Debian (docs/devices.md "The guest's OS", "Power off and
// restart from the guest"): the agent names the OS (OS: /etc/os-release's PRETTY_NAME, in the status bar's Guest OS),
// and the toolbar's Power off and Restart ask the guest first (POWER, web/app/run/soft-power.ts): a block inhibitor
// refuses it (said, then today's question, answered Cancel here: the machine runs on), Restart reboots the guest itself
// (its PSCI reset, a new run that boots again), and Power off shuts it down (its systemd's shutdown, then PSCI's
// power-off: the page's state `off`), the toolbar's sign shown meanwhile, the stop button then cutting the power.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { pageFixture } from './debian-fixture.ts';
import { loadSnapshotFile } from '../bench/snapshot-start.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { CAP } from '../web/agent-frame.ts';
import { words } from './words.ts';
import { t } from '../web/i18n.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const AGENT = new URL('../target/images/agent/waarm64-agent.gz', import.meta.url); // what the page serves
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE) || !existsSync(AGENT)) && 'SKIPPED: run images/build.sh debian edk2 agent';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
let runs = 0;
/** Runs `cmd` on the serial shell: its output on one line, between markers of its own. */
async function run(page: Page, cmd: string, ms = 60_000) {
  const re = new RegExp(`<<${++runs}:([^<>]*)>>`);
  await page.locator('.xterm').click();
  await page.keyboard.type(`clear; echo "<<${runs}:$({ ${cmd}; } | tr '\\n<>' ' []')>"">"\n`, { delay: 10 });
  await shows(page, re, ms);
  return re.exec(await terminal(page))![1].trim();
}
type Hello = { version: number; caps: number };
/** The agent's HELLO on the run's link (a new link each run). */
const hello = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __agent?: { agent?: Hello } }).__agent?.agent, null, { timeout: 240_000, polling: 100 }).then((h) => h.jsonValue() as Promise<Hello>);
async function login(page: Page) {
  await shows(page, /login: /, 240_000);
  await page.locator('.xterm').click();
  await page.keyboard.type('root\n', { delay: 10 });
  await shows(page, /root@\S+:~# /);
}
const state = (page: Page) => page.evaluate(() => document.body.dataset.state);

test("Debian's OS in the status bar, its clean restart and power-off from the toolbar (refused under a block inhibitor)", { skip, timeout: 15 * 60_000 }, async (t0) => {
  // The first boot from a booted-Debian fixture (tests/debian-fixture.ts): the restart's is the one tested.
  const query = `${PAGE_QUERY}ncpus=2&view=both&${unattendedQuery()}`;
  const restore = await pageFixture(browser, base, query);
  await withDebianLock(async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const asked: Question[] = [];
    // Every question cancelled (a hard power-off never happens here) but Load snapshot's, while the fixture loads.
    let loading = false;
    await answerAsks(page, (q) => { if (loading) return true; asked.push(q); return false; });
    await page.goto(`${base}/web/app/?autostart=1&${query}`);
    if (restore) {
      loading = true;
      await loadSnapshotFile(page, restore);
      loading = false;
    }
    await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: 300_000, polling: 250 });
    assert.equal(await state(page), 'running');
    await login(page);
    // A restored guest's clock stood still since the save.
    if (restore) await run(page, `date -u -s @${(Date.now() / 1000).toFixed(3)} > /dev/null`);
    const h = await hello(page);
    assert.ok(h.caps & CAP.OS && h.caps & CAP.POWER, `the agent names the OS and powers off (caps ${h.caps})`);

    // OS: the status bar's Guest OS says what /etc/os-release says.
    const pretty = await run(page, '. /etc/os-release; echo "$PRETTY_NAME"');
    assert.match(pretty, /^Debian GNU\/Linux/);
    await page.waitForFunction((p) => document.querySelector('#status [data-kind=os]')?.textContent?.trim() === p, pretty, { timeout: 10_000, polling: 100 })
      .catch(async (e) => { throw new Error(`${e}; the bar shows: ${await page.evaluate(() => document.getElementById('status')?.textContent)}`); });
    assert.equal(await page.getAttribute('#power-off', 'title'), t('toolbar:Toolbar.powerOff.soft.title'));

    // A block inhibitor: the guest refuses (logind, even to root: ROOT_CHECK_INHIBITORS), the page says so, then asks
    // today's question (cancelled: the machine runs on).
    // (Its pid kept in a file: `run`'s subshell isn't the shell's, so the shell has no job to kill.)
    assert.equal(await run(page, 'systemd-inhibit --what=shutdown --mode=block --who=test --why=test sleep 600 >/dev/null 2>&1 & echo $! >/tmp/inhibitor; sleep 1; systemd-inhibit --list --no-legend | grep -c test'), '1');
    await page.click('#power-off');
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('machine:soft-power.refused.off').source, { timeout: 30_000, polling: 100 })
      .catch(async (e) => { throw new Error(`${e}; the agent says: ${await run(page, 'journalctl -b -u waarm64-agent -o cat --no-pager | tail -3')}`); });
    for (let i = 0; i < 50 && asked.length < 1; i++) await page.waitForTimeout(100);
    assert.deepEqual(asked.map((q) => q.text), [t('machine:power-actions.powerOff.confirm')], "today's question after the refusal");
    assert.equal(await state(page), 'running');
    assert.equal(await page.locator('#soft-power').count(), 0, 'no sign once refused');
    assert.match(await run(page, 'journalctl -b -u waarm64-agent -o cat --no-pager | grep -c "power: refused"'), /^1$/);
    assert.equal(await run(page, 'kill $(cat /tmp/inhibitor); sleep 1; systemd-inhibit --list --no-legend | grep -c test'), '0', 'the inhibitor gone');

    // Restart: the guest reboots itself (the sign meanwhile, no question), its reset starts a new run, which boots again.
    await page.evaluate(() => ((window as unknown as { __firstLink?: unknown; __agent?: unknown }).__firstLink = (window as unknown as { __agent?: unknown }).__agent));
    await page.click('#restart');
    await page.waitForSelector('#soft-power', { timeout: 30_000 });
    assert.equal(await page.textContent('#soft-power'), t('toolbar:Toolbar.soft.reboot'));
    const t1 = performance.now();
    await page.waitForFunction(() => {
      const w = window as unknown as { __firstLink?: unknown; __agent?: unknown };
      return w.__agent !== w.__firstLink;
    }, null, { timeout: 180_000, polling: 250 })
      .catch(async (e) => { throw new Error(`${e}; the state is ${await state(page)}; the message bar: ${await page.evaluate(() => document.getElementById('message-text')?.textContent ?? '').catch(() => '')}; asked: ${JSON.stringify(asked)}; the terminal shows: ${(await terminal(page)).slice(-1500)}`); });
    t0.diagnostic(`the guest's restart reached its reset in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
    assert.equal(await page.locator('#soft-power').count(), 0, 'the sign gone with the run');
    await login(page);
    await hello(page);
    assert.equal(asked.length, 1, 'no question for the clean restart');
    // (The hard restart would have asked first, and the question was cancelled: the new run is the guest's own reset.)

    // Power off: the guest shuts itself down (the sign, the stop button now red: it would cut the power), and its
    // PSCI power-off stops the machine.
    await page.click('#power-off');
    await page.waitForSelector('#soft-power', { timeout: 30_000 });
    assert.equal(await page.textContent('#soft-power'), t('toolbar:Toolbar.soft.off'));
    assert.equal(await page.getAttribute('#power-off', 'title'), t('toolbar:Toolbar.powerOff.now.title'));
    assert.match((await page.getAttribute('#power-off', 'class')) ?? '', /\bnow\b/);
    // The status bar's state says it too (#state's data-state stays `running` until the machine stops).
    const stateIs = (words: string) => page.waitForFunction((w) => document.querySelector('#status [data-kind=state]')?.textContent?.includes(w) ?? false, words, { timeout: 10_000, polling: 100 });
    await stateIs(t('statusbar:statusbar-render.state.shuttingDown'));
    assert.equal(await state(page), 'running');
    const t2 = performance.now();
    await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 180_000, polling: 250 })
      .catch(async (e) => { throw new Error(`${e}; the state is ${await state(page)}; the terminal shows: ${(await terminal(page)).slice(-400)}`); });
    await stateIs(t('machine:messages.state.off'));
    t0.diagnostic(`the guest's shutdown reached its power-off in ${((performance.now() - t2) / 1000).toFixed(1)} s`);
    assert.match(await terminal(page), /reboot: Power down/);
    assert.equal(asked.length, 1, 'no question for the clean power-off');
    assert.equal(await page.locator('#soft-power').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
