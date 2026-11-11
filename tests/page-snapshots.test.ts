// Snapshots of a machine kept in the browser (docs/machines.md §5), on Debian, through the page and its modal:
// three kept; an older one restored forks the newer state into an overlay of its own (nothing lost), the ramdisk comes
// back with the snapshot; Suspend resumes while its pins match and boots instead once the disk moved on; a change of
// RAM orphans the snapshots, and one action deletes them. Opt-in with WEBPC_DISTROS=debian (scripts/ci-machines.sh).
//
// A fresh profile on disk, as a user's: an off-the-record context keeps OPFS in memory, where Chromium's sync handles
// come back short at ~0.8 GB while `estimate()` reports 3.2 GB. The URL disk's block cache (web/diskcache.ts), sized
// from that estimate, then takes the room the snapshots, the forks and the suspended copy need (~1 GB in all), and a
// Restore or Suspend found the storage full (VK3 L3b).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WEBPC_DISTROS=debian)' : !existsSync(IMAGE) && 'SKIPPED: run images/build.sh debian edk2';
const BOOT_MS = 420_000;

let base: string;
let profile: { dir: string; context: BrowserContext } | undefined;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await profile?.context.close();
  if (profile) rmSync(profile.dir, { recursive: true, force: true });
  close?.();
});

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
const stateIs = (page: Page, ...states: string[]) => page.waitForFunction((s) => s.includes(document.body.dataset.state!), states, { timeout: BOOT_MS, polling: 200 })
  .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => `${document.body.dataset.state}: ${(document.getElementById('message-text')?.textContent ?? '')}`)}`); });
async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}
let tag = 0;
/** Runs `cmd` in the guest's shell; its output on one line, and its status (tests/page-machines.test.ts's). */
async function ok(page: Page, cmd: string, ms = 120_000) {
  const t = ++tag;
  await type(page, `clear; o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
  const re = new RegExp(`<${t}<(.*?)>(\\d+)>${t}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  assert.equal(m[2], '0', `${cmd}: ${m[1]}`);
  return m[1].trim();
}
const record = <T>(page: Page, f: string, a: unknown) => page.evaluate(async ({ f, a }) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const store = await Store.open();
  try {
    return await (new Function('store', 'a', `return (${f})(store, a)`))(store, a);
  } finally {
    store.close();
  }
}, { f, a }) as Promise<T>;

test('kept snapshots: an older one restored forks the newer state, the ramdisk comes back, Suspend on its pins, a RAM change orphans them all', { skip, timeout: 40 * 60_000 }, () => withDebianLock(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webpc-profile-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  profile = { dir, context };
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  const dialogs: string[] = [];
  let keepAs = '';
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, (q) => { dialogs.push(q.text); return q.kind === 'prompt' ? keepAs : true; });
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  const id = await record<string>(page, `async (store) => {
    const { newId } = await import('/web/app/shape.ts');
    const now = Date.now();
    const bytes = (await fetch('/target/images/debian/disk.qcow2', { method: 'HEAD' })).headers.get('content-length');
    const head = new DataView(await (await fetch('/target/images/debian/disk.qcow2', { headers: { Range: 'bytes=0-31' } })).arrayBuffer());
    const disk = { id: newId(), kind: 'url', name: 'debian.qcow2', size: Number(head.getBigUint64(24)), url: '/target/images/debian/disk.qcow2', identity: { kind: 'url', path: '/target/images/debian/disk.qcow2', bytes: Number(bytes) }, created: now };
    const rid = newId();
    const ram = { id: rid, kind: 'ramdisk', name: 'Ramdisk', size: 64 << 20, identity: { kind: 'ramdisk', id: rid, bytes: 64 << 20 }, created: now };
    await store.put('disks', disk);
    await store.put('disks', ram);
    const id = newId();
    await store.put('machines', { id, name: 'Snappy', ncpus: 2, ramMiB: 1024, display: '2d', network: true, attachments: [{ id: newId(), disk: disk.id, readOnly: false }, { id: newId(), disk: rid, readOnly: false }], created: now, modified: now });
    return id;
  }`, null);
  const url = `${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&${credentialsQuery()}`;
  await page.goto(url);
  await stateIs(page, 'running');
  await type(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  const ramdisk = '/dev/vdb';
  await ok(page, `mkfs.ext4 -q ${ramdisk} && mkdir -p /mnt/r && mount ${ramdisk} /mnt/r`);

  /** Keeps a snapshot (the toolbar's Snapshot: named by the time), waits for the page to say so, then renames it `name` on the Machines page. */
  const keep = async (name: string) => {
    const before = await page.locator('#message').getAttribute('data-snapshot');
    await page.locator('#save-snapshot').click();
    await page.waitForFunction(([b, src]) => document.getElementById('message')?.dataset.snapshot !== (b ?? undefined) && new RegExp(src!).test(document.getElementById('message-text')?.textContent ?? ''), [before, words('snapshots:snapshot-actions.kept', {}, { start: true }).source] as const, { timeout: 120_000 });
    keepAs = name;
    await page.locator('#machines-open').click();
    await page.locator('.machines [data-tab=snapshots]').click();
    await page.locator('.machines [data-snapshot]').first().getByRole('button', { name: t('snapshots:Snapshots.rename') }).click();
    await page.locator('.machines [data-snapshot]', { hasText: name }).waitFor({ timeout: 10_000 });
    await page.locator('[data-action=back]').click();
  };
  await ok(page, 'echo a > /root/f && echo r-one > /mnt/r/x && sync');
  await keep('one');
  await ok(page, 'echo b > /root/f && echo r-two > /mnt/r/x && sync');
  await keep('two');
  await ok(page, 'echo c > /root/f && sync');
  await keep('three');
  const snaps = await record<{ name: string; pins: { overlay?: string; generation?: number; ram?: boolean; blocks: number }[] }[]>(page, `async (store, id) => (await store.snapshotsOf(id)).sort((a, b) => a.created - b.created)`, id);
  assert.deepEqual(snaps.map((s) => s.name), ['one', 'two', 'three']);
  // Each pins the overlay at a later generation (the machine wrote between them), and carries the ramdisk.
  const gens = snaps.map((s) => s.pins.find((p) => p.overlay)!.generation!);
  assert.ok(gens[0] < gens[1] && gens[1] < gens[2], `generations ${gens}`);
  assert.ok(snaps.every((s) => s.pins.some((p) => p.ram && p.blocks > 0)));

  /** Restores kept snapshot `name` from the modal; waits for the machine to run from it. */
  const restore = async (name: string) => {
    await page.click('#machines-open');
    await page.locator('.machines [data-tab=snapshots]').click();
    await page.locator('.machines [data-snapshot]', { hasText: name }).getByRole('button', { name: t('snapshots:Snapshots.restore') }).click();
    await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 30_000, polling: 50 })
      .catch((e) => { throw new Error(`${e}; the last dialog: ${dialogs.at(-1)}`); });
    await stateIs(page, 'running');
  };
  // "one": the overlay moved on since, so its state goes into a new overlay; the newer state stays in the old one.
  await restore('one');
  assert.match(dialogs.at(-2)!, words('snapshots:snapshot-restore.restore.fork.new'));
  assert.equal(await ok(page, 'cat /root/f /mnt/r/x'), 'a r-one');
  const after1 = await record<{ overlays: { name: string; fork?: unknown }[]; attached: string }>(page, `async (store, id) => {
    const m = await store.get('machines', id);
    const overlays = await store.overlaysOf(m.attachments[0].disk);
    return { overlays: overlays.map((o) => ({ name: o.name, fork: o.fork })), attached: overlays.find((o) => o.id === m.attachments[0].overlay).name };
  }`, id);
  assert.equal(after1.attached, 'one', 'the fork is attached');
  assert.deepEqual(after1.overlays.map((o) => o.name).sort(), [t('disks:page-disks.overlayName'), 'one'].sort());
  // "three" from there: its state was the old overlay's (moved on since too: the machine wrote after it), forked again.
  await restore('three');
  assert.equal(await ok(page, 'cat /root/f'), 'c');
  // "two": the ramdisk as it was then.
  await restore('two');
  assert.equal(await ok(page, 'cat /root/f /mnt/r/x'), 'b r-two');

  // Suspend: resumed by the next load while its pins match.
  await page.locator('#suspend').click();
  await stateIs(page, 'suspended');
  await page.goto(url);
  await stateIs(page, 'running');
  assert.match(await page.locator('#message-text').textContent() ?? '', words('machine:worker.resumed'));
  assert.equal(await ok(page, 'cat /root/f /mnt/r/x'), 'b r-two');
  // Suspended again, then its overlay switched: the next load boots instead, with a note.
  await page.locator('#suspend').click();
  await stateIs(page, 'suspended');
  await record(page, `async (store, id) => {
    const { createOverlay, switchOverlay } = await import('/web/app/disks.ts');
    const m = await store.get('machines', id);
    const d = await store.get('disks', m.attachments[0].disk);
    const o = await createOverlay(store, d, 'Fresh');
    await switchOverlay(store, m, m.attachments[0].id, o.id);
  }`, id);
  await page.goto(url);
  await stateIs(page, 'booting', 'running');
  assert.match(await page.locator('#message-text').textContent() ?? '', words('machine:worker.notResumed'));
  assert.match(await page.locator('#message-details').textContent() ?? '', words('machine:worker-start.diskChanged')); // why: the note's detail

  // A RAM change orphans every snapshot (it asks first; the machine restarts with it); the Machines page deletes them in one action.
  await page.locator('#machines-open').click();
  const m = page.locator('.machines section.machine[data-selected]');
  await m.locator('[data-tab=settings]').click();
  await m.locator('[data-field=ram]').selectOption('2048');
  await m.locator('[data-action=save]').click(); // asks whether to orphan the snapshots, then to restart
  await page.waitForFunction(() => document.body.dataset.state === 'loading' || document.body.dataset.state === 'booting', null, { timeout: 30_000, polling: 50 });
  await m.locator('[data-tab=snapshots]').click();
  await page.locator('.machines .orphan').first().waitFor();
  assert.equal(await page.locator('.machines .orphan').count(), 3);
  assert.match(await page.locator('.machines .orphan').first().textContent() ?? '', words('machines:shape-diff.ram', { was: 1024, now: 2048 }));
  await page.locator('.machines [data-action=delete-orphaned]').click();
  await page.waitForFunction(() => document.querySelectorAll('.machines [data-snapshot]').length === 0, null, { timeout: 10_000 });
  assert.equal((await record<unknown[]>(page, `async (store, id) => store.snapshotsOf(id)`, id)).length, 0);
  assert.deepEqual(await record<string[]>(page, `async (store, id) => store.files.list('machines/' + id + '/snapshots')`, id), []);
  assert.deepEqual(errors, []);
  await context.close();
}));
