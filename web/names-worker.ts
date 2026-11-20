// The names agent's worker (web/names.ts, docs/networking/names.md "The names agent"): the module (target/net/ts.wasm)
// for its pure `ts_names_*` operations, proof of work above all (a minute of a core in production), and the publishers
// that put titles to a room's servers and the dialog's checkers, off the page's thread. Messages are requests by number; each gets one answer.
import { localBackend, NamesError, type NamesBackend } from './names-ops.ts';
import { TsModule, type NamesOp } from './ts-client.ts';

export type ToNames =
  | { type: 'start'; wasm: string }
  | { type: 'op'; n: number; op: NamesOp; input: object }
  | { type: 'publish'; n: number; link: string; items: { id: string; item: string }[] }
  | { type: 'ids'; n: number; link: string; first: number };

export type FromNames =
  { type: 'answer'; n: number; value: unknown } | { type: 'refused'; n: number; code: string; message: string };

let backend: Promise<NamesBackend> | undefined;

self.onmessage = async (e: MessageEvent<ToNames>) => {
  const m = e.data;
  if (m.type === 'start') {
    backend = TsModule.load(m.wasm).then((mod) => localBackend(mod, { log: (s) => console.log('names:', s) }));
    backend.catch(() => {});
    return;
  }
  try {
    if (!backend) throw new Error('the names worker has no module');
    const b = await backend;
    const value =
      m.type === 'op'
        ? await b.op(m.op, m.input)
        : m.type === 'ids'
          ? await b.ids(m.link, m.first)
          : Object.fromEntries(await b.publish(m.link, m.items));
    self.postMessage({ type: 'answer', n: m.n, value } satisfies FromNames);
  } catch (err) {
    const code = err instanceof NamesError ? err.code : '';
    self.postMessage({ type: 'refused', n: m.n, code, message: String(err) } satisfies FromNames);
  }
};
