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

/** One mapping of /proc/<pid>/smaps: its permissions, name, size (its reservation) and resident and huge-page bytes. */
export type Mapping = { perm: string; name: string; size: number; rss: number; thp: number };

/** /proc/<pid>/smaps's text as mappings (`Rss` and `AnonHugePages` in bytes). */
export function parseSmaps(txt: string): Mapping[] {
  const maps: Mapping[] = [];
  let cur: Mapping | undefined;
  for (const line of txt.split('\n')) {
    const h = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (h) maps.push((cur = { perm: h[3], name: h[4], size: parseInt(h[2], 16) - parseInt(h[1], 16), rss: 0, thp: 0 }));
    else if (cur && line.startsWith('Rss:')) cur.rss = Number(line.split(/\s+/)[1]) * 1024;
    else if (cur && line.startsWith('AnonHugePages:')) cur.thp = Number(line.split(/\s+/)[1]) * 1024;
  }
  return maps;
}

export const CLASSES = ['wasm-mem', 'shared', 'code', 'exec-lib', 'anon', 'other'] as const;
export type SmapsClass = (typeof CLASSES)[number];

/**
 * A mapping's class: `wasm-mem` (anonymous reservations of 1 GiB or more: the wasm memories, guest RAM and the core's
 * heap), `shared` (shared mappings past 3 MB), `code` (executable anonymous mappings: V8's wasm and JS code),
 * `exec-lib` (Chromium's own text), `anon` (the rest that's anonymous and writable: PartitionAlloc, V8's heaps,
 * malloc), `other`.
 */
export function smapsClass(m: Mapping): SmapsClass {
  const anon = !m.name || m.name.startsWith('[anon');
  // A wasm memory is an anonymous reservation of its maximum and guard regions (gigabytes), resident where touched.
  return /s/.test(m.perm) && m.size > 3e6 ? 'shared' : /x/.test(m.perm) ? (anon ? 'code' : 'exec-lib') : anon && m.size >= 2 ** 30 ? 'wasm-mem' : anon && /rw/.test(m.perm) ? 'anon' : 'other';
}

/** A renderer's RSS by class (smapsClass), MiB: the classes, `total`, and the wasm memories' and shared mappings' sizes with their RSS, largest first. */
export function smapsClasses(pid: number) {
  let txt = '';
  try { txt = readFileSync(`/proc/${pid}/smaps`, 'utf8'); } catch { return undefined; }
  const cls: Record<string, number> = Object.fromEntries(CLASSES.map((k) => [k, 0]));
  const big: [number, number][] = [];
  for (const m of parseSmaps(txt)) {
    const k = smapsClass(m);
    cls[k] += m.rss;
    if (k === 'shared' || k === 'wasm-mem') big.push([m.size, m.rss]);
  }
  const mib = (b: number) => Math.round(b / 2 ** 20);
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, mib(v)]));
  out.total = mib(Object.values(cls).reduce((a, b) => a + b, 0));
  out.sharedMaps = big.sort((a, b) => b[0] - a[0]).slice(0, 12).map(([s, r]) => [mib(s), mib(r)]);
  return out;
}

/** Per class (smapsClass), bytes: resident, reserved (`size`), in transparent huge pages (`thp`), and the mappings' count. */
export function smapsTotals(maps: Mapping[]) {
  const zero = () => ({ rss: 0, size: 0, thp: 0, n: 0 });
  const cls = Object.fromEntries(CLASSES.map((k) => [k, zero()])) as Record<SmapsClass, ReturnType<typeof zero>>;
  const total = zero();
  for (const m of maps) {
    for (const c of [cls[smapsClass(m)], total]) { c.rss += m.rss; c.size += m.size; c.thp += m.thp; c.n++; }
  }
  return { cls, total };
}

/** The kernel's own RSS counters of a process (/proc/<pid>/status: VmRSS, RssAnon, RssFile, RssShmem), bytes. */
export function statusRss(pid: number): Record<string, number> | undefined {
  try {
    const txt = readFileSync(`/proc/${pid}/status`, 'utf8');
    return Object.fromEntries(['VmRSS', 'RssAnon', 'RssFile', 'RssShmem'].map((k) => [k, Number(new RegExp(`${k}:\\s+(\\d+)`).exec(txt)?.[1] ?? 0) * 1024]));
  } catch { return undefined; }
}

/**
 * A process's smapsTotals, its largest code mappings ([size, rss, thp] bytes, by rss), the ms the read took, and the
 * kernel's RSS counters read just before and after it (smaps is read in pieces while the process maps and unmaps, its
 * sum is not one moment's: the counters are); none without /proc.
 */
export function smapsDetail(pid: number) {
  let txt = '';
  const before = statusRss(pid);
  const t0 = performance.now();
  try { txt = readFileSync(`/proc/${pid}/smaps`, 'utf8'); } catch { return undefined; }
  const readMs = Math.round(performance.now() - t0);
  const after = statusRss(pid);
  const maps = parseSmaps(txt);
  const topCode = maps.filter((m) => smapsClass(m) === 'code').sort((a, b) => b.rss - a.rss).slice(0, 8).map((m) => [m.size, m.rss, m.thp]);
  return { ...smapsTotals(maps), topCode, readMs, before, after };
}

/** The kernel's transparent-huge-page counters (/proc/vmstat's `thp_*`) and the system's AnonHugePages (bytes). */
export function thpCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const l of readFileSync('/proc/vmstat', 'utf8').split('\n')) {
      const m = /^(thp_\w+) (\d+)$/.exec(l);
      if (m) out[m[1]] = Number(m[2]);
    }
    out.anonHugePages = Number(/AnonHugePages:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) * 1024;
  } catch {}
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
