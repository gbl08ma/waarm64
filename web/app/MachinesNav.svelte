<!--
  The Machines page's list (MachinesPage.svelte): the page's own machine (a transient one), the machines kept in this
  browser (each with its disks and its state), the commands that make one (new, from a disk image, import a
  definition: docs/machines.md §6), then the browser's panes (Disks, Shared folders, Connections, Preferences, About).
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import { ABOUT, CONNECTIONS, DISKS, FOLDERS, PAGE, PREFERENCES } from './machines-panes.ts';
  import type { IconName } from './icons.ts';
  import type { Actions } from './actions.svelte.ts';
  import { createMachine } from './machines.ts';
  import { importDefinition, parseDefinition } from './definitions.ts';
  import { t, type Msg } from '../i18n.ts';
  import type { MachineRecord } from './shape.ts';
  import type { Store } from './store.ts';
  import { page, ui } from './ui.svelte.ts';

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

  const panes = $derived<{ id: string; icon: IconName; label: string; title: string }[]>([
    {
      id: DISKS,
      icon: 'database',
      label: t('machines:MachinesNav.disks', { n: counts.disks }),
      title: t('machines:MachinesNav.disks.title'),
    },
    {
      id: FOLDERS,
      icon: 'folder',
      label: t('machines:MachinesNav.folders', { n: counts.folders }),
      title: t('machines:MachinesNav.folders.title'),
    },
    {
      id: CONNECTIONS,
      icon: 'network',
      label: t('machines:MachinesNav.connections', { n: counts.connections }),
      title: t('machines:MachinesNav.connections.title'),
    },
    {
      id: PREFERENCES,
      icon: 'adjustments-horizontal',
      label: t('machines:MachinesNav.preferences'),
      title: t('machines:MachinesNav.preferences.title'),
    },
    {
      id: ABOUT,
      icon: 'info-circle',
      label: t('machines:MachinesPage.about'),
      title: t('machines:MachinesNav.about.title'),
    },
  ]);

  const newMachine = () =>
    actions.run(t('machines:MachinesNav.busy.making'), async () => {
      onchoose((await createMachine(store)).id);
    });

  let defInput = $state<HTMLInputElement>();
  /** Makes a machine from a definition file (docs/machines.md §6); disks that are files are picked at its first start. */
  function importDef() {
    const f = defInput?.files?.[0];
    if (defInput) defInput.value = '';
    if (!f) return;
    void actions.run(t('machines:MachinesNav.busy.importing'), async () => {
      const r = await importDefinition(store, parseDefinition(await f.text()));
      ui.machinesSelected = r.machine.id;
      if (r.toPick.length)
        actions.fail(t('machines:MachinesNav.imported.toPick', { name: r.machine.name, files: r.toPick }));
    });
  }
</script>

<nav>
  <ul>
    {#if ui.transient}
      <li class:chosen={ui.machinesSelected === PAGE}>
        <button class="pick" onclick={() => onchoose(PAGE)} data-machine={PAGE}>
          <span class="name">{ui.transient.label}</span>
          <span class="meta">{t('machines:MachinesNav.list.transient')}</span>
        </button>
      </li>
    {/if}
    {#each machines as m (m.id)}
      <li class:chosen={m.id === ui.machinesSelected}>
        <button class="pick" onclick={() => onchoose(m.id)} data-machine={m.id}>
          <span class="name">{m.name}</span>
          <span class="meta">
            {t('machines:MachinesNav.list.meta', { count: m.attachments.length, state: stateOf(m.id) })}
          </span>
        </button>
      </li>
    {/each}
  </ul>
  <div class="new">
    <button onclick={newMachine} data-action="new-machine">
      <Icon name="plus" size={16} />{t('machines:MachinesNav.newMachine')}
    </button>
    {#if ui.firmware}
      <button onclick={() => page.openDisk()} title={t('machines:MachinesNav.fromImage.title')}>
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
  <div class="new">
    {#each panes as p (p.id)}
      <button
        class:chosen={ui.machinesSelected === p.id}
        onclick={() => onchoose(p.id)}
        data-machine={p.id}
        title={p.title}
      >
        <Icon name={p.icon} size={16} />{p.label}
      </button>
    {/each}
  </div>
</nav>

<style>
  nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow: auto;
    padding: var(--space-3);
    border-right: 1px solid var(--border);
    background: var(--surface-raised);
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
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .new button {
    align-items: center;
    gap: var(--space-3);
  }
  @media (max-width: 720px) {
    nav {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
