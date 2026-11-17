// The names agent's work in the module (docs/plans/room-names.md "The names agent"): the pure operations of
// net/ts/src/room/names/agent.rs (`ts_names_*`: make, mine, sign and check an entry, sign a pending anchor, make a zone,
// a title's status, what a server showed), and a publisher, a room client that is a names client alone (no machine, no
// guest, a key made new each time) which puts titles to the room's servers. One instance of the module does both: in
// the names worker (web/names-worker.ts), or in Node for the tests. No JavaScript crypto: the module's.
import { TsClient, type NamesIds, type NamesOp, type NamesPut, type TsModule } from './ts-client.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Why an operation refused: an `Invalid`'s name from the module (`Signature`, `Name`, `HeaderFloor`, …) or a message. */
export class NamesError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`names: ${code}`);
    this.code = code;
  }
}

/** A server's answer to a put, without the event's type. */
export type PutAnswer = Omit<NamesPut, 'type'>;

/** The dialog's check (docs/plans/room-names.md "A member resolving a name"), one a press of Register: the ids the
 * room's servers hold under one first byte, each with until when its owner holds it (Unix seconds, 0: nobody now);
 * `nobody` when nobody serves the room's names, `failed` when no server answered. */
export type IdsAnswer = { result: 'ids' | 'nobody' | 'failed'; ids: [string, number][] };

/** What the agent asks of the module, wherever it runs. */
export type NamesBackend = {
  /** One of the module's operations (net/ts/src/room/names/agent.rs), JSON in and out; a refusal is a `NamesError`. */
  op<T = Record<string, unknown>>(op: NamesOp, input: object): Promise<T>;
  /** Puts `items` (hex) to the servers of the room with link `link`, through a publisher made for it: each item's
   * answers (by its name id), `nobody` when nobody serves, `failed` when the room couldn't be reached. */
  publish(link: string, items: { id: string; item: string }[]): Promise<Map<string, PutAnswer[]>>;
  /** The dialog's check in the room with link `link`: every id under `first` (the name's id's first byte, never the
   * id), through a checker of its own (`idsWith`). */
  ids(link: string, first: number): Promise<IdsAnswer>;
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

/** A check's longest wait (finding servers, then their answers). */
const CHECK_MS = 20_000;

/**
 * The dialog's check in the room with link `link` (module `m`): every id under `first`, through a checker made for this
 * one check and closed with its answer (a publisher: a names client alone, a key made new, no machine), so no server
 * can link one press of Register to another. Resolves once two servers answered, or one and SECOND_ANSWER_MS more, or
 * nobody serves, or at CHECK_MS: with the ids of every server that answered (the latest until of each).
 */
export function idsWith(m: TsModule, link: string, first: number, o: { derpMapURL?: string; log?: (s: string) => void } = {}): Promise<IdsAnswer> {
  const answers: NamesIds[] = [];
  return new Promise((resolve) => {
    let client: TsClient | undefined;
    let second: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(second);
      client?.close();
      client = undefined;
      const said = answers.filter((a) => a.result === 'ids');
      const until = new Map<string, number>();
      for (const a of said) for (const [id, u] of a.ids ?? []) until.set(id, Math.max(until.get(id) ?? 0, u));
      resolve({ result: said.length ? 'ids' : answers.some((a) => a.result === 'nobody') ? 'nobody' : 'failed', ids: [...until] });
    };
    const timer = setTimeout(done, CHECK_MS);
    try {
      client = new TsClient(m, { room: { link, publish: true }, ...(o.derpMapURL ? { derpMapURL: o.derpMapURL } : {}) }, {
        packet() {},
        event(e) {
          if (e.type === 'log') return o.log?.(e.msg);
          // Not from inside the client's pump.
          if (e.type === 'state' && e.state === 'Failed') return queueMicrotask(done);
          if (e.type !== 'names-ids' || e.first !== first) return;
          answers.push(e);
          if (e.result === 'nobody' || answers.length >= 2 || (e.result === 'failed' && !e.server)) return queueMicrotask(done);
          if (e.result === 'ids') second ??= setTimeout(done, SECOND_ANSWER_MS);
        },
      });
      if (!client.namesIds(first)) queueMicrotask(done);
    } catch (err) {
      o.log?.(`no checker: ${String(err)}`);
      queueMicrotask(done);
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
    ids: (link, first) => idsWith(m, link, first, o),
    close() {},
  };
}
