// The Home page's About pane (web/app/About.svelte, docs/frontend.md "About") in Chromium, without a guest: after
// Preferences; the repository, the commit the page was built from and its date; the third-party projects in their
// groups, each linking its license texts; every link to another site opened apart, with no referrer, opener or
// endorsement; the license files beside the page served.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { aboutGroups, load } from '../tools/third-party.ts';
import { t } from '../web/i18n.ts';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

test('About: the build, waarm64\'s license, the third-party projects and their license texts, links opened apart', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/`);
  await page.click('#machines-open');
  // The last of the buttons under the list, after Preferences and Demos (which opens the demo store's page).
  const buttons = await page.$$eval('nav .new:last-of-type button', (bs) => bs.map((b) => (b as HTMLElement).dataset.machine));
  assert.deepEqual(buttons.slice(-3), ['preferences', 'demos', 'about']);
  await page.click('[data-machine=about]');
  const pane = page.locator('section[data-selected=about]');
  assert.equal(await pane.locator('h3').textContent(), t('machines:MachinesPage.about'));

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(await pane.locator(`[data-about-version] a[href$="/commit/${commit}"]`).count(), 1);
  assert.match(await pane.locator('[data-about-version]').textContent() ?? '', new RegExp(commit.slice(0, 12)));
  assert.equal(await pane.locator('[data-about-link=repository]').getAttribute('href'), 'https://github.com/gbl08ma/waarm64');

  // Each group of THIRD_PARTY.json's About rows, with its projects.
  const groups = aboutGroups(load());
  assert.deepEqual(await pane.locator('[data-about-group]').evaluateAll((s) => s.map((x) => (x as HTMLElement).dataset.aboutGroup)), groups.map((g) => g.group));
  for (const g of groups) {
    assert.equal(await pane.locator(`[data-about-group=${g.group}] h5`).textContent(), t(`machines:About.group.${g.group}`));
    assert.deepEqual(await pane.locator(`[data-about-group=${g.group}] tr[data-project]`).evaluateAll((r) => r.map((x) => (x as HTMLElement).dataset.project)), g.projects.map((p) => p.name));
  }
  const dynarmic = pane.locator('[data-about-group=core] tr[data-project=dynarmic]');
  assert.equal(await dynarmic.locator('.derived').textContent(), t('machines:About.derived'));
  assert.match(await dynarmic.locator('a[href*="LICENSE"]').getAttribute('href') ?? '', /^https:\/\/github\.com\/lioncash\/dynarmic\/blob\/a41c380246d3\//);

  // Every link to another site: a new tab, no referrer, no opener, not followed.
  const links = await pane.locator('a').evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, rel: a.getAttribute('rel') ?? '', target: a.getAttribute('target') })));
  const outside = links.filter((l) => new URL(l.href).origin !== new URL(base).origin);
  assert.ok(outside.length > 50, `${outside.length} links to other sites`);
  for (const l of outside) {
    assert.equal(l.target, '_blank', l.href);
    for (const r of ['external', 'nofollow', 'noopener', 'noreferrer']) assert.ok(l.rel.split(' ').includes(r), `${l.href}: rel ${l.rel}`);
  }
  // The license files beside the page (waarm64's own, the firmware's when it's built) answer.
  const beside = links.filter((l) => new URL(l.href).origin === new URL(base).origin);
  assert.ok(beside.some((l) => l.href.endsWith('/LICENSE')));
  for (const l of beside) assert.equal((await fetch(l.href)).status, 200, l.href);
  assert.deepEqual(errors, []);
  await page.close();
});
