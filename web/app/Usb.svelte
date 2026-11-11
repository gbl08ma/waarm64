<!--
  A machine's USB devices on the Machines page (docs/usb.md "The page"): the devices it remembers,
  each with its state (attached, plugged in, not plugged in, held by another machine, no permission in this browser),
  its connector and whether it is attached at start; Attach and Detach while it runs on this page, Allow, Forget. Add a
  device… opens the wizard (AddUsb.svelte). The controller's switch is the Machines page's (it is in the shape).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import AddUsb from './AddUsb.svelte';
  import Icon from './ui/Icon.svelte';
  import UsbProblems from './UsbProblems.svelte';
  import { t } from '../i18n.ts';
  import { ask } from './ask.svelte.ts';
  import { KEYBOARD_CONNECTOR, USER_CONNECTORS, type MachineRecord } from './shape.ts';
  import { deviceName, hasTwins, idsText } from './usb-ports.ts';
  import type { EntryView } from './usb-live.ts';
  import { page, ui } from './ui.svelte.ts';

  type Props = {
    machine: MachineRecord;
    /** It runs (on this page, or in another tab). */
    running: boolean;
    /** It has kept snapshots (turning the controller on would orphan them). */
    snapshots: boolean;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
  };
  let { machine, running, snapshots, act }: Props = $props();

  const here = $derived(machine.id === ui.current && ui.usb.running);
  let views = $state<EntryView[]>([]);
  $effect(() => {
    void ui.records;
    void ui.usb.tick;
    const m = $state.snapshot(machine) as MachineRecord;
    void page.usbStates(m).then((v) => {
      views = v;
    });
  });
  let adding = $state(false);

  const STATE: Record<EntryView['state'], string> = {
    attached: 'usb:Usb.state.attached',
    plugged: 'usb:Usb.state.plugged',
    unplugged: 'usb:Usb.state.unplugged',
    held: 'usb:Usb.state.held',
    ungranted: 'usb:Usb.state.ungranted',
  };
  const stateText = (v: EntryView) =>
    v.state === 'held' && v.holder ? t('usb:Usb.state.heldBy', { holder: v.holder }) : t(STATE[v.state]);
  /** The English ordinal's suffix of `n` as the words write it (2nd, 3rd, 4th…): a message each. */
  const nth = (n: number) =>
    n === 2
      ? t('usb:Usb.meta.index.nd', { n })
      : n === 3
        ? t('usb:Usb.meta.index.rd', { n })
        : t('usb:Usb.meta.index.th', { n });

  async function forget(v: EntryView) {
    const name = deviceName(v.entry);
    const attached = here && v.state === 'attached';
    if (
      !(await ask.confirm(attached ? t('usb:Usb.forget.attached', { name }) : t('usb:Usb.forget', { name }), {
        title: t('usb:Usb.forget.title'),
        ok: t('usb:Usb.forget.ok'),
        danger: attached,
      }))
    )
      return;
    await act(t('usb:Usb.busy.forgetting'), () => page.usbForget(machine.id, v.entry.id));
  }
</script>

<div class="usb">
  {#if !machine.usb}
    <p class="note" data-usb-off>{snapshots ? t('usb:Usb.noController.orphans') : t('usb:Usb.noController')}</p>
  {/if}
  <ul class="entries">
    {#each views as v (v.entry.id)}
      {@const e = v.entry}
      {@const c = here && v.state === 'attached' ? ui.usb.connectors[e.connector] : null}
      <li data-usb-entry={e.id} data-state={v.state}>
        <Icon name={e.api === 'hid' ? 'device-gamepad-2' : 'usb'} size={18} />
        <div class="what">
          <strong>{deviceName(e)}</strong>
          <span class="meta"
            >{e.api === 'hid'
              ? t('usb:Usb.meta.hid', { ids: idsText(e) })
              : t('usb:Usb.meta.usb', { ids: idsText(e) })}{#if e.serialNumber}
              · {t('usb:Usb.meta.serial', { serial: e.serialNumber })}{:else if e.index}
              · {nth(e.index + 1)}{/if} · <span data-usb-state>{stateText(v)}</span></span
          >
          {#if c?.entry === e.id && c.problems?.length}
            <div class="problems" data-usb-problems={e.id}><UsbProblems words={c.problems} /></div>
          {/if}
        </div>
        <label class="field" title={t('usb:Usb.connector.title')}
          >{t('usb:Usb.connector')}
          <select
            value={e.connector}
            disabled={here && v.state === 'attached'}
            onchange={(ev) =>
              act(t('usb:Usb.busy.saving'), () =>
                page.usbEdit(machine.id, e.id, { connector: Number((ev.currentTarget as HTMLSelectElement).value) }),
              )}
            data-field="connector"
          >
            {#each Array.from({ length: USER_CONNECTORS }, (_, i) => i) as c (c)}<option value={c}>{c + 1}</option
              >{/each}
          </select></label
        >
        <Check
          compact
          checked={e.atStart}
          onchange={(on) => act(t('usb:Usb.busy.saving'), () => page.usbEdit(machine.id, e.id, { atStart: on }))}
          field="at-start"
          title={t('usb:Usb.atStart.title')}>{t('usb:Usb.atStart')}</Check
        >
        {#if v.state === 'ungranted'}
          <button
            onclick={() => act(t('usb:Usb.busy.asking'), () => page.usbAllow(machine.id, e.id))}
            data-action="allow"
            title={t('usb:Usb.allow.title')}>{t('usb:Usb.allow')}</button
          >
        {/if}
        {#if here && v.state === 'attached'}
          <button
            onclick={() => act(t('usb:Usb.busy.detaching'), () => page.usbDetach(e.id))}
            data-action="detach"
            title={t('usb:Usb.detach.title')}><Icon name="plug" size={16} />{t('usb:Usb.detach')}</button
          >
        {:else if here && (v.state === 'plugged' || v.state === 'held')}
          <button
            class="primary"
            onclick={() => act(t('usb:Usb.busy.attaching'), () => page.usbAttach(e.id))}
            data-action="attach"
            title={v.state === 'held' ? t('usb:Usb.attachHere.title') : t('usb:Usb.attach.title')}
            ><Icon name="plug-connected" size={16} />{v.state === 'held'
              ? t('usb:Usb.attachHere')
              : t('usb:Usb.attach')}</button
          >
        {/if}
        <button onclick={() => forget(v)} data-action="forget" title={t('usb:Usb.forget.button.title')}
          ><Icon name="trash" size={16} />{t('usb:Usb.forget.button')}</button
        >
      </li>
    {:else}
      <li class="none">{t('usb:Usb.none')}</li>
    {/each}
  </ul>
  {#if machine.usb}
    {@const k = here ? ui.usb.connectors[KEYBOARD_CONNECTOR] : null}
    <p class="note" data-usb-builtin data-state={k?.builtin ? k.state : 'detached'}>
      {here
        ? k?.builtin
          ? t('usb:Usb.builtin.pluggedNow', { connector: KEYBOARD_CONNECTOR + 1 })
          : t('usb:Usb.builtin.asNow', { connector: KEYBOARD_CONNECTOR + 1 })
        : t('usb:Usb.builtin', { connector: KEYBOARD_CONNECTOR + 1 })}
    </p>
  {/if}
  <div class="row">
    <button onclick={() => (adding = true)} data-action="add-usb" disabled={!machine.usb}
      ><Icon name="plus" size={16} />{t('usb:Usb.add')}</button
    >
  </div>
  {#if hasTwins(machine.usbDevices ?? [])}
    <p class="note" data-usb-twins>{t('usb:Usb.twins')}</p>
  {/if}
  <p class="note">
    {running && !here ? t('usb:Usb.note.otherTab') : !running ? t('usb:Usb.note.stopped') : t('usb:Usb.note')}
  </p>
</div>
{#if adding}<AddUsb machine={machine.id} name={machine.name} close={() => (adding = false)} />{/if}

<style>
  .usb {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .entries li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
  }
  .entries li.none {
    color: var(--dim);
  }
  .what {
    flex: 1;
    min-width: 200px;
    display: flex;
    flex-direction: column;
  }
  .meta {
    color: var(--dim);
    font-size: 12px;
  }
  li[data-state='attached'] [data-usb-state] {
    color: #8fd18f;
  }
  li[data-state='held'] [data-usb-state],
  li[data-state='ungranted'] [data-usb-state] {
    color: #ffb36b;
  }
  .problems {
    margin-top: 4px;
    color: #ffb36b;
    font-size: 12px;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--dim);
    font-size: 12px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 10px;
  }
  .primary {
    background: #24406b;
    border-color: #3b6db3;
    color: #fff;
  }
  .note {
    color: var(--dim);
    font-size: 12px;
    margin: 0;
  }
</style>
