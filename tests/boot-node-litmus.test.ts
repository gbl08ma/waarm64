// Whole-VM guests in Node (tests/boot-node-suite.ts): the parallel litmus and atomics stress runs (the longest).
(globalThis as { bootNodePart?: (name: string) => boolean }).bootNodePart = (name) => name.startsWith('parallel: litmus');
await import('./boot-node-suite.ts');
