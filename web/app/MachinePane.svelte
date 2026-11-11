<!--
  A machine's pane on the Machines page (docs/machines.md §7): its head (open it here or start it, duplicate, export its
  definition, delete) and its tabs, Settings, Disks, Network, USB, Shared folders and Snapshots, each a component of
  its own. The tabs that edit the record share one draft and its Save (machine-edit.svelte.ts).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Pane from './ui/Pane.svelte';
  import Disks from './Disks.svelte';
  import FoldersTab from './FoldersTab.svelte';
  import NetworkTab from './NetworkTab.svelte';
  import SettingsTab from './SettingsTab.svelte';
  import Snapshots from './Snapshots.svelte';
  import UsbTab from './UsbTab.svelte';
  import { ask } from './ask.svelte.ts';
  import type { Act } from './actions.svelte.ts';
  import { exportDefinition } from './definitions.ts';
  import type { IconName } from './icons.ts';
  import { t, text, type Msg } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { deleteMachine, duplicateMachine } from './machines.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import { machinesNav, type MachinesTab } from './areas/machines-nav.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { isLive, power } from './areas/power.svelte.ts';
  import { inBar, page } from './page.ts';

  type Props = {
    edit: Editing;
    store: Store;
    net: PageNetwork;
    folders: PageFolders;
    machines: MachineRecord[];
    disks: Map<string, DiskRecord>;
    overlays: OverlayRecord[];
    /** The machine's state in words: running, suspended or off. */
    state: Msg;
    act: Act;
    offFirst: (m: MachineRecord) => Promise<boolean>;
    onchoose: (id: string) => void;
  };
  let { edit, store, net, folders, machines, disks, overlays, state, act, offFirst, onchoose }: Props = $props();

  const m = $derived(edit.draft);
  /** The record as stored, else the draft (a tab's lists show what's saved). */
  const saved = $derived(edit.record ?? m);
  const meta = $derived(m.id === current.id ? t('machines:MachinePane.head.stateHere', { state }) : text(state));
  const tabs = $derived<{ id: MachinesTab; icon: IconName; label: string }[]>([
    { id: 'settings', icon: 'settings', label: t('machines:MachinePane.tab.settings') },
    { id: 'disks', icon: 'database', label: t('machines:MachinePane.tab.disksCount', { n: m.attachments.length }) },
    { id: 'network', icon: 'network', label: t('machines:MachinePane.tab.network') },
    {
      id: 'usb',
      icon: 'usb',
      label: m.usbDevices?.length
        ? t('machines:MachinePane.tab.usbCount', { n: m.usbDevices.length })
        : t('machines:MachinePane.tab.usb'),
    },
    {
      id: 'folders',
      icon: 'folder',
      label: m.folders?.length
        ? t('machines:MachinePane.tab.foldersCount', { n: m.folders.length })
        : t('machines:MachinePane.tab.folders'),
    },
    { id: 'snapshots', icon: 'history', label: t('machines:MachinePane.tab.snapshots') },
  ]);
  /** The machine runs on this page, or is starting. */
  const busyHere = $derived(isLive(power.state) || power.state === 'loading');

  const duplicate = () =>
    act(t('machines:MachinePane.busy.copying'), async () => {
      onchoose((await duplicateMachine(store, m.id)).id);
    });
  // The definition out (docs/machines.md §6): the machine's shape as a small file.
  const exportDef = () =>
    act(t('machines:MachinePane.busy.exporting'), async () => {
      const def = await exportDefinition(store, m.id);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' })),
        download: `${m.name.replace(/[^\w.-]+/g, '-')}.webpc-machine.json`, // i18n-ignore: a file name
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
  async function remove() {
    const sure = await ask.confirm(t('machines:MachinePane.delete.confirm', { name: m.name }), {
      ok: t('machines:MachinePane.delete.ok'),
      danger: true,
    });
    if (sure) await act(t('machines:MachinePane.busy.deleting'), () => deleteMachine(store, m.id));
  }
  function start() {
    page.closeMachines();
    inBar(() => page.restart());
  }
</script>

<Pane
  id={m.id}
  title={m.name}
  {meta}
  metaAttrs={{ 'data-machine-state': '' }}
  {tabs}
  tab={machinesNav.tab}
  ontab={(x) => (machinesNav.tab = x as MachinesTab)}
>
  {#snippet actions()}
    {#if m.id !== current.id}
      <Button icon="player-play" onclick={() => inBar(() => page.openMachine(m.id))} data-action="open">
        {t('machines:MachinePane.open')}
      </Button>
    {:else if busyHere}
      <Button data-action="open" disabled title={t('machines:MachinePane.runningHere.title')}>
        {t('machines:MachinePane.runningHere')}
      </Button>
    {:else}
      <Button
        icon="player-play"
        variant="primary"
        onclick={start}
        data-action="start"
        title={t('machines:MachinePane.start.title')}
      >
        {t('machines:MachinePane.start')}
      </Button>
    {/if}
    <Button icon="copy" onclick={duplicate} title={t('machines:MachinePane.duplicate.title')}>
      {t('machines:MachinePane.duplicate')}
    </Button>
    <Button icon="file-export" onclick={exportDef} title={t('machines:MachinePane.exportDefinition.title')}>
      {t('machines:MachinePane.exportDefinition')}
    </Button>
    <Button icon="trash" onclick={remove} title={t('machines:MachinePane.machine.delete.title')}>
      {t('machines:MachinePane.machine.delete')}
    </Button>
  {/snippet}
  {#if machinesNav.tab === 'settings'}
    <SettingsTab {edit} />
  {:else if machinesNav.tab === 'network'}
    <NetworkTab {edit} {net} {act} />
  {:else if machinesNav.tab === 'usb'}
    <UsbTab {edit} machine={saved} {act} />
  {:else if machinesNav.tab === 'folders'}
    <FoldersTab {edit} machine={saved} {folders} {act} />
  {:else if machinesNav.tab === 'disks'}
    <Disks {store} machine={m} {machines} {disks} {overlays} {act} {offFirst} />
  {:else}
    <Snapshots {store} machine={m} running={edit.running} {act} />
  {/if}
</Pane>
