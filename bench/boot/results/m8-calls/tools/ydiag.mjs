// Y:<i> diagnostic counts per phase from userprof marks.
import { readFileSync } from 'node:fs';
const { marks } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const y = (m) => Object.fromEntries(m.report.filter((r) => r.op.startsWith('Y:')).map((r) => [r.op, r.calls]));
const N = ['calls returned', 'flagged', 'cont matched', 'ret_up', 'depth-limit tail'];
for (let i = 1; i < marks.length; i++) {
  const [a, b] = [y(marks[i - 1]), y(marks[i])];
  const st = marks[i].steps - marks[i - 1].steps; if (marks[i].ms - marks[i - 1].ms < 50) continue;
  const disp = marks[i].stats.jit.dispatches - marks[i - 1].stats.jit.dispatches;
  console.log(marks[i - 1].name.slice(0, 20).padEnd(20), N.map((n, k) => `${n} ${((1000 * ((b['Y:' + k] ?? 0) - (a['Y:' + k] ?? 0))) / st).toFixed(2)}`).join(', '), `dispatch ${(1000 * disp / st).toFixed(2)} /1000 insns`);
}
