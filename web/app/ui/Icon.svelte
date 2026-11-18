<!-- An icon of the page's set (web/app/icons.ts: Tabler's outline icons), in the text's colour; `size` in px, or a CSS
  length (`0.9em`: an icon in words, T.svelte). -->
<script lang="ts">
  import { ICONS, type IconName } from '../icons.ts';
  let { name, size = 20 }: { name: IconName; size?: number | string } = $props();
  const Glyph = $derived(ICONS[name]);
</script>

<Glyph {size} stroke={1.75} aria-hidden="true" />

<style>
  /* The package's component draws the <svg>, with its class. */
  :global(svg.tabler-icon) {
    flex: none;
    display: block;
  }
</style>
