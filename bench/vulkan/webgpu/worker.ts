// The worker of VK0's WebGPU page: one Aquarium (aquarium.ts), its calls from page.ts.
import { Aquarium, type Settings } from './aquarium.ts';

const scene = new Aquarium();
scene.onMark = (m) => self.postMessage({ log: `@${m}` });
self.onmessage = async (e: MessageEvent<{ id: number; op: string; args: unknown }>) => {
  const { id, op, args } = e.data;
  try {
    let result: unknown;
    if (op === 'init') {
      const a = args as { packUrl: string; wasmUrl: string };
      await scene.init(a.packUrl, a.wasmUrl);
      result = scene.adapterInfo();
    } else if (op === 'run') {
      result = await scene.run(args as Settings);
    } else if (op === 'dump') {
      const a = args as { s: Settings; frame: number };
      const r = await scene.run(a.s, a.frame);
      let bin = '';
      const px = r.pixels!;
      for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000));
      result = btoa(bin);
    } else throw new Error(`unknown op ${op}`);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error).stack ?? err) });
  }
};
