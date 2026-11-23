<!--
  The veil over the screen or the serial terminal while the machine doesn't run (docs/frontend.md "The veil"; `veil`:
  web/app/areas/power.svelte.ts): a hatch over the picture left there, which App.svelte dims and takes the color out of,
  or with `cover` nothing of it (a machine that is off shows no picture); and in the middle, with `plaque`, the state on
  a plaque as the boot card's (ui/Plaque.svelte), with Resume under a suspended machine's and Start under one that is off. A machine held still for a snapshot (`paused`) gets the hatch alone,
  and only once the pause has lasted a moment: the message bar says what goes on, and a short save doesn't flash.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Plaque from './ui/Plaque.svelte';
  import type { IconName } from './icons.ts';
  import { power, type Veil } from './areas/power.svelte.ts';
  import { inBar, page } from './page.ts';
  import { t } from '../i18n.ts';

  type Props = { veil: Veil; cover?: boolean; plaque?: boolean };
  let { veil, cover = false, plaque = true }: Props = $props();

  type Stopped = Exclude<Veil, 'paused'>;
  const ICON: Record<Stopped, IconName> = {
    suspended: 'player-pause',
    off: 'player-stop',
    crashed: 'alert-triangle',
    failed: 'alert-triangle',
    idle: 'player-play',
  };
  const WORDS: Record<Stopped, string> = {
    suspended: 'machine:messages.state.suspended',
    off: 'machine:messages.state.off',
    crashed: 'machine:messages.state.crashed',
    failed: 'machine:messages.state.failed',
    idle: 'machine:messages.state.idle',
  };
  const stopped = $derived(veil === 'paused' ? undefined : veil);
  /** The plaque: the state's icon and words, in the warning color for a machine that stopped by a fault. */
  const said = $derived(
    plaque && stopped
      ? { icon: ICON[stopped], words: t(WORDS[stopped]), warn: stopped === 'crashed' || stopped === 'failed' }
      : undefined,
  );
</script>

<div class="veil" data-state-veil={veil} data-cover={cover ? '' : undefined}>
  {#if said}
    <Plaque icon={said.icon} tone={said.warn ? 'warn' : 'plain'}>
      {#snippet title()}<span data-veil-title>{said.words}</span>{/snippet}
      {#if (stopped === 'suspended' || stopped === 'off') && !power.cantRun}
        <span class="act">
          <Button
            variant="primary"
            icon="player-play"
            data-action={stopped === 'off' ? 'start' : 'resume'}
            disabled={power.busy}
            onclick={() => inBar(() => page.restart())}
          >
            {stopped === 'off' ? t('machine:StateVeil.start') : t('machine:StateVeil.resume')}
          </Button>
        </span>
      {/if}
    </Plaque>
  {/if}
</div>

<style>
  .veil {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    overflow: hidden;
    pointer-events: none;
    background: repeating-linear-gradient(135deg, transparent 0 10px, var(--veil-hatch) 10px 12px);
    animation: veil-in var(--motion-fast) var(--ease) both;
  }
  /* The veil lets the pointer through to the screen and the terminal; the plaque's button takes it. */
  .act {
    pointer-events: auto;
  }
  .veil[data-cover] {
    background: var(--screen-bg);
  }
  .veil[data-state-veil='paused'] {
    animation-delay: var(--motion);
  }
  @keyframes veil-in {
    from {
      opacity: 0;
    }
  }
</style>
