<!--
  The toolbar's USB menu (docs/usb.md "The page"): the running machine's remembered devices with
  attach toggles, the host's game pads (the game pad of ours: docs/usb.md "The game pad"), the offers (a device that just appeared, one that left and may come back as another, a permission to
  give), Add a device…, and the Machines page's USB tab. With `?usbzero=1`, Gadget Zero (the controller's test device).
  It opens by itself when there is something to do (`ui.usb.open`).
-->
<script lang="ts">
  import AddUsb from './AddUsb.svelte';
  import Menu from './Menu.svelte';
  import UsbProblems from './UsbProblems.svelte';
  import { t } from '../i18n.ts';
  import { deviceName, errorView, type ErrorView } from './usb-ports.ts';
  import { page, ui } from './ui.svelte.ts';

  let open = $state(false);
  let adding = $state(false);
  let error = $state<ErrorView>();
  let lastOpen = 0;
  $effect(() => {
    const n = ui.usb.open;
    if (n !== lastOpen) { lastOpen = n; if (ui.usb.offers.length) open = true; }
  });
  // The built-in keyboard is the machine's own, not a device of the user's: not counted, not listed.
  const attached = $derived(ui.usb.connectors.filter((c) => c && !c.builtin).length);
  const zeroOn = $derived(ui.usb.connectors.some((c) => c?.virtual && !c.builtin && c.pad === undefined));

  async function run(f: () => Promise<unknown>) {
    error = undefined;
    try {
      await f();
    } catch (e) {
      error = errorView(e);
    }
  }
  const toggle = (id: string, on: boolean) => run(() => (on ? page.usbAttach(id) : page.usbDetach(id)));
  type View = (typeof ui.usb.entries)[number];
  /** The device's line's tooltip: why it can't be attached now, if it can't. */
  const why = (v: View) => (v.state === 'unplugged' ? t('usb:UsbMenu.why.unplugged') : v.state === 'held' ? (v.holder ? t('usb:UsbMenu.why.heldBy', { holder: v.holder }) : t('usb:UsbMenu.why.held')) : v.state === 'ungranted' ? t('usb:UsbMenu.why.ungranted') : '');
  /** What the device's line says at its right: where it is, or why it can't be attached. */
  function where(v: View, c: (typeof ui.usb.connectors)[number]) {
    if (c?.entry === v.entry.id && c.state !== 'attached') return c.state === 'detaching' ? t('usb:UsbMenu.where.detaching') : t('usb:UsbMenu.where.attaching');
    if (v.state === 'attached') return t('usb:UsbMenu.where.connector', { connector: v.entry.connector + 1 });
    if (v.state === 'held') return v.holder ? t('usb:UsbMenu.where.heldBy', { holder: v.holder }) : t('usb:UsbMenu.where.held');
    if (v.state === 'plugged') return '';
    return v.state === 'ungranted' ? t('usb:UsbMenu.where.ungranted') : t('usb:UsbMenu.where.unplugged');
  }
</script>

<Menu id="usb-menu" icon="usb" title={t('usb:UsbMenu.title')} bind:open panel data-attached={attached || undefined}>
  {#snippet badge()}{#if attached}<span class="count" aria-label={t('usb:UsbMenu.attached', { n: attached })}>{attached}</span>{/if}{/snippet}
  {#each ui.usb.offers as o (o.id)}
    <div class="offer" data-usb-offer={o.id}>
      <p>{o.text}</p>
      <div class="row"><button class="primary" onclick={() => page.usbOffer(o.id, true)}>{o.label}</button><button onclick={() => page.usbOffer(o.id, false)}>{t('usb:UsbMenu.notNow')}</button></div>
    </div>
  {/each}
  {#each ui.usb.entries as v (v.entry.id)}
    {@const on = v.state === 'attached'}
    {@const c = ui.usb.connectors[v.entry.connector]}
    <label class="device" data-usb-device={v.entry.id} data-state={v.state} title={why(v)}>
      <input type="checkbox" checked={on || c?.entry === v.entry.id} disabled={!ui.usb.running || (!on && (v.state === 'unplugged' || v.state === 'ungranted' || (!!c && c.entry !== v.entry.id)))} onchange={(e) => toggle(v.entry.id, (e.currentTarget as HTMLInputElement).checked)}>
      <span class="name">{deviceName(v.entry)}</span>
      <span class="dim">{where(v, c)}</span>
    </label>
    {#if on && c?.entry === v.entry.id && c.problems?.length}
      <p class="warn" data-usb-problems={v.entry.id} title={c.problems.map((w) => w.text).join('\n\n')}>{t('usb:UsbMenu.problems')}</p>
    {/if}
  {:else}
    <p class="hint">{t('usb:UsbMenu.none')}</p>
  {/each}
  {#if ui.usb.hasPads}
    <p class="head">{t('usb:UsbMenu.pads')}</p>
    {#each ui.usb.pads as g (g.index)}
      {@const at = ui.usb.connectors.findIndex((c) => c?.pad === g.index)}
      <label class="device" data-usb-pad={g.index} title={t('usb:UsbMenu.pad.why')}>
        <input type="checkbox" checked={at >= 0} disabled={!ui.usb.running} onchange={() => run(() => page.usbPad(g.index))}>
        <span class="name">{g.name}</span>
        <span class="dim">{at >= 0 ? t('usb:UsbMenu.where.connector', { connector: at + 1 }) : ''}</span>
      </label>
    {:else}
      <p class="hint">{t('usb:UsbMenu.pads.none')}</p>
    {/each}
  {/if}
  {#if ui.usb.zero}
    <label class="device" data-usb-zero><input type="checkbox" checked={zeroOn} disabled={!ui.usb.running} onchange={() => run(() => page.usbZero())}><span class="name">{t('usb:UsbMenu.zero')}</span><span class="dim">{t('usb:UsbMenu.zero.note')}</span></label>
  {/if}
  {#if error}<div class="error" role="alert">{error.text}{#if error.words}<UsbProblems words={error.words} />{/if}</div>{/if}
  <div class="row">
    <button id="usb-add" onclick={() => { open = false; adding = true; }}>{t('usb:UsbMenu.add')}</button>
    {#if ui.current}<button onclick={() => { open = false; page.openMachines('usb', ui.current); }}>{t('usb:UsbMenu.all')}</button>{/if}
  </div>
  {#if !ui.usb.running}<p class="hint">{t('usb:UsbMenu.stopped')}</p>{/if}
</Menu>
{#if adding}<AddUsb machine={ui.current} name={ui.title} close={() => (adding = false)} />{/if}

<style>
  .offer { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid #5c4a1d; border-radius: 6px; background: #2a2412; }
  .offer p { margin: 0; }
  .device { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; }
  .name { overflow-wrap: anywhere; }
  .dim { color: var(--dim); font-size: 12px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .count { min-width: 14px; padding: 0 4px; border-radius: 7px; background: #3b6db3; color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
  .head { margin: 4px 0 0; color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .warn { color: #ffb36b; font-size: 12px; margin: -4px 0 0 24px; max-width: 360px; }
  .error { display: flex; flex-direction: column; gap: 6px; color: #ff8f8f; white-space: pre-wrap; margin: 0; max-width: 360px; }
  .primary { background: #24406b; border-color: #3b6db3; color: #fff; }
</style>
