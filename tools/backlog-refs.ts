// The backlog moved to GitHub issues (docs/issues.md) and docs/backlog.md is gone: this fails on a tracked file that
// still points at it (static checks of scripts/ci-fast.sh and scripts/ci.sh). Allowed: the dated journals
// (bench/*/REPORT.md, results), whose entries describe the backlog as it was, docs/issues.md's note on where it went,
// and links to the file as it last stood.
//   node tools/backlog-refs.ts
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The commit whose docs/backlog.md the issues were made from: links to it stay valid. */
export const LAST = 'e04a6974';

/** Files whose mentions are history, not pointers. */
export function allowedFile(path: string): boolean {
  return /^bench\/[^/]+\/REPORT\.md$/.test(path) || /^bench\/(.+\/)?results\//.test(path) || path === 'tools/backlog-refs.ts' || path === 'docs/issues.md';
}

/** A line's mentions of backlog.md that aren't links to the file at LAST. */
export function strayRefs(line: string): number {
  return (line.replaceAll(`blob/${LAST}/docs/backlog.md`, '').match(/backlog\.md/g) ?? []).length;
}

/** The lines of `git grep -n` output that still point at the file. */
export function strayLines(grep: string): string[] {
  return grep.split('\n').filter((l) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    return m !== null && !allowedFile(m[1]) && strayRefs(m[3]) > 0;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let out = '';
  try {
    // --untracked: a new file the fast lane checks before it is added.
    out = execFileSync('git', ['-C', ROOT, 'grep', '-n', '--no-color', '-I', '--untracked', 'backlog\\.md'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e; // 1: no line matched
  }
  const bad = strayLines(out.trim());
  for (const b of bad) console.error(`${b.slice(0, 200)}`);
  if (bad.length) {
    console.error(`backlog-refs: ${bad.length} line(s) still point at docs/backlog.md: link the issue (docs/issues.md)`);
    process.exitCode = 1;
  } else console.log('backlog-refs: no file points at docs/backlog.md');
}
