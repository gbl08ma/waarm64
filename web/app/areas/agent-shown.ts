// What the page shows of the run's agent (web/app/areas/agent-actions.ts `AgentShown`): the guest's OS in the status
// bar, and whether Power off and Restart ask the guest first (the toolbar's words; a request pending ends with the run).
import type { AgentShown } from './agent-actions.ts';
import { power } from './power.svelte.ts';
import { status } from './status.svelte.ts';

export const agentShown: AgentShown = {
  os(os) {
    status.os = os;
  },
  canPower(can) {
    power.canSoft = can;
    if (!can) power.soft = undefined;
  },
};
