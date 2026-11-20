<!--
  The chosen demo's pane on the demo store's page (DemosPage.svelte; docs/frontend.md "The demo store"), beside the
  list or, in one column, alone with **All demos** back to it (`back`), before anything of it is downloaded: its name
  with how to start it at the pane's head (ui/Pane.svelte, as a machine's pane on Home), then its screenshot and
  summary (the store's data, plain text), its download, what it needs of the browser (DemoChecks.svelte: checked here,
  before any download), and what the project is. Started before (a machine of the visitor's from it): **Open my
  machine** (the default) or **Start a fresh copy**, with when theirs was last used. Start makes the machine from the
  definition (web/app/template.ts `machineFromDemo`: the template snapshot downloaded first, with its progress), opens
  it in the demo's view, and its first start restores the template. A failure (the files gone, the server down, the
  download cut off, the storage full) is said here. A start belongs to its pane: one at a time on the page
  (`demos.starting`), aborted (its download with it) when the pane goes, and switched to only if the machine running
  here then is the one the visitor agreed to stop (asked again otherwise).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Callout from './ui/Callout.svelte';
  import ErrorWords from './ErrorWords.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import T from './T.svelte';
  import DemoChecks from './DemoChecks.svelte';
  import { Actions } from './actions.svelte.ts';
  import { allMet, canStart, checkDemo, needsOf, readEnv, type Check } from './demo-check.ts';
  import { checkDisks, lastUsed } from './demo-open.ts';
  import { downloadEnded } from './demo-leave.ts';
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

  type Props = {
    store: Store;
    demo: StoreDemo;
    /** One column: the list isn't beside it, so All demos leads back there (`onback`). */
    back?: boolean;
    onback?: () => void;
    /** Takes the focus as it shows (it replaced the list, whose row had it): Open my machine, else the pane. */
    takesFocus?: boolean;
  };
  let { store, demo, back = false, onback, takesFocus = false }: Props = $props();

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
  /** The pane, named after the demo, which takes the focus when there's no Open my machine (a row's button, gone, had it). */
  let pane = $state<HTMLElement>();
  $effect(() => {
    if (takesFocus) (mineButton ?? pane)?.focus();
  });
  /** This pane's start, if one runs: aborted when it goes. */
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
   * pane is gone (its abort: the download stops, or the machine made stays, found as started before).
   */
  const start = () => {
    if (demos.starting) return;
    const stop = new AbortController();
    const gone = () => stop.signal.aborted;
    [mineStart, demos.starting, demos.startingName] = [stop, stop, def.machine.name];
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
        if (demos.starting === stop) {
          demos.starting = undefined;
          downloadEnded();
        }
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

<article class="start" data-demo={def.demo.id} aria-label={def.machine.name} tabindex="-1" bind:this={pane}>
  {#if back}
    <div class="back">
      <Button variant="link" icon="arrow-left" onclick={() => onback?.()} data-action="all-demos">
        {t('machines:DemoStart.back')}
      </Button>
    </div>
  {/if}
  <Pane id="demo" title={def.machine.name}>
    {#snippet actions()}
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
    {/snippet}
    <div class="body">
      {#if runner.busy}
        <div class="busy" role="status" data-field="progress">
          <span>{runner.busy}</span>
          {#if progress}
            <progress max={progress.total} value={progress.done} aria-label={runner.busy}></progress>
            <Note inline>{t('machines:DemoStart.progress', { done: progress.done, total: progress.total })}</Note>
          {/if}
        </div>
      {/if}
      {#if runner.error}
        <div class="wide">
          <Callout role="alert" data-field="start-error"><ErrorWords error={runner.error} /></Callout>
        </div>
      {/if}
      {#if mine}
        <Note size="md" data-field="started-before">
          {#if used}
            <T k="machines:DemoStart.mine" params={{ machine: mine.name, when: used }} />
          {:else}
            <T k="machines:DemoStart.mine.undated" params={{ machine: mine.name }} />
          {/if}
        </Note>
        {#if elsewhere}
          <Note tone="warn"><T k="machines:DemoStart.elsewhere" params={{ machine: mine.name }} /></Note>
        {/if}
      {:else if older}
        <Note size="md" data-field="older"><T k="machines:DemoStart.older" params={{ machine: older.name }} /></Note>
      {/if}
      {#if runningHere}
        <Note tone="warn" data-field="running-here">
          <T k="machines:DemoStart.runningHere" params={{ machine: runningHere }} />
        </Note>
      {/if}
      <div class="what">
        {#if def.demo.thumbnail}
          <img src={def.demo.thumbnail} alt="" crossorigin="anonymous" />
        {/if}
        <div class="words">
          <p class="summary">{def.demo.summary}</p>
          <Note size="md" data-field="download">
            <T k="machines:DemoStart.download" params={{ size: def.demo.download }}>
              {#snippet size(text: string)}<strong>{text}</strong>{/snippet}
            </T>
          </Note>
        </div>
      </div>
      {#if checks}
        {#if !allMet(checks)}<h4>{t('machines:DemoStart.needs')}</h4>{/if}
        <DemoChecks {checks} />
      {:else}
        <Note>{t('machines:DemoStart.checking')}</Note>
      {/if}
      <div class="fine">
        {#if def.demo.room}<Note size="md" data-field="room"><T k="machines:DemoStart.room" /></Note>{/if}
        <Note size="md">{t('machines:DemoStart.about')}</Note>
      </div>
    </div>
  </Pane>
</article>

<style>
  /* The pane's place beside the list; the pane scrolls in it. */
  /* The content's column: the pane's head keeps to it (ui/Pane.svelte), so Start is at the content's top right corner. */
  .start {
    --pane-width: 800px;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .back {
    padding: var(--space-3) var(--space-5) 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
    max-width: var(--pane-width);
  }
  /* The screenshot beside what the demo is; under it where the pane is too narrow for both. */
  .what {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-4) var(--space-5);
    width: 100%;
  }
  /* The demo started: its picture grows into the machine's place (web/app/view-transition.ts). */
  :global(html[data-vt='launch']) img {
    view-transition-name: machine-view;
  }
  img {
    flex: 0 1 360px;
    min-width: 0;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    border-radius: var(--radius);
    background: var(--screen-bg);
    box-shadow: var(--shadow-frame);
  }
  .words {
    flex: 1 1 280px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  h4 {
    margin: var(--space-2) 0 0;
    font-size: var(--text-base);
  }
  .summary {
    margin: 0;
    white-space: pre-line;
  }
  /* The fine print, parted from what the visitor acts on. */
  .fine {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
    margin-top: var(--space-2);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  .busy {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    color: var(--status-busy);
  }
  /* The bar as the boot card draws its own (BootCard.svelte): slim, lit in the accent. */
  progress {
    width: 100%;
    height: 6px;
    accent-color: var(--accent);
  }
  .wide {
    width: 100%;
  }
  /* The download's size, the number that matters on a metered connection: the page's own color among the dim words. */
  strong {
    color: var(--text);
    font-weight: var(--weight-bold);
  }
</style>
