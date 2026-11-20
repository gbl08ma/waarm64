<!--
  The machine in the introduction's first screen (IntroHero.svelte; docs/frontend.md "The introduction"): a small
  guest that boots when the page opens (intro/guest-run.svelte.ts), its screen, a line of ours that says what the
  visitor is looking at (by the tour's marks), its serial terminal, and what it has run so far. It runs only while it
  is on screen in a visible tab, and ends when the introduction is left. A visitor who asked for less motion starts it
  with a button; where it can't run at all, the machine's plate shows instead (IntroPlate.svelte).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Button from '../ui/Button.svelte';
  import IntroPlate from './IntroPlate.svelte';
  import T from '../T.svelte';
  import { GuestRun, SCREEN } from './guest-run.svelte.ts';
  import { count } from '../statusbar-piece.ts';
  import { reducedMotion } from '../view-transition.ts';
  import { t } from '../../i18n.ts';

  const guest = new GuestRun();
  let frame = $state<HTMLElement>();
  let canvas = $state<HTMLCanvasElement>();
  let terminal = $state<HTMLElement>();
  /** The frame is on screen, in a tab that shows. */
  let inView = $state(false);
  let tabShown = $state(!document.hidden);

  const start = () => {
    if (canvas && terminal) guest.start(canvas, terminal);
  };
  // By itself, once: when the frame first comes on screen (not for a visitor who asked for less motion).
  let started = false;
  $effect(() => {
    if (started || !inView || !canvas || !terminal || reducedMotion()) return;
    started = true;
    start();
  });
  $effect(() => guest.pause(!inView || !tabShown));
  $effect(() => {
    if (!frame) return;
    const seen = new IntersectionObserver((entries) => (inView = entries.some((e) => e.isIntersecting)), {
      threshold: 0.1,
    });
    seen.observe(frame);
    return () => seen.disconnect();
  });
  onDestroy(() => void guest.stop());

  /** The tour has said what the picture is (its reveal, or a key ended it): only then do the counters show, which would give it away. */
  const revealed = $derived(guest.mark !== undefined && guest.mark !== 'scope');
  /** Which line of ours is under the screen: the tour's mark, or what the frame waits for. */
  const line = $derived(
    guest.state === 'off' ? 'off' : guest.state === 'waiting' ? 'waiting' : (guest.mark ?? 'scope'),
  );
</script>

<svelte:document onvisibilitychange={() => (tabShown = !document.hidden)} />

{#if guest.state === 'unable'}
  <IntroPlate />
{:else}
  <figure bind:this={frame} data-guest={guest.state} data-mark={guest.mark} aria-label={t('intro:IntroGuest.label')}>
    <div class="screen">
      {#key guest.run}
        <canvas bind:this={canvas} width={SCREEN.width} height={SCREEN.height}></canvas>
      {/key}
      {#if guest.state === 'waiting' || guest.state === 'off'}
        <div class="over">
          <Button variant="primary" onclick={start} data-action="intro-guest-start">
            {guest.state === 'off' ? t('intro:IntroGuest.again') : t('intro:IntroGuest.start')}
          </Button>
        </div>
      {/if}
    </div>
    <!-- A message a line, its key written out (tools/i18n-check.ts reads them here). -->
    <p class="caption" aria-live="polite" data-line={line}>
      {#if line === 'waiting'}{t('intro:IntroGuest.caption.waiting')}
      {:else if line === 'off'}{t('intro:IntroGuest.caption.off')}
      {:else if line === 'reveal'}{t('intro:IntroGuest.caption.reveal')}
      {:else if line === 'ridges'}{t('intro:IntroGuest.caption.ridges')}
      {:else if line === 'life'}{t('intro:IntroGuest.caption.life')}
      {:else if line === 'shell'}<T k="intro:IntroGuest.caption.shell" />
      {:else}{t('intro:IntroGuest.caption.scope')}{/if}
    </p>
    {#key guest.run}
      <div class="serial" bind:this={terminal} aria-label={t('intro:IntroGuest.terminal')}></div>
    {/key}
    <p class="counters" data-steps={guest.stats?.steps ?? 0}>
      {#if guest.stats && revealed}
        {t('intro:IntroGuest.counters', { steps: count(guest.stats.steps), blocks: count(guest.stats.blocks) })}
      {:else}
        &nbsp;
      {/if}
    </p>
  </figure>
{/if}

<style>
  /* A module of the panel, as the plate is: raised, its top edge lit; the screen and the terminal sunk into it. */
  figure {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    width: 100%;
    min-width: 0;
    max-width: calc(512px + 2 * var(--space-4) + 2px);
    margin: 0;
    justify-self: end;
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-raised);
    box-shadow: var(--card-edge), var(--shadow-menu);
  }
  .screen {
    position: relative;
    border-radius: var(--radius);
    background: var(--screen-bg);
    box-shadow: var(--well-edge);
    overflow: hidden;
  }
  /* The guest's pixels one to one where the frame has its full width (whole multiples on a dense display). */
  canvas {
    display: block;
    width: 100%;
    aspect-ratio: 512 / 320;
    image-rendering: pixelated;
  }
  .over {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--screen-overlay);
  }
  /* The line of ours: two lines' room, so the frame doesn't move as the tour goes on. */
  .caption {
    margin: 0;
    min-height: calc(2 * var(--line-height) * 1em);
    color: var(--text);
    font-size: var(--text-md);
  }
  /* Its eight rows' room before it has any (not started yet); in a narrow window its right end is cut. */
  .serial {
    min-height: 128px;
    padding: var(--space-3);
    border-radius: var(--radius);
    background: var(--well-bg);
    box-shadow: var(--well-edge);
    overflow: hidden;
  }
  /* One column (IntroHero.svelte's narrow window): the frame starts where the words do. */
  @media (max-width: 900px) {
    figure {
      justify-self: start;
    }
  }
  .counters {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
