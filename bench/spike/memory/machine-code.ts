// M0.5 machine-code evidence: runs the kernels in headless Chromium with V8's
// --perf-prof (jitdump), then extracts the named wasm functions' code bytes
// from the jitdump and disassembles them with objdump. No `perf` needed.
//   node bench/spike/memory/machine-code.ts [--config turbofan|liftoff] [--filter <regex>] [--out <file>]
// Linux only (V8 writes jitdump files only there). The renderer sandbox must
// be off (--no-sandbox) so it can write the file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { ROOT, startServer } from '../../../tools/serve.ts';

const { values: args } = parseArgs({
  options: { config: { type: 'string', default: 'turbofan' }, filter: { type: 'string', default: '^JS:(k_|slow_ld_(A|B1|C|D)_rand_bare|run-)' }, out: { type: 'string' } },
});
const tierFlag = { turbofan: '--no-liftoff', liftoff: '--liftoff-only' }[args.config!];
if (!tierFlag) throw new Error('--config turbofan|liftoff');

type Code = { name: string; addr: bigint; bytes: Buffer };

/** JIT_CODE_LOAD records of a jitdump file (https://github.com/torvalds/linux/blob/master/tools/perf/Documentation/jitdump-specification.txt). */
export function parseJitdump(buf: Buffer): Code[] {
  if (buf.readUInt32LE(0) !== 0x4a695444) throw new Error('not a jitdump file');
  const out: Code[] = [];
  for (let p = buf.readUInt32LE(8); p + 16 <= buf.length;) {
    const id = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    if (id === 0) {
      const addr = buf.readBigUInt64LE(p + 16 + 16), len = Number(buf.readBigUInt64LE(p + 16 + 24));
      const nameStart = p + 16 + 40, nameEnd = buf.indexOf(0, nameStart);
      out.push({ name: buf.toString('utf8', nameStart, nameEnd), addr, bytes: buf.subarray(nameEnd + 1, nameEnd + 1 + len) });
    }
    if (!size) break;
    p += size;
  }
  return out;
}

if (import.meta.main) {
  const dir = mkdtempSync(join(os.tmpdir(), 'waarm64-jitdump-'));
  const server = await startServer();
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    args: ['--no-sandbox', `--js-flags=--perf-prof --perf-prof-path=${dir} --logfile=${dir}/v8-%p.log ${tierFlag}`],
  });
  let version = '';
  try {
    version = browser.version();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/bench/spike/memory/index.html?only=machinecode`);
    const r = await (await page.waitForFunction(() => (window as unknown as { benchResult?: unknown }).benchResult, null, { timeout: 600_000 })).jsonValue() as { error?: string };
    if (r.error) throw new Error(r.error);
  } finally {
    await browser.close();
    server.close();
  }

  const machine = ({ x64: 'i386:x86-64', arm64: 'aarch64' } as Record<string, string>)[os.arch()];
  if (!machine) throw new Error(`unsupported arch ${os.arch()}`);
  const filter = new RegExp(args.filter!);
  const codes = readdirSync(dir).filter((f) => f.startsWith('jit-')).flatMap((f) => parseJitdump(readFileSync(join(dir, f))));
  // Keep the last version of each function (after tier-up there may be several).
  const byName = new Map<string, Code>();
  for (const c of codes) if (filter.test(c.name.replace(/^\*?/, ''))) byName.set(c.name, c);
  const parts = [`# V8 ${args.config} machine code, Chromium ${version}, ${os.arch()}, ${new Date().toISOString()}`,
    `# ${codes.length} code objects in jitdump; ${byName.size} matching ${filter}`];
  for (const c of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const bin = join(dir, 'code.bin');
    writeFileSync(bin, c.bytes);
    const dis = execFileSync('objdump', ['-D', '-b', 'binary', '-m', machine, ...(machine.startsWith('i386') ? ['-M', 'intel'] : []), `--adjust-vma=0x${c.addr.toString(16)}`, bin])
      .toString().split('\n').filter((l) => /^\s+[0-9a-f]+:/.test(l)).map((l) => l.replace(/^\s+([0-9a-f]+):\t(?:[0-9a-f]{2} )+\s*\t?/, '$1  '));
    parts.push('', `## ${c.name} (${c.bytes.length} bytes)`, ...dis);
  }
  rmSync(dir, { recursive: true, force: true });
  const out = args.out ?? `bench/results/local/machine-code-${args.config}.txt`;
  mkdirSync(join(ROOT, out, '..'), { recursive: true });
  writeFileSync(join(ROOT, out), parts.join('\n') + '\n');
  console.error(`wrote ${out} (${byName.size} functions)`);
}
