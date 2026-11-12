<!--
  The Network wizard's choice for a room (NetWizard.svelte): join the global public room (web/room.ts `GLOBAL_ROOM`),
  create one, or join one by its link or name (NetRoomStep.svelte each way).
-->
<script lang="ts">
  import Choice from './ui/Choice.svelte';
  import Step from './ui/Step.svelte';
  import { t } from '../i18n.ts';
  import type { Flow } from './net-wizard.ts';

  type Props = { flow: Flow; active: boolean };
  let { flow, active }: Props = $props();

  let first = $state<HTMLElement>();
  export function begin() {
    // Nothing to reset: the step only chooses.
  }
  export function enter() {
    queueMicrotask(() => first?.focus());
  }
</script>

<Step id="net-step-room-pick" {active}>
  <Choice
    id="net-room-global"
    label={t('network:NetRoomPickStep.room.global')}
    onclick={() => flow.go('roomGlobal')}
    {@attach (el: HTMLElement) => {
      first = el;
    }}
  >
    {t('network:NetRoomPickStep.room.global.note')}
  </Choice>
  <Choice id="net-room-create" label={t('network:NetRoomPickStep.room.create')} onclick={() => flow.go('roomCreate')}>
    {t('network:NetRoomPickStep.room.create.note')}
  </Choice>
  <Choice id="net-room-join" label={t('network:NetRoomPickStep.room.join')} onclick={() => flow.go('roomJoin')}>
    {t('network:NetRoomPickStep.room.join.note')}
  </Choice>
</Step>
