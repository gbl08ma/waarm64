// The local network helper for the tests (github.com/gbl08ma/waarm64-net, its own repository; docs/plans/networking-local.md):
// its source at the commit pinned below, fetched with git into target/net/waarm64-net-src, or a checkout of yours with
// WAARM64_NET_SRC (e.g. ../waarm64-net, when the page and the helper change together). Move the pin with a change of the
// helper the page needs, after its CI passed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const WAARM64_NET_COMMIT = 'b6d9c06b1450f5135303a488f9307198b3493380'; // v0.3.0
// Over HTTPS once the repository is public; while it's private, over SSH with the user's key.
const REPOS = ['https://github.com/gbl08ma/waarm64-net.git', 'git@github.com:gbl08ma/waarm64-net.git'];

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = `${ROOT}target/net/waarm64-net-src`;

const git = (args: string[], cwd: string) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
}).trim();

let source: { dir: string } | { skip: string } | undefined;

/** The helper's source directory, or why there is none (no git, no access to the repository). Fetched once. */
export function helperSource(): { dir: string } | { skip: string } {
  if (source) return source;
  if (process.env.WAARM64_NET_SRC) {
    const dir = resolve(process.env.WAARM64_NET_SRC);
    return source = existsSync(`${dir}/go.mod`) ? { dir } : { skip: `SKIPPED: WAARM64_NET_SRC=${dir} isn't a checkout of waarm64-net` };
  }
  if (fetched(DIR)) return source = { dir: DIR };
  // Into a directory of this process's, then renamed into place: test files run in parallel processes.
  const tmp = `${DIR}-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const why: string[] = [];
  for (const repo of REPOS) {
    try {
      git(['init', '-q'], tmp);
      git(['fetch', '-q', '--depth', '1', repo, WAARM64_NET_COMMIT], tmp);
      git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], tmp);
      if (!fetched(DIR)) {
        rmSync(DIR, { recursive: true, force: true });
        try { renameSync(tmp, DIR); } catch { /* another process's got there first */ }
      }
      break;
    } catch (e) {
      why.push(`${repo}: ${String((e as { stderr?: string }).stderr ?? e).trim().split('\n').pop()}`);
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return source = fetched(DIR) ? { dir: DIR }
    : { skip: `SKIPPED: couldn't fetch waarm64-net ${WAARM64_NET_COMMIT.slice(0, 12)} (${why.join('; ')}); WAARM64_NET_SRC names a checkout` };
}

/** Whether `dir` holds the pinned commit, unchanged. */
function fetched(dir: string) {
  try {
    return existsSync(`${dir}/.git`) && git(['rev-parse', 'HEAD'], dir) === WAARM64_NET_COMMIT && git(['status', '--porcelain'], dir) === '';
  } catch {
    return false;
  }
}

/** Builds the helper from its source into target/net/waarm64-net and returns the binary's path. */
export function buildHelper(): string {
  const s = helperSource();
  if ('skip' in s) throw new Error(s.skip);
  mkdirSync(`${ROOT}target/net`, { recursive: true });
  // Built beside it and renamed into place: test files build it in parallel processes, and one may be running it.
  const out = `${ROOT}target/net/waarm64-net`;
  execFileSync('go', ['build', '-o', `${out}-${process.pid}`, '.'], { cwd: s.dir, stdio: 'inherit', timeout: 300_000 });
  renameSync(`${out}-${process.pid}`, out);
  return out;
}

/** Why a test that builds the helper can't run (no Go, no source), or undefined. */
export function helperSkip(): string | undefined {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
  } catch {
    return 'SKIPPED: no Go to build waarm64-net';
  }
  const s = helperSource();
  return 'skip' in s ? s.skip : undefined;
}
