<!--
  A demo's interstitial on the demo store's page (DemosPage.svelte; docs/frontend.md "The demo store"), before anything
  of it is downloaded: what the project is, the demo's card (its words the store's data, plain text), its download,
  what it needs of the browser (DemoChecks.svelte: checked here, before any download), and how to start it. Started
  before (a machine of the visitor's from it): **Open my machine** (the default) or **Start a fresh copy**, with when
  theirs was last used. Start makes the machine from the definition (web/app/template.ts `machineFromDemo`: the
  template snapshot downloaded first, with its progress), opens it in the demo's view, and its first start restores
  the template. A failure (the files gone, the server down, the download cut off, the storage full) is said here.
  A start belongs to its interstitial: one at a time on the page (`demos.starting`), aborted (its download with it) when
  the interstitial goes, and switched to only if the machine running here then is the one the visitor agreed to stop
  (asked again otherwise).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import ErrorWords from './ErrorWords.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import DemoChecks from './DemoChecks.svelte';
  import { Actions } from './actions.svelte.ts';
  import { canStart, checkDemo, needsOf, readEnv, type Check } from './demo-check.ts';
  import { checkDisks, lastUsed } from './demo-open.ts';
  import { machinesOf, type StoreDemo } from './demo-store.ts';
  import { isRunning } from './machines.ts';
  import { machineFromDemo } from './template.ts';
  import type { Store } from './store.ts';
  import { current } from './areas/current.svelte.ts';
  import { demos } from './areas/demos.svelte.ts';
  import { isLive, power } from './areas/power.svelte.ts';
  import { records } from './areas/records.svelte.ts';
  import { page } from './page.ts';
  import { t } from '../i18n.ts';

  type Props = { store: Store; demo: StoreDemo };
  let { store, demo }: Props = $props();

  const def = $derived(demo.def);
  const view = $derived(def.demo.view);
  const marks = $derived(machinesOf(records.machines, demo));
  /** The visitor's machine from it, the most recently changed. */
  const mine = $derived(marks.mine.at(0));
  const older = $derived(marks.older.at(0));
  /** The machine running on this page, which starting the demo powers off (asked first). */
  const runningHere = $derived(isLive(power.state) && current.id !== mine?.id ? current.title : undefined);

  let checks = $state.raw<Check[]>();
  let used = $state<Date>();
  let elsewhere = $state(false);
  let progress = $state<{ done: number; total: number }>();
  const runner = new Actions({ after: () => records.reread() });
  /** Open my machine, the default: it takes the focus (Enter opens it). */
  let mineButton = $state<HTMLButtonElement>();
  /** The demo's name, which takes the focus when there's no Open my machine (a card's button, gone, had it). */
  let heading = $state<HTMLHeadingElement>();
  $effect(() => (mineButton ?? heading)?.focus());
  /** This interstitial's start, if one runs: aborted when it goes. */
  let mineStart: AbortController | undefined;
  $effect(() => () => mineStart?.abort());

  $effect(() => {
    const n = needsOf(def);
    void readEnv(n).then((env) => (checks = checkDemo(env, n)));
  });
  $effect(() => {
    const m = mine;
    if (!m) return;
    void lastUsed(m).then((when) => (used = new Date(when)));
    void isRunning(m.id).then((on) => (elsewhere = on && m.id !== current.id));
  });

  const ready = $derived(!!checks && canStart(checks));

  /** The machine running on this page (undefined: none), which opening another stops. */
  const live = () => (isLive(power.state) ? current.id : undefined);
  /**
   * A new machine from the demo (a fresh copy beside the visitor's, if they have one), opened: asked first whether the
   * machine running here may stop, and again before the switch if another runs by then. Nothing is opened once the
   * interstitial is gone (its abort: the download stops, or the machine made stays, found as started before).
   */
  const start = () => {
    if (demos.starting) return;
    const stop = new AbortController();
    const gone = () => stop.signal.aborted;
    [mineStart, demos.starting] = [stop, stop];
    return runner.run(t('machines:DemoStart.busy.download'), async () => {
      try {
        const agreed = live();
        if (!(await page.askSwitch()) || gone()) return;
        progress = undefined;
        const { machine } = await machineFromDemo(
          store,
          demo,
          (done, total) => (progress = { done, total }),
          stop.signal,
        );
        if (gone()) return;
        const now = live();
        if (now !== undefined && now !== agreed && !(await page.askSwitch(machine.id))) return;
        if (gone()) return;
        await page.openDemo(machine.id, view);
      } finally {
        if (demos.starting === stop) demos.starting = undefined;
        if (mineStart === stop) mineStart = undefined;
      }
    });
  };
  /** The visitor's machine from it, opened (its disk's files checked first: gone, the server down). */
  const openMine = (id: string) =>
    runner.run(t('machines:DemoStart.busy.opening'), async () => {
      const m = records.machines.find((x) => x.id === id);
      if (current.id === id && isLive(power.state)) return page.closeDemos(false); // it runs here already: to it
      if (!m || !(await page.askSwitch(id))) return;
      await checkDisks(store, m);
      await page.openDemo(id, view);
    });
</script>

<article class="start" data-demo={def.demo.id}>
  <Button variant="link" icon="arrow-left" onclick={() => page.chooseDemo()} data-action="all-demos">
    {t('machines:DemoStart.back')}
  </Button>
  <div class="card">
    {#if def.demo.thumbnail}
      <img src={def.demo.thumbnail} alt="" crossorigin="anonymous" />
    {/if}
    <div class="words">
      <h3 tabindex="-1" bind:this={heading}>{def.machine.name}</h3>
      <p class="summary">{def.demo.summary}</p>
    </div>
  </div>
  <Note size="md">{t('machines:DemoStart.about')}</Note>
  <Note size="md" data-field="download">{t('machines:DemoStart.download', { size: def.demo.download })}</Note>
  {#if def.demo.room}<Note size="md" data-field="room">{t('machines:DemoStart.room')}</Note>{/if}
  <h4>{t('machines:DemoStart.needs')}</h4>
  {#if checks}<DemoChecks {checks} />{:else}<Note>{t('machines:DemoStart.checking')}</Note>{/if}
  {#if mine}
    <Note size="md" data-field="started-before">
      {#if used}
        <T k="machines:DemoStart.mine" params={{ machine: mine.name, when: used }} />
      {:else}
        <T k="machines:DemoStart.mine.undated" params={{ machine: mine.name }} />
      {/if}
    </Note>
    {#if elsewhere}<Note tone="warn"><T k="machines:DemoStart.elsewhere" params={{ machine: mine.name }} /></Note>{/if}
  {:else if older}
    <Note size="md" data-field="older"><T k="machines:DemoStart.older" params={{ machine: older.name }} /></Note>
  {/if}
  {#if runningHere}
    <Note tone="warn" data-field="running-here"
      ><T k="machines:DemoStart.runningHere" params={{ machine: runningHere }} /></Note
    >
  {/if}
  <div class="actions">
    {#if mine}
      <Button
        variant="primary"
        icon="player-play"
        disabled={!!runner.busy}
        onclick={() => openMine(mine.id)}
        bind:ref={mineButton}
        data-action="open-mine"
      >
        {t('machines:DemoStart.openMine')}
      </Button>
      <Button disabled={!ready || !!runner.busy || !!demos.starting} onclick={start} data-action="fresh-copy">
        {t('machines:DemoStart.fresh')}
      </Button>
    {:else}
      <Button
        variant="primary"
        icon="player-play"
        disabled={!ready || !!runner.busy || !!demos.starting}
        onclick={start}
        data-action="start-demo"
      >
        {t('machines:DemoStart.start')}
      </Button>
    {/if}
  </div>
  {#if runner.busy}
    <div class="busy" role="status" data-field="progress">
      <span>{runner.busy}</span>
      {#if progress}
        <progress max={progress.total} value={progress.done} aria-label={runner.busy}></progress>
        <Note inline>{t('machines:DemoStart.progress', { done: progress.done, total: progress.total })}</Note>
      {/if}
    </div>
  {/if}
  {#if runner.error}<div class="error" role="alert"><ErrorWords error={runner.error} /></div>{/if}
</article>

<style>
  .start {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
    max-width: 720px;
  }
  .card {
    display: flex;
    gap: var(--space-5);
    align-items: flex-start;
  }
  img {
    width: 240px;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    border-radius: var(--radius);
    background: var(--screen-bg);
  }
  h3 {
    margin: 0 0 var(--space-2);
    outline: none;
    font-size: var(--text-lg);
  }
  h4 {
    margin: var(--space-2) 0 0;
    font-size: var(--text-base);
  }
  .summary {
    margin: 0;
    white-space: pre-line;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .busy {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    color: var(--status-busy);
  }
  progress {
    width: 100%;
  }
  .error {
    width: 100%;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--error-border);
    border-radius: var(--radius);
    background: var(--error-bg);
    color: var(--error-bar-fg);
  }
  @media (max-width: 720px) {
    .card {
      flex-direction: column;
    }
    img {
      width: 100%;
    }
  }
</style>
