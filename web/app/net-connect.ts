// What a connection's client is started with (docs/networking/adapters.md §3): a stored connection's settings
// (web/app/connections.ts) as web/app/network.ts's `Connect`, for each kind's client. DOM-free.
import { settingsOf, type Connection } from './connections.ts';
import type { Connect } from './network.ts';

/** What a connection's client is started with (`authKey`: a tailnet's first login, never kept). */
export function connectOf(c: Connection, authKey?: string): Connect {
  if (c.kind === 'local') return { controlURL: '', hostname: '', local: settingsOf(c, 'local').url };
  if (c.kind === 'room') {
    const r = settingsOf(c, 'room');
    return {
      controlURL: '',
      hostname: '',
      room: {
        link: r.link,
        incoming: r.incoming,
        relayOnly: r.relayOnly,
        identityKey: r.identityKey,
        identity: r.identity,
      },
    };
  }
  if (c.kind === 'tailcat') {
    const t = settingsOf(c, 'tailcat');
    // Its identity always: a kept connection is the same node going online through a server too (a server can `--allow` it).
    const serve = t.serve
      ? { tailcatServe: { relay: t.exit ? '' : t.relay, ...(t.allow?.length ? { allow: t.allow } : {}) } }
      : {};
    return {
      controlURL: '',
      hostname: '',
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- no exit node ('') is none
      tailcat: t.exit || undefined,
      ...serve,
      tailcatIdentity: { identityKey: t.identityKey, identity: t.identity },
    };
  }
  const t = settingsOf(c, 'tailnet');
  // A stored connection's node is kept under its profile (so it comes back without a login, an auth key's too); an ephemeral one's isn't.
  return {
    controlURL: t.controlURL,
    hostname: t.hostname,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty auth key is none
    authKey: authKey || undefined,
    exitNode: t.exitNode || undefined,
    ...(t.acceptRoutes === false ? { acceptRoutes: false } : {}),
    persist: c.ephemeral ? undefined : t.stateKey,
  };
}
