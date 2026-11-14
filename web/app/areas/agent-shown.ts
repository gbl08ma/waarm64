// What the page shows of the run's agent (web/app/areas/agent-actions.ts `AgentShown`): the guest's OS in the status
// bar, and whether Power off and Restart ask the guest first (the toolbar's words; a request pending ends with the run).
// On the page's areas (web/app/main.ts: `power`, `status`); runes-free, for tests/agent-power.test.ts.
import type { GuestOs } from '../../agent-frame.ts';
import type { AgentShown } from './agent-actions.ts';

type Power = { canSoft: boolean; soft: 'off' | 'reboot' | undefined };
type Status = { os?: GuestOs };

export const agentShown = (power: Power, status: Status): AgentShown => ({
  os(os) {
    status.os = os;
  },
  // A connection's end doesn't clear a pending request: the guest's shutdown stops its agent before it powers off
  // (web/app/run/soft-power.ts; an agent that connects again clears it there).
  canPower(can) {
    power.canSoft = can;
  },
  ended() {
    power.canSoft = false;
    power.soft = undefined;
  },
});
