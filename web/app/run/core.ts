// What every area's actions take (web/app/main.ts makes them, in this order): the page's machine, its run, the power
// actions that stop and start it, the state and message bar, and the serial terminal (reset at each start).
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import type { Messages } from './messages.ts';
import type { PageMachine } from './page-machine.svelte.ts';
import type { PowerActions } from './power-actions.ts';
import type { Runner } from './runner.ts';

export type Core = {
  machine: PageMachine;
  runner: Runner;
  power: PowerActions;
  messages: Messages;
  terminal: SerialTerminal;
};
