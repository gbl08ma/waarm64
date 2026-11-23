<!--
  The serial terminal's place on the page (docs/frontend.md "Views"): the box xterm.js draws in (`onmount` gives it to
  the terminal's area, web/app/areas/serial-terminal.ts), alone, beside the screen or under it (`body[data-view]`,
  App.svelte's split), and the veil over it while the machine doesn't run (StateVeil.svelte: its text stays, dimmed).
-->
<script lang="ts">
  import StateVeil from './StateVeil.svelte';
  import { power } from './areas/power.svelte.ts';
  import { screen } from './areas/screen.svelte.ts';

  type Props = { onmount: (el: HTMLElement) => void };
  let { onmount }: Props = $props();
  let terminal = $state<HTMLElement>();
  $effect(() => {
    if (terminal) onmount(terminal);
  });
</script>

<div id="terminal-view">
  <!-- xterm.js adds its element beside the veil (`open`). The plaque is the screen's while both show. -->
  <div id="terminal" bind:this={terminal} data-veil={power.veil}>
    {#if power.veil}<StateVeil veil={power.veil} plaque={screen.view === 'terminal'} />{/if}
  </div>
</div>

<style>
  #terminal-view {
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow: auto;
  }
  #terminal {
    position: relative;
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
  /* xterm.js's layers stay under the veil; its text is dimmed and without its colors under one, as the screen's
     picture is (App.svelte), only once a pause for a snapshot has lasted a moment. */
  #terminal :global(.xterm) {
    isolation: isolate;
    transition: filter var(--motion-fast) var(--ease);
  }
  #terminal[data-veil] :global(.xterm) {
    filter: var(--veil-dim);
  }
  #terminal[data-veil='paused'] :global(.xterm) {
    transition-delay: var(--motion);
  }
  #terminal:focus-within {
    border-color: var(--accent);
  }
  :global(body[data-view='screen']) #terminal-view {
    display: none;
  }
  :global(body[data-view='terminal']) #terminal-view {
    flex: 1;
  }
  /* Both, once the divider was moved: the terminal's share is where it put it. */
  :global(body[data-view='both'] main[data-split-across]) #terminal-view {
    flex: 0 0 calc((100% - var(--space-4)) * var(--split-across));
    min-width: 0;
  }
  /* The terminal alone, as the screen alone: no frame around it (its border and its own padding). */
  :global(body[data-view='terminal']) #terminal {
    padding: 0;
    border: 0;
    border-radius: 0;
  }
  :global(body[data-view='terminal']) #terminal:global([data-fit] > .xterm) {
    padding: 0;
  }
  @media (max-width: 1100px) {
    :global(body[data-view='both'] main[data-split-across]) #terminal-view {
      flex: 0 1 auto;
    }
    :global(body[data-view='both'] main[data-split-stacked]) #terminal-view {
      flex: 0 0 calc((100% - var(--space-4)) * var(--split-stacked));
      min-height: 0;
    }
  }
</style>
