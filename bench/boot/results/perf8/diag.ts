// Prints the helper calls of a userprof.ts OUT file per phase, with the diag core's M: lines decoded.
import { readFileSync } from 'node:fs';
const marks = JSON.parse(readFileSync(process.argv[2], 'utf8')).marks as { name: string; ms: number; steps: number; report: { op: string; calls: number }[] }[];
const names: Record<number, string> = {};
const sr = (o0: number, o1: number, n: number, m: number, o2: number) => ((o0 - 2) << 14) | (o1 << 11) | (n << 7) | (m << 3) | o2;
Object.assign(names, { [sr(3, 3, 4, 2, 0)]: 'NZCV', [sr(3, 3, 4, 2, 1)]: 'DAIF', [sr(3, 3, 4, 4, 0)]: 'FPCR', [sr(3, 3, 4, 4, 1)]: 'FPSR', [sr(3, 0, 4, 2, 0)]: 'SPSel', [sr(3, 0, 1, 0, 0)]: 'SCTLR', [sr(3, 0, 2, 0, 0)]: 'TTBR0', [sr(3, 0, 2, 0, 1)]: 'TTBR1', [sr(3, 0, 1, 0, 2)]: 'CPACR', [sr(3, 0, 2, 0, 2)]: 'TCR', [sr(3, 0, 4, 2, 2)]: 'CurrentEL', [sr(3, 3, 14, 3, 1)]: 'CNTV_CTL', [sr(3, 3, 14, 3, 2)]: 'CNTV_CVAL', [sr(3, 3, 14, 3, 0)]: 'CNTV_TVAL', [sr(3, 0, 12, 12, 1)]: 'ICC_EOIR1', [sr(3, 0, 12, 11, 5)]: 'ICC_SGI1R', [sr(3, 0, 12, 12, 0)]: 'ICC_IAR1', [sr(3, 0, 4, 6, 0)]: 'ICC_PMR', [sr(3, 0, 12, 0, 0)]: 'VBAR', [sr(3, 0, 13, 0, 1)]: 'CONTEXTIDR', [sr(3, 0, 10, 2, 0)]: 'MAIR', [sr(3, 0, 4, 2, 3)]: 'PAN', [sr(3, 0, 4, 2, 4)]: 'UAO', [sr(3, 3, 14, 1, 0)]: 'CNTKCTL', [sr(3, 0, 14, 1, 0)]: 'CNTKCTL_EL1', [sr(3, 0, 1, 0, 1)]: 'ACTLR', [sr(3, 0, 12, 11, 7)]: 'ICC_SGI0R', [sr(3, 0, 4, 2, 5)]: 'DIT?', [sr(3, 0, 12, 12, 5)]: 'ICC_CTLR?', [sr(3, 0, 0, 0, 0)]: 'MIDR' });
const key = (k: number) => {
  const isb = k >> 18 & 1, imm = k >> 16 & 1, el = k >> 17 & 1, r = k & 0xffff;
  if (isb) return `ISB el${el}`;
  if (imm) { const op1 = r >> 11 & 7, crm = r >> 3 & 15, op2 = r & 7; const n = op1 === 3 && op2 === 7 ? 'DAIFClr' : op1 === 3 && op2 === 6 ? 'DAIFSet' : op1 === 0 && op2 === 5 ? 'SPSel#' : op1 === 0 && op2 === 4 ? 'PAN#' : op1 === 0 && op2 === 3 ? 'UAO#' : `imm${op1}.${op2}`; return `MSRi ${n}#${crm} el${el}`; }
  return `MSRr ${names[r] ?? r.toString(16)} el${el}`;
};
const rep = (m: (typeof marks)[0]) => new Map(m.report.map((h) => [h.op, h.calls]));
const sel = process.argv[3] ? process.argv[3].split(',') : null;
for (let i = 1; i < marks.length; i++) {
  const [a, b] = [rep(marks[i - 1]), rep(marks[i])];
  const ms = marks[i].ms - marks[i - 1].ms;
  if (ms < 50) continue;
  const d = [...b].map(([k, n]) => [k, n - (a.get(k) ?? 0)] as [string, number]).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  const steps = marks[i].steps - marks[i - 1].steps;
  console.log(`== ${marks[i - 1].name} -> ${marks[i].name}: ${(ms / 1000).toFixed(2)} s, ${(steps / 1e6).toFixed(0)}M steps`);
  console.log('  ' + d.filter(([k]) => !k.startsWith('M:')).slice(0, 14).map(([k, n]) => `${k} ${n}`).join(', '));
  console.log('  ' + d.filter(([k]) => k.startsWith('M:')).map(([k, n]) => `${key(parseInt(k.slice(2), 16))} ${n}`).join(', '));
  const mm = d.filter(([k]) => /^(LD|ST)[SU](MAX|MIN)/.test(k));
  if (mm.length) console.log('  minmax: ' + mm.map(([k, n]) => `${k} ${n}`).join(', '));
}
