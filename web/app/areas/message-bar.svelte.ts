// The message bar (web/app/App.svelte): a problem or a note, its details and what can be done about it. web/app/run/
// messages.ts writes it (`Messages.show`).
import type { Msg } from '../../i18n.ts';

/** `info`: something done (a snapshot saved), a notice that closes itself; `warn` and `error` stay until closed. */
export type MessageKind = 'error' | 'warn' | 'info';
export type Action = { label: string; run: (button: HTMLButtonElement) => void };
/**
 * A notice's time on screen: `ms`, counted by the bar's ring around its close button (paused while the pointer is on
 * the bar or the tab is hidden), then `end`. `id` tells one notice's from the next's (the ring starts over; a bar that takes a notice from another goes on from its time: ui/ErrorBanner.svelte).
 */
export type Countdown = { ms: number; id: number; end: () => void };

export const messageBar = $state<{
  text: string;
  details: string[];
  from: readonly (Msg | 'raw' | undefined)[];
  kind: MessageKind;
  actions: Action[];
  countdown: Countdown | undefined;
  snapshot: string;
  load: string;
}>({
  /** The headline (none: the bar is hidden). */
  text: '',
  /** The message's details, one per line, under it (an error's causes: web/i18n.ts `describe`). */
  details: [],
  /** What each line is, the headline's first, where it's known (web/i18n.ts `Described`): drawn by MessageWords.svelte. */
  from: [],
  kind: 'warn',
  actions: [],
  /** A notice's countdown (none: the message stays until closed). */
  countdown: undefined,
  /** The last snapshot written (its bytes, pause, id and phases), for tools: `#message[data-snapshot]`. */
  snapshot: '',
  /** The last start from a snapshot or a suspended copy (its phases: protocol.ts `LoadPhases`), for tools: `#message[data-load]`. */
  load: '',
});
