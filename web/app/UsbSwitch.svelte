<!--
  A machine's USB controller, on or off (its Settings and USB tabs), and the warning when that orphans its snapshots.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Note from './ui/Note.svelte';
  import { t } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();
</script>

<Check bind:checked={edit.draft.usb} field="usb" title={t('machines:UsbSwitch.usb.title')}>
  {t('machines:UsbSwitch.usb')}
</Check>
{#if edit.orphans('usb')}
  <Note tone="warn" data-usb-orphans>
    {edit.draft.usb ? t('machines:UsbSwitch.usb.orphans.on') : t('machines:UsbSwitch.usb.orphans.off')}
  </Note>
{/if}
