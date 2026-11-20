<!--
  The toolbar's USB menu (docs/usb.md "The page"): the running machine's remembered devices with
  attach toggles, the host's game pads (the game pad of ours: docs/usb.md "The game pad"), the offers (a device that just appeared, one that left and may come back as another, a permission to
  give), Add a device…, and the Home page's USB tab. With `?usbzero=1`, Gadget Zero (the controller's test device).
  It opens by itself when there is something to do (web/app/areas/usb.svelte.ts `openMenu`: an offer).
-->
<script lang="ts">
  import ErrorText from './ErrorText.svelte';
  import AddUsb from './AddUsb.svelte';
  import Menu from './ui/Menu.svelte';
  import Button from './ui/Button.svelte';
  import Callout from './ui/Callout.svelte';
  import Note from './ui/Note.svelte';
  import UsbProblems from './UsbProblems.svelte';
  import T from './T.svelte';
  import { msg, t, type Msg } from '../i18n.ts';
  import { deviceName } from './usb-ports.ts';
  import { Actions } from './actions.svelte.ts';
  import { usb } from './areas/usb.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  let open = $state(false);
  let adding = $state(false);
  const runner = new Actions();
  $effect(() =>
    usb.menu.handle(() => {
      open = true;
    }),
  );
  // The built-in keyboard is the machine's own, not a device of the user's: not counted, not listed.
  const attached = $derived(usb.connectors.filter((c) => c && !c.builtin).length);
  const zeroOn = $derived(usb.connectors.some((c) => c?.virtual && !c.builtin && c.pad === undefined));

  const run = (f: () => Promise<unknown>) => runner.run('', f);
  const toggle = (id: string, on: boolean) => run(() => (on ? page.usbAttach(id) : page.usbDetach(id)));
  type View = (typeof usb.entries)[number];
  /** The device's line's tooltip: why it can't be attached now, if it can't. */
  const why = (v: View) =>
    v.state === 'unplugged'
      ? t('usb:UsbMenu.why.unplugged')
      : v.state === 'held'
        ? v.holder
          ? t('usb:UsbMenu.why.heldBy', { holder: v.holder })
          : t('usb:UsbMenu.why.held')
        : v.state === 'ungranted'
          ? t('usb:UsbMenu.why.ungranted')
          : '';
  /** What the device's line says at its right: where it is, or why it can't be attached. */
  function where(v: View, c: (typeof usb.connectors)[number]): Msg | undefined {
    if (c?.entry === v.entry.id && c.state !== 'attached')
      return c.state === 'detaching' ? msg('usb:UsbMenu.where.detaching') : msg('usb:UsbMenu.where.attaching');
    if (v.state === 'attached') return msg('usb:UsbMenu.where.connector', { connector: v.entry.connector + 1 });
    if (v.state === 'held')
      return v.holder ? msg('usb:UsbMenu.where.heldBy', { holder: v.holder }) : msg('usb:UsbMenu.where.held');
    if (v.state === 'plugged') return undefined;
    return v.state === 'ungranted' ? msg('usb:UsbMenu.where.ungranted') : msg('usb:UsbMenu.where.unplugged');
  }
</script>

<Menu id="usb-menu" icon="usb" title={t('usb:UsbMenu.title')} bind:open panel data-attached={attached || undefined}>
  {#snippet badge()}{#if attached}<span class="count" aria-label={t('usb:UsbMenu.attached', { n: attached })}
        >{attached}</span
      >{/if}{/snippet}
  {#each usb.offers as o (o.id)}
    <Callout tone="warn" class="offer" data-usb-offer={o.id}>
      <p><T m={o.text} /></p>
      {#snippet actions()}
        <Button variant="primary" onclick={() => page.usbOffer(o.id, true)}>{o.label}</Button>
        <Button onclick={() => page.usbOffer(o.id, false)}>{t('usb:UsbMenu.notNow')}</Button>
      {/snippet}
    </Callout>
  {/each}
  {#each usb.entries as v (v.entry.id)}
    {@const on = v.state === 'attached'}
    {@const c = usb.connectors[v.entry.connector]}
    {@const place = where(v, c)}
    <label class="device" data-usb-device={v.entry.id} data-state={v.state} title={why(v)}>
      <input
        type="checkbox"
        checked={on || c?.entry === v.entry.id}
        disabled={!usb.running ||
          (!on && (v.state === 'unplugged' || v.state === 'ungranted' || (!!c && c.entry !== v.entry.id)))}
        onchange={(e) => toggle(v.entry.id, e.currentTarget.checked)}
      />
      <span class="name">{deviceName(v.entry)}</span>
      <span class="dim"
        >{#if place}<T m={place} />{/if}</span
      >
    </label>
    {#if on && c?.entry === v.entry.id && c.problems?.length}
      <div class="problems">
        <Note tone="warn" data-usb-problems={v.entry.id} title={c.problems.map((w) => w.text).join('\n\n')}>
          <T k="usb:UsbMenu.problems" />
        </Note>
      </div>
    {/if}
  {:else}
    <Note>{t('usb:UsbMenu.none')}</Note>
  {/each}
  {#if usb.hasPads}
    <p class="head">{t('usb:UsbMenu.pads')}</p>
    {#each usb.pads as g (g.index)}
      {@const at = usb.connectors.findIndex((c) => c?.pad === g.index)}
      <label class="device" data-usb-pad={g.index} title={t('usb:UsbMenu.pad.why')}>
        <input
          type="checkbox"
          checked={at >= 0}
          disabled={!usb.running}
          onchange={() => run(() => page.usbPad(g.index))}
        />
        <span class="name">{g.name}</span>
        <span class="dim">{at >= 0 ? t('usb:UsbMenu.where.connector', { connector: at + 1 }) : ''}</span>
      </label>
    {:else}
      <Note>{t('usb:UsbMenu.pads.none')}</Note>
    {/each}
  {/if}
  {#if usb.zero}
    <label class="device" data-usb-zero
      ><input
        type="checkbox"
        checked={zeroOn}
        disabled={!usb.running}
        onchange={() => run(() => page.usbZero())}
      /><span class="name">{t('usb:UsbMenu.zero')}</span><span class="dim">{t('usb:UsbMenu.zero.note')}</span></label
    >
  {/if}
  {#if runner.error}<div class="error" role="alert">
      <Note tone="error"><ErrorText error={runner.error} /></Note>{#if runner.error.words}<UsbProblems
          words={runner.error.words}
        />{/if}
    </div>{/if}
  <div class="row">
    <Button
      id="usb-add"
      onclick={() => {
        open = false;
        adding = true;
      }}>{t('usb:UsbMenu.add')}</Button
    >
    {#if current.id}<Button
        onclick={() => {
          open = false;
          page.openMachines('usb', current.id);
        }}>{t('usb:UsbMenu.all')}</Button
      >{/if}
  </div>
  {#if !usb.running}<Note><T k="usb:UsbMenu.stopped" /></Note>{/if}
</Menu>
{#if adding}<AddUsb machine={current.id} name={current.title} close={() => (adding = false)} />{/if}

<style>
  .device {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--space-3);
  }
  .name {
    overflow-wrap: anywhere;
  }
  .dim {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .row {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  /* The number of attached devices, on the menu's button: the primary button's color. */
  .count {
    min-width: 14px;
    padding: 0 var(--space-2);
    border-radius: 999px;
    background: var(--primary-border);
    color: var(--primary-fg);
    font-size: var(--text-xs);
    line-height: 14px;
    text-align: center;
  }
  .head {
    margin: var(--space-2) 0 0;
    color: var(--text-dim);
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* Under its device's line, past the box. */
  .problems {
    max-width: 360px;
    padding-left: var(--space-6);
  }
  .error {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 360px;
    color: var(--error-fg);
  }
</style>
