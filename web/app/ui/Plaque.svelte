<!--
  A plaque: the small raised panel in the middle of the screen or the serial terminal that says what the machine is
  doing while it shows no live picture (starting: BootCard.svelte; suspended, powered off, crashed: StateVeil.svelte).
  An icon and a title (the parent's snippet); under them what the parent gives (a progress, a line). `tone` `warn`
  lights the icon in the warning color.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from '../icons.ts';

  type Props = { icon: IconName; title: Snippet; tone?: 'plain' | 'warn'; children?: Snippet };
  let { icon, title, tone = 'plain', children }: Props = $props();
</script>

<div class="plaque" data-tone={tone}>
  <div class="head">
    <span class="icon"><Icon name={icon} size={22} /></span>
    <div class="title">{@render title()}</div>
  </div>
  {@render children?.()}
</div>

<style>
  .plaque {
    box-sizing: border-box;
    max-width: min(440px, 100%);
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-menu);
    color: var(--text-dim);
  }
  .head {
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .icon {
    flex: none;
  }
  .plaque[data-tone='warn'] .icon {
    color: var(--warn-fg);
  }
  .title {
    min-width: 0;
    color: var(--text);
    font-size: var(--text-lg);
    overflow-wrap: anywhere;
  }
</style>
