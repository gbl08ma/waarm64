// bench/remote-disk/boot.ts's runs summed up per phase (between its marks): wall time, the disk's base reads (count,
// MB, ms inside them, share of the phase) and, for a local server, the requests that reached it (Chromium's HTTP
// cache answers the rest) and their MB; and the reads' sizes. One table a run.
//   node bench/remote-disk/summary.ts <run.json>...
import { readFileSync } from 'node:fs';

type Run = { label: string; marks: Record<string, number>; io?: { trace: number[] }; server?: { t: number; method: string; start: number; end: number }[]; error?: string };

export function phases(r: Run) {
  const names = Object.keys(r.marks);
  const bounds = [0, ...names.map((n) => r.marks[n])];
  const tr = r.io?.trace ?? [];
  return names.map((name, k) => {
    const [a, b] = [bounds[k], bounds[k + 1]];
    let reads = 0, bytes = 0, ms = 0;
    for (let i = 0; i < tr.length; i += 4) if (tr[i] >= a && tr[i] < b) { reads++; bytes += tr[i + 2]; ms += tr[i + 3]; }
    const net = r.server?.filter((s) => s.method === 'GET' && s.t >= a && s.t < b);
    return { phase: name, s: +((b - a) / 1000).toFixed(1), at: +(b / 1000).toFixed(1), reads, MB: +(bytes / 1e6).toFixed(1), readS: +(ms / 1000).toFixed(1), readPct: +((100 * ms) / (b - a)).toFixed(0), ...(net ? { requests: net.length, netMB: +(net.reduce((n, s) => n + s.end - s.start + 1, 0) / 1e6).toFixed(1) } : {}) };
  });
}

export function sizes(r: Run) {
  const tr = r.io?.trace ?? [];
  const h = new Map<number, [number, number]>();
  for (let i = 0; i < tr.length; i += 4) {
    const k = Math.max(12, Math.ceil(Math.log2(tr[i + 2])));
    const e = h.get(k) ?? [0, 0];
    e[0]++;
    e[1] += tr[i + 2];
    h.set(k, e);
  }
  return [...h].sort((a, b) => a[0] - b[0]).map(([k, [n, b]]) => ({ upTo: k >= 20 ? `${2 ** (k - 20)} MiB` : `${2 ** (k - 10)} KiB`, reads: n, MB: +(b / 1e6).toFixed(1) }));
}

if (import.meta.main) {
  for (const f of process.argv.slice(2)) {
    const r = JSON.parse(readFileSync(f, 'utf8')) as Run;
    console.log(`\n${r.label}${r.error ? ` (failed: ${r.error.slice(0, 120)})` : ''}`);
    console.table(phases(r));
    console.table(sizes(r));
  }
}
