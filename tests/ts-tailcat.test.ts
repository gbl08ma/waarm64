// The tailnet client in Node against the tailcat rig (tests/net/tailcat.sh), no guest: what a real relay and
// server show that the native fakes don't (docs/tailnet.md "Tests"). Opt-in: WEBPC_TAILCAT=1 (Go builds tailcat and
// derper), target/net/ts.wasm (net/ts/build.sh); scripts/ci-net.sh runs it.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_TAILCAT !== '1' ? 'SKIPPED: set WEBPC_TAILCAT=1'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/tailcat`) ? 'SKIPPED: no Go to build tailcat and derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;

let env: Record<string, string>;
before(() => {
  if (skip) return;
  env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
});
after(() => { if (!skip) spawnSync(script, ['down']); });

test('a relay whose path dies without a word is noticed and replaced: the guest\'s traffic comes back within seconds', { skip, timeout: 90_000 }, async () => {
  // Its own process: Node takes the relay's CA only at its start.
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', `${ROOT}tests/net/tailcat-blackhole.ts`, env.WEBPC_TAILCAT_ADDR], {
    cwd: ROOT, timeout: 80_000, env: { ...process.env, NODE_EXTRA_CA_CERTS: env.WEBPC_TAILCAT_CA },
  });
  const r = JSON.parse(stdout.trim().split('\n').at(-1)!) as { before: number; back: number; opened: number };
  console.log(`# echoes before: ${r.before.toFixed(0)} ms; back ${r.back.toFixed(0)} ms after the path died, on ${r.opened} new connection(s)`);
  assert.ok(r.back >= 0, `the echoes never came back:\n${stderr}`);
  // Sending with nothing back: a ping after 2 s, given up 6 s later, a new connection at once.
  assert.ok(r.back < 15_000, `back after ${r.back} ms`);
  assert.ok(r.opened >= 1);
});
