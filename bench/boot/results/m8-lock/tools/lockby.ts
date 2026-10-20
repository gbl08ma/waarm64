// Per-caller lock counts from a session's results.json (the diagnostic patch's jit.lockBy).
import { readFileSync } from 'node:fs';
const NAMES = ['new', 'report', 'queued', 'compiled', 'notyet', 'sync', 'tier', 'other', 'never', '(refill)', '(known)', '(empty)'];
for (const d of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(`${d}/results.json`, 'utf8'));
  const j = r.jit, by: number[] = j.lockBy ?? [];
  console.log(`${d}: locks ${j.locks} contended ${((j.lockContended / j.locks) * 100).toFixed(2)}% wait ${(j.lockWaitNs / 1e9).toFixed(1)} s`);
  for (let i = 0; i < NAMES.length && by.length; i++) {
    const [n, c, w] = [by[3 * i], by[3 * i + 1], by[3 * i + 2]];
    console.log(`  ${NAMES[i].padEnd(9)} ${String(n).padStart(11)} ${((n / j.locks) * 100).toFixed(1).padStart(5)}%  contended ${((c / Math.max(n, 1)) * 100).toFixed(2).padStart(5)}%  wait ${(w / 1e9).toFixed(2).padStart(7)} s`);
  }
}
