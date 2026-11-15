<!--
  A disk's small line ended by a "visualize" link that opens the disk's surface window (SurfaceWindow.svelte): "… · vda ·
  visualize", the link part of the line. In the Disks pane (DiskInfo.svelte) and a machine's Disks tab (Disks.svelte).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';

  let { line, onvisualize }: { line: string; onvisualize: () => void } = $props();
</script>

<T k="disks:VisualizeLine.line" params={{ line }}
  >{#snippet link(words: string)}<Button
      variant="link"
      data-action="surface-open"
      title={t('disks:VisualizeLine.title')}
      onclick={onvisualize}>{words}</Button
    >{/snippet}</T
>
