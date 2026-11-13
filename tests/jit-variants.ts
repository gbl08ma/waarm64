// The JIT's amplifying variants (JIT-stress: a code cache of a few blocks, compiling on most dispatches; JIT-check:
// every block compiled on sight, with the stale-code checker) run in scripts/ci-jit.sh, which sets
// WAARM64_JIT_VARIANTS=1, not in scripts/ci.sh or a plain npm test: the plain JIT, the default path, stays there.
export const jitVariantSkip = process.env.WAARM64_JIT_VARIANTS !== '1' && 'SKIPPED: scripts/ci-jit.sh runs it (WAARM64_JIT_VARIANTS=1)';
