// Whole-VM guests in Node (tests/boot-node-suite.ts): the tests that don't run in parallel SMP.
(globalThis as { bootNodePart?: (name: string) => boolean }).bootNodePart = (name) => !name.startsWith('parallel:');
await import('./boot-node-suite.ts');
