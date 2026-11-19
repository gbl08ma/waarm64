// The alpine-demo image's command-not-found hook (images/alpine-demo/command-not-found.sh; docs/images.md
// `alpine-demo`), on the host's BusyBox ash at a terminal (`script` gives it one, so its history is kept): a missing
// command is installed (a stand-in `apk` on the PATH) and, when the line typed is that command alone, run again with its
// arguments; a line with more after it (`;`, `&&`, a redirection, a pipe) isn't run again (the prompt's shell runs the
// rest of the line itself: run again, the rest would run twice), the hook says to run it again. Skipped without
// BusyBox or `script`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const HOOK = join(import.meta.dirname, '../images/alpine-demo/command-not-found.sh');
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const skip = (!has('busybox') || !has('script')) && 'SKIPPED: needs busybox and script';

/** `lines` typed at an interactive BusyBox ash with the hook sourced; what the commands logged, and what was said. */
function typed(lines: string[]): { log: string[]; said: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cnf-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', [bin]);
    const log = join(dir, 'log');
    // apk: `hello` is in a package; `add` installs it (a script that logs its arguments).
    writeFileSync(
      join(bin, 'apk'),
      `#!/bin/sh\ncase "$1" in\nsearch) case "$*" in *cmd:hello*) echo hello-1.0;; esac;;\nadd) printf '#!/bin/sh\\necho "hello $*" >>"${log}"\\n' >"${bin}/hello"; chmod +x "${bin}/hello";;\nesac\n`,
    );
    chmodSync(join(bin, 'apk'), 0o755);
    const input = [`. ${HOOK}`, ...lines, 'exit 0', ''].join('\n');
    const r = spawnSync('timeout', ['20', 'script', '-qec', 'busybox ash -i', '/dev/null'], {
      input,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ENV: '', TERM: 'dumb' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `the shell: ${r.stdout}${r.stderr}`);
    return { log: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], said: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the command alone is installed and run again with its arguments', { skip }, () => {
  const { log, said } = typed([`hello a 'b c'`]);
  assert.deepEqual(log, ['hello a b c'], said);
});

test('#3: a line with more after the command runs that rest once, and says to run the command again', { skip }, () => {
  for (const rest of ['; echo after >>"$L"', ' && echo after >>"$L"', ' || echo after >>"$L"', ' >"$L.x"; echo after >>"$L"']) {
    const { log, said } = typed([`L=$HOME/log`, `hello a${rest}`]);
    assert.deepEqual(log.filter((l) => l === 'after').length, rest.includes('&&') ? 0 : 1, `${rest}: the rest ran ${log.length} times`);
    assert.ok(!log.includes('hello a'), `${rest}: run again`);
    assert.match(said, /hello-1\.0 is installed: run hello again/, rest);
  }
});
