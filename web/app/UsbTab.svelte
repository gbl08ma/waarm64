<!--
  A machine's USB tab (docs/usb.md "The page"): its USB controller on or off (saved with Save), then the devices it
  remembers (Usb.svelte).
-->
<script lang="ts">
  import Fields from './ui/Fields.svelte';
  import SaveRow from './SaveRow.svelte';
  import Usb from './Usb.svelte';
  import UsbSwitch from './UsbSwitch.svelte';
  import type { Act } from './actions.svelte.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import type { MachineRecord } from './shape.ts';

  type Props = { edit: Editing; machine: MachineRecord; act: Act };
  let { edit, machine, act }: Props = $props();
</script>

<Fields class="usb-switch" oninput={edit.touch} onchange={edit.touch}>
  <UsbSwitch {edit} />
  {#if edit.dirty}<SaveRow {edit} />{/if}
</Fields>
<div class="below">
  <Usb {machine} running={edit.running} snapshots={edit.hasSnapshots} {act} />
</div>

<style>
  /* The devices' list under the switch. */
  .below {
    margin-top: var(--space-4);
  }
</style>
