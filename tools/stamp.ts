// What the page was built from, in its <meta name="waarm64-build"> (vite.config.ts writes it into every load of the page,
// the dev server's and the build's), for its console: main.ts logs it at load. And the same, structured, for the
// Machines page's About pane (tools/third-party.ts `aboutData`).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The commit, its date, and whether the work tree had changes then (tracked files only). Undefined outside a git
 * checkout.
 */
export function buildStamp(root = ROOT) {
  const info = buildInfo(root);
  return info && `${info.commit.slice(0, 12)} (${info.date})${info.dirty ? ' with local changes' : ''}`;
}

/** What the About pane says of the build (tools/third-party.ts `aboutData`): the commit, the tag on it if one was cut, the commit's date. */
export type BuildInfo = { commit: string; tag?: string; date: string; dirty: boolean };

/** The build's commit, its tag (a tag on that commit), its date and whether the work tree had changes; undefined outside a git checkout. */
export function buildInfo(root = ROOT): BuildInfo | undefined {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const [commit, date] = git('log', '-1', '--format=%H %cI').split(' ');
    let tag: string | undefined;
    try { tag = git('describe', '--tags', '--exact-match', 'HEAD') || undefined; } catch { /* no tag on the commit */ }
    return { commit, tag, date, dirty: git('status', '--porcelain', '--untracked-files=no') !== '' };
  } catch {
    return undefined;
  }
}

/** The page with its build stamp (`buildStamp`) in a `<meta name="waarm64-build">` after its charset. */
export const withStamp = (html: string, stamp: string | undefined) => {
  if (!stamp) return html;
  if (!html.includes('<meta charset="utf-8">')) throw new Error('web/app/index.html has no <meta charset="utf-8">: update withStamp');
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="waarm64-build" content="${stamp.replace(/[&"<>]/g, '')}">`);
};
