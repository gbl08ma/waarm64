<!--
  The boot card over the screen while a machine loads and boots (docs/frontend.md "The page's code"): on a plaque as a
  stopped machine's state is (ui/Plaque.svelte, StateVeil.svelte), its title, its progress and the boot's last line
  (web/app/areas/boot-card.svelte.ts), and the way to the serial console where a firmware machine's boot is.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Plaque from './ui/Plaque.svelte';
  import T from './T.svelte';
  import { bootCard } from './areas/boot-card.svelte.ts';
  import { page } from './page.ts';
  import { t } from '../i18n.ts';
</script>

<div id="boot" hidden={!bootCard.shown}>
  <Plaque icon="player-play">
    {#snippet title()}
      <span id="boot-title">
        {#if typeof bootCard.title === 'string'}{bootCard.title}{:else}<T m={bootCard.title} />{/if}
      </span>
    {/snippet}
    {#if bootCard.progress === undefined}<progress id="boot-progress"></progress>{:else}<progress
        id="boot-progress"
        value={bootCard.progress}
      ></progress>{/if}
    <div id="boot-line">{bootCard.line}</div>
    <div id="boot-serial" hidden={!bootCard.serial}>
      <span>{t('common:BootCard.serial')}</span><Button id="boot-serial-show" onclick={() => page.showLog()}
        >{t('common:BootCard.serial.show')}</Button
      >
    </div>
  </Plaque>
</div>

<style>
  #boot {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    overflow: hidden;
    background: var(--screen-bg);
    pointer-events: none;
  }
  #boot progress {
    width: 320px;
    max-width: 100%;
    height: 6px;
    accent-color: var(--accent);
  }
  #boot-serial {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-md);
    text-align: center;
    pointer-events: auto;
  }
  #boot-line {
    max-width: 100%;
    min-height: 1lh;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
