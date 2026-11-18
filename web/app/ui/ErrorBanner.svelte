<!--
  A bar that says something went wrong (`tone` `error`), needs a look (`warn`) or was done (`info`): the message bar, the
  Home page's error. Across the page, or `floating` over what's under it (a card the size of its words, which the
  caller places). With a `countdown` (an `info` notice's), a ring around its close button runs down its time, paused
  while the pointer is on the bar, then calls its `end`. Its words (`children`) take the room, centered on its buttons
  while they're a line or two and from the top when taller; its buttons (`actions`) and its close button (with
  `ondismiss`, named `dismissLabel`) stay at the top, one height. `bodyId`, `actionsId` and `dismissId` name its parts (the tests' handles); `class` and other
  attributes (`id`, `role`, `hidden`, `data-*`) go on the bar. Two bars with the same `crossfade` key, one leaving
  as the other comes, move into each other (crossfade.ts): the message bar between floating and the Home page.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';
  import type { Countdown } from '../areas/message-bar.svelte.ts';
  import { sendKeyed, receiveKeyed } from './crossfade.ts';

  type Props = {
    tone?: 'error' | 'warn' | 'info';
    floating?: boolean;
    countdown?: Countdown;
    ondismiss?: () => void;
    dismissLabel?: string;
    bodyId?: string;
    actionsId?: string;
    dismissId?: string;
    crossfade?: string;
    class?: string;
    children: Snippet;
    actions?: Snippet;
    [attr: string]: unknown;
  };
  let {
    tone = 'error',
    floating = false,
    countdown,
    ondismiss,
    dismissLabel,
    bodyId,
    actionsId,
    dismissId,
    crossfade,
    class: cls,
    children,
    actions,
    ...rest
  }: Props = $props();
  /** The ring's time (a CSS duration). */
  const ringStyle = $derived(countdown && `--ring-ms: ${countdown.ms}ms`);
</script>

<div
  class={['banner', tone, floating && 'floating', cls]}
  {...rest}
  data-crossfade={crossfade}
  in:receiveKeyed|global
  out:sendKeyed|global
>
  <!-- Its words and buttons wrap among themselves; the close button stays beside them, at the top right. -->
  <div class="main">
    <div class="body" id={bodyId}>{@render children()}</div>
    {#if actions}<div class="actions" id={actionsId}>{@render actions()}</div>{/if}
  </div>
  {#if ondismiss}
    <span class="dismiss-at">
      {#if countdown}{#key countdown.id}<svg
            class="ring"
            viewBox="0 0 28 28"
            aria-hidden="true"
            style={ringStyle}
            onanimationend={countdown.end}><circle cx="14" cy="14" r="12.5" pathLength="100" /></svg
          >{/key}{/if}
      <Button
        variant="plain"
        class="dismiss close"
        id={dismissId}
        icon="x"
        aria-label={dismissLabel}
        title={dismissLabel}
        onclick={ondismiss}
      />
    </span>
  {/if}
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid;
    /* Its buttons take the bar's color: the frame of a bordered one too. */
    --text: currentColor;
    --border: currentColor;
  }
  .error {
    color: var(--error-bar-fg);
    background: var(--error-bg);
    border-color: var(--error-border);
  }
  .warn {
    color: var(--warn-bar-fg);
    background: var(--warn-bg);
    border-color: var(--warn-border);
  }
  .info {
    color: var(--ok-bar-fg);
    background: var(--ok-bg);
    border-color: var(--ok-border);
  }
  /* Over the page rather than in its column: the room under it (the machine's screen) stays its size. */
  .floating {
    border-width: 1px;
    border-style: solid;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-menu);
  }
  .main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3) var(--space-5);
  }
  /* The message's words beside its actions: the body takes the room the actions leave (so they sit at the bar's far
     end when the words are short; a floating bar is the size of its words anyway) and can shrink so long words wrap
     instead of overflowing; the actions always stay to its right on the same line. */
  .body {
    align-self: center;
    flex: 1 1 auto;
    min-width: 0;
    max-height: 30vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  /* The close button, at the end. */
  .dismiss-at {
    position: relative;
    display: flex;
    flex: none;
  }
  /* A notice's time left: the ring empties clockwise from the top, around the close button. */
  .ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
    pointer-events: none;
  }
  .ring circle {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-dasharray: 100;
    animation: run-down var(--ring-ms) linear forwards;
  }
  .banner:hover .ring circle,
  .banner:focus-within .ring circle {
    animation-play-state: paused;
  }
  @keyframes run-down {
    to {
      stroke-dashoffset: 100;
    }
  }
</style>
