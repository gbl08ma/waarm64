// What the page's memory signal is checked against (docs/jit.md "Memory", "The page's memory signal"; dev-only): the
// renderer's RSS by mapping class from /proc/<pid>/smaps (the biggest Chromium renderer: the page's), and
// `performance.measureUserAgentSpecificMemory()` from the page, its breakdown grouped by realm (attribution scope and
// URL) and by type. bench/gpu/guest-session.ts samples both under MEMLOG=<seconds> into <out>/mem.jsonl, with the
// page's own estimate (`__status.memory`, web/app/memory.ts) beside them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';

/** The biggest Chromium renderer's pid (the page's: the guest's memory is in it); none without /proc (the Mac). */
export function rendererPid(): number | undefined {
  if (!existsSync('/proc')) return undefined;
  let best: number | undefined, rss = 0;
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (!readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=renderer')) continue;
      const r = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${d}/status`, 'utf8'))?.[1] ?? 0);
      if (r > rss) [best, rss] = [Number(d), r];
    } catch {}
  }
  return best;
}

/**
 * A renderer's RSS by class, MiB: `wasm-mem` (anonymous reservations of 1 GiB or more: the wasm memories, guest RAM and
 * the core's heap), `shared` (shared mappings past 3 MB),
 * `code` (executable anonymous mappings: V8's wasm and JS code), `exec-lib` (Chromium's own text), `anon` (the rest
 * that's anonymous and writable: PartitionAlloc, V8's heaps, malloc), `other`; `total`, and the shared mappings' sizes
 * (their reservations) with their RSS, largest first.
 */
export function smapsClasses(pid: number) {
  const cls: Record<string, number> = { 'wasm-mem': 0, shared: 0, code: 0, 'exec-lib': 0, anon: 0, other: 0 };
  const big: [number, number][] = [];
  let cur: { perm: string; name: string; size: number; rss: number } | undefined;
  const add = () => {
    if (!cur) return;
    const anon = !cur.name || cur.name.startsWith('[anon');
    // A wasm memory is an anonymous reservation of its maximum and guard regions (gigabytes), resident where touched.
    const k = /s/.test(cur.perm) && cur.size > 3e6 ? 'shared' : /x/.test(cur.perm) ? (anon ? 'code' : 'exec-lib') : anon && cur.size >= 2 ** 30 ? 'wasm-mem' : anon && /rw/.test(cur.perm) ? 'anon' : 'other';
    cls[k] += cur.rss;
    if (k === 'shared' || k === 'wasm-mem') big.push([cur.size, cur.rss]);
  };
  let txt = '';
  try { txt = readFileSync(`/proc/${pid}/smaps`, 'utf8'); } catch { return undefined; }
  for (const line of txt.split('\n')) {
    const h = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (h) { add(); cur = { perm: h[3], name: h[4], size: parseInt(h[2], 16) - parseInt(h[1], 16), rss: 0 }; } else if (cur && line.startsWith('Rss:')) cur.rss = Number(line.split(/\s+/)[1]) * 1024;
  }
  add();
  const mib = (b: number) => Math.round(b / 2 ** 20);
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, mib(v)]));
  out.total = mib(Object.values(cls).reduce((a, b) => a + b, 0));
  out.sharedMaps = big.sort((a, b) => b[0] - a[0]).slice(0, 12).map(([s, r]) => [mib(s), mib(r)]);
  return out;
}

/** `measureUserAgentSpecificMemory` from the page, MiB: its total, and its breakdown by realm (scope and file) and by type; the call's ms. */
export async function uasm(page: Page) {
  return page.evaluate(async () => {
    const t0 = performance.now();
    type Entry = { bytes: number; types: string[]; attribution: { url: string; scope: string }[] };
    const r = await (performance as unknown as { measureUserAgentSpecificMemory(): Promise<{ bytes: number; breakdown: Entry[] }> }).measureUserAgentSpecificMemory();
    const realm: Record<string, number> = {}, type: Record<string, number> = {};
    for (const e of r.breakdown) {
      const k = e.attribution.map((a) => `${a.scope} ${a.url.replace(/^.*\//, '').replace(/\?.*/, '')}`).join('+') || '(none)';
      realm[k] = (realm[k] ?? 0) + e.bytes / 2 ** 20;
      const t = e.types.join(',') || '(none)';
      type[t] = (type[t] ?? 0) + e.bytes / 2 ** 20;
    }
    const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
    return { mib: Math.round(r.bytes / 2 ** 20), realms: r.breakdown.length, byRealm: round(realm), byType: round(type), ms: Math.round(performance.now() - t0) };
  });
}
