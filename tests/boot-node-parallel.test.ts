// Whole-VM guests in Node (tests/boot-node-suite.ts): the parallel SMP tests but the litmus runs.
(globalThis as { bootNodePart?: (name: string) => boolean }).bootNodePart = (name) => name.startsWith('parallel:') && !name.startsWith('parallel: litmus');
await import('./boot-node-suite.ts');
