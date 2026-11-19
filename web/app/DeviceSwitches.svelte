<!--
  A machine's input and clock devices, its guest agent and clipboard sharing through it, on or off (its Settings tab),
  and the warnings when a change orphans its snapshots (the agent and the clipboard don't: they aren't in the shape).
  Under the clipboard's switch, a link to a dialog with the command that installs the agent's service in a guest
  without systemd (OpenRC: docs/devices.md "On OpenRC"), to copy.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Icon from './ui/Icon.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import ValueField from './ui/ValueField.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { page } from './page.ts';
  import { AGENT_OPENRC_INSTALL, AGENT_OPENRC_NAME, AGENT_OPENRC_REMOVE } from './guest-agent.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();

  const pointersOrphan = $derived(edit.orphans('mouse') || edit.orphans('touch') || edit.orphans('clock'));
  const agent = $derived(edit.draft.agent !== false);
  function setAgent(on: boolean) {
    edit.draft.agent = on ? undefined : false;
    edit.touch();
  }
  /** The OpenRC dialog is open (mounted while it is). */
  let openrc = $state(false);
  let dialog = $state<{ close: () => void }>();
  /** The command's field: the dialog's focus lands on it, which would show the command's end; its start is shown. */
  let field = $state<HTMLInputElement>();
  $effect(() => {
    if (!field) return;
    field.setSelectionRange(0, 0);
    field.scrollLeft = 0;
  });
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

{#snippet agentNote()}
  <span data-agent-note
    >{#if agent}<T k="machines:DeviceSwitches.agent.on" />{:else}{t('machines:DeviceSwitches.agent.off')}{/if}</span
  >
{/snippet}

<!-- The note names the toolbar's clipboard menu with its icon after the words (docs/copy.md "The elements"). -->
{#snippet clipboardNote()}
  <T k="machines:DeviceSwitches.clipboard.note">
    {#snippet icon(words: string)}{words}
      <span class="inline-icon" aria-hidden="true"><Icon name="clipboard" size={14} /></span>{/snippet}
  </T>
{/snippet}

<Check bind:checked={edit.draft.mouse} field="mouse" title={t('machines:DeviceSwitches.mouse.title')}>
  {t('machines:DeviceSwitches.mouse')}
</Check>
<Check bind:checked={edit.draft.touch} field="touch" title={t('machines:DeviceSwitches.touch.title')}>
  {t('machines:DeviceSwitches.touch')}
</Check>
<Check bind:checked={edit.draft.clock} field="clock" title={t('machines:DeviceSwitches.clock.title')}>
  {t('machines:DeviceSwitches.clock')}
</Check>
{#if pointersOrphan}<Note tone="warn" data-pointer-orphans>{t('machines:DeviceSwitches.pointers.orphans')}</Note>{/if}
<Check
  checked={agent}
  onchange={setAgent}
  field="agent"
  title={t('machines:DeviceSwitches.agent.title')}
  note={agentNote}
>
  {t('machines:DeviceSwitches.agent')}
</Check>
<!-- Through the agent: off with it. Turning it on is the click that asks for the browser's read permission
     (docs/plans/clipboard.md §4.1). -->
<div class="under">
  <Check
    bind:checked={edit.draft.clipboard}
    field="clipboard"
    disabled={!agent}
    onchange={(on: boolean) => {
      if (on) page.clipboardAsk();
    }}
    note={clipboardNote}
  >
    {t('machines:DeviceSwitches.clipboard')}
  </Check>
  <Button type="button" variant="link" id="agent-openrc-open" onclick={() => (openrc = true)}>
    {t('machines:DeviceSwitches.openrc.link')}
  </Button>
</div>
{#if openrc}
  <Modal
    id="agent-openrc"
    bind:this={dialog}
    title={t('machines:DeviceSwitches.openrc.title')}
    onclose={() => (openrc = false)}
  >
    <Note size="md">{t('machines:DeviceSwitches.openrc.systemd')}</Note>
    <Note size="md">{t('machines:DeviceSwitches.openrc.run')}</Note>
    <ValueField
      id="agent-openrc-command"
      copyId="agent-openrc-command-copy"
      value={AGENT_OPENRC_INSTALL}
      bind:ref={field}
      readonly
      copy
      mono
    />
    <Note size="md">
      <T
        k="machines:DeviceSwitches.openrc.what"
        params={{ service: `/etc/init.d/${AGENT_OPENRC_NAME}`, remove: AGENT_OPENRC_REMOVE }}
        {code}
      />
    </Note>
    <Note size="md">{t('machines:DeviceSwitches.openrc.demo')}</Note>
    {#snippet buttons()}
      <Button type="button" variant="primary" id="agent-openrc-close" onclick={() => dialog?.close()}>
        {t('machines:DeviceSwitches.openrc.close')}
      </Button>
    {/snippet}
  </Modal>
{/if}

<style>
  /* A switch that works through the one above it. */
  .under {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding-inline-start: var(--space-5);
  }
  /* A toolbar button's icon named in a sentence (the clipboard note): on the text's line, the words' color. */
  .inline-icon {
    display: inline-flex;
    vertical-align: -2px;
  }
</style>
