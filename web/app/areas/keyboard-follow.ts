// The keyboard layout setting saved while the machine runs (docs/frontend.md "The keyboard layout"): the boot's
// credentials set it at the next boot; the guest agent sets it in the running session now (KEYMAP), and the on-screen
// keyboard then shows it. Without the agent nothing changes until the next boot.
import { keyboardLayout, resolveKeyboard } from '../keyboard.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { AgentActions } from './agent-actions.ts';
import { keys } from './keys.svelte.ts';

/** The layout the run gives its guest (web/app/run/runner.ts sets `keys.layout` at each start), for the agent's HELLOs. */
export const runLayout = () => keyboardLayout(keys.layout);

/** `page.keyboardFollow`: the page's machine's record saved (web/app/machine-edit.svelte.ts). */
export const keyboardFollow = (machine: PageMachine, agent: AgentActions) => async () => {
  const l = await resolveKeyboard(machine.resolve().keyboard);
  if (l && l.id !== keys.layout && agent.keymap(l)) keys.layout = l.id;
};
