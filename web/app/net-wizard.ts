// The Network wizard's parts (NetWizard.svelte, the shell, and a component per step): its steps, what the shell tells
// a step, and what a step offers the shell.
import type { Connection } from './connections.ts';

/**
 * How the wizard was opened (web/app/areas/network.ts `openWizard`; docs/networking/adapters.md §3.2): `attach` a
 * connection to `machine`'s adapter `adapter` (machine undefined: the page's transient one), a `new` connection on its
 * own, or `edit` connection `connection`. `here`: the machine is the page's (it connects now, so an auth key is asked for).
 */
export type Opened = {
  mode: 'attach' | 'new' | 'edit';
  machine?: string;
  adapter?: number;
  connection?: string;
  here?: boolean;
  /** The local helper's pairing link (`#net=`): the wizard opens on it. */
  localURL?: string;
};

export type Step =
  | 'pick'
  | 'kind'
  | 'tailscale'
  | 'tailcat'
  | 'local'
  | 'roomPick'
  | 'roomGlobal'
  | 'roomCreate'
  | 'roomJoin'
  | 'roomEdit';

/** The steps NetRoomStep.svelte shows (one form, four ways). */
export const ROOM_STEPS: ReadonlySet<Step> = new Set(['roomGlobal', 'roomCreate', 'roomJoin', 'roomEdit']);

/** The steps that make a connection: Keep shows under them. */
export const MAKING_STEPS: ReadonlySet<Step> = new Set([
  'tailscale',
  'tailcat',
  'local',
  'roomGlobal',
  'roomCreate',
  'roomJoin',
]);

/** The step a connection is edited on. */
export const EDIT_STEP: Record<Connection['kind'], Step> = {
  tailnet: 'tailscale',
  local: 'local',
  room: 'roomEdit',
  tailcat: 'tailcat',
};

/** What the shell gives every step: the session, and how a step's Save ends. */
export type Flow = {
  /** How the wizard was opened. */
  readonly opened: Opened;
  /** The connection being edited, if it is (`forget` replaces it). */
  readonly editing: Connection | undefined;
  /** A new connection is kept in this browser (the shell's Keep). */
  readonly keep: boolean;
  /** What the wizard attaches connects now (the machine is the page's): an auth key is asked for then. */
  readonly here: boolean;
  /** Ends a step that made `c`: attaches it (connecting it with `key` on the page's machine), or closes. */
  made(c: Connection, key?: string): Promise<void>;
  /** Ends an edit: writes `c` back, closes. */
  edited(c: Connection): Promise<void>;
  /** Shows an error under the form (a message, an error with its causes). */
  fail(e: unknown): void;
  /** Goes to another step. */
  go(to: Step): void;
  /** Gives the connection being edited a new address or name (a new key): false if nothing changed. */
  forget(): Promise<boolean>;
};

/** What a step offers the shell (its component's exports). */
export type StepApi = {
  /** A new session: the step's form takes its first values. */
  begin: () => void;
  /** The step is shown: it focuses its first control (and checks what it needs to). */
  enter: () => void;
  /** Its Save (the dialog's submit); steps that only choose have none. */
  save?: () => Promise<void>;
};
