// The names agent's work in the module (docs/plans/room-names.md "The names agent"): the pure operations of
// net/ts/src/room/names/agent.rs (`ts_names_*`: make, mine, sign and check an entry, sign a pending anchor, make a zone,
// a title's status, what a server showed), and a publisher, a room client that is a names client alone (no machine, no
// guest, a key made new each time) which puts titles to the room's servers. One instance of the module does both: in
// the names worker (web/names-worker.ts), or in Node for the tests. No JavaScript crypto: the module's.
import { TsClient, type NamesOp, type NamesPut, type TsModule } from './ts-client.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Why an operation refused: an `Invalid`'s name from the module (`AnchorWindow`, `Signature`, `Name`, …) or a message. */
export class NamesError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`names: ${code}`);
    this.code = code;
  }
}

/** A server's answer to a put, without the event's type. */
export type PutAnswer = Omit<NamesPut, 'type'>;

/** What the agent asks of the module, wherever it runs. */
export type NamesBackend = {
  /** One of the module's operations (net/ts/src/room/names/agent.rs), JSON in and out; a refusal is a `NamesError`. */
  op<T = Record<string, unknown>>(op: NamesOp, input: object): Promise<T>;
  /** Puts `items` (hex) to the servers of the room with link `link`, through a publisher made for it: each item's
   * answers (by its name id), `nobody` when nobody serves, `failed` when the room couldn't be reached. */
  publish(link: string, items: { id: string; item: string }[]): Promise<Map<string, PutAnswer[]>>;
  close(): void;
};

/** How long a publisher may take from its start to the last answer (finding servers takes 1 to 3 s on public relays). */
export const PUBLISH_MS = 45_000;
/** After an item's first answer, how long its second server's may take. */
const SECOND_ANSWER_MS = 3_000;

/** The module's operations, at once. */
export function namesOp<T>(m: TsModule, op: NamesOp, input: object): T {
  const n = m.x[`ts_names_${op}`](...m.put(encoder.encode(JSON.stringify(input))));
  if (n < 0) throw new NamesError(decoder.decode(m.buf(-n)));
  return JSON.parse(decoder.decode(m.buf(n))) as T;
}

/**
 * Puts `items` through a publisher in the room with link `link` (module `m`): resolves with each item's answers once
 * every item has two, or one and SECOND_ANSWER_MS more, or `nobody`; or at PUBLISH_MS with what came.
 */
export function publishWith(m: TsModule, link: string, items: { id: string; item: string }[], o: { derpMapURL?: string; log?: (s: string) => void } = {}): Promise<Map<string, PutAnswer[]>> {
  const answers = new Map<string, PutAnswer[]>(items.map((i) => [i.id, []]));
  return new Promise((resolve) => {
    let client: TsClient | undefined;
    let put = false;
    let second: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(second);
      client?.close();
      client = undefined;
      resolve(answers);
    };
    const timer = setTimeout(done, PUBLISH_MS);
    const settled = () => [...answers.values()].every((a) => a.length >= 2 || a.some((x) => x.result === 'nobody'));
    const failAll = () => {
      for (const a of answers.values()) if (!a.length) a.push({ id: '', server: null, result: 'failed', item: null });
      done();
    };
    try {
      client = new TsClient(m, { room: { link, publish: true }, ...(o.derpMapURL ? { derpMapURL: o.derpMapURL } : {}) }, {
        packet() {},
        event(e) {
          if (e.type === 'log') return o.log?.(e.msg);
          if (e.type === 'state' && e.state === 'Failed') return queueMicrotask(failAll);
          if (e.type === 'state' && e.state === 'Running' && !put) {
            put = true;
            // Not from inside the client's pump: on the next turn.
            queueMicrotask(() => {
              for (const i of items) if (!client?.namesPut(hexBytes(i.item))) answers.get(i.id)?.push({ id: i.id, server: null, result: 'failed', item: null });
            });
          }
          if (e.type !== 'names-put') return;
          answers.get(e.id)?.push({ id: e.id, server: e.server, result: e.result, item: e.item });
          if (settled()) return queueMicrotask(done);
          if ([...answers.values()].every((a) => a.length > 0)) second ??= setTimeout(done, SECOND_ANSWER_MS);
        },
      });
    } catch (err) {
      o.log?.(`no publisher: ${String(err)}`);
      failAll();
    }
  });
}

export function hexBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length >> 1);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return b;
}

/** The agent's backend on module `m` in this thread (the names worker's; the tests' in Node). */
export function localBackend(m: TsModule, o: { derpMapURL?: string; log?: (s: string) => void } = {}): NamesBackend {
  return {
    op: <T>(op: NamesOp, input: object) => {
      try {
        return Promise.resolve(namesOp<T>(m, op, input));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    publish: (link, items) => publishWith(m, link, items, o),
    close() {},
  };
}
