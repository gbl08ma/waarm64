<!--
  The Up and Down buttons of an ordered list (a machine's disks, shared folders and network adapters): what each move
  means there goes in `upTitle` and `downTitle`, and `action` names them for the tests (`<action>-up`, `<action>-down`).
-->
<script lang="ts">
  import Icon from './Icon.svelte';

  let { index, count, onmove, upTitle = 'Move up', downTitle = 'Move down', action }: {
    /** This item's place, and how many there are: the ends can't move past themselves. */
    index: number;
    count: number;
    onmove: (by: -1 | 1) => void;
    upTitle?: string;
    downTitle?: string;
    action?: string;
  } = $props();
</script>

<button onclick={() => onmove(-1)} disabled={index === 0} aria-label="Up" title={upTitle} data-action={action && `${action}-up`}><Icon name="arrow-up" size={16} /></button>
<button onclick={() => onmove(1)} disabled={index >= count - 1} aria-label="Down" title={downTitle} data-action={action && `${action}-down`}><Icon name="arrow-down" size={16} /></button>

<style>
  button { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 6px; padding: 3px 5px; }
</style>
