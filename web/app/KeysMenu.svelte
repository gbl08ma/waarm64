<!--
  The toolbar's Keys menu (docs/frontend.md "Input"): the on-screen keyboard, the combinations a browser or a desktop
  takes (Esc, Ctrl+W…), Hold Esc, Ctrl+Alt+Del and Ctrl+Alt+F1–F12, sent to the guest.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Menu from './ui/Menu.svelte';
  import { t } from '../i18n.ts';
  import { keys } from './areas/keys.svelte.ts';
  import { page } from './page.ts';

  let open = $state(false);
  const chord = (keys: string) => {
    open = false;
    page.chord(keys.split(' '));
  };
  /** How long Hold Esc holds it (ms): past what a browser asks to leave its full screen (Chromium's keyboard lock, ~2 s). */
  const HOLD_ESC_MS = 3000;
  /** The combinations the menu sends besides Ctrl+Alt+Del and Ctrl+Alt+F1–F12: those a browser or a desktop takes. */
  const COMBOS = [
    { keys: 'Escape', label: 'toolbar:KeysMenu.keys.esc', title: 'toolbar:KeysMenu.keys.esc.title' },
    { keys: 'ControlLeft KeyW', label: 'toolbar:KeysMenu.keys.ctrlW', title: 'toolbar:KeysMenu.keys.ctrlW.title' },
    { keys: 'ControlLeft KeyT', label: 'toolbar:KeysMenu.keys.ctrlT', title: 'toolbar:KeysMenu.keys.ctrlT.title' },
    { keys: 'ControlLeft KeyN', label: 'toolbar:KeysMenu.keys.ctrlN', title: 'toolbar:KeysMenu.keys.ctrlN.title' },
    { keys: 'ControlLeft KeyQ', label: 'toolbar:KeysMenu.keys.ctrlQ', title: 'toolbar:KeysMenu.keys.ctrlQ.title' },
    { keys: 'AltLeft F4', label: 'toolbar:KeysMenu.keys.altF4', title: 'toolbar:KeysMenu.keys.altF4.title' },
    { keys: 'AltLeft Tab', label: 'toolbar:KeysMenu.keys.altTab', title: 'toolbar:KeysMenu.keys.altTab.title' },
    { keys: 'MetaLeft', label: 'toolbar:KeysMenu.keys.super', title: 'toolbar:KeysMenu.keys.super.title' },
  ] as const;
  const FKEYS = Array.from({ length: 12 }, (_, k) => k + 1);
  function osk() {
    open = false;
    page.showOsk(!keys.osk);
  }
  function holdEsc() {
    open = false;
    page.holdKey('Escape', HOLD_ESC_MS);
  }
</script>

<Menu id="keys" icon="keyboard" title={t('toolbar:KeysMenu.keys.title')} bind:open>
  <Button
    variant="item"
    id="osk-toggle"
    aria-pressed={keys.osk}
    title={t('toolbar:KeysMenu.keys.osk.title')}
    onclick={osk}
  >
    {keys.osk ? t('toolbar:KeysMenu.keys.osk.hide') : t('toolbar:KeysMenu.keys.osk')}
  </Button>
  <hr />
  <div class="combos">
    {#each COMBOS as c (c.keys)}
      <Button variant="item" align="center" data-chord={c.keys} title={t(c.title)} onclick={() => chord(c.keys)}>
        {t(c.label)}
      </Button>
    {/each}
    <Button
      variant="item"
      align="center"
      id="hold-esc"
      title={t('toolbar:KeysMenu.keys.holdEsc.title')}
      onclick={holdEsc}
    >
      {t('toolbar:KeysMenu.keys.holdEsc')}
    </Button>
  </div>
  <Button variant="item" data-chord="ControlLeft AltLeft Delete" onclick={() => chord('ControlLeft AltLeft Delete')}>
    {t('toolbar:KeysMenu.keys.ctrlAltDel')}
  </Button>
  <div class="heading">{t('toolbar:KeysMenu.keys.ctrlAlt')}</div>
  <div class="fkeys" id="fkeys">
    {#each FKEYS as k (k)}
      <Button
        variant="item"
        align="center"
        data-chord={`ControlLeft AltLeft F${k}`}
        title={t('toolbar:KeysMenu.keys.fkey.title', { n: k })}
        aria-label={t('toolbar:KeysMenu.keys.fkey.title', { n: k })}
        onclick={() => chord(`ControlLeft AltLeft F${k}`)}
      >
        {t('toolbar:KeysMenu.keys.fkey', { n: k })}
      </Button>
    {/each}
  </div>
</Menu>

<style>
  .heading {
    padding: var(--space-3) var(--space-4) var(--space-1);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .combos {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
  }
  .fkeys {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
</style>
