<!--
  The page (docs/frontend.md): the toolbar, the message bar, the machine (its screen and serial terminal) or the
  Home page or the demo store's page in its place, a disk's surface window over either, the status line, and the page's questions. The machine's run draws on the canvas and the
  terminal here (given to its areas: `view`), and writes what the rest shows into the areas' state (web/app/areas/). The body's
  `data-*` (the tests' and the page's styles' hooks) follow that state here.
-->
<script lang="ts">
  import Ask from './Ask.svelte';
  import BootCard from './BootCard.svelte';
  import FilePickers from './FilePickers.svelte';
  import FolderWizard from './FolderWizard.svelte';
  import FoldersMount from './FoldersMount.svelte';
  import DemosPage from './DemosPage.svelte';
  import ViewDivider from './ViewDivider.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import MessageBar from './MessageBar.svelte';
  import NetWizard from './NetWizard.svelte';
  import NetDetails from './NetDetails.svelte';
  import NameDialog from './NameDialog.svelte';
  import Osk from './Osk.svelte';
  import RamWindow from './RamWindow.svelte';
  import StatusBar from './StatusBar.svelte';
  import SurfaceWindow from './SurfaceWindow.svelte';
  import Toolbar from './Toolbar.svelte';
  import type { PageAudio } from '../audio.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { Store } from './store.ts';
  import type { PageView } from './areas/page-window.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { demos } from './areas/demos.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { power } from './areas/power.svelte.ts';
  import { keys } from './areas/keys.svelte.ts';
  import { mouse } from './areas/mouse.svelte.ts';
  import { screen } from './areas/screen.svelte.ts';
  import { surfaceWindow } from './areas/surface.svelte.ts';
  import { ramWindow } from './areas/ram.svelte.ts';
  import { page } from './page.ts';
  import type { Mods } from './osk.ts';
  import { t } from '../i18n.ts';

  type Props = { store: Store; audio: PageAudio; net: PageNetwork; folders: PageFolders; view: PageView };
  let { store, audio, net, folders, view }: Props = $props();

  // The machine's elements, given to its areas (web/app/areas/page-window.ts `PageView`): the canvas is made again for
  // each start (`screen.generation`: a canvas hands its drawing over only once).
  let canvas = $state<HTMLCanvasElement>();
  let box = $state<HTMLElement>();
  let lockCursor = $state<HTMLCanvasElement>();
  /** The canvas's size on the page, as areas/screen-view.ts `fit` fitted it (none yet: its own size). */
  const fitted = $derived(
    screen.fitted && {
      width: `${screen.fitted.width}px`,
      height: `${screen.fitted.height}px`,
      rendering: screen.fitted.pixelated ? 'pixelated' : 'auto',
    },
  );
  let terminal = $state<HTMLElement>();
  let main = $state<HTMLElement>();
  $effect(() => {
    if (canvas && box && lockCursor) view.screen({ canvas, box, lockCursor });
  });
  $effect(() => {
    if (terminal) view.terminal(terminal);
  });
  $effect(() => {
    if (main) view.main(main);
  });

  $effect(() => {
    const body = document.body.dataset;
    body.page = demos.open ? 'demos' : machinesNav.open ? 'machines' : 'machine';
    body.state = power.state;
    body.view = screen.view;
    if (current.graphics) body.graphics = current.graphics;
  });
</script>

<svelte:window
  onfocus={view.events.focus}
  onblur={view.events.focus}
  onbeforeunload={view.events.beforeUnload}
  onhashchange={view.events.hashChange}
  onpopstate={view.events.popState}
/>
<svelte:document
  onfocusin={view.events.focusLater}
  onfocusout={view.events.focusLater}
  ondragover={view.events.dragOver}
  ondrop={view.events.drop}
  onfullscreenchange={view.events.fullscreenChanged}
/>
<Toolbar {audio} {net} {folders} />
{#if !machinesNav.open && !demos.open}<MessageBar />{/if}
<main
  bind:this={main}
  data-split-across={screen.split.across === undefined ? undefined : ''}
  data-split-stacked={screen.split.stacked === undefined ? undefined : ''}
  style:--split-across={screen.split.across}
  style:--split-stacked={screen.split.stacked}
>
  <div id="screen-view" bind:this={box}>
    <div id="screen-frame">
      {#key screen.generation}
        <canvas
          id="screen"
          bind:this={canvas}
          tabindex="0"
          aria-label={t('common:App.screen.label')}
          width={screen.size.width}
          height={screen.size.height}
          data-scale={screen.scale}
          style:width={fitted?.width}
          style:height={fitted?.height}
          style:image-rendering={fitted?.rendering}
        ></canvas>
      {/key}
      <div id="screen-hint">{mouse.lock ? t('common:App.screen.hintLock') : t('common:App.screen.hint')}</div>
      <div id="screen-cursor-clip">
        <canvas id="screen-cursor" bind:this={lockCursor} width="64" height="64" hidden></canvas>
      </div>
      <BootCard />
    </div>
  </div>
  {#if screen.view === 'both'}<ViewDivider {main} />{/if}
  <div id="terminal-view"><div id="terminal" bind:this={terminal}></div></div>
  {#if keys.osk}<Osk
      send={(code: string, down: boolean, mods: Mods, repeat?: boolean) => page.oskKey(code, down, mods, repeat)}
      keyLayout={keys.layout}
      mode={keys.oskModifiers}
      leds={keys.leds}
      onclose={() => {
        keys.osk = false;
      }}
    />{/if}
</main>
{#if demos.open}<DemosPage {store} />{:else if machinesNav.open}<MachinesPage {store} {net} {folders} />{/if}
<!-- A disk's surface floats over the machine and the Home page alike, and stays as the user goes between them. -->
{#if surfaceWindow.open}{#key surfaceWindow.open}<SurfaceWindow open={surfaceWindow.open} />{/key}{/if}
<!-- The RAM map, the same way: over the machine and the Home page. -->
{#if ramWindow.open}<RamWindow />{/if}
<StatusBar {net} />
<NetWizard {net} />
<NetDetails {net} />
<NameDialog {net} />
<FolderWizard {folders} />
<FoldersMount />
<Ask />
<FilePickers />

<style>
  /* The machine: its screen, its serial terminal, or both (`body[data-view]`, which `setView` sets at once with
     `screen.view`: it measures the screen's room right after). */
  main {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4);
  }
  main:fullscreen {
    background: var(--surface);
  }
  #screen-view {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #screen-frame {
    position: relative;
    display: flex;
  }
  #screen {
    background: var(--screen-bg);
    outline: none;
    box-shadow: var(--shadow-frame);
    touch-action: none;
  }
  #screen:focus {
    box-shadow: var(--shadow-focus);
  }
  #screen-hint {
    position: absolute;
    bottom: var(--space-5);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--space-2) var(--space-4);
    border-radius: 999px;
    background: var(--screen-overlay);
    color: var(--text);
    font-size: var(--text-sm);
    pointer-events: none;
  }
  #screen:focus + #screen-hint,
  :global(body:not([data-state='running'], [data-state='booting'])) #screen-hint {
    display: none;
  }
  /* The guest's cursor under the mouse lock: clipped to the screen, as a cursor is, so it never makes the page overflow. */
  #screen-cursor-clip {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  #screen-cursor {
    position: absolute;
    left: 0;
    top: 0;
  }
  #terminal-view {
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow: auto;
  }
  #terminal {
    padding: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  /* Fitting its box (an agent that sets the guest's size: web/app/areas/serial-terminal.ts `follow`, which sets
     `data-fit`: global, as the template doesn't have it): it takes the view's room, and xterm.js the cells that fit in
     it. The padding moves onto xterm.js's element, which the fit subtracts (it measures this box whole). */
  #terminal-view:global(:has(> #terminal[data-fit])) {
    align-items: stretch;
  }
  #terminal:global([data-fit]) {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 0;
  }
  #terminal:global([data-fit] > .xterm) {
    height: 100%;
    padding: var(--space-3);
  }
  #terminal:focus-within {
    border-color: var(--accent);
  }
  :global(body[data-view='screen']) #terminal-view,
  :global(body[data-view='terminal']) #screen-view {
    display: none;
  }
  :global(body[data-view='terminal']) #terminal-view {
    flex: 1;
  }
  :global(body[data-view='screen']) main {
    padding: 0;
  }
  :global(body[data-view='screen']) #screen-view {
    background: var(--screen-bg);
  }
  :global(body[data-view='screen']) #screen {
    box-shadow: none;
  }
  /* Both: the divider (ViewDivider.svelte) takes the gap; once moved, the terminal's share is where it put it. */
  :global(body[data-view='both']) main {
    gap: 0;
  }
  :global(body[data-view='both']) main[data-split-across] #terminal-view {
    flex: 0 0 calc((100% - var(--space-4)) * var(--split-across));
    min-width: 0;
  }
  /* The terminal alone, as the screen alone: no frame around it (the page's padding, its border and its own). */
  :global(body[data-view='terminal']) main {
    padding: 0;
  }
  :global(body[data-view='terminal']) #terminal {
    padding: 0;
    border: 0;
    border-radius: 0;
  }
  :global(body[data-view='terminal']) #terminal:global([data-fit] > .xterm) {
    padding: 0;
  }
  /* The Home page and the demo store's take the machine's place; the machine runs on behind them. */
  :global(body[data-page='machines']) main,
  :global(body[data-page='demos']) main {
    display: none;
  }
  @media (max-width: 1100px) {
    :global(body[data-view='both']) main {
      flex-direction: column;
    }
    :global(body[data-view='both']) main[data-split-across] #terminal-view {
      flex: 0 1 auto;
    }
    :global(body[data-view='both']) main[data-split-stacked] #terminal-view {
      flex: 0 0 calc((100% - var(--space-4)) * var(--split-stacked));
      min-height: 0;
    }
  }
</style>
