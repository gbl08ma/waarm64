<!-- An icon of the page's set (web/app/icons.ts: Tabler's outline icons), in the text's colour. -->
<script lang="ts">
  import { ICONS, type IconName } from './icons.ts';
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{@html ICONS[name]}</svg>

<style>
  .icon { flex: none; display: block; }
</style>
