// The tailcat CLI (tests/net/tailcat.sh builds it) for the tests: as a client, for those that let tailcat clients in,
// and as a second exit node on the rig's relay, for those that restrict one to a key.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const DIR = `${ROOT}target/net/tailcat-test`;
export const TAILCAT = `${DIR}/bin/tailcat`;
/** The rig's relay (tests/net/tailcat.sh). */
export const RIG_RELAY = '127.0.0.1:8444';

/** How the CLI runs: `rig` (the default) trusts the rig's relay's certificate; `internet` uses the system's (tailcat's
 * public relays). Its home (and so its saved keys, `client-default` among them) is the rig's run directory either way. */
export type CliOptions = { internet?: boolean; env?: Record<string, string>; timeoutMs?: number };

const envOf = (o: CliOptions) => ({
  ...process.env,
  ...(o.internet ? {} : { SSL_CERT_FILE: `${DIR}/certs/127.0.0.1.crt`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }),
  HOME: `${DIR}/run`,
  XDG_CONFIG_HOME: `${DIR}/run/.config`,
  ...o.env,
});

/** Runs the CLI, `input` on its stdin. Never synchronous: this process serves the page's disk, and a guest reading it
 * while the CLI waits on the guest would wait for the timeout. */
export async function tailcatRun(args: string[], input = '', o: CliOptions = {}): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(TAILCAT, args, { env: envOf(o) });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 60_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  return { code, out, err };
}

/** The CLI as a client, `input` on its stdin; its stdout (an error when it failed with none). */
export async function tailcat(args: string[], input: string, o: CliOptions = {}): Promise<string> {
  const r = await tailcatRun(args, input, o);
  if (r.code !== 0 && !r.out) throw new Error(`tailcat ${args.join(' ').slice(0, 80)}: exit ${r.code}; ${r.err.slice(-800)}`);
  return r.out;
}

/** The CLI's own client key (`tailcat genkey --client --key=client-default`, which client modes then use), made once. */
export async function clientKey(): Promise<string> {
  const r = await tailcatRun(['genkey', '--client', '--key=client-default']);
  const made = /nodekey:[0-9a-f]{64}/.exec(r.out);
  if (made) return made[0];
  // Already there: genkey refuses to overwrite it; its public half is in the saved key.
  const saved = JSON.parse(readFileSync(`${DIR}/run/.config/tailcat/keys/client-default.private.json`, 'utf8')) as Record<string, unknown>;
  const found = /nodekey:[0-9a-f]{64}/.exec(JSON.stringify(saved));
  if (!found) throw new Error(`no client key: ${r.err.slice(-400)}`);
  return found[0];
}

/** A second `tailcat serve exit-node` on the rig's relay with a fresh key and `args` (e.g. `--allow=…`); its address. */
export async function exitNode(args: string[]): Promise<{ addr: string; stop: () => void }> {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-tailcat-'));
  const key = `${tmp}/server.json`;
  const g = await tailcatRun(['genkey', `--key=${key}`, '--region=127.0.0.1']);
  if (g.code !== 0) throw new Error(`genkey: ${g.err.slice(-400)}`);
  // The region's node gets the rig's port (genkey leaves it out), as tests/net/tailcat.sh does.
  const k = JSON.parse(readFileSync(key, 'utf8')) as { Public: { Region: { Nodes: { DERPPort?: number }[] }[] } };
  for (const r of k.Public.Region) for (const n of r.Nodes) n.DERPPort = Number(RIG_RELAY.split(':')[1]);
  writeFileSync(key, JSON.stringify(k));
  const child: ChildProcess = spawn(TAILCAT, ['--verbose', 'serve', `--key=${key}`, ...args, 'exit-node'], { env: envOf({}) });
  let log = '';
  const stop = () => { child.kill(); rmSync(tmp, { recursive: true, force: true }); };
  try {
    const addr = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the exit node didn't start: ${log.slice(-800)}`)), 30_000);
      const on = (d: Buffer) => {
        log += d.toString();
        const a = /Server listening.*?(tc[A-Za-z0-9_-]{40,})/s.exec(log)?.[1] ?? /(tc[A-Za-z0-9_-]{40,})/.exec(log)?.[1];
        // It answers meows only once its own relay connection is up.
        if (a && log.includes('derp-1 connected')) { clearTimeout(timer); resolve(a); }
      };
      child.stdout!.on('data', on);
      child.stderr!.on('data', on);
      child.on('close', (code) => { clearTimeout(timer); reject(new Error(`the exit node exited (${code}): ${log.slice(-800)}`)); });
    });
    return { addr, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
