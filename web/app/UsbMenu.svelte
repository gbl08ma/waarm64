<!--
  The toolbar's USB menu (docs/usb.md "The page"): the running machine's remembered devices with
  attach toggles, the offers (a device that just appeared, one that left and may come back as another, a permission to
  give), Add a device…, and the Machines page's USB tab. With `?usbzero=1`, Gadget Zero (the controller's test device).
  It opens by itself when there is something to do (`ui.usb.open`).
-->
<script lang="ts">
  import AddUsb from './AddUsb.svelte';
  import Menu from './Menu.svelte';
  import UsbProblems from './UsbProblems.svelte';
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
  const zeroOn = $derived(ui.usb.connectors.some((c) => c?.virtual && !c.builtin));

  async function run(f: () => Promise<unknown>) {
    error = undefined;
    try {
      await f();
    } catch (e) {
      error = errorView(e);
    }
  }
  const toggle = (id: string, on: boolean) => run(() => (on ? page.usbAttach(id) : page.usbDetach(id)));
</script>

<Menu id="usb-menu" icon="usb" title="USB devices: attach them to the machine, or add one" bind:open panel data-attached={attached || undefined}>
  {#snippet badge()}{#if attached}<span class="count" aria-label={`${attached} attached`}>{attached}</span>{/if}{/snippet}
  {#each ui.usb.offers as o (o.id)}
    <div class="offer" data-usb-offer={o.id}>
      <p>{o.text}</p>
      <div class="row"><button class="primary" onclick={() => page.usbOffer(o.id, true)}>{o.label}</button><button onclick={() => page.usbOffer(o.id, false)}>Not now</button></div>
    </div>
  {/each}
  {#each ui.usb.entries as v (v.entry.id)}
    {@const on = v.state === 'attached'}
    {@const c = ui.usb.connectors[v.entry.connector]}
    <label class="device" data-usb-device={v.entry.id} data-state={v.state} title={v.state === 'unplugged' ? 'Not plugged in' : v.state === 'held' ? `Held by ${v.holder ?? 'another machine'}` : v.state === 'ungranted' ? 'No permission in this browser yet: Allow it on the Machines page\'s USB tab' : ''}>
      <input type="checkbox" checked={on || c?.entry === v.entry.id} disabled={!ui.usb.running || (!on && (v.state === 'unplugged' || v.state === 'ungranted' || (!!c && c.entry !== v.entry.id)))} onchange={(e) => toggle(v.entry.id, (e.currentTarget as HTMLInputElement).checked)}>
      <span class="name">{deviceName(v.entry)}</span>
      <span class="dim">{c?.entry === v.entry.id && c.state !== 'attached' ? `${c.state}…` : on ? `connector ${v.entry.connector + 1}` : v.state === 'held' ? `in ${v.holder ?? 'another machine'}` : v.state === 'plugged' ? '' : v.state === 'ungranted' ? 'no permission' : 'not plugged in'}</span>
    </label>
    {#if on && c?.entry === v.entry.id && c.problems?.length}
      <p class="warn" data-usb-problems={v.entry.id} title={c.problems.map((w) => w.text).join('\n\n')}>Part of it doesn't reach the guest: hover here, or see All USB settings…</p>
    {/if}
  {:else}
    <p class="hint">No devices remembered yet.</p>
  {/each}
  {#if ui.usb.zero}
    <label class="device" data-usb-zero><input type="checkbox" checked={zeroOn} disabled={!ui.usb.running} onchange={() => run(() => page.usbZero())}><span class="name">Gadget Zero</span><span class="dim">test device</span></label>
  {/if}
  {#if error}<div class="error" role="alert">{error.text}{#if error.words}<UsbProblems words={error.words} />{/if}</div>{/if}
  <div class="row">
    <button id="usb-add" onclick={() => { open = false; adding = true; }}>Add a device…</button>
    {#if ui.current}<button onclick={() => { open = false; page.openMachines('usb', ui.current); }}>All USB settings…</button>{/if}
  </div>
  {#if !ui.usb.running}<p class="hint">The machine isn't running: its devices are attached when it runs.</p>{/if}
</Menu>
{#if adding}<AddUsb machine={ui.current} name={ui.title} close={() => (adding = false)} />{/if}

<style>
  .offer { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid #5c4a1d; border-radius: 6px; background: #2a2412; }
  .offer p { margin: 0; }
  .device { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dim { color: var(--dim); font-size: 12px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .count { min-width: 14px; padding: 0 4px; border-radius: 7px; background: #3b6db3; color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
  .warn { color: #ffb36b; font-size: 12px; margin: -4px 0 0 24px; max-width: 360px; }
  .error { display: flex; flex-direction: column; gap: 6px; color: #ff8f8f; white-space: pre-wrap; margin: 0; max-width: 360px; }
  .primary { background: #24406b; border-color: #3b6db3; color: #fff; }
</style>
