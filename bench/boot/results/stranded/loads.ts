// Workers stranded at a machine's end (bench/boot/REPORT.md): Chromium started by hand and driven over raw CDP (no
// worker auto-attach, unlike Playwright), Debian booted on the page's transient machine, then LOADS loads of SNAP (a
// snapshot of it, saved from the page). After each, the renderer's RSS and anonymous memory (MiB) and the worker
// targets. CHROMIUM=<binary> SNAP=<file> [LOADS=8] node bench/boot/results/stranded/loads.ts
import { readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../../../tools/serve.ts';
import { credentialsQuery } from '../../../../tests/debian-unattended.ts';

const LOADS = Number(process.env.LOADS ?? 8);
const SNAP = process.env.SNAP!;
const server = await startServer(8232);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const prof = mkdtempSync(join(tmpdir(), 'stranded-'));
const chrome = spawn(process.env.CHROMIUM!, ['--headless', '--no-sandbox', `--user-data-dir=${prof}`, '--remote-debugging-port=9341', '--window-size=1200,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ver: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:9341/json/version')).json() as typeof ver; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const ws = new WebSocket(ver!.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map<number, (v: { result?: Record<string, unknown>; error?: unknown }) => void>();
ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } });
const send = (method: string, params: object = {}, sessionId?: string) => new Promise<{ result?: Record<string, unknown>; error?: unknown }>((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const tgts = (await send('Target.getTargets')).result!.targetInfos as { targetId: string; type: string; url: string }[];
const pageT = tgts.find((t) => t.type === 'page')!;
const sid = (await send('Target.attachToTarget', { targetId: pageT.targetId, flatten: true })).result!.sessionId as string;
const ev = async (expr: string) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid); return (r.result as { result?: { value?: unknown } })?.result?.value; };
await send('Page.enable', {}, sid); await send('DOM.enable', {}, sid);
const watch = `(() => { if (window.__w) return; window.__w = 1; const tick = () => { const d = document.getElementById('ask'); if (!d?.open || d.dataset.answered === d.dataset.serial) return; d.dataset.answered = d.dataset.serial; d.querySelector('[data-answer=ok]')?.click(); }; new MutationObserver(tick).observe(document, { subtree: true, childList: true, attributes: true }); tick(); })()`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: `${watch}; window.showSaveFilePicker = undefined;` }, sid);
await send('Page.navigate', { url: `${base}/web/app/?machine=debian&ncpus=2&view=terminal&clocksync=0&${credentialsQuery()}` }, sid);
const state = () => ev(`document.body?.dataset.state ?? ''`) as Promise<string>;
async function until(s: string[], ms = 900_000) { const t = Date.now(); while (Date.now() - t < ms) { const x = await state(); if (s.includes(x)) return x; await new Promise((r) => setTimeout(r, 300)); } throw new Error(`timeout waiting for ${s}`); }
const typeOf = (cmd: string) => /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'browser';
/** This browser's processes: the one started here and its descendants. */
function ours(): number[] {
  const parent = new Map<number, number>();
  for (const p of readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)) {
    try { const st = readFileSync(`/proc/${p}/stat`, 'utf8'); parent.set(p, Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1])); } catch { /* gone */ }
  }
  const pids = [chrome.pid!];
  for (let i = 0; i < pids.length; i++) for (const [p, pp] of parent) if (pp === pids[i]) pids.push(p);
  return pids;
}
/** The largest renderer of this browser (the page's): [RSS, anonymous] MiB. */
function renderer() {
  let best = [0, 0];
  for (const p of ours()) {
    try {
      if (typeOf(readFileSync(`/proc/${p}/cmdline`, 'utf8')) !== 'renderer') continue;
      const r = readFileSync(`/proc/${p}/smaps_rollup`, 'utf8');
      const g = (k: string) => Math.round(Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(r)?.[1] ?? 0) / 1024);
      if (g('Rss') > best[0]) best = [g('Rss'), g('Anonymous')];
    } catch { /* gone */ }
  }
  return best;
}
const workers = async () => { const t = (await send('Target.getTargets')).result!.targetInfos as { type: string; url: string }[]; const c: Record<string, number> = {}; for (const x of t.filter((x) => x.type === 'worker')) { const k = x.url.split('/').pop()!.split('?')[0]; c[k] = (c[k] ?? 0) + 1; } return JSON.stringify(c); };
await until(['running']);
console.log('booted');
await new Promise((r) => setTimeout(r, 5000));
console.log('before', renderer(), await workers());
const doc = (await send('DOM.getDocument', {}, sid)).result!.root as { nodeId: number };
for (let k = 0; k < LOADS; k++) {
  const n = (await send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#load-snapshot-input' }, sid)).result!.nodeId as number;
  await send('DOM.setFileInputFiles', { files: [SNAP], nodeId: n }, sid);
  const t0 = Date.now(); while ((await state()) !== 'loading' && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 30));
  const s = await until(['running', 'failed', 'crashed', 'off']);
  if (s !== 'running') throw new Error(s);
  await new Promise((r) => setTimeout(r, 10_000));
  console.log(`load ${k}`, renderer(), await workers());
}
chrome.kill(); server.close(); process.exit(0);
