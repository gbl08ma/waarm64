<!--
  The Home page's left column at its root (HomeColumn.svelte; a context has ConnectionNav.svelte's instead): first,
  while a machine is on the page, Back to the machine (HomeBack.svelte); under its Machines heading, the page's own
  machine (a transient one) and the machines kept in this browser (each with its disks and its state), or a line saying
  there are none yet;
  the commands that make one (new: NewMachine.svelte's dialog, an empty machine or a template; from a disk image;
  import a definition: docs/machines.md §6), then the browser's
  panes (Disks, Shared folders, Connections, Preferences, About) with Demos before About, which opens the demo store's
  page (DemosPage.svelte) in Home's place.
-->
<script lang="ts">
  import Count from './ui/Count.svelte';
  import Icon from './ui/Icon.svelte';
  import HomeBack from './HomeBack.svelte';
  import { ABOUT, CONNECTIONS, DISKS, FOLDERS, PAGE, PREFERENCES } from './machines-panes.ts';
  import type { IconName } from './icons.ts';
  import type { Actions } from './actions.svelte.ts';
  import NewMachine from './NewMachine.svelte';
  import { importDefinition, parseDefinition } from './definitions.ts';
  import { msg, t, type Msg } from '../i18n.ts';
  import type { MachineRecord } from './shape.ts';
  import type { Store } from './store.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { inBar, page } from './page.ts';

  type Props = {
    store: Store;
    machines: MachineRecord[];
    /** The browser's disks, shared folders and connections, counted on their panes' buttons. */
    counts: { disks: number; folders: number; connections: number };
    /** A machine's state in the list: here, running, suspended or off. */
    stateOf: (id: string) => Msg;
    actions: Actions;
    onchoose: (id: string) => void;
  };
  let { store, machines, counts, stateOf, actions, onchoose }: Props = $props();

  /** The browser's panes, and Demos, which opens the demo store's page instead of a pane (`open`). */
  type PaneButton = {
    id: string;
    icon: IconName;
    label: string;
    title: string;
    count?: number;
    name?: string;
    open?: () => void;
  };
  /** A pane's count, in a pill and in its button's name, only when there is some. */
  const counted = (n: number, name: (n: number) => string) => (n > 0 ? { count: n, name: name(n) } : {});
  const panes = $derived<PaneButton[]>([
    {
      id: DISKS,
      icon: 'database',
      label: t('machines:MachinesNav.disks.label'),
      ...counted(counts.disks, (n) => t('machines:MachinesNav.disks', { n })),
      title: t('machines:MachinesNav.disks.title'),
    },
    {
      id: FOLDERS,
      icon: 'folder',
      label: t('machines:MachinesNav.folders.label'),
      ...counted(counts.folders, (n) => t('machines:MachinesNav.folders', { n })),
      title: t('machines:MachinesNav.folders.title'),
    },
    {
      id: CONNECTIONS,
      icon: 'network',
      label: t('machines:MachinesNav.connections.label'),
      ...counted(counts.connections, (n) => t('machines:MachinesNav.connections', { n })),
      title: t('machines:MachinesNav.connections.title'),
    },
    {
      id: PREFERENCES,
      icon: 'adjustments-horizontal',
      label: t('machines:MachinesNav.preferences'),
      title: t('machines:MachinesNav.preferences.title'),
    },
    {
      id: 'demos',
      icon: 'apps',
      label: t('machines:MachinesNav.demos'),
      title: t('machines:MachinesNav.demos.title'),
      open: () => page.openDemos(),
    },
    {
      id: ABOUT,
      icon: 'info-circle',
      label: t('machines:MachinesPage.about'),
      title: t('machines:MachinesNav.about.title'),
    },
  ]);

  /** Anything in the list of machines (none: a line says so, and no rule parts it from the commands under it). */
  const listed = $derived(!!current.transient || machines.length > 0);

  /** New machine's dialog (NewMachine.svelte: an empty machine, or a template) is open. */
  let making = $state(false);
  /** A machine New machine made: chosen, and its disks that are files to pick said. */
  function made(id: string, toPick?: { name: string; files: string[] }) {
    onchoose(id);
    if (toPick) actions.fail(msg('machines:MachinesNav.imported.toPick', toPick));
  }

  let defInput = $state<HTMLInputElement>();
  /** Makes a machine from a definition file (docs/machines.md §6); disks that are files are picked at its first start. */
  function importDef() {
    const f = defInput?.files?.[0];
    if (defInput) defInput.value = '';
    if (!f) return;
    void actions.run(t('machines:MachinesNav.busy.importing'), async () => {
      const r = await importDefinition(store, parseDefinition(await f.text()));
      machinesNav.choose(r.machine.id);
      if (r.toPick.length)
        actions.fail(msg('machines:MachinesNav.imported.toPick', { name: r.machine.name, files: r.toPick }));
    });
  }
</script>

{#if current.loaded}
  <!-- Back to the machine (the toolbar's Home and the wordmark do it too, and Esc), first in the column. -->
  <HomeBack
    words={msg('machines:MachinesNav.back')}
    onclick={() => page.closeMachines()}
    data-action="back-to-machine"
  />
{/if}
<h3 id="machines-heading">{t('machines:MachinesNav.heading')}</h3>
{#if listed}
  <ul>
    {#if current.transient}
      <li class:chosen={machinesNav.selected === PAGE}>
        <button class="pick" onclick={() => onchoose(PAGE)} data-machine={PAGE}>
          <span class="name">{current.transient.label}</span>
          <span class="meta">{t('machines:MachinesNav.list.transient')}</span>
        </button>
      </li>
    {/if}
    {#each machines as m (m.id)}
      <li class:chosen={m.id === machinesNav.selected}>
        <button class="pick" onclick={() => onchoose(m.id)} data-machine={m.id}>
          <span class="name">{m.name}</span>
          <span class="meta">
            {t('machines:MachinesNav.list.meta', { count: m.attachments.length, state: stateOf(m.id) })}
          </span>
        </button>
      </li>
    {/each}
  </ul>
{:else}
  <p class="none" data-empty="machines">{t('machines:MachinesNav.list.empty')}</p>
{/if}
<div class="new" class:ruled={listed}>
  <button onclick={() => (making = true)} data-action="new-machine">
    <Icon name="plus" size={16} />{t('machines:MachinesNav.newMachine')}
  </button>
  {#if current.firmware}
    <button onclick={() => inBar(() => page.openDisk())} title={t('machines:MachinesNav.fromImage.title')}>
      <Icon name="file" size={16} />{t('machines:MachinesNav.fromImage')}
    </button>
  {/if}
  <button onclick={() => defInput?.click()} title={t('machines:MachinesNav.importDefinition.title')}>
    <Icon name="file-import" size={16} />{t('machines:MachinesNav.importDefinition')}
  </button>
  <input
    type="file"
    accept=".json,application/json"
    hidden
    bind:this={defInput}
    onchange={importDef}
    data-field="import-definition"
  />
</div>
<div class="new ruled">
  {#each panes as p (p.id)}
    <button
      class:chosen={machinesNav.selected === p.id}
      onclick={() => (p.open ? p.open() : onchoose(p.id))}
      data-machine={p.id}
      title={p.title}
      aria-label={p.name}
    >
      <Icon name={p.icon} size={16} />{p.label}{#if p.count !== undefined}<Count n={p.count} />{/if}
    </button>
  {/each}
</div>
{#if making}<NewMachine {store} act={actions.run} onmade={made} close={() => (making = false)} />{/if}

<style>
  /* The list's heading, a label over it, in line with its machines' names. */
  h3 {
    margin: 0 0 calc(-1 * var(--space-2));
    padding: 0 var(--space-4);
    font-size: var(--text-xs);
    font-weight: var(--weight-bold);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: var(--label-tracking);
  }
  .none {
    margin: 0;
    padding: 0 var(--space-4);
    color: var(--text-dim);
    font-size: var(--text-md);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  /* A machine (its name and its line), then the page's own panes and commands. */
  .pick,
  .new button {
    display: flex;
    width: 100%;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    text-align: start;
  }
  .pick {
    flex-direction: column;
    align-items: flex-start;
  }
  li.chosen .pick,
  .new .chosen {
    background: var(--pressed-bg);
    box-shadow: var(--chosen-edge);
    /* The row is sunk already: its count stands on it. */
    --count-bg: var(--surface-raised);
  }
  .name {
    font-weight: var(--weight-bold);
  }
  .meta {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .new {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .ruled {
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .new button {
    align-items: center;
    gap: var(--space-3);
  }
</style>
