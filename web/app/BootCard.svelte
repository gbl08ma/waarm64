<!--
  The boot card over the screen while a machine loads and boots (docs/frontend.md "The page's code"): its title, its
  progress and the boot's last line (web/app/areas/boot-card.svelte.ts), and the way to the serial console where a
  firmware machine's boot is.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import T from './T.svelte';
  import { bootCard } from './areas/boot-card.svelte.ts';
  import { page } from './page.ts';
  import { t } from '../i18n.ts';
</script>

<div id="boot" hidden={!bootCard.shown}>
  <div id="boot-title">
    {#if typeof bootCard.title === 'string'}{bootCard.title}{:else}<T m={bootCard.title} />{/if}
  </div>
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
</div>

<style>
  #boot {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    padding: var(--space-6);
    background: var(--screen-bg);
    color: var(--text-dim);
    pointer-events: none;
  }
  #boot-title {
    color: var(--text);
    font-size: var(--text-lg);
  }
  #boot progress {
    width: min(320px, 80%);
    height: 6px;
    accent-color: var(--accent);
  }
  #boot-serial {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
    font-size: var(--text-md);
    pointer-events: auto;
  }
  #boot-line {
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
