<!--
  The Machines page (docs/machines.md §7): it takes the machine's place on the page (which runs on behind it). It
  composes: the list (MachinesNav.svelte: the machines kept in this browser, the commands that make one, the browser's
  panes) and the chosen pane, a machine's (MachinePane.svelte and its tabs), the page's own transient machine's
  (PagePane.svelte), the browser's Disks (DisksPane.svelte), Shared folders (FoldersPane.svelte) and Connections
  (ConnectionsPane.svelte), Preferences (PreferencesPane.svelte) and About (About.svelte); the browser's storage at the
  bottom (StorageBar.svelte). It reads the records, runs the panes' actions (one runner: what runs, the error) and
  holds the machine being edited (machine-edit.svelte.ts). Logic is in web/app/machines.ts, disks.ts and main.ts
  (`page`); every action that loses data asks first.
-->
<script lang="ts">
  import About from './About.svelte';
  import ConnectionsPane from './ConnectionsPane.svelte';
  import DisksPane from './DisksPane.svelte';
  import ErrorWords from './ErrorWords.svelte';
  import FoldersPane from './FoldersPane.svelte';
  import MachinePane from './MachinePane.svelte';
  import MachinesNav from './MachinesNav.svelte';
  import { ABOUT, CONNECTIONS, DISKS, FOLDERS, PAGE, PREFERENCES } from './machines-panes.ts';
  import PagePane from './PagePane.svelte';
  import PreferencesPane from './PreferencesPane.svelte';
  import StorageBar from './StorageBar.svelte';
  import Button from './ui/Button.svelte';
  import ErrorBanner from './ui/ErrorBanner.svelte';
  import Pane from './ui/Pane.svelte';
  import { untrack } from 'svelte';
  import { Actions } from './actions.svelte.ts';
  import { records } from './areas/records.svelte.ts';
  import { ask } from './ask.svelte.ts';
  import { msg, t } from '../i18n.ts';
  import { MachineEdit } from './machine-edit.svelte.ts';
  import { isRunning, storageReport } from './machines.ts';
  import { suspended as suspendedCopy } from '../overlay.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { MachineRecord } from './shape.ts';
  import { machineDir, type Store } from './store.ts';
  import { shares } from './areas/shares.svelte.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { power } from './areas/power.svelte.ts';
  import { page } from './page.ts';

  type Props = { store: Store; net: PageNetwork; folders: PageFolders };
  let { store, net, folders }: Props = $props();

  const machines = $derived(records.machines);
  const disks = $derived(records.disks);
  const overlays = $derived(records.overlays);
  /** The machines with kept snapshots: only theirs warn, under a control, that a change of shape orphans them. */
  const withSnapshots = $derived(new Set(records.snapshots.map((s) => s.machine)));
  let running = $state<Set<string>>(new Set());
  /** The machines with a suspended copy (Start resumes them). */
  let suspended = $state<Set<string>>(new Set());
  let storage = $state<Awaited<ReturnType<typeof storageReport>> | undefined>();

  /** The ids of `list`'s machines for which `has` holds. */
  const which = async (list: MachineRecord[], has: (m: MachineRecord) => Promise<unknown>) =>
    new Set((await Promise.all(list.map(async (m) => ((await has(m)) ? m.id : '')))).filter(Boolean));

  /** What the records don't say: which machines run (their locks, in any tab), which are suspended, the storage. */
  async function readLive(list: MachineRecord[]) {
    running = await which(list, (m) => isRunning(m.id));
    suspended = await which(list, (m) => suspendedCopy(machineDir(m.id)).catch(() => undefined));
    storage = await storageReport(store).catch(() => undefined);
  }
  // This tab's own writes aren't announced to it: the records are read again after each action.
  const runner = new Actions(() => records.reread());
  const act = runner.run;
  // The store is the page's one, for the page's life.
  // svelte-ignore state_referenced_locally
  const edit = new MachineEdit(store, runner);

  // Read with the records, and again when the machine on this page starts or stops (its "running").
  $effect(() => {
    void power.state;
    void readLive(machines);
  });
  // The chosen machine's record, as read now, goes to its editor (which keeps a draft being edited).
  $effect(() => {
    const m = machines.find((x) => x.id === machinesNav.selected);
    const [snapshots, runs] = [!!m && withSnapshots.has(m.id), !!m && running.has(m.id)];
    untrack(() => edit.follow(m, snapshots, runs));
  });
  function choose(id: string) {
    machinesNav.choose(id);
    edit.dirty = false;
  }
  /** Running, suspended or off. */
  function stateText(id: string) {
    if (running.has(id)) return msg('machines:MachinesPage.state.running');
    if (suspended.has(id)) return msg('machines:MachinesPage.state.suspended');
    return msg('machines:MachinesPage.state.off');
  }
  /** A machine's state in the list: the one open on this page and off is "here". */
  const listState = (id: string) =>
    id === current.id && !running.has(id) && !suspended.has(id)
      ? msg('machines:MachinesPage.state.here')
      : stateText(id);
  const counts = $derived({
    disks: disks.size,
    folders: folders.folders.length,
    connections: net.connections.length,
  });

  /** Powers machine `m` off, after asking, before an edit that needs it off; false if it can't be (or the user says no). */
  async function offFirst(m: MachineRecord) {
    if (!running.has(m.id)) return true;
    if (m.id !== current.id) {
      runner.fail(t('machines:MachinesPage.otherTab'));
      return false;
    }
    const sure = await ask.confirm(t('machines:MachinesPage.powerOff.confirm', { name: m.name }), {
      ok: t('machines:MachinesPage.powerOff.ok'),
      danger: true,
    });
    if (!sure) return false;
    await page.powerOff();
    await records.reread();
    return true;
  }
</script>

<div class="machines" data-busy={runner.busy}>
  <div class="bar">
    <Button
      variant="tool"
      labelled
      icon="arrow-left"
      onclick={() => page.closeMachines()}
      data-action="back"
      title={t('machines:MachinesPage.back')}
    >
      {t('machines:MachinesPage.back')}
    </Button>
    <h2>{t('machines:MachinesPage.heading')}</h2>
    {#if runner.busy}<span class="busy">{t('machines:MachinesPage.busy', { what: runner.busy })}</span>{/if}
  </div>
  {#if runner.error}
    <ErrorBanner
      class="error"
      role="alert"
      dismissLabel={t('machines:MachinesPage.dismiss')}
      ondismiss={() => runner.clear()}
    >
      <ErrorWords error={runner.error} />
    </ErrorBanner>
  {/if}
  <div class="panes">
    <MachinesNav {store} {machines} {counts} stateOf={listState} actions={runner} onchoose={choose} />
    {#if machinesNav.selected === PREFERENCES}
      <PreferencesPane {net} />
    {:else if machinesNav.selected === ABOUT}
      <Pane id={ABOUT} title={t('machines:MachinesPage.about')} meta={t('machines:MachinesPage.about.meta')}>
        <About />
      </Pane>
    {:else if machinesNav.selected === DISKS}
      <Pane id={DISKS} title={t('machines:MachinesPage.disks.heading')} meta={t('machines:MachinesPage.disks.meta')}>
        <DisksPane {store} {machines} {disks} {overlays} {running} {act} {offFirst} />
      </Pane>
    {:else if machinesNav.selected === FOLDERS}
      <Pane
        id={FOLDERS}
        title={t('machines:MachinesPage.folders.heading')}
        meta={t('machines:MachinesPage.folders.meta')}
      >
        {#snippet actions()}
          <Button icon="plus" onclick={() => shares.openWizard({})} data-action="new-folder">
            {t('machines:MachinesPage.folders.new')}
          </Button>
        {/snippet}
        <FoldersPane {folders} {store} {act} />
      </Pane>
    {:else if machinesNav.selected === CONNECTIONS}
      <ConnectionsPane {net} {machines} {act} />
    {:else if machinesNav.selected === PAGE && current.transient}
      <PagePane {store} {act} label={current.transient.label} disk={current.transient.disk} />
    {:else if edit.editing()}
      <MachinePane
        {edit}
        {store}
        {net}
        {folders}
        {machines}
        {disks}
        {overlays}
        state={stateText(edit.draft.id)}
        {act}
        {offFirst}
        onchoose={choose}
      />
    {:else}
      <section class="empty"><p>{t('machines:MachinesPage.empty')}</p></section>
    {/if}
  </div>
  {#if storage}<StorageBar {storage} {act} />{/if}
</div>

<style>
  .machines {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  .busy {
    color: var(--status-busy);
    font-size: var(--text-md);
  }
  .panes {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(200px, 260px) 1fr;
  }
  section.empty {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
  }
  @media (max-width: 720px) {
    .panes {
      grid-template-columns: 1fr;
    }
  }
</style>
