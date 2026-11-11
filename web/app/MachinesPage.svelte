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
  import { ABOUT, CONNECTIONS, DISKS, FOLDERS, PAGE, PANES, PREFERENCES } from './machines-panes.ts';
  import PagePane from './PagePane.svelte';
  import PreferencesPane from './PreferencesPane.svelte';
  import StorageBar from './StorageBar.svelte';
  import Button from './ui/Button.svelte';
  import ErrorBanner from './ui/ErrorBanner.svelte';
  import Pane from './ui/Pane.svelte';
  import { Actions } from './actions.svelte.ts';
  import { ask } from './ask.svelte.ts';
  import { msg, t } from '../i18n.ts';
  import { MachineEdit } from './machine-edit.svelte.ts';
  import { isRunning, storageReport } from './machines.ts';
  import { suspended as suspendedCopy } from '../overlay.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { machineDir, type OverlayRecord, type Store } from './store.ts';
  import { shares } from './areas/shares.svelte.ts';
  import { page, ui } from './ui.svelte.ts';

  type Props = { store: Store; net: PageNetwork; folders: PageFolders };
  let { store, net, folders }: Props = $props();

  let machines = $state<MachineRecord[]>([]);
  let disks = $state<Map<string, DiskRecord>>(new Map());
  let overlays = $state<OverlayRecord[]>([]);
  let running = $state<Set<string>>(new Set());
  /** The machines with a suspended copy (Start resumes them). */
  let suspended = $state<Set<string>>(new Set());
  /** The machines with kept snapshots: only theirs warn, under a control, that a change of shape orphans them. */
  let withSnapshots = $state<Set<string>>(new Set());
  let storage = $state<Awaited<ReturnType<typeof storageReport>> | undefined>();

  /** The ids of `list`'s machines for which `has` holds. */
  const which = async (list: MachineRecord[], has: (m: MachineRecord) => Promise<unknown>) =>
    new Set((await Promise.all(list.map(async (m) => ((await has(m)) ? m.id : '')))).filter(Boolean));

  async function reread() {
    machines = (await store.all('machines')).sort((a, b) => a.name.localeCompare(b.name));
    disks = new Map((await store.all('disks')).map((d) => [d.id, d]));
    overlays = await store.all('overlays');
    running = await which(machines, (m) => isRunning(m.id));
    withSnapshots = new Set((await store.all('snapshots')).map((s) => s.machine));
    suspended = await which(machines, (m) => suspendedCopy(machineDir(m.id)).catch(() => undefined));
    ui.machinesSelected ??= ui.current ?? (ui.transient ? PAGE : undefined);
    const chosen = ui.machinesSelected;
    if (chosen && !PANES.has(chosen) && !machines.some((m) => m.id === chosen)) ui.machinesSelected = undefined;
    const m = machines.find((x) => x.id === ui.machinesSelected);
    edit.follow(m, !!m && withSnapshots.has(m.id), !!m && running.has(m.id));
    storage = await storageReport(store).catch(() => undefined);
  }
  const runner = new Actions(reread);
  const act = runner.run;
  // The store is the page's one, for the page's life.
  // svelte-ignore state_referenced_locally
  const edit = new MachineEdit(store, runner);
  // Read now, again when a record changes (in any tab), and when the machine on this page starts or stops (its "running").
  $effect(() => store.onChange(() => void reread()));
  $effect(() => {
    void ui.state;
    void ui.records;
    void reread();
  });

  function choose(id: string) {
    ui.machinesSelected = id;
    edit.dirty = false;
    void reread();
  }
  /** Running, suspended or off. */
  function stateText(id: string) {
    if (running.has(id)) return msg('machines:MachinesPage.state.running');
    if (suspended.has(id)) return msg('machines:MachinesPage.state.suspended');
    return msg('machines:MachinesPage.state.off');
  }
  /** A machine's state in the list: the one open on this page and off is "here". */
  const listState = (id: string) =>
    id === ui.current && !running.has(id) && !suspended.has(id)
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
    if (m.id !== ui.current) {
      runner.fail(t('machines:MachinesPage.otherTab'));
      return false;
    }
    const sure = await ask.confirm(t('machines:MachinesPage.powerOff.confirm', { name: m.name }), {
      ok: t('machines:MachinesPage.powerOff.ok'),
      danger: true,
    });
    if (!sure) return false;
    await page.powerOff();
    await reread();
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
    {#if ui.machinesSelected === PREFERENCES}
      <PreferencesPane {net} />
    {:else if ui.machinesSelected === ABOUT}
      <Pane id={ABOUT} title={t('machines:MachinesPage.about')} meta={t('machines:MachinesPage.about.meta')}>
        <About />
      </Pane>
    {:else if ui.machinesSelected === DISKS}
      <Pane id={DISKS} title={t('machines:MachinesPage.disks.heading')} meta={t('machines:MachinesPage.disks.meta')}>
        <DisksPane {store} {machines} {disks} {overlays} {running} {act} {offFirst} />
      </Pane>
    {:else if ui.machinesSelected === FOLDERS}
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
    {:else if ui.machinesSelected === CONNECTIONS}
      <ConnectionsPane {net} {machines} {act} />
    {:else if ui.machinesSelected === PAGE && ui.transient}
      <PagePane {store} {act} label={ui.transient.label} disk={ui.transient.disk} />
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
