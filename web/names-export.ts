// A room connection's names as its export carries them (web/names.ts; docs/networking/names.md): the owners' secret and
// the titles, as text, and taken in again as a copy of their own.
import { NamesError } from './names-ops.ts';
import type { NamesStore, TitleRecord } from './names-store.ts';

// ---- Export and import (with a room connection's key) ----

/** An export's names. Version 2: zones' 64-bit `seq` (rooms are pre-release: a version 1 bundle is refused). */
type Bundle = { v: 2; secret: string; titles: Omit<TitleRecord, 'identityKey'>[] };

/** A copy's branch of a title's zone `seq`: 32 random bits. */
export const newBranch = () => crypto.getRandomValues(new Uint32Array(1))[0];

function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
}

/** Connection `identityKey`'s owners' secret and titles as text (base64url of JSON), or undefined without a secret.
 * Nothing is written: each copy made from the text draws a branch of its own when it is taken in (`importNames`). */
export async function exportNames(store: NamesStore, identityKey: string): Promise<string | undefined> {
  const secret = await store.secret(identityKey);
  if (!secret) return undefined;
  const titles: Bundle['titles'] = [];
  for (const t of await store.titles(identityKey)) {
    const copy: Partial<TitleRecord> = { ...t };
    delete copy.identityKey;
    delete copy.repoint; // this browser's New name, for its connection's key
    titles.push(copy as Bundle['titles'][number]);
  }
  return b64url(new TextEncoder().encode(JSON.stringify({ v: 2, secret, titles } satisfies Bundle)));
}

/** Takes an export's secret and titles as connection `identityKey`'s (a title it holds already: the two merge as a
 * server would, by the module, at the next pass's publish; here the one kept stays). Every title taken in is a copy of
 * its own, so it draws a fresh branch: the same text pasted twice gives two branches, never the exporter's. */
export async function importNames(store: NamesStore, identityKey: string, bundle: string): Promise<void> {
  const b = JSON.parse(new TextDecoder().decode(unb64url(bundle))) as Bundle;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a pasted export: any version
  if (b.v !== 2 || !/^[0-9a-f]{64}$/.test(b.secret)) throw new NamesError('Bundle');
  const kept = await store.addSecret(identityKey, b.secret);
  for (const t of b.titles) {
    if (await store.get(identityKey, t.room, t.name)) continue;
    let branch = newBranch();
    while (branch === t.zone.branch) branch = newBranch();
    // The bundle's secret signs its titles: kept with each where the connection has another (review 2).
    const secret = t.secret ?? (b.secret !== kept ? b.secret : undefined);
    const copy: TitleRecord = { ...t, identityKey, zone: { n: t.zone.n, branch } };
    if (secret) copy.secret = secret;
    else delete copy.secret;
    await store.put(copy);
  }
}
