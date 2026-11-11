<!--
  A machine's input and clock devices and its clipboard sharing, on or off (its Settings tab), and the warnings when a
  change orphans its snapshots.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Icon from './ui/Icon.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { page } from './page.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();

  const pointersOrphan = $derived(edit.orphans('mouse') || edit.orphans('touch') || edit.orphans('clock'));
</script>

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
<!-- Turning it on is the click that asks for the browser's read permission (docs/plans/clipboard.md §4.1). -->
<Check
  bind:checked={edit.draft.clipboard}
  field="clipboard"
  onchange={(on: boolean) => {
    if (on) page.clipboardAsk();
  }}
  note={clipboardNote}
>
  {t('machines:DeviceSwitches.clipboard')}
</Check>
{#if edit.orphans('clipboard')}
  <Note tone="warn" data-clipboard-orphans>
    {edit.draft.clipboard
      ? t('machines:DeviceSwitches.clipboard.orphans.on')
      : t('machines:DeviceSwitches.clipboard.orphans.off')}
  </Note>
{/if}

<style>
  /* A toolbar button's icon named in a sentence (the clipboard note): on the text's line, the words' color. */
  .inline-icon {
    display: inline-flex;
    vertical-align: -2px;
  }
</style>
