<!--
  A machine's USB devices on the Machines page (docs/plans/usb.md §4a, docs/usb.md "The page"): the devices it remembers,
  each with its state (attached, plugged in, not plugged in, held by another machine, no permission in this browser),
  its connector and whether it is attached at start; Attach and Detach while it runs on this page, Allow, Forget. Add a
  device… opens the wizard (AddUsb.svelte). The controller's switch is the Machines page's (it is in the shape).
-->
<script lang="ts">
  import AddUsb from './AddUsb.svelte';
  import Icon from './Icon.svelte';
  import { ask } from './ask.svelte.ts';
  import { KEYBOARD_CONNECTOR, USER_CONNECTORS, type MachineRecord } from './shape.ts';
  import { deviceName, hasTwins, idsText } from './usb-ports.ts';
  import type { EntryView } from './usb-live.ts';
  import { page, ui } from './ui.svelte.ts';

  type Props = {
    machine: MachineRecord;
    /** It runs (on this page, or in another tab). */
    running: boolean;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
  };
  let { machine, running, act }: Props = $props();

  const here = $derived(machine.id === ui.current && ui.usb.running);
  let views = $state<EntryView[]>([]);
  $effect(() => {
    void ui.records;
    void ui.usb.tick;
    const m = $state.snapshot(machine) as MachineRecord;
    void page.usbStates(m).then((v) => { views = v; });
  });
  let adding = $state(false);

  const STATE: Record<EntryView['state'], string> = {
    attached: 'attached',
    plugged: 'plugged in',
    unplugged: 'not plugged in',
    held: 'held by another machine',
    ungranted: 'no permission in this browser',
  };
  const stateText = (v: EntryView) => (v.state === 'held' && v.holder ? `held by ${v.holder}` : STATE[v.state]);

  async function forget(v: EntryView) {
    if (!(await ask.confirm(`Forget ${deviceName(v.entry)}? ${here && v.state === 'attached' ? 'It is detached first (the guest sees it unplugged). ' : ''}When no other machine remembers it, the browser's permission for it goes too.`, { title: 'Forget a USB device', ok: 'Forget', danger: here && v.state === 'attached' }))) return;
    await act('Forgetting', () => page.usbForget(machine.id, v.entry.id));
  }
</script>

<div class="usb">
  {#if !machine.usb}
    <p class="note" data-usb-off>This machine has no USB controller: turn it on above to attach devices. It changes the machine's shape, so the snapshots taken before are orphaned.</p>
  {/if}
  <ul class="entries">
    {#each views as v (v.entry.id)}
      {@const e = v.entry}
      {@const c = here && v.state === 'attached' ? ui.usb.connectors[e.connector] : null}
      <li data-usb-entry={e.id} data-state={v.state}>
        <Icon name={e.api === 'hid' ? 'device-gamepad-2' : 'usb'} size={18} />
        <div class="what">
          <strong>{deviceName(e)}</strong>
          <span class="meta">{e.api === 'hid' ? 'HID' : 'USB'} {idsText(e)}{e.serialNumber ? ` · serial ${e.serialNumber}` : e.index ? ` · the ${e.index + 1}${['st', 'nd', 'rd'][e.index] ?? 'th'} of its kind` : ''} · <span data-usb-state>{stateText(v)}</span></span>
          {#if c?.entry === e.id && c.problems?.length}
            <ul class="problems" data-usb-problems={e.id}>{#each c.problems as p, i (i)}<li>{p}</li>{/each}</ul>
          {/if}
        </div>
        <label class="field" title="The root connector it goes on (the guest's port path: its names under /dev/serial/by-path stay the same)">Connector
          <select value={e.connector} disabled={here && v.state === 'attached'} onchange={(ev) => act('Saving', () => page.usbEdit(machine.id, e.id, { connector: Number((ev.currentTarget as HTMLSelectElement).value) }))} data-field="connector">
            {#each Array.from({ length: USER_CONNECTORS }, (_, i) => i) as c (c)}<option value={c}>{c + 1}</option>{/each}
          </select></label>
        <label class="check" title="Attached when the machine starts, and when it is plugged in while the machine runs"><input type="checkbox" checked={e.atStart} onchange={(ev) => act('Saving', () => page.usbEdit(machine.id, e.id, { atStart: (ev.currentTarget as HTMLInputElement).checked }))} data-field="at-start"> At start</label>
        {#if v.state === 'ungranted'}
          <button onclick={() => act('Asking the browser', () => page.usbAllow(machine.id, e.id))} data-action="allow" title="The browser's chooser, showing this device: pick it to give this page its permission">Allow…</button>
        {/if}
        {#if here && v.state === 'attached'}
          <button onclick={() => act('Detaching', () => page.usbDetach(e.id))} data-action="detach" title="Unplug it from the guest"><Icon name="plug" size={16} />Detach</button>
        {:else if here && (v.state === 'plugged' || v.state === 'held')}
          <button class="primary" onclick={() => act('Attaching', () => page.usbAttach(e.id))} data-action="attach" title={v.state === 'held' ? 'Another machine has it: it is detached there first (asked)' : 'Plug it into the guest'}><Icon name="plug-connected" size={16} />{v.state === 'held' ? 'Attach here…' : 'Attach'}</button>
        {/if}
        <button onclick={() => forget(v)} data-action="forget" title="The machine no longer remembers it"><Icon name="trash" size={16} />Forget</button>
      </li>
    {:else}
      <li class="none">No USB devices remembered.</li>
    {/each}
  </ul>
  {#if machine.usb}
    {@const k = here ? ui.usb.connectors[KEYBOARD_CONNECTOR] : null}
    <p class="note" data-usb-builtin data-state={k?.builtin ? k.state : 'detached'}>Connector {KEYBOARD_CONNECTOR + 1} is the built-in keyboard's: the screen's keys reach the firmware and the boot loader through it, until the guest's own keyboard driver takes over (then it is unplugged{here ? (k?.builtin ? ', now it is plugged in' : ', as now') : ''}).</p>
  {/if}
  <div class="row"><button onclick={() => (adding = true)} data-action="add-usb" disabled={!machine.usb}><Icon name="plus" size={16} />Add a device…</button></div>
  {#if hasTwins(machine.usbDevices ?? [])}
    <p class="note" data-usb-twins>Identical devices without a serial number are told apart by the order the browser lists them in (usually the order they were plugged in): plug them in the same order, or the guest sees them swapped.</p>
  {/if}
  <p class="note">{running && !here ? 'It runs in another tab: attach and detach there. ' : !running ? 'Attach and detach while the machine runs on this page (its toolbar has a USB menu). ' : ''}Devices aren't part of the machine's shape: they are plugged in and out while it runs, and Snapshot and Suspend unplug them first (asked).</p>
</div>
{#if adding}<AddUsb machine={machine.id} name={machine.name} close={() => (adding = false)} />{/if}

<style>
  .usb { display: flex; flex-direction: column; gap: 12px; max-width: 820px; }
  .entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .entries li { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
  .entries li.none { color: var(--dim); }
  .what { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
  .meta { color: var(--dim); font-size: 12px; }
  li[data-state=attached] [data-usb-state] { color: #8fd18f; }
  li[data-state=held] [data-usb-state], li[data-state=ungranted] [data-usb-state] { color: #ffb36b; }
  .problems { margin: 4px 0 0; padding-left: 18px; color: #ffb36b; font-size: 12px; }
  .field { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .primary { background: #24406b; border-color: #3b6db3; color: #fff; }
  .note { color: var(--dim); font-size: 12px; margin: 0; }
</style>
