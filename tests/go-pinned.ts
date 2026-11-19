// A Go program of its own repository that the tests build at a pinned commit (tests/waarm64-net.ts, the local helper;
// tests/waarm64-demonet.ts, the demo network's server): its source fetched with git into target/net/<name>-src, or a
// checkout of yours named by an environment variable, built with Go into target/net/<name>.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export type Pinned = {
  /** The program's name: its repository's, its binary's, and the directories' under target/net. */
  name: string;
  commit: string;
  /** Tried in order (over HTTPS once the repository is public; over SSH with the user's key while it's private). */
  repos: string[];
  /** The variable that names a checkout of yours instead (e.g. `WAARM64_NET_SRC=../waarm64-net`). */
  env: string;
  /** Why it can't be fetched where the repository is private (a cloud session): added to the skip's words. */
  privateNote?: string;
};

export type PinnedGo = {
  /** The source directory, or why there is none (no git, no access to the repository). Fetched once. */
  source(): { dir: string } | { skip: string };
  /** Builds it from its source into target/net/<name> and returns the binary's path. */
  build(): string;
  /** Why a test that builds it can't run (no Go, no source), or undefined. */
  skip(): string | undefined;
};

const ROOT = new URL('..', import.meta.url).pathname;

const git = (args: string[], cwd: string) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
}).trim();

export function pinnedGo(p: Pinned): PinnedGo {
  const DIR = `${ROOT}target/net/${p.name}-src`;
  let source: { dir: string } | { skip: string } | undefined;

  /** Whether `dir` holds the pinned commit, unchanged. */
  const fetched = (dir: string) => {
    try {
      return existsSync(`${dir}/.git`) && git(['rev-parse', 'HEAD'], dir) === p.commit && git(['status', '--porcelain'], dir) === '';
    } catch {
      return false;
    }
  };

  const getSource = (): { dir: string } | { skip: string } => {
    if (source) return source;
    const own = process.env[p.env];
    if (own) {
      const dir = resolve(own);
      return source = existsSync(`${dir}/go.mod`) ? { dir } : { skip: `SKIPPED: ${p.env}=${dir} isn't a checkout of ${p.name}` };
    }
    if (fetched(DIR)) return source = { dir: DIR };
    // Into a directory of this process's, then renamed into place: test files run in parallel processes.
    const tmp = `${DIR}-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const why: string[] = [];
    for (const repo of p.repos) {
      try {
        git(['init', '-q'], tmp);
        git(['fetch', '-q', '--depth', '1', repo, p.commit], tmp);
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
      : { skip: `SKIPPED: couldn't fetch ${p.name} ${p.commit.slice(0, 12)} (${why.join('; ')})${p.privateNote ? `; ${p.privateNote}` : ''}; ${p.env} names a checkout` };
  };

  return {
    source: getSource,
    build() {
      const s = getSource();
      if ('skip' in s) throw new Error(s.skip);
      mkdirSync(`${ROOT}target/net`, { recursive: true });
      // Built beside it and renamed into place: test files build it in parallel processes, and one may be running it.
      const out = `${ROOT}target/net/${p.name}`;
      execFileSync('go', ['build', '-o', `${out}-${process.pid}`, '.'], { cwd: s.dir, stdio: 'inherit', timeout: 300_000 });
      renameSync(`${out}-${process.pid}`, out);
      return out;
    },
    skip() {
      try {
        execFileSync('go', ['version'], { stdio: 'ignore' });
      } catch {
        return `SKIPPED: no Go to build ${p.name}`;
      }
      const s = getSource();
      return 'skip' in s ? s.skip : undefined;
    },
  };
}
