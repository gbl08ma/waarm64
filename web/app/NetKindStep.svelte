<!--
  The Network wizard's choice of a new connection's kind (NetWizard.svelte): a tailnet, a tailcat exit or server, the
  local helper on this computer, the demo network, a room.
-->
<script lang="ts">
  import Choice from './ui/Choice.svelte';
  import Note from './ui/Note.svelte';
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

<Step id="net-step-kind" {active}>
  <Note size="md">{t('network:NetKindStep.kind.note')}</Note>
  <Choice
    id="net-pick-tailnet"
    label={t('network:NetKindStep.kind.pickTailnet')}
    onclick={() => flow.go('tailscale')}
    {@attach (el: HTMLElement) => {
      first = el;
    }}
  >
    {t('network:NetKindStep.kind.pickTailnet.note')}
  </Choice>
  <Choice id="net-pick-tailcat" label={t('network:NetKindStep.kind.pickTailcat')} onclick={() => flow.go('tailcat')}>
    {t('network:NetKindStep.kind.pickTailcat.note')}
  </Choice>
  <Choice id="net-pick-local" label={t('network:NetKindStep.kind.pickLocal')} onclick={() => flow.go('local')}>
    {t('network:NetKindStep.kind.pickLocal.note')}
  </Choice>
  <Choice id="net-pick-demo" label={t('network:NetKindStep.kind.pickDemo')} onclick={() => flow.go('demo')}>
    {t('network:NetKindStep.kind.pickDemo.note')}
  </Choice>
  <Choice id="net-pick-room" label={t('network:NetKindStep.kind.pickRoom')} onclick={() => flow.go('roomPick')}>
    {t('network:NetKindStep.kind.pickRoom.note')}
  </Choice>
</Step>
