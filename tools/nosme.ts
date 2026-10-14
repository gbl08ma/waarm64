// The environment for a Chromium that reads decoded video frames (docs/testing.md "Video over virgl"): on a CPU with SME but no
// SVE (the M4 under Lima), Chromium's SME kernels (libyuv) fault at their first instruction, so tools/nosme/nosme.c
// hides SME from getauxval as an LD_PRELOAD. Built on demand into target/nosme/libnosme.so (`cc`); elsewhere (x86_64,
// the Mac host, a CPU with SVE) the environment is returned unchanged.
//   chromium.launch({ executablePath, env: chromiumEnv() })
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'tools/nosme/nosme.c');
export const LIB = join(ROOT, 'target/nosme/libnosme.so');

/** Whether this machine needs the shim: aarch64 Linux whose CPU flags list `sme` and not `sve`. */
export function needsNosme(cpuinfo?: string) {
  if (cpuinfo === undefined) {
    if (process.platform !== 'linux' || process.arch !== 'arm64') return false;
    try { cpuinfo = readFileSync('/proc/cpuinfo', 'utf8'); } catch { return false; }
  }
  const flags = new Set((/^Features\s*:(.*)$/m.exec(cpuinfo)?.[1] ?? '').trim().split(/\s+/));
  return flags.has('sme') && !flags.has('sve');
}

/** Builds the shim if it's missing or older than its source; returns its path. */
export function buildNosme() {
  if (existsSync(LIB) && statSync(LIB).mtimeMs >= statSync(SRC).mtimeMs) return LIB;
  mkdirSync(join(ROOT, 'target/nosme'), { recursive: true });
  const r = spawnSync('cc', ['-O2', '-shared', '-fPIC', '-o', LIB, SRC, '-ldl'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`building ${LIB} failed (cc exit ${r.status})`);
  return LIB;
}

/** `env` with the shim preloaded where the CPU needs it (for Playwright's `launch({ env })`). */
export function chromiumEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  if (!needsNosme()) return out;
  const lib = buildNosme();
  out.LD_PRELOAD = out.LD_PRELOAD ? `${lib}:${out.LD_PRELOAD}` : lib;
  return out;
}

if (import.meta.main) console.log(needsNosme() ? buildNosme() : 'not needed here');
