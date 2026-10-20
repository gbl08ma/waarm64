// Benchmark sessions started from a snapshot (docs/benchmarking.md "Starting from a snapshot"; dev-only, not in tests):
// a warm guest saved once with the page's Save snapshot, then loaded by each arm of an A/B with Load snapshot…, so an
// arm skips the boot, the login and the desktop's start. The JIT's code isn't in a snapshot (docs/plans/snapshots.md
// "What a snapshot holds"): a restored machine starts with no compiled code, no TLB and zeroed counters, whatever core
// made the file. The page loads a file whose core state format (`snapshot_version`) and machine (devices, vCPUs, RAM,
// CPU features) match: a core that differs only in its JIT or its build loads it; one with another state layout is
// refused. `sidecar` keeps what made the file beside it (<file>.json): the core's SHA-256, the commit, the scene.
// Playwright saves a download in the browser's downloadsPath first (a temporary directory under /tmp, which is RAM on
// the dev VM): the tools that save one launch with `downloadsPath: process.env.WEBPC_DOWNLOADS`, a directory on a disk.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openAsBlob, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { openSnapshot } from '../web/snapshot-file.ts';

/** The core the page loads (bench/snapshot-start.ts `routeCore` can serve another). */
export const CORE_PATH = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url).pathname;

/** A file's SHA-256, hex, first 16 digits (enough to tell builds apart). */
export const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);

/**
 * Serves `core` as the page's core (the machine worker's fetch of webpc_core.wasm) instead of target/'s, so arms
 * needn't copy builds over target/ (which leaves the last one copied there, newer than the sources). Returns a
 * counter of the requests served: 0 after `running` means the page never asked (it read target/'s).
 */
export async function routeCore(page: Page, core: string) {
  const served = { n: 0, sha: sha(core) };
  await page.context().route('**/webpc_core.wasm', (r) => { served.n++; return r.fulfill({ path: core, contentType: 'application/wasm' }); });
  return served;
}

/** What made a snapshot file (`sidecar`): read back by an arm to say which core made what it loads. */
export type Made = { scene: string; core: string; commit: string; query?: string; created: string; bytes: number; pausedMs?: number; [k: string]: unknown };

/** The commit and whether the tree had changes, for the record. */
export function commit() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return 'unknown';
  }
}

/**
 * Save snapshot on the page, as a download kept at `path` (the page's numbers: the file's bytes, the machine's pause),
 * and the sidecar <path>.json. The page must have `showSaveFilePicker` hidden (a download, not a picker).
 */
export async function saveSnapshotFile(page: Page, path: string, made: { scene: string; core?: string; query?: string; [k: string]: unknown }) {
  const before = await page.evaluate(() => document.getElementById('message')?.dataset.snapshot ?? '');
  const download = page.waitForEvent('download', { timeout: 600_000 });
  const t0 = performance.now();
  await page.locator('#save-snapshot').click();
  await page.waitForFunction((b) => { const m = document.getElementById('message'); return (m?.dataset.snapshot ?? '') !== b || /no file was saved/.test(m?.textContent ?? ''); }, before, { timeout: 600_000, polling: 100 });
  const msg = await page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
  if (!/^Saved the snapshot/.test(msg)) throw new Error(`the snapshot failed: ${msg}`);
  const numbers = JSON.parse(await page.evaluate(() => document.getElementById('message')!.dataset.snapshot!)) as { bytes: number; pausedMs: number };
  const d = await download;
  await d.saveAs(path);
  await d.delete();
  const wallMs = Math.round(performance.now() - t0);
  const header = (await openSnapshot(await openAsBlob(path))).header;
  const record: Made = { ...made, core: sha(made.core ?? CORE_PATH), commit: commit(), created: String(header.created), bytes: statSync(path).size, pausedMs: Math.round(numbers.pausedMs), wallMs, coreVersion: header.coreVersion, abi: header.abi };
  writeFileSync(`${path}.json`, JSON.stringify(record, null, 1) + '\n');
  return record;
}

/**
 * Loads the snapshot at `path` into the page's machine (Load snapshot…, the confirmation answered by
 * tests/page-ask.ts's `answerAsks`), once the page has a machine to replace (`booting` or `running`: the page starts
 * the machine its query names first; the restore stops it and starts a new machine worker, with new vCPU workers and
 * an empty code cache). Resolves when the restored machine runs; throws with the page's message if it doesn't. The
 * file's header and sidecar say what made it (`from` in a session's results).
 */
export async function loadSnapshotFile(page: Page, path: string, core = CORE_PATH) {
  const header = (await openSnapshot(await openAsBlob(path))).header;
  let made: Partial<Made> = {};
  try { made = JSON.parse(readFileSync(`${path}.json`, 'utf8')) as Made; } catch { /* no sidecar */ }
  await page.waitForFunction(() => ['booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 300_000, polling: 100 });
  const t0 = performance.now();
  await page.setInputFiles('#load-snapshot-input', path);
  await page.waitForFunction(() => document.getElementById('boot-title')?.textContent?.startsWith('Loading '), null, { timeout: 60_000, polling: 20 });
  await page.waitForFunction(() => ['running', 'failed', 'crashed'].includes(document.body.dataset.state!), null, { timeout: 600_000, polling: 100 });
  const state = await page.evaluate(() => document.body.dataset.state);
  if (state !== 'running') throw new Error(`the snapshot ${path} didn't load: ${await page.evaluate(() => document.getElementById('message-text')?.textContent ?? '')}`);
  const running = sha(core);
  return {
    file: path, bytes: statSync(path).size, loadMs: Math.round(performance.now() - t0), created: header.created, coreVersion: header.coreVersion, abi: header.abi,
    scene: made.scene, madeBy: made.core, madeAt: made.commit, core: running, sameCore: made.core === running,
  };
}

/** A per-session marker prefix for commands typed on a terminal: a restored terminal shows the saving session's markers. */
export const sessionTag = () => Math.random().toString(36).slice(2, 6).replace(/\d/g, (d) => 'ghijklmnop'[+d]);
