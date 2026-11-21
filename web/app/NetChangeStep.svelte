<!--
  The Network wizard's first step on an adapter that has a connection (NetWizard.svelte; docs/networking/adapters.md
  §3.2): which change is meant. Edit <name> closes the wizard and opens the connection's Settings on the Home page
  (`onedit`); Attach a different connection goes on to the wizard's steps (`onother`), whose Back returns here.
-->
<script lang="ts">
  import Choice from './ui/Choice.svelte';
  import Step from './ui/Step.svelte';
  import T from './T.svelte';
  import { msg } from '../i18n.ts';
  import type { Connection } from './connections.ts';

  type Props = { connection: Connection | undefined; active: boolean; onedit: () => void; onother: () => void };
  let { connection, active, onedit, onother }: Props = $props();

  let first = $state<HTMLElement>();
  export function begin() {
    // Nothing to reset: the step only chooses.
  }
  export function enter() {
    queueMicrotask(() => first?.focus());
  }
</script>

<Step id="net-step-change" {active}>
  {#if connection}
    {@const name = connection.name}
    <Choice
      id="net-change-edit"
      label={msg('network:NetChangeStep.edit', { name })}
      onclick={onedit}
      {@attach (el: HTMLElement) => {
        first = el;
      }}
    >
      <T k="network:NetChangeStep.edit.note" />
    </Choice>
    <Choice id="net-change-other" label={msg('network:NetChangeStep.other')} onclick={onother}>
      <T k="network:NetChangeStep.other.note" params={{ name }} />
    </Choice>
  {/if}
</Step>
