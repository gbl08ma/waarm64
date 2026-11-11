<!-- An icon of the page's set (web/app/icons.ts: Tabler's outline icons), in the text's colour. -->
<script lang="ts">
  import { ICONS, type IconName } from './icons.ts';
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
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
