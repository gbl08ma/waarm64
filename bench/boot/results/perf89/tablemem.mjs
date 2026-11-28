const t = new WebAssembly.Table({ element: 'anyfunc', initial: 2048 });
globalThis.gc?.();
const a = process.memoryUsage();
t.grow(262144);
globalThis.gc?.();
const b = process.memoryUsage();
console.log(JSON.stringify({ node: process.version, rssMiB: (b.rss - a.rss) / 2 ** 20, heapMiB: (b.heapUsed - a.heapUsed) / 2 ** 20, externalMiB: (b.external - a.external) / 2 ** 20, arrayBuffers: b.arrayBuffers - a.arrayBuffers, len: t.length }));
