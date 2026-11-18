// JIT vs interpreter on generated encodings (tests/jit-diff-suite.ts): every fourth of its tests in their order, from the third.
(globalThis as { jitDiffPart?: [number, number] }).jitDiffPart = [2, 4];
await import('./jit-diff-suite.ts');
