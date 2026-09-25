// One command for the whole M0.5 memory suite on this host:
//   node bench/spike/memory/run-all.ts [--quick]
// Builds the Rust side, then writes bench/spike/memory/results/chromium-<os>-<arch>-*:
// capacity.json, cost-<config>.json, and on Linux cost-default-nothp.json (1 GiB
// working sets with transparent huge pages off) and machine-code-<tier>.txt.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { ROOT } from '../../../tools/serve.ts';

const quick = process.argv.includes('--quick');
const prefix = `bench/spike/memory/results/chromium-${os.platform()}-${os.arch() === 'x64' ? 'x86_64' : os.arch()}`;
const sh = (cmd: string, ...args: string[]) => shEnv({}, cmd, ...args);
const shEnv = (env: Record<string, string>, cmd: string, ...args: string[]) => {
  console.error(`\n== ${Object.entries(env).map(([k, v]) => `${k}=${v} `).join('')}${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};
const node = (...args: string[]) => sh(process.execPath, '--disable-warning=ExperimentalWarning', ...args);
const cost = (config: string, suffix = '', env: Record<string, string> = {}, only: string[] = []) =>
  shEnv(env, process.execPath, '--disable-warning=ExperimentalWarning', 'bench/run.ts', '--page', 'bench/spike/memory/index.html', '--config', config,
    '--out', `${prefix}-cost-${config}${suffix}.json`, ...only, ...(quick ? ['--quick'] : []));

sh('bench/spike/memory/build.sh', '-q');
node('bench/spike/memory/capacity.ts', '--out', `${prefix}-capacity.json`);
for (const config of ['default', 'liftoff-only', 'turbofan-only', 'bounds-checks']) cost(config);
if (os.platform() === 'linux') {
  if (!quick) cost('default', '-nothp', { CHROMIUM: 'bench/spike/memory/no-thp.sh' }, ['--only', 'large']);
  for (const tier of ['turbofan', 'liftoff']) node('bench/spike/memory/machine-code.ts', '--config', tier, '--out', `${prefix}-machine-code-${tier}.txt`);
} else {
  console.error('machine code: skipped (V8 writes jitdump only on Linux)');
}
