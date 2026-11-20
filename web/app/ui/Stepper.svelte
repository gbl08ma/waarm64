<!--
  A stepper (the introduction's pictures): which step of `count` shows (`at`, bound), with Back and Next, and Play or
  Pause when the steps can run by themselves (`playing`, bound: its owner advances `at`). The words are its owner's
  (`labels`), the place is said to a screen reader as it changes.
-->
<script lang="ts">
  import Button from './Button.svelte';

  type Props = {
    at: number;
    count: number;
    playing?: boolean;
    labels: { back: string; next: string; play: string; pause: string; place: string };
  };
  let { at = $bindable(), count, playing = $bindable(), labels }: Props = $props();
  const step = (by: number) => {
    playing = playing === undefined ? undefined : false;
    at = (at + by + count) % count;
  };
</script>

<div class="stepper" role="group">
  <Button icon="arrow-left" title={labels.back} aria-label={labels.back} onclick={() => step(-1)} data-step="back" />
  {#if playing !== undefined}
    <Button
      icon={playing ? 'player-pause' : 'player-play'}
      title={playing ? labels.pause : labels.play}
      aria-label={playing ? labels.pause : labels.play}
      aria-pressed={playing}
      onclick={() => (playing = !playing)}
      data-step="play"
    />
  {/if}
  <Button icon="arrow-right" title={labels.next} aria-label={labels.next} onclick={() => step(1)} data-step="next" />
  <!-- Said as it changes only while the visitor steps: stepping by itself, it would be read out every step. -->
  <span class="place" aria-live={playing ? 'off' : 'polite'}>{labels.place}</span>
</div>

<style>
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .place {
    margin-left: var(--space-3);
    color: var(--text-dim);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
</style>
