<!--
  Add a USB device (docs/usb.md "The page"): a wizard, as Add a disk is. The kind first, each
  explained (WebUSB or WebHID: what each reaches), then the browser's chooser, which lists every device it may show.
  What is picked is remembered by the machine, and attached at once when it runs on this page.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import UsbProblems from './UsbProblems.svelte';
  import { t } from '../i18n.ts';
  import type { IconName } from './icons.ts';
  import { hasApi, type Api } from './usb-live.ts';
  import { errorView, type ErrorView } from './usb-ports.ts';
  import { page } from './ui.svelte.ts';

  type Props = {
    /** A stored machine's id; undefined: the page's own (transient) machine. */
    machine: string | undefined;
    name: string;
    close(): void;
  };
  let { machine, name, close }: Props = $props();

  const KINDS: { api: Api; icon: IconName; name: string; text: string }[] = [
    { api: 'usb', icon: 'usb', name: t('usb:AddUsb.usb'), text: t('usb:AddUsb.usb.text') },
    { api: 'hid', icon: 'device-gamepad-2', name: t('usb:AddUsb.hid'), text: t('usb:AddUsb.hid.text') },
  ];

  let dialog: HTMLDialogElement;
  let error = $state<ErrorView>();
  let busy = $state(false);
  onMount(() => dialog.showModal());

  async function choose(api: Api) {
    error = undefined;
    busy = true;
    try {
      const names = await page.usbAdd(machine, api);
      if (names.length) dialog.close();
    } catch (e) {
      error = errorView(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog id="add-usb" bind:this={dialog} onclose={close} aria-labelledby="add-usb-title">
  <div class="body">
    <h2 id="add-usb-title">{t('usb:AddUsb.title', { name })}</h2>
    <p class="note">{t('usb:AddUsb.intro')}</p>
    <div class="choices">
      {#each KINDS as k (k.api)}
        <button type="button" class="choice" data-usb-kind={k.api} disabled={busy || !hasApi(k.api)} title={hasApi(k.api) ? undefined : k.api === 'usb' ? t('usb:AddUsb.noWebUsb') : t('usb:AddUsb.noWebHid')} onclick={() => choose(k.api)}>
          <b><Icon name={k.icon} size={18} />{k.name}</b><span>{k.text}</span>
        </button>
      {/each}
    </div>
    {#if error}<div class="error" role="alert">{error.text}{#if error.words}<UsbProblems words={error.words} />{/if}</div>{/if}
    <div class="buttons"><span class="grow"></span><button type="button" onclick={() => dialog.close()}>{t('usb:AddUsb.cancel')}</button></div>
  </div>
</dialog>

<style>
  dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; }
  .body { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .choices { display: flex; flex-direction: column; gap: 8px; }
  .choice b { display: flex; align-items: center; gap: 8px; }
  .note { margin: 0; color: var(--dim); font-size: 13px; }
  .error { display: flex; flex-direction: column; gap: 6px; color: #ff8f8f; white-space: pre-wrap; margin: 0; }
  .buttons { display: flex; gap: 8px; }
  .grow { flex: 1; }
  .buttons button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px; background: var(--bg); }
</style>
