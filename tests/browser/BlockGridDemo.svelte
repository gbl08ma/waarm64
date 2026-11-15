<!--
  The block map in a floating window with made-up data (block-grid-page.ts): what a surface window will be, without
  a disk. Developer's words: a test page, not the page.
-->
<script lang="ts">
  import BlockGrid from '../../web/app/ui/BlockGrid.svelte';
  import BlockSwatch from '../../web/app/ui/BlockSwatch.svelte';
  import FloatingWindow from '../../web/app/ui/FloatingWindow.svelte';
  import { CORE, FLASH, RIM } from '../../web/app/ui/block-grid.ts';
  import { fakeSurface, flashOf } from './grid-demo.ts';

  const query = new URLSearchParams(location.search);
  const fixed = query.has('cells') ? Number(query.get('cells')) : undefined;
  let room = $state(0);
  const cells = $derived(fixed ?? room);
  const surface = $derived(fakeSurface(cells));
  let flash = $state<Uint8Array>();
  let hover = $state<number>();
  let pinned = $state<number>();
  let open = $state(true);

  window.__grid = {
    rooms: [],
    hovers: [],
    picks: [],
    rim: new Uint8Array(),
    core: new Uint8Array(),
    mark: 0,
    flash: (read, write) => (flash = flashOf(cells, read, write)),
  };
  $effect(() => {
    Object.assign(window.__grid, { rim: surface.rim, core: surface.core, mark: surface.mark });
    if (query.get('flash') !== '0') {
      const at = (f: number) => Math.floor(cells * f);
      flash = flashOf(cells, [at(0.05), at(0.15), at(0.4)], [at(0.12), at(0.4), at(0.86)]);
    }
  });
</script>

<div id="screen" tabindex="-1"></div>
{#if open}
  <FloatingWindow id="grid-window" place="grid-demo" title="vda · debian.qcow2" onclose={() => (open = false)}>
    {#snippet head()}
      <select data-field="layer">
        <option>disk alone</option>
        <option selected>overlay: work</option>
      </select>
    {/snippet}
    <div class="map">
      <BlockGrid
        {cells}
        rim={surface.rim}
        core={surface.core}
        {flash}
        mark={surface.mark}
        {pinned}
        label="surface"
        onroom={(n: number) => {
          window.__grid.rooms.push(n);
          room = n;
        }}
        onhover={(i: number | undefined) => {
          window.__grid.hovers.push(i);
          hover = i;
        }}
        onpick={(i: number) => {
          window.__grid.picks.push(i);
          pinned = i;
        }}
      />
    </div>
    <div class="legend">
      <BlockSwatch rim={RIM.empty}>empty</BlockSwatch>
      <BlockSwatch rim={RIM.step(1)}>held</BlockSwatch>
      <BlockSwatch rim={RIM.step(4)}>full</BlockSwatch>
      <BlockSwatch rim={RIM.opaque}>not examined</BlockSwatch>
      <BlockSwatch rim={RIM.absent}>past the end</BlockSwatch>
      <BlockSwatch rim={RIM.step(2)} core={CORE.step(3)}>changed</BlockSwatch>
      <BlockSwatch rim={RIM.step(2)} core={CORE.hollow}>zeroed</BlockSwatch>
      <BlockSwatch rim={RIM.step(2)} flash={FLASH.read}>read</BlockSwatch>
      <BlockSwatch rim={RIM.step(2)} flash={FLASH.write}>written</BlockSwatch>
    </div>
    <div class="line" data-field="hover">{hover ?? '–'} · {cells} cells · pinned {pinned ?? '–'}</div>
  </FloatingWindow>
{/if}

<style>
  #screen {
    position: fixed;
    inset: 0;
    background: var(--screen-bg);
  }
  .map {
    flex: 1;
    min-height: 0;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }
  .line {
    font-size: var(--text-sm);
    color: var(--text-dim);
    font-family: var(--font-mono);
  }
</style>
