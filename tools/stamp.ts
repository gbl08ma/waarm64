// What the page was built from, in its <meta name="webpc-build"> (vite.config.ts writes it into every load of the page,
// the dev server's and the build's), for its console: main.ts logs it at load.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The commit, its date, and whether the work tree had changes then (tracked files only). Undefined outside a git
 * checkout.
 */
export function buildStamp(root = ROOT) {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const [commit, date] = git('log', '-1', '--format=%h %cI', '--abbrev=12').split(' ');
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    return `${commit} (${date})${dirty ? ' with local changes' : ''}`;
  } catch {
    return undefined;
  }
}

/** The page with its build stamp (`buildStamp`) in a `<meta name="webpc-build">` after its charset. */
export const withStamp = (html: string, stamp: string | undefined) => {
  if (!stamp) return html;
  if (!html.includes('<meta charset="utf-8">')) throw new Error('web/app/index.html has no <meta charset="utf-8">: update withStamp');
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="webpc-build" content="${stamp.replace(/[&"<>]/g, '')}">`);
};
