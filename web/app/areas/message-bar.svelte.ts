// The message bar (web/app/App.svelte): a problem or a note, its details and what can be done about it. web/app/run/
// messages.ts writes it (`Messages.show`).

export type MessageKind = 'error' | 'warn';
export type Action = { label: string; run: (button: HTMLButtonElement) => void };

export const messageBar = $state<{
  text: string;
  details: string[];
  kind: MessageKind;
  actions: Action[];
  snapshot: string;
  load: string;
}>({
  /** The headline (none: the bar is hidden). */
  text: '',
  /** The message's details, one per line, under it (an error's causes: web/i18n.ts `describe`). */
  details: [],
  kind: 'warn',
  actions: [],
  /** The last snapshot written (its bytes, pause, id and phases), for tools: `#message[data-snapshot]`. */
  snapshot: '',
  /** The last start from a snapshot or a suspended copy (its phases: protocol.ts `LoadPhases`), for tools: `#message[data-load]`. */
  load: '',
});
