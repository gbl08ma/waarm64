// The page's install lines for the local helper (web/local-release.ts) against the release's (webpc-net's build.sh
// --install, which writes INSTALL.md): the same lines, byte for byte, for every target, from the sums of a build of ours.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installLines, parseSums, RELEASE, TARGETS, thisTarget, type Release } from '../web/local-release.ts';
import { helperSource } from './webpc-net.ts';

const ROOT = new URL('..', import.meta.url).pathname;

/** The install lines of build.sh --install (the pinned source's) for `release`, by target, against the page's. */
function sameLines(dir: string, release: Release, sums: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'webpc-release-'));
  writeFileSync(join(tmp, 'SHA256SUMS'), sums);
  const md = execFileSync('sh', [`${dir}/build.sh`, '--install', join(tmp, 'SHA256SUMS'), release.version], { encoding: 'utf8', env: { ...process.env, WEBPC_NET_DOWNLOAD: '' } });
  rmSync(tmp, { recursive: true });
  const blocks = [...md.matchAll(/^## (\w+) (\w+).*\n\n```\w+\n([\s\S]*?)\n```$/gm)];
  assert.equal(blocks.length, TARGETS.length);
  for (const [, os, arch, lines] of blocks) {
    const t = TARGETS.find((x) => x.os === os && x.arch === arch)!;
    assert.equal(installLines(release, t), lines, `${release.version} ${os} ${arch}`);
    assert.ok(lines.includes(release.sums[`webpc-net-${release.version}-${os}-${arch}${os === 'windows' ? '.exe' : ''}`]));
  }
}

test("the page's install lines are the release's", (t) => {
  const src = helperSource();
  if ('skip' in src) return t.skip(src.skip);
  const text = readFileSync(`${ROOT}bench/net/results/local-helper/build-x86_64.txt`, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  const repro = { version: 'v0.0.0-repro', sums: parseSums(text) };
  assert.equal(Object.keys(repro.sums).length, 7);
  sameLines(src.dir, repro, text);
  // The release the page offers, its SHA256SUMS written back out as the release has it.
  assert.equal(Object.keys(RELEASE.sums).length, 7);
  sameLines(src.dir, RELEASE, Object.entries(RELEASE.sums).map(([f, h]) => `${h}  ${f}\n`).join(''));
});

test('the target from the client hints, or the user agent', async () => {
  const hints = (platform: string, architecture: string) => ({ getHighEntropyValues: async () => ({ platform, architecture }) });
  assert.deepEqual(await thisTarget({ userAgent: '', userAgentData: hints('macOS', 'arm') }), { os: 'darwin', arch: 'arm64' });
  assert.deepEqual(await thisTarget({ userAgent: '', userAgentData: hints('Windows', 'x86') }), { os: 'windows', arch: 'amd64' });
  assert.deepEqual(await thisTarget({ userAgent: '', userAgentData: hints('Linux', 'arm') }), { os: 'linux', arch: 'arm64' });
  assert.deepEqual(await thisTarget({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), { os: 'linux', arch: 'amd64' });
  assert.deepEqual(await thisTarget({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), { os: 'darwin', arch: 'arm64' });
  assert.equal(await thisTarget({ userAgent: 'Mozilla/5.0 (iPhone)' }), undefined);
});
