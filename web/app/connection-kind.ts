// A network connection's kind in words (docs/networking/adapters.md §2), for its line on the Connections pane and an
// adapter's on a machine's Network tab.
import { msg, type Msg } from '../msg.ts';
import type { Connection } from './connections.ts';

const KINDS: Record<Connection['kind'], (c: Connection) => Msg> = {
  tailnet: (c) => msg('machines:connection-kind.tailnet', { host: new URL(c.tailnet?.controlURL ?? '').host }),
  local: () => msg('machines:connection-kind.local'),
  room: () => msg('machines:connection-kind.room'),
  tailcat: (c) =>
    c.tailcat?.exit ? msg('machines:connection-kind.tailcatExit') : msg('machines:connection-kind.tailcatServe'),
};

/** Its kind (its server's, for a tailnet), and whether it's kept. */
export function kindText(c: Connection): Msg {
  const kind = KINDS[c.kind](c);
  return c.ephemeral ? msg('machines:connection-kind.ephemeral', { kind }) : kind;
}
