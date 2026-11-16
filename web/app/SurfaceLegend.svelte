<!--
  A disk surface window's legend (SurfaceWindow.svelte): the looks its view can show and what each means, drawn as the
  grid draws them (BlockSwatch.svelte); `kind` the view (web/app/surface-look.ts `legendOf`).
-->
<script lang="ts">
  import BlockSwatch from './ui/BlockSwatch.svelte';
  import { legendOf, type ViewKind } from './surface-look.ts';
  import { t } from '../i18n.ts';

  let { kind }: { kind: ViewKind } = $props();
  const entries = $derived(legendOf(kind));
</script>

<div class="legend" data-legend={entries.map((e) => e.key.slice(e.key.lastIndexOf('.') + 1)).join(' ')}>
  {#each entries as e (e.key)}<BlockSwatch rim={e.rim} core={e.core} flash={e.flash} tick={e.tick}
      >{t(e.key)}</BlockSwatch
    >{/each}
</div>

<style>
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }
</style>
