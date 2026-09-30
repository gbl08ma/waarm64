// Whole-VM guests in Node (tests/boot-node-suite.ts): the bare-metal tests and kvm-unit-tests, one vCPU thread.
(globalThis as { bootNodePart?: (name: string) => boolean }).bootNodePart = (name) => !name.startsWith('parallel:') && (name.startsWith('bare-metal') || name.startsWith('kvm-unit-tests'));
await import('./boot-node-suite.ts');
