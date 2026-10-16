// tools/tailscale.ts: when the Tailscale client is (re)built for `npm run serve` and `npm start`,
// with a fake tree, a fake `go` and a fake build script, so nothing is compiled.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareTailscale, tailscaleCurrent, tailscaleInputs } from '../tools/tailscale.ts';

function tree(buildOk = true) {
  const root = mkdtempSync(join(tmpdir(), 'webpc-ts-build-'));
  mkdirSync(join(root, 'net/tailscale/overlay'), { recursive: true });
  writeFileSync(join(root, 'net/tailscale/main_js.go'), 'package main\n');
  writeFileSync(join(root, 'net/tailscale/overlay/x.go'), 'package x\n');
  writeFileSync(join(root, 'net/tailscale/build.sh'), buildOk
    ? 'mkdir -p "$(dirname "$1")"; echo wasm > "$1"; echo js > "$(dirname "$1")/wasm_exec.js"; echo x >> "$(dirname "$1")/builds"\n'
    : 'exit 1\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'go'), '#!/bin/sh\necho go version fake\n');
  chmodSync(join(bin, 'go'), 0o755);
  return { root, env: { PATH: `${bin}:/usr/bin:/bin` } as NodeJS.ProcessEnv, noGo: { PATH: '/nonexistent' } as NodeJS.ProcessEnv };
}

test('the client is built when missing, left alone when current, rebuilt when its sources change', () => {
  const t = tree();
  try {
    const said: string[] = [];
    const log = (s: string) => said.push(s);
    assert.equal(tailscaleCurrent(t.root), false);
    assert.equal(prepareTailscale(t.root, t.env, log), 'built');
    assert.match(said[0], /^Building the Go Tailscale client/);
    assert.equal(tailscaleCurrent(t.root), true);
    assert.equal(prepareTailscale(t.root, t.env, log), 'current');
    assert.equal(said.length, 1, 'nothing said when current');
    writeFileSync(join(t.root, 'net/tailscale/main_js.go'), 'package main // changed\n');
    assert.equal(tailscaleCurrent(t.root), false);
    assert.equal(prepareTailscale(t.root, t.env, log), 'built');
    assert.match(said[1], /sources changed: rebuilding/);
    // Removing the glue also makes it stale.
    rmSync(join(t.root, 'target/net/wasm_exec.js'));
    assert.equal(tailscaleCurrent(t.root), false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('inputs are the contents of net/tailscale, including subdirectories', () => {
  const t = tree();
  try {
    const a = tailscaleInputs(t.root);
    writeFileSync(join(t.root, 'net/tailscale/overlay/x.go'), 'package y\n');
    assert.notEqual(tailscaleInputs(t.root), a);
    writeFileSync(join(t.root, 'net/tailscale/overlay/x.go'), 'package x\n');
    assert.equal(tailscaleInputs(t.root), a);
    writeFileSync(join(t.root, 'unrelated.txt'), 'x');
    assert.equal(tailscaleInputs(t.root), a);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('without Go (quietly), with WEBPC_TAILSCALE=0, or without the sources: skipped, and the server goes on', () => {
  const t = tree();
  try {
    const said: string[] = [];
    assert.equal(prepareTailscale(t.root, t.noGo, (s) => said.push(s)), 'skipped');
    assert.equal(said.length, 0, `nothing said without Go: only ?tsbackend=go needs this client (${said})`);
    assert.equal(existsSync(join(t.root, 'target/net/tailscale.wasm')), false);
    said.length = 0;
    assert.equal(prepareTailscale(t.root, { ...t.env, WEBPC_TAILSCALE: '0' }, (s) => said.push(s)), 'skipped');
    rmSync(join(t.root, 'net/tailscale/build.sh'));
    assert.equal(prepareTailscale(t.root, t.env, (s) => said.push(s)), 'skipped');
    assert.deepEqual(said, []);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('a build that fails is reported, leaves no stamp, and is tried again next time', () => {
  const t = tree(false);
  try {
    const said: string[] = [];
    assert.equal(prepareTailscale(t.root, t.env, (s) => said.push(s)), 'failed');
    assert.match(said.at(-1)!, /didn't build/);
    assert.equal(tailscaleCurrent(t.root), false);
    assert.equal(prepareTailscale(t.root, t.env, (s) => said.push(s)), 'failed');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
