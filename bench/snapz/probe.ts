// The snapshot probe (docs/benchmarking.md "The snapshot probe"; dev-only): a warm snapshot loaded on the page, then
// saved as a kept snapshot (and the machine started from it: `keptStart`), to a file (a download, then a picked file:
// `picked`, an OPFS file standing in for the pick) and as a suspend, and
// resumed; per round, each operation's wall time
// and the page's own phases (`#message`'s `data-load` and `data-snapshot`: web/app/protocol.ts `LoadPhases`,
// `SaveTimes`), and the browser's memory before and during each save.
//
//   WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads \
//     node bench/snapz/probe.ts <desktop|debian> [out.json]
//
// ROUNDS (3), SETTLE_S (20: the guest runs that long after a load or a resume before the next save). The guests:
// desktop is target/snapbench/pages.waarm64snap (Firefox on a still page; bench/gpu/warm-snapshots.sh firefox), debian
// target/snapbench/debian-go.waarm64snap (logged in; warm-snapshots.sh debian); SNAPSHOT=<file> another of the same
// machine. Both were saved by transient machines (opened by URL), which can't keep a snapshot, so the probe makes a
// stored machine of the same shape in the profile ("SNAPZ desktop", its disks by URL) and a copy of the file whose
// header is that machine's (its name, shape and hash, its disks' identities, no overlay pinned: the frames are the file's),
// target/snapz/<guest>-<hash>.waarm64snap, once (the header is taken from a kept snapshot of the machine's first seconds).
// MODE=transient instead loads the file itself on the page's transient machine and saves it to a file only (what the
// REPORT's SNAPZ measurement did). A persistent profile is the measure: off the record OPFS costs ~250 µs a call
// (bench/boot/REPORT.md "SNAPZ: compression across the emulator, measured"); WAARM64_PROFILE=off measures that case on
// purpose (a fresh context each run). OPS (comma-separated, default all: load, kept, keptStart, file, picked, suspend)
// picks a round's operations. Runs alone, like any Chromium session.
import { createReadStream, createWriteStream, existsSync, mkdirSync, openAsBlob, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { chromiumEnv } from '../../tools/nosme.ts';
import { answerAsks } from '../../tests/page-ask.ts';
import { credentialsQuery } from '../../tests/debian-unattended.ts';
import { crc32, type SnapshotHeader } from '../../web/snapshot-file.ts';

/**
 * A snapshot's header (the magic and version, the JSON's length at 12, the JSON at 16), read here rather than with
 * web/snapshot-file.ts's `readHeader`, which loop 0's tree doesn't have (SNAPZ's end measured against it).
 */
async function readHeader(b: Blob): Promise<SnapshotHeader> {
  const h = new DataView(await b.slice(0, 16).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(await b.slice(16, 16 + h.getUint32(12, true)).arrayBuffer())) as SnapshotHeader;
}
import { commit, CORE_PATH, sha } from '../snapshot-start.ts';
import { t } from '../../web/i18n.ts';
import { words } from '../../tests/words.ts';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const [guest = 'desktop', outArg] = process.argv.slice(2);
const GUESTS = {
  desktop: {
    file: 'target/snapbench/pages.waarm64snap',
    disks: [{ url: '/target/archarm/desktop.qcow2' }, { url: '/target/ffpages/pages.ext4', readOnly: true }],
    ncpus: 4, ramMiB: 2560,
    query: 'gpu=virgl&view=both&displaystats&clocksync=0',
    transient: 'ncpus=4&ram=2560&gpu=virgl&view=both&displaystats&clocksync=0&disk=/target/archarm/desktop.qcow2&disk2=%2Ftarget%2Fffpages%2Fpages.ext4',
  },
  debian: {
    file: 'target/snapbench/debian-go.waarm64snap',
    disks: [{ url: '/target/images/debian/disk.qcow2' }, { url: '/target/images/stress/goroot.ext4', readOnly: true }],
    ncpus: 4, ramMiB: 1024,
    query: 'view=terminal&displaystats&clocksync=0',
    transient: `machine=debian&ncpus=4&view=terminal&displaystats&clocksync=0&${credentialsQuery()}&disk2=%2Ftarget%2Fimages%2Fstress%2Fgoroot.ext4`,
  },
} as const;
const g = GUESTS[guest as keyof typeof GUESTS];
if (!g) throw new Error(`the guest is desktop or debian, not ${guest}`);
const profile = process.env.WAARM64_PROFILE;
if (!profile || !process.env.WAARM64_DOWNLOADS) throw new Error('WAARM64_PROFILE and WAARM64_DOWNLOADS (directories under target/) are required');
/** `WAARM64_PROFILE=off`: Playwright's off-the-record context (OPFS in memory, ~250 µs a call) instead of a profile. */
const offRecord = profile === 'off';
/** The operations a round runs (`OPS`, comma-separated; default all): load, kept, keptStart, file, picked, suspend (and the resume). */
const OPS = new Set((process.env.OPS ?? 'load,kept,keptStart,file,picked,suspend').split(','));
/** A flag of the browser's command line that finds its processes (`browserPids`), off the record too. */
const TAG = `--waarm64-probe=${process.pid}`;
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const SETTLE_S = Number(process.env.SETTLE_S ?? 20);
const MODE = process.env.MODE ?? 'stored';
const warm = resolve(ROOT, process.env.SNAPSHOT ?? g.file);
const out = resolve(outArg ?? `${ROOT}/bench/results/local/snapz-probe/${guest}-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(out), { recursive: true });
mkdirSync(process.env.WAARM64_DOWNLOADS, { recursive: true });

// ---- the browser's memory ----

/** The browser's processes: the one with this profile and its descendants. */
function browserPids(): number[] {
  const all = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  const parent = new Map<number, number>();
  let root: number | undefined;
  const dir = resolve(profile!);
  for (const p of all) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
      parent.set(p, Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8');
      if (root === undefined && (offRecord ? cmd.includes(TAG) : cmd.includes(`--user-data-dir=${dir}`)) && !cmd.includes('--type=')) root = p;
    } catch { /* gone */ }
  }
  if (root === undefined) return [];
  const pids = [root];
  for (let i = 0; i < pids.length; i++) for (const [p, pp] of parent) if (pp === pids[i]) pids.push(p);
  return pids;
}
/** The browser's resident memory, MiB: RSS summed over its processes, and PSS (shared pages counted once). */
function memory() {
  let rss = 0, pss = 0;
  for (const p of browserPids()) {
    try {
      const r = readFileSync(`/proc/${p}/smaps_rollup`, 'utf8');
      rss += Number(/^Rss:\s+(\d+)/m.exec(r)?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+)/m.exec(r)?.[1] ?? 0);
    } catch { /* gone */ }
  }
  return { rssMiB: Math.round(rss / 1024), pssMiB: Math.round(pss / 1024) };
}
/** Samples `memory()` every 250 ms until `stop`: the peak. */
function sampler() {
  let peak = { rssMiB: 0, pssMiB: 0 };
  const take = () => { const m = memory(); peak = { rssMiB: Math.max(peak.rssMiB, m.rssMiB), pssMiB: Math.max(peak.pssMiB, m.pssMiB) }; };
  const timer = setInterval(take, 250);
  return () => { clearInterval(timer); take(); return peak; };
}

// ---- the page ----

const server = await startServer(Number(process.env.WAARM64_PORT ?? 8197)); // a kept profile keeps its storage for one origin
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const launch = { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, downloadsPath: resolve(process.env.WAARM64_DOWNLOADS), env: chromiumEnv(), args: [TAG] };
const ctx = offRecord
  ? await (await chromium.launch(launch)).newContext({ viewport: { width: 1400, height: 1300 }, acceptDownloads: true })
  : await chromium.launchPersistentContext(profile, { ...launch, viewport: { width: 1400, height: 1300 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
// The user agent says 155.0.0.0 (reduced): the binary says its version.
const chromiumVersion = execFileSync(process.env.CHROMIUM ?? '/usr/bin/chromium', ['--version'], { encoding: 'utf8' }).trim();
await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
await page.addInitScript(() => localStorage.setItem('waarm64.settings', JSON.stringify({ screen: '1376x762' })));
// Every question answered OK but a restore's offer to keep the disk's state in a fork: the overlay is replaced (no forks pile up).
const keepAsk = words('snapshots:snapshot-restore.restore.keep', { count: 1 }, { start: true });
await answerAsks(page, (q) => !keepAsk.test(q.text));
page.on('pageerror', (e) => console.log('[page error]', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[page console]', m.text().slice(0, 400)); });

const state = () => page.evaluate(() => document.body.dataset.state ?? '');
const until = (states: string[], ms = 600_000) => page.waitForFunction((s) => s.includes(document.body.dataset.state!), states, { timeout: ms, polling: 100 });
const messageText = () => page.evaluate(() => [document.getElementById('message-text')?.textContent, document.getElementById('message-details')?.textContent].filter(Boolean).join(': '));
const data = (key: 'snapshot' | 'load') => page.evaluate((k) => document.getElementById('message')?.dataset[k] ?? '', key);
const changed = (key: 'snapshot' | 'load', before: string, ms = 600_000) =>
  page.waitForFunction(([k, b]) => (document.getElementById('message')?.dataset[k!] ?? '') !== b, [key, before] as const, { timeout: ms, polling: 50 });
const settle = () => new Promise((r) => setTimeout(r, SETTLE_S * 1000));
const store = <T>(f: string, a?: unknown) => page.evaluate(async ({ f, a }) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const s = await Store.open();
  try {
    return await (new Function('store', 'a', `return (${f})(store, a)`))(s, a);
  } finally {
    s.close();
  }
}, { f, a }) as Promise<T>;
const round = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(o, (_k, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v) : v)));

/** A load: the file into the page's machine (Load snapshot, its questions answered), until it runs; the phases. */
async function load(file: string) {
  const before = await data('load');
  const t0 = performance.now();
  await page.setInputFiles('#load-snapshot-input', file);
  await page.waitForFunction(() => document.body.dataset.state === 'loading', null, { timeout: 60_000, polling: 20 });
  await until(['running', 'failed', 'crashed', 'off']);
  const wallMs = performance.now() - t0;
  if ((await state()) !== 'running') throw new Error(`the snapshot didn't load: ${await messageText()}`);
  await changed('load', before, 10_000);
  return round({ wallMs, phases: JSON.parse(await data('load')) });
}
/** A start from kept snapshot `id` (the Home page's Snapshots tab, Restore), until it runs; the phases. */
async function keptStart(id: string) {
  const before = await data('load');
  const t0 = performance.now();
  await page.locator('#machines-open').click();
  await page.locator('.machines [data-tab=snapshots]').click();
  await page.locator(`.machines [data-snapshot="${id}"]`).getByRole('button', { name: t('snapshots:Snapshots.restore') }).click();
  await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 60_000, polling: 20 });
  await until(['running', 'failed', 'crashed', 'off']);
  const wallMs = performance.now() - t0;
  if ((await state()) !== 'running') throw new Error(`the kept snapshot didn't start: ${await messageText()}`);
  await changed('load', before, 10_000);
  if (await page.locator('.machines').isVisible()) await page.locator('#machines-open').click();
  return round({ wallMs, phases: JSON.parse(await data('load')) });
}
/** A save by `start` (a click): until `data-snapshot` changes; its numbers, the wall time, the memory before and its peak. */
async function save(kind: string, start: () => Promise<void>, done?: () => Promise<void>) {
  const before = await data('snapshot');
  const mem = memory();
  const stop = sampler();
  const t0 = performance.now();
  await start();
  await changed('snapshot', before);
  await done?.();
  const wallMs = performance.now() - t0;
  const peak = stop();
  const s = JSON.parse(await data('snapshot')) as { kind: string; id?: string };
  if (s.kind !== kind) throw new Error(`a ${kind} save said ${JSON.stringify(s)}: ${await messageText()}`);
  return round({ wallMs, ...s, memory: { before: mem, peak } });
}
const download = async () => {
  const d = page.waitForEvent('download', { timeout: 600_000 });
  return async () => { await (await d).delete(); };
};

// ---- the stored machine and its copy of the file ----

/** The machine "SNAPZ <guest>" in the profile (made the first time: its disks by URL, the shape of the file's machine). */
async function storedMachine(): Promise<string> {
  await page.goto(`${base}/web/app/?clocksync=0`);
  return store<string>(`async (store, g) => {
    const name = 'SNAPZ ' + g.guest;
    const had = (await store.all('machines')).find((m) => m.name === name);
    if (had) return had.id;
    const { newId } = await import('/web/app/shape.ts');
    const now = Date.now();
    const disks = [];
    for (const d of g.disks) {
      const bytes = Number((await fetch(d.url, { method: 'HEAD' })).headers.get('content-length'));
      const head = new DataView(await (await fetch(d.url, { headers: { Range: 'bytes=0-31' } })).arrayBuffer());
      const qcow2 = head.getUint32(0) === 0x514649fb;
      const rec = { id: newId(), kind: 'url', name: d.url.split('/').pop(), size: qcow2 ? Number(head.getBigUint64(24)) : bytes, url: d.url, identity: { kind: 'url', path: d.url, bytes }, created: now };
      await store.put('disks', rec);
      disks.push({ id: newId(), disk: rec.id, readOnly: !!d.readOnly });
    }
    const id = newId();
    await store.put('machines', { id, name, ncpus: g.ncpus, ramMiB: g.ramMiB, display: '3d', network: true, clock: true, attachments: disks, created: now, modified: now });
    return id;
  }`, { guest, disks: g.disks, ncpus: g.ncpus, ramMiB: g.ramMiB });
}

/** The header of the snapshot kept as `id` of machine `m`, read from OPFS on the page. */
const keptHeader = (m: string, id: string) => page.evaluate(async ([m, id]) => {
  const readHeader = async (b: Blob) => {
    const h = new DataView(await b.slice(0, 16).arrayBuffer());
    return JSON.parse(new TextDecoder().decode(await b.slice(16, 16 + h.getUint32(12, true)).arrayBuffer())) as unknown;
  };
  let dir = await navigator.storage.getDirectory();
  for (const p of ['machines', m, 'snapshots']) dir = await dir.getDirectoryHandle(p);
  return readHeader(await (await dir.getFileHandle(id)).getFile());
}, [m, id]) as Promise<SnapshotHeader>;

/** The file's frames under `header` (its length and CRC made again): written to `to`. */
async function rewrite(from: string, to: string, header: SnapshotHeader) {
  const blob = await openAsBlob(from);
  const head = new DataView(await blob.slice(0, 16).arrayBuffer());
  const len = head.getUint32(12, true);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const top = new Uint8Array(20 + json.length);
  const v = new DataView(top.buffer);
  top.set(new Uint8Array(head.buffer, 0, 12));
  v.setUint32(12, json.length, true);
  top.set(json, 16);
  v.setUint32(16 + json.length, crc32(json), true);
  const w = createWriteStream(`${to}.part`);
  w.write(top);
  await pipeline(createReadStream(from, { start: 20 + len }), w);
  renameSync(`${to}.part`, to);
}

/**
 * The file as the stored machine's (`m`): its header's machine fields, shape and disks' identities from a snapshot kept
 * in the machine's first seconds (then deleted), the frames the file's. Made once per machine shape.
 */
async function storedCopy(m: string, url: string) {
  const warmHeader = await readHeader(await openAsBlob(warm));
  await page.goto(url);
  await until(['booting', 'running'], 120_000);
  const s = await save('kept', () => page.locator('#save-snapshot').click());
  const own = await keptHeader(m, s.id);
  await store(`(store, id) => store.deleteSnapshot(id)`, s.id);
  for (const k of ['devices', 'cpu'] as const) {
    if (JSON.stringify(own[k]) !== JSON.stringify(warmHeader[k])) throw new Error(`the stored machine's ${k} aren't the file's: ${JSON.stringify(own[k])} against ${JSON.stringify(warmHeader[k])}`);
  }
  const to = resolve(ROOT, `target/snapz/${guest}-${String(own.shapeHash).slice(0, 12)}.waarm64snap`);
  if (existsSync(to)) return to;
  mkdirSync(dirname(to), { recursive: true });
  type Pin = { slot: number; identity: string; overlay?: string; generation?: number };
  const pins = own.disks as Pin[];
  const header: SnapshotHeader = {
    ...warmHeader,
    ...Object.fromEntries(['machine', 'label', 'disk', 'name', 'shape', 'shapeHash', 'urls'].map((k) => [k, own[k]])),
    disks: (warmHeader.disks as Pin[]).map((d) => {
      const p = pins.find((x) => x.slot === d.slot);
      if (!p) throw new Error(`the stored machine has no writable disk in slot ${d.slot}`);
      // No overlay pinned: no restore finds its overlay as pinned and keeps it, so each writes the file's blocks.
      const { overlay: _o, generation: _g, ...rest } = d;
      return { ...rest, identity: p.identity };
    }),
  };
  await rewrite(warm, to, header);
  return to;
}

// ---- the rounds ----

const results: Record<string, unknown>[] = [];
const say = (what: string, r: Record<string, unknown>) => console.log(what, JSON.stringify(r));
const t0 = performance.now();
if (MODE === 'transient') {
  await page.goto(`${base}/web/app/?${g.transient}`);
  await until(['booting', 'running'], 300_000);
  for (let k = 0; k < ROUNDS; k++) {
    const r: Record<string, unknown> = { round: k, load: await load(warm) };
    say(`round ${k} load`, r.load as Record<string, unknown>);
    await settle();
    const deleted = await download();
    r.file = await save('file', () => page.locator('#save-snapshot').click(), deleted);
    say(`round ${k} file`, r.file as Record<string, unknown>);
    results.push(r);
  }
} else {
  const m = await storedMachine();
  const url = `${base}/web/app/?autostart=1&m=${m}&${g.query}`;
  const file = await storedCopy(m, url);
  console.log('stored machine', m, 'file', file);
  for (let k = 0; k < ROUNDS; k++) {
    if ((await state()) === 'loading') await until(['booting', 'running', 'off', 'suspended', 'failed']);
    const r: Record<string, unknown> = { round: k, load: await load(file) };
    say(`round ${k} load`, r.load as Record<string, unknown>);
    if (OPS.has('kept') || OPS.has('keptStart')) {
      await settle();
      const kept = await save('kept', () => page.locator('#save-snapshot').click());
      r.kept = kept;
      say(`round ${k} kept`, kept);
      if (OPS.has('keptStart')) {
        await settle();
        // The machine started from that kept snapshot (the Snapshots tab's Restore; its overlay replaced by the file's
        // blocks: the probe answers no to keeping the changes), then the snapshot deleted.
        r.keptStart = await keptStart(kept.id as string);
        say(`round ${k} keptStart`, r.keptStart as Record<string, unknown>);
      }
      await store(`(store, id) => store.deleteSnapshot(id)`, kept.id);
    }
    if (OPS.has('file')) {
      await settle();
      const deleted = await download();
      r.file = await save('file', async () => {
        await page.locator('#machines-open').click();
        await page.locator('.machines [data-tab=snapshots]').click();
        await page.locator('.machines').getByRole('button', { name: t('snapshots:Snapshots.toFile') }).click();
      }, deleted);
      say(`round ${k} file`, r.file as Record<string, unknown>);
      if (await page.locator('.machines').isVisible()) await page.locator('#machines-open').click();
    }
    if (OPS.has('picked')) {
      await settle();
      // A picked file (a file in OPFS stands in for the user's pick: a FileSystemWritableFileStream as a real pick's):
      // the pause, and a staged save's copy after the resume (`phases.copy`, in the wall time).
      await page.evaluate(() => {
        (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('probe-picked.waarm64snap', { create: true });
      });
      r.picked = await save('file', async () => {
        await page.locator('#machines-open').click();
        await page.locator('.machines [data-tab=snapshots]').click();
        await page.locator('.machines').getByRole('button', { name: t('snapshots:Snapshots.toFile') }).click();
      });
      await page.evaluate(async () => {
        (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined;
        await (await navigator.storage.getDirectory()).removeEntry('probe-picked.waarm64snap');
      });
      say(`round ${k} picked`, r.picked as Record<string, unknown>);
      if (await page.locator('.machines').isVisible()) await page.locator('#machines-open').click();
    }
    if (OPS.has('suspend')) {
      await settle();
      r.suspend = await save('suspend', () => page.locator('#suspend').click(), () => until(['suspended']).then(() => undefined));
      say(`round ${k} suspend`, r.suspend as Record<string, unknown>);
      // The resume: the page opened again starts the machine from its suspended copy.
      const tr = performance.now();
      await page.goto(url);
      await until(['running', 'booting', 'failed']);
      if (!(await messageText()).includes(t('machine:worker.resumed'))) throw new Error(`no resume: ${await messageText()}`);
      await page.waitForFunction(() => !!document.getElementById('message')?.dataset.load, null, { timeout: 10_000 });
      r.resume = round({ wallMs: performance.now() - tr, phases: JSON.parse(await data('load')) });
      say(`round ${k} resume`, r.resume as Record<string, unknown>);
    }
    results.push(r);
  }
}

const meta = { guest, mode: MODE, profile: offRecord ? 'off the record' : 'persistent', ops: [...OPS], file: warm, bytes: (await openAsBlob(warm)).size, rounds: ROUNDS, settleS: SETTLE_S, commit: commit(), core: sha(CORE_PATH), chromium: chromiumVersion, host: `${cpus().length} CPUs ${cpus()[0]?.model ?? ''}`.trim(), date: new Date().toISOString(), wallS: Math.round((performance.now() - t0) / 1000) };
writeFileSync(out, JSON.stringify({ meta, rounds: results }, null, 1) + '\n');
console.log('wrote', out);
await ctx.close();
if (offRecord) await ctx.browser()?.close();
server.close();
process.exit(0);
