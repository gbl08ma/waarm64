// The A/B of a CPU feature on programs that pick their paths from the hwcaps (bench/boot/REPORT.md "FEAT_DotProd and FEAT_JSCVT, measured"):
// the Arch desktop disk on 4 vCPUs, a root shell, codecs.sh on the second disk (codecs-disk.sh), alternating arms, a
// boot per arm and round. Writes <out>/<round>-<arm>.txt with the guest's lines and prints the medians by arm.
//   timeout 3000 node bench/imgdecode/codecs.ts <feature> <mode: codecs|js> [rounds, 3] [repeats in a boot, 3]
// Env: OUT (bench/boot/results/<feature>).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const [feature, mode, rounds = '3', repeats = '3'] = process.argv.slice(2);
if (!feature || !mode) throw new Error('usage: codecs.ts <feature> <codecs|js> [rounds] [repeats]');
const out = process.env.OUT ?? `bench/boot/results/${feature}`;
mkdirSync(out, { recursive: true });
const first = Number(process.env.FIRST ?? 1);

async function one(round: number, on: boolean): Promise<string> {
  const s = await openSession({ gpu: 'virgl', image: 'target/arch/desktop.qcow2', out: `target/imgdecode/out`, ncpus: 4, ramMiB: 3072, disk2: '/target/imgdecode/codecs.ext4', query: on ? undefined : `${feature}=0` });
  await s.rootShell();
  await s.run('mkdir -p /mnt/i; mount -o ro /dev/vdb /mnt/i; systemctl stop greetd 2>/dev/null; dmesg -n 1');
  await s.onSerial(`sh /mnt/i/codecs.sh /mnt/i ${mode} ${repeats} > /tmp/out.txt 2>&1; echo CODECS-""DONE\n`);
  await s.shows(/CODECS-DONE/, 3_000_000);
  // The results a screenful at a time: the serial terminal shows the last rows only.
  const lines: string[] = [];
  const total = Number((await s.run('wc -l < /tmp/out.txt')).trim());
  for (let i = 1; i <= total; i += 20) lines.push(...(await s.run(`sed -n '${i},${i + 19}p' /tmp/out.txt | tr '\\n' '|'`)).trim().split('|').filter(Boolean));
  await s.close();
  return lines.join('\n') + '\n';
}

const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
function table() {
  const by: Record<string, Record<string, Record<number, number[]>>> = {};
  for (let r = 1; r <= Number(rounds) + first - 1; r++) for (const arm of ['off', 'on']) {
    let text: string;
    try { text = readFileSync(`${out}/${mode}-${r}-${arm}.txt`, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      const m = /^(?:CODEC|JS|Q8DOT) (.*?) (\S+?)(?: ms)?(?: check.*)?$/.exec(l.replace(/^JS (\S+) (\S+) /, 'JS $1-$2 '));
      if (!m) continue;
      ((((by[m[1]] ??= {})[arm] ??= {})[r] ??= [])).push(Number(m[2]));
    }
  }
  for (const [k, arms] of Object.entries(by)) {
    const rs = (a: string) => Object.values(arms[a] ?? {}).map(med);
    const [off, on] = [rs('off'), rs('on')];
    if (!off.length || !on.length) { console.log(k, JSON.stringify(arms)); continue; }
    console.log(`${k}: off ${med(off)} [${off.join(' ')}]  on ${med(on)} [${on.join(' ')}]  on/off ${(med(on) / med(off)).toFixed(3)}`);
  }
}

for (let r = first; r < first + Number(rounds); r++) {
  // Alternating, the order swapped each round.
  for (const on of r % 2 ? [false, true] : [true, false]) {
    const t0 = Date.now();
    const text = await one(r, on);
    writeFileSync(`${out}/${mode}-${r}-${on ? 'on' : 'off'}.txt`, text);
    console.log(`# ${mode} round ${r} ${on ? 'on' : 'off'}: ${((Date.now() - t0) / 1000).toFixed(0)} s, ${text.split('\n').length} lines`);
  }
}
table();
