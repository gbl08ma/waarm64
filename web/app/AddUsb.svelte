<!--
  Add a USB device (docs/usb.md "The page"): a wizard, as Add a disk is. Two numbered steps (the kind, then the
  browser's chooser), the kinds, each explained (WebUSB or WebHID: what each reaches), then a note: what is picked is
  remembered by the machine, and attached at once when it runs in this tab.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Choice from './ui/Choice.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import { t } from '../i18n.ts';
  import type { IconName } from './icons.ts';
  import { hasApi, type Api } from './usb-live.ts';
  import { Actions } from './actions.svelte.ts';
  import ErrorWords from './ErrorWords.svelte';
  import { page } from './page.ts';

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

  /** Why a kind can't be chosen: the browser lacks its API. */
  const unavailable: Record<Api, string> = { usb: t('usb:AddUsb.noWebUsb'), hid: t('usb:AddUsb.noWebHid') };

  let dialog: Modal;
  const runner = new Actions();
  const busy = $derived(runner.busy !== undefined);

  function choose(api: Api) {
    void runner.run('', async () => {
      const names = await page.usbAdd(machine, api);
      if (names.length) dialog.close();
    });
  }
</script>

<Modal id="add-usb" bind:this={dialog} title={t('usb:AddUsb.title', { name })} onclose={close}>
  <ol class="steps">
    <li>{t('usb:AddUsb.step.kind')}</li>
    <li>{t('usb:AddUsb.step.pick')}</li>
  </ol>
  {#each KINDS as k (k.api)}
    <Choice
      label={k.name}
      icon={k.icon}
      data-usb-kind={k.api}
      disabled={busy || !hasApi(k.api)}
      title={hasApi(k.api) ? undefined : unavailable[k.api]}
      onclick={() => choose(k.api)}>{k.text}</Choice
    >
  {/each}
  <Note size="md">{t('usb:AddUsb.note')}</Note>
  {#if runner.error}<div class="error" role="alert">
      <ErrorWords error={runner.error} />
    </div>{/if}
  {#snippet buttons()}<Button type="button" onclick={() => dialog.close()}>{t('usb:AddUsb.cancel')}</Button>{/snippet}
</Modal>

<style>
  .steps {
    margin: 0;
    padding-left: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .error {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    color: var(--error-fg);
  }
</style>
