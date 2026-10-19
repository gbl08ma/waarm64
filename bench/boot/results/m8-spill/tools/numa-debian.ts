// Spill memories on Debian (docs/spill-memories.md; dev-only, not in tests): the page's Debian with RAM past memory 0
// (`?ram=`, the automatic split), headless Chromium, realtime. What the guest sees (nodes, distances, NUMA balancing,
// the credential), where the boot put its memory (each node's meminfo right after the login), then workloads bound to
// node 0 and to node 1 in turn (systemd-run's NUMAPolicy=bind; their input on a tmpfs bound to the same node), timed
// in the guest (ms), alternating 0, 1 then 1, 0. Every command is run unbound once first, so the programs' text is in
// the page cache before either side (it is shared, wherever it landed).
//   node bench/boot/results/m8-spill/tools/numa-debian.ts [outdir]
// RAM (MiB, default 6144), NCPUS (default 2), ROUNDS (default 5), ONLY (a comma list of workloads), MB (the data
// file's size, default 64).
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';
import { unattendedQuery } from '../../../../../tests/debian-unattended.ts';
import { answerAsks } from '../../../../../tests/page-ask.ts';

const out = process.argv[2] ?? new URL('../../../../results/local/spill/debian/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const RAM = Number(process.env.RAM ?? 6144), NCPUS = Number(process.env.NCPUS ?? 2), ROUNDS = Number(process.env.ROUNDS ?? 5), MB = Number(process.env.MB ?? 64);
/** The workloads: a name and a command (`$D`: the data file on the bound node's tmpfs, `$S`: its first 16 MiB). */
const ALL: [string, string][] = [
  ['zero', 'dd if=/dev/zero of=/dev/null bs=4M count=128 2>/dev/null'],
  ['copy', 'cat $D > /dev/null'],
  ['sha256', 'sha256sum $D'],
  ['gzip', 'gzip -1 -c $D | wc -c'],
  ['sort', 'sort -S 256M $S | md5sum'],
  ['perl', `perl -e 'my %h; $h{$_} = $_ * 2 for 1 .. 300000; my $s = 0; $s += $h{$_} for keys %h; print $s'`],
];
const ONLY = process.env.ONLY?.split(',');
const WORK = ALL.filter(([n]) => !ONLY || ONLY.includes(n));

const t0 = performance.now();
const log = (...a: unknown[]) => console.log(`[${((performance.now() - t0) / 1000).toFixed(0)} s]`, ...a);
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const results: Record<string, unknown> = { ram: RAM, ncpus: NCPUS, rounds: ROUNDS, mb: MB, chromium: browser.version(), date: new Date().toISOString() };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
let mark = 0;
/** Runs `cmd` on the serial console and returns what it printed between two markers (xterm's rows run together). */
async function run(page: Page, cmd: string, ms = 600_000): Promise<string> {
  const k = ++mark;
  // The markers are split in the typed line, so the line's echo never matches.
  await page.keyboard.type(`clear; echo "<${k}""<"; ${cmd}; echo ">${k}"">"\n`, { delay: 2 });
  const re = new RegExp(`<${k}<([\\s\\S]*?)>${k}>`);
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
  return (await terminal(page)).match(re)![1].trim();
}

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror', String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?ncpus=${NCPUS}&ram=${RAM}&view=both&gpu=2d&${unattendedQuery()}`);
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), undefined, { timeout: 300_000, polling: 250 });
  const state = await page.evaluate(() => document.body.dataset.state);
  if (state !== 'running') throw new Error(`the page is ${state}`);
  await page.locator('.xterm').click();
  await page.keyboard.type('root\n', { delay: 5 });
  await page.waitForFunction(() => /root@\S+:~#/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), undefined, { timeout: 120_000 });
  log('logged in');
  const N = '/sys/devices/system/node';
  const meminfo = `for n in $(ls -d ${N}/node* | sed 's/.*node//'); do grep -E 'MemTotal|MemFree|MemUsed|FilePages|AnonPages|Shmem:|Slab:|KernelStack|PageTables' ${N}/node$n/meminfo | awk -v n=$n '{printf "n%s.%s%s ", n, $3, $4}'; done`;
  const parse = (s: string) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((f) => { const [k, v] = f.split(':'); return [k, Number(v)]; }));
  results.boot = parse(await run(page, meminfo));
  log('after boot (kB)', results.boot);
  results.nodes = await run(page, `echo online $(cat ${N}/online) cpus0 $(cat ${N}/node0/cpulist) cpus1 "$(cat ${N}/node1/cpulist)" distance $(cat ${N}/node0/distance) / $(cat ${N}/node1/distance) balancing $(cat /proc/sys/kernel/numa_balancing) creds $(systemd-creds --system list 2>/dev/null | grep -c sysctl.extra)`);
  log(results.nodes);
  results.dmesg = (await run(page, `dmesg | grep -iE 'numa|node [01]|memblock' | head -30 | cut -c1-140 | tr '\\n' '|'`)).split('|').map((l) => l.trim()).filter(Boolean);
  log(results.dmesg);

  // The data, on a tmpfs bound to each node.
  await run(page, `for n in 0 1; do mkdir -p /n$n; mount -t tmpfs -o size=${MB * 2 + 64}m,mpol=bind:$n n$n /n$n; done; head -c ${MB * 3 / 4}M /dev/urandom | base64 -w 100 > /n0/d; head -c 16M /n0/d > /n0/s; cp /n0/d /n0/s /n1/; ls -l /n0 /n1 | tr '\\n' ' '`, 300_000);
  results.data = parse(await run(page, meminfo));
  log('with the data (kB)', results.data);
  await run(page, `b() { systemd-run -q --pipe --wait -p NUMAPolicy=bind -p NUMAMask=$1 sh -c "D=/n$1/d; S=/n$1/s; $2"; }; t() { s=$(date +%s%N); b $1 "$2" > /dev/null; e=$(date +%s%N); echo "T $3 $1 $(( (e - s) / 1000000 ))"; }`);
  // Unbound once each (the programs' text into the page cache; and a check that each runs).
  for (const [name, cmd] of WORK) log('warm', name, await run(page, `D=/n0/d S=/n0/s; ${cmd.replace(/\$D/g, '/n0/d').replace(/\$S/g, '/n0/s')} | tail -c 80`));
  const samples: Record<string, { n0: number[]; n1: number[] }> = Object.fromEntries(WORK.map(([n]) => [n, { n0: [], n1: [] }]));
  for (let r = 0; r < ROUNDS; r++) {
    for (const n of r % 2 ? [1, 0] : [0, 1]) {
      for (const [name, cmd] of WORK) {
        const line = await run(page, `t ${n} '${cmd.replace(/'/g, `'"'"'`)}' ${name}`);
        const m = line.match(/T (\S+) (\d) (\d+)/);
        if (!m) throw new Error(`no time: ${line}`);
        samples[name][`n${n}` as 'n0' | 'n1'].push(Number(m[3]));
        log(line);
      }
    }
    results.samples = samples;
    save();
  }
  const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  results.summary = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, { n0: median(v.n0), n0Iqr: q(v.n0, 0.75) - q(v.n0, 0.25), n1: median(v.n1), n1Iqr: q(v.n1, 0.75) - q(v.n1, 0.25), ratio: +(median(v.n1) / median(v.n0)).toFixed(2) }]));
  log(results.summary);
  results.end = parse(await run(page, meminfo));
  save();
  await context.close();
} finally {
  save();
  await browser.close();
  server.close();
}
