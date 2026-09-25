// Quick Node entry for the spike (same V8 family, faster iteration than Chromium).
import { runAll } from './benchmarks.ts';

const quick = process.argv.includes('--quick');
for (const s of await runAll({ quick, log: (m) => console.error(m) })) {
  const sorted = [...s.samples].sort((a, b) => a - b);
  console.log(s.name.padEnd(28), JSON.stringify(s.params ?? {}).padEnd(70), sorted[sorted.length >> 1].toFixed(3), s.unit);
}
