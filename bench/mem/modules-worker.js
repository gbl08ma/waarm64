// bench/mem/modules.ts replay: installs a capture's modules as web/vm.ts's jitHost does, without running them
// (V8 compiles lazily, so this is the memory of everything but their code).
onmessage = async (e) => {
  const { dir, pages } = e.data;
  const buf = new Uint8Array(await (await fetch(dir + '/modules.bin')).arrayBuffer());
  const slots = await (await fetch(dir + '/slots.json')).json();
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  let max = 0; for (const s of slots) for (const i of s) max = Math.max(max, i);
  const table = new WebAssembly.Table({ initial: max + 1, element: 'anyfunc' });
  const stub = () => 0;
  const dv = new DataView(buf.buffer);
  let n = 0;
  for (let o = 0, m = 0; o < buf.length; m++) {
    const len = dv.getUint32(o, true);
    const mod = new WebAssembly.Module(buf.subarray(o + 4, o + 4 + len));
    o += 4 + len;
    const env = { memory, table }, t = {};
    for (const i of WebAssembly.Module.imports(mod)) {
      if (i.module === 't') t[i.name] = table.get(Number(i.name));
      else if (i.kind === 'function') env[i.name] = stub;
    }
    const f = new WebAssembly.Instance(mod, { env, t }).exports;
    slots[m].forEach((at, k) => table.set(at, f['f' + k]));
    n++;
  }
  self.keep = table;
  postMessage(n);
};
