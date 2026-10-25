// The worker of VK0's arm 3: one Replay (replay.ts) a trace; its calls from page.ts.
import { Replay } from './replay.ts';

let replay: Replay | undefined;
self.onmessage = async (e: MessageEvent<{ id: number; op: string; args: Record<string, unknown> }>) => {
  const { id, op, args } = e.data;
  try {
    let result: unknown;
    if (op === 'init') {
      replay = new Replay();
      replay.onMark = (m) => self.postMessage({ log: `@${m}` });
      replay.log = (m) => self.postMessage({ log: m });
      await replay.init(args.url as string, !!args.noImmediates);
      result = replay.adapterInfo();
    } else if (op === 'run') {
      result = await replay!.replay(args as never);
    } else if (op === 'dump') {
      const r = await replay!.replay(args.s as never, { frame: args.frame as number, image: args.image as number });
      let bin = '';
      const px = r.pixels!;
      for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000));
      result = { b64: btoa(bin), width: r.width, height: r.height };
    } else throw new Error(`unknown op ${op}`);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error).stack ?? err) });
  }
};
