// The machines a connection is attached to (docs/networking/adapters.md §3.1): the stored machines whose adapters have
// it, and the page's transient machine when its adapter has it. Connections' cards name them in their line, and a
// connection's Details links each stored one to its Network tab.
import { settings } from './settings.ts';
import type { MachineRecord } from './shape.ts';

/** A machine that has the connection attached: a stored one (`id`), or the page's transient one (no id). */
export type ConnectionUser = { id?: string; name: string };

/** The machines whose adapters have connection `id`; `transient`: the page's transient machine's name, if it has one. */
export function usersOf(id: string, machines: readonly MachineRecord[], transient?: string): ConnectionUser[] {
  return [
    ...machines.filter((m) => m.adapters?.some((a) => a.connection === id)).map((m) => ({ id: m.id, name: m.name })),
    ...(transient !== undefined && settings().transientNet === id ? [{ name: transient }] : []),
  ];
}
