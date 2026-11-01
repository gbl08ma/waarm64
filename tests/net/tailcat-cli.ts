// The tailcat CLI as a client (tests/net/tailcat.sh builds it), for the tests that let tailcat clients in.
import { spawn } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url).pathname;

/** The tailcat CLI (tests/net/tailcat.sh built it) as a client, `input` on its stdin; its stdout. Never synchronous: this
 * process serves the page's disk, and a guest reading it while the CLI waits on the guest would wait for the timeout. */
export async function tailcat(args: string[], input: string): Promise<string> {
  const child = spawn(`${ROOT}target/net/tailcat-test/bin/tailcat`, args, {
    env: { ...process.env, SSL_CERT_FILE: `${ROOT}target/net/tailcat-test/certs/127.0.0.1.crt`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', HOME: `${ROOT}target/net/tailcat-test/run` },
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  if (code !== 0 && !out) throw new Error(`tailcat ${args[0]}: exit ${code}; ${err.slice(-800)}`);
  return out;
}
