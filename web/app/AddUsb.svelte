<!--
  Add a USB device (docs/usb.md "The page"): a wizard, as Add a disk is. Two numbered steps (the kind, then the
  browser's chooser), the kinds, each explained (WebUSB or WebHID: what each reaches), then a note: what is picked is
  remembered by the machine, and attached at once when it runs in this tab.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
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

  let dialog: Modal;
  let error = $state<ErrorView>();
  let busy = $state(false);

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

<Modal id="add-usb" bind:this={dialog} title={t('usb:AddUsb.title', { name })} onclose={close}>
  <ol class="steps">
    <li>{t('usb:AddUsb.step.kind')}</li>
    <li>{t('usb:AddUsb.step.pick')}</li>
  </ol>
  <div class="choices">
    {#each KINDS as k (k.api)}
      <button
        type="button"
        class="choice"
        data-usb-kind={k.api}
        disabled={busy || !hasApi(k.api)}
        title={hasApi(k.api) ? undefined : k.api === 'usb' ? t('usb:AddUsb.noWebUsb') : t('usb:AddUsb.noWebHid')}
        onclick={() => choose(k.api)}
      >
        <b><Icon name={k.icon} size={18} />{k.name}</b><span>{k.text}</span>
      </button>
    {/each}
  </div>
  <p class="note">{t('usb:AddUsb.note')}</p>
  {#if error}<div class="error" role="alert">
      {error.text}{#if error.words}<UsbProblems words={error.words} />{/if}
    </div>{/if}
  {#snippet buttons()}<span class="grow"></span><button type="button" onclick={() => dialog.close()}
      >{t('usb:AddUsb.cancel')}</button
    >{/snippet}
</Modal>

<style>
  .steps {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
