<!--
  The Home page (docs/machines.md §7; the toolbar's Home): it takes the machine's place on the page (which runs on behind it). It
  composes: the list (MachinesNav.svelte: the machines kept in this browser, the commands that make one, the browser's
  panes) and the chosen pane, a machine's (MachinePane.svelte and its tabs), the page's own transient machine's
  (PagePane.svelte), the browser's Disks (DisksPane.svelte), Shared folders (FoldersPane.svelte) and Connections
  (ConnectionsPane.svelte), Preferences (PreferencesPane.svelte) and About (About.svelte); the browser's storage at the
  bottom (StorageBar.svelte). It reads the records, runs the panes' actions (one runner: what runs, the error) and
  holds the machine being edited (machine-edit.svelte.ts). Logic is in web/app/machines.ts, disks.ts and the areas' modules
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
  import MessageWords from './MessageWords.svelte';
  import { leaveInPlace } from './ui/crossfade.ts';
  import Pane from './ui/Pane.svelte';
  import { untrack } from 'svelte';
  import { Actions } from './actions.svelte.ts';
  import { records } from './areas/records.svelte.ts';
  import { ask } from './ask.svelte.ts';
  import { msg, t } from '../i18n.ts';
  import { MachineEdit } from './machine-edit.svelte.ts';
  import { isRunning } from './machines.ts';
  import { storageReport } from './storage-report.ts';
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
  import { messageBar } from './areas/message-bar.svelte.ts';

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
  // An action ends once the records it wrote are read again.
  const runner = new Actions({ after: () => records.reread() });
  const act = runner.run;
  // The store is the page's one, for the page's life.
  // svelte-ignore state_referenced_locally
  const edit = new MachineEdit(store, runner);

  // Read with the records, and again when the machine on this page starts or stops (its "running").
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
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
      runner.fail(msg('machines:MachinesPage.otherTab'));
      return false;
    }
    // The guest asked to shut down first where its agent can (the page's powerOff: web/app/run/clean-stop.ts).
    const soft = power.canSoft;
    const question = soft ? 'machines:MachinesPage.powerOff.confirm.soft' : 'machines:MachinesPage.powerOff.confirm';
    const sure = await ask.confirm(msg(question, { name: m.name }), {
      ok: t(soft ? 'machines:MachinesPage.powerOff.ok.soft' : 'machines:MachinesPage.powerOff.ok'),
      danger: true,
    });
    if (!sure) return false;
    // Nothing stopped (another stop or start under way, the user kept it running): no edit.
    const off = await page.powerOff();
    await records.reread();
    return off;
  }
</script>

<div class="machines" data-busy={runner.busy} out:leaveInPlace={!!messageBar.text || !!runner.error}>
  <!-- The page's heading, for a screen reader (its top bar says it with the toolbar's Home): its list and panes are
       under it, and its left column, the way to them, is named after it. -->
  <h2 id="home-heading" class="sr">{t('machines:MachinesPage.heading')}</h2>
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
    {#if runner.busy}<span class="busy">{t('machines:MachinesPage.busy', { what: runner.busy })}</span>{/if}
  </div>
  {#if messageBar.text || runner.error}
    <ErrorBanner
      class="machines-page"
      tone={messageBar.text ? messageBar.kind : undefined}
      role={messageBar.text ? (messageBar.kind === 'info' ? 'status' : 'alert') : 'alert'}
      dismissLabel={t('machines:MachinesPage.dismiss')}
      ondismiss={() => (messageBar.text ? page.dismiss() : runner.clear())}
      countdown={messageBar.text ? messageBar.countdown : undefined}
      crossfade={messageBar.text ? 'message' : undefined}
    >
      {#snippet actions()}
        {#each messageBar.actions as a (a)}<Button
            onclick={(e: MouseEvent & { currentTarget: HTMLButtonElement }) => a.run(e.currentTarget)}>{a.label}</Button
          >{/each}
      {/snippet}
      {#if messageBar.text}
        <MessageWords />
      {:else if runner.error}<ErrorWords error={runner.error} />
      {/if}
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
