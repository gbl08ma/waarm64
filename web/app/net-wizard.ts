// The Network wizard's parts (NetWizard.svelte, the shell, and a component per step): its steps, what the shell tells
// a step, and what a step offers the shell.
import type { Connection } from './connections.ts';
import type { From } from './home-route.ts';

/**
 * How the wizard was opened (web/app/areas/network.ts `openWizard`; docs/networking/adapters.md §3.2): `attach` a
 * connection to `machine`'s adapter `adapter` (machine undefined: the page's transient one), or a `new` connection on
 * its own. `here`: the machine is the page's (it connects now, so an auth key is asked for).
 */
export type Opened = {
  mode: 'attach' | 'new';
  machine?: string;
  adapter?: number;
  /** The connection the adapter has now: the wizard first asks whether it's to be edited or another attached. */
  attached?: string;
  /** Where the wizard was opened (a machine's Network tab, the machine's screen): the connection's page, opened to
   *  edit the attached connection, leads back there. */
  from?: From;
  here?: boolean;
  /** The local helper's pairing link (`#net=`): the wizard opens on it. */
  localURL?: string;
};

export type Step =
  | 'change'
  | 'pick'
  | 'kind'
  | 'tailscale'
  | 'tailcat'
  | 'local'
  | 'demo'
  | 'roomPick'
  | 'roomGlobal'
  | 'roomCreate'
  | 'roomJoin';

/** The steps NetRoomStep.svelte shows (one form, three ways). */
export const ROOM_STEPS: ReadonlySet<Step> = new Set(['roomGlobal', 'roomCreate', 'roomJoin']);

/** The steps that make a connection: Keep shows under them. */
export const MAKING_STEPS: ReadonlySet<Step> = new Set([
  'tailscale',
  'tailcat',
  'local',
  'demo',
  'roomGlobal',
  'roomCreate',
  'roomJoin',
]);

/** What the shell gives every step: the session, and how a step's Save ends. */
export type Flow = {
  /** How the wizard was opened. */
  readonly opened: Opened;
  /** A new connection is kept in this browser (the shell's Keep). */
  readonly keep: boolean;
  /** What the wizard attaches connects now (the machine is the page's): an auth key is asked for then. */
  readonly here: boolean;
  /** Ends a step that made `c`: attaches it (connecting it with `key` on the page's machine), or closes. */
  made(c: Connection, key?: string): Promise<void>;
  /** Shows an error under the form (a message, an error with its causes). */
  fail(e: unknown): void;
  /** Goes to another step. */
  go(to: Step): void;
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

/** What the shell knows of how it was opened: there are connections to pick, and the adapter has one (`changing`). */
export type Start = { pickable: boolean; changing: boolean };

/**
 * The step the wizard opens on: the local helper's on its pairing link; the choice between editing the adapter's
 * connection and attaching another, when it has one; else the pick step where there's a connection to pick, or the kind.
 */
export function firstStep(o: Opened, s: Start): Step {
  if (o.localURL) return 'local';
  if (s.changing) return 'change';
  return s.pickable ? 'pick' : 'kind';
}

/** Where Back leads from `step`; undefined where there's no Back (the step the wizard opened on). */
export function stepBack(step: Step, s: Start): Step | undefined {
  if (step === 'change') return undefined;
  if (step === 'pick') return s.changing ? 'change' : undefined;
  if (step === 'kind') return s.pickable ? 'pick' : s.changing ? 'change' : undefined;
  if (ROOM_STEPS.has(step)) return 'roomPick';
  return 'kind';
}
