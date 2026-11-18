<!--
  Resize… (docs/machines.md §4.5): a dialog over the Home page that grows a stored disk, a ramdisk or an overlay,
  opened from the Disks pane (a disk's card, an overlay's row in Overlays…) and from a machine's Disks tab (its
  attachment's overlay, one made for it where it has none yet, its stored disk written in place or ramdisk). The size
  now and what it holds, the new one (a SizeField: MiB or GiB, rounded up to
  a whole MiB), the guest's growth at its next start (on by default; not for a ramdisk) and what `resizeCosts` says as
  the size is typed: the machines whose disk grows, a running one (the machine on this page powered off from here, as
  the page's other edits do), the snapshots it orphans, or why the size is refused.
-->
<script lang="ts">
  import ErrorText from './ErrorText.svelte';
  import { onMount } from 'svelte';
  import { Actions, type Act } from './actions.svelte.ts';
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import SizeField from './ui/SizeField.svelte';
  import T from './T.svelte';
  import type { Dialog } from './ui/dialog.ts';
  import { msg, t } from '../i18n.ts';
  import { errorView } from './usb-problems.ts';
  import { resize, resizeCosts, sizeNow, type ResizeCosts, type ResizeWhat } from './resize.ts';
  import type { Store } from './store.ts';
  import type { MachineRecord } from './shape.ts';
  import { current } from './areas/current.svelte.ts';

  type Props = {
    store: Store;
    target: ResizeWhat;
    /** The disk's or the overlay's name. */
    name: string;
    /** A ramdisk: empty at every start, so no growth in the guest. */
    ramdisk: boolean;
    /** The machine's name, where the dialog was opened from its Disks tab (an attachment with no overlay yet names it). */
    machine?: string;
    act: Act;
    offFirst: (m: MachineRecord) => Promise<boolean>;
    close: () => void;
  };
  let { store, target, name, ramdisk, machine, act, offFirst, close }: Props = $props();

  const MiB = 1024 ** 2;
  const GiB = 1024 ** 3;

  let dialog: Dialog;
  /** The dialog's own runner: its errors show here (the page's bar is behind the dialog). */
  const runner = new Actions();

  let now = $state<number>();
  /** What the overlay or stored disk holds now (none known: a ramdisk, a stored disk not read yet). */
  let held = $state<number>();
  /** The new size typed (whole MiB, the guest's partitions being aligned to them; SizeField's), none while it isn't one. */
  let bytes = $state<number>();
  let grow = $state(true);
  const size = $derived(bytes ?? 0);
  let costs = $state.raw<ResizeCosts>();
  /** Why the size typed is refused (the refusal's cause), or the costs couldn't be read. */
  let refusal = $state<string>();
  /** Bumped after a power-off: the costs are asked again (which machines run). */
  let powered = $state(0);

  onMount(() => {
    sizeNow(store, target).then(
      ({ size: n, held: h }) => {
        now = n;
        held = h;
        // The next whole GiB past it (or 256 MiB under a GiB): a size that grows it.
        const step = n >= GiB ? GiB : 256 * MiB;
        bytes = (Math.floor(n / step) + 1) * step;
      },
      (e: unknown) => runner.fail(e),
    );
  });

  // What the size typed does, read again as it changes (IndexedDB and Web Locks are outside the component; an answer
  // for a size typed over since is dropped).
  $effect(() => {
    const s = size;
    let stale = false;
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
    void powered;
    if (now === undefined || !s) {
      costs = undefined;
      refusal = undefined;
      return;
    }
    resizeCosts(store, $state.snapshot(target), s).then(
      (c) => {
        if (stale) return;
        costs = c;
        refusal = undefined;
      },
      (e: unknown) => {
        if (stale) return;
        costs = undefined;
        refusal = errorView((e as Error).cause ?? e).text;
      },
    );
    return () => {
      stale = true;
    };
  });

  /** Running machines: the resize waits for them off; the one on this page can be powered off from here. */
  const running = $derived(costs?.running ?? []);
  const here = $derived(running.find((m) => m.id === current.id));
  const machinesLine = $derived(
    costs?.machines.length
      ? msg('disks:ResizeDisk.machines', { machines: costs.machines.map((m) => m.name) })
      : msg('disks:ResizeDisk.machinesNone'),
  );
  const snapshotsLine = $derived.by(() => {
    if (!costs?.snapshots.length) return undefined;
    const names = new Map(costs.machines.map((m) => [m.id, m.name]));
    const list = costs.snapshots.map((s) =>
      msg('disks:ResizeDisk.snapshot', { name: s.name, machine: names.get(s.machine) ?? '' }),
    );
    return msg('disks:ResizeDisk.snapshots', { count: costs.snapshots.length, list });
  });
  const ready = $derived(!!costs && !running.length && !runner.busy);

  async function powerOff(m: MachineRecord) {
    await act(t('disks:ResizeDisk.busy.powerOff'), async () => {
      await offFirst($state.snapshot(m));
    });
    powered++;
  }
  async function ok() {
    const [s, g] = [size, !ramdisk && grow];
    let done = false;
    await act(t('disks:ResizeDisk.busy'), async () => {
      done = await runner.run('', () => resize(store, $state.snapshot(target), s, { grow: g }));
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by the callback `act` runs
    if (done) dialog.close();
  }
</script>

<Modal id="resize-disk" bind:this={dialog} title={msg('disks:ResizeDisk.title', { name })} onclose={close}>
  <Note size="md">{t('disks:ResizeDisk.note')}</Note>
  {#if now !== undefined}<Note size="md" data-now
      >{held === undefined
        ? t('disks:ResizeDisk.now', { size: now })
        : t('disks:ResizeDisk.nowHeld', { size: now, held })}</Note
    >{/if}
  {#if 'attachment' in target}<Note size="md" data-new-overlay
      ><T
        k="disks:ResizeDisk.newOverlay"
        params={{ name: t('disks:page-disks.overlayName'), machine: machine ?? '' }}
      /></Note
    >{/if}
  {#if now !== undefined}<Field label={t('disks:ResizeDisk.size')}
      ><SizeField bind:bytes field="resize-size" unitField="resize-unit" /></Field
    >{/if}
  {#if refusal}<Note tone="error" size="md" data-refusal role="alert">{refusal}</Note>{/if}
  {#if costs}
    <Note size="md" data-new>{t('disks:ResizeDisk.newSize', { size })}</Note>
    <Note size="md" data-machines><T m={machinesLine} /></Note>
    {#if snapshotsLine}<Note tone="warn" size="md" data-snapshots><T m={snapshotsLine} /></Note>{/if}
    {#if running.length}
      <Note tone="error" size="md" data-running role="alert"
        ><T
          k="machines:resize.running"
          params={{ machines: running.map((m) => m.name), count: running.length }}
        /></Note
      >
      {#if here}<span
          ><Button onclick={() => powerOff(here)} data-action="resize-power-off"
            ><T k="disks:ResizeDisk.powerOff" params={{ name: here.name }} /></Button
          ></span
        >{/if}
    {/if}
  {/if}
  {#if !ramdisk}
    <Check bind:checked={grow} field="resize-grow" note={t('disks:ResizeDisk.grow.note')}
      >{t('disks:ResizeDisk.grow')}</Check
    >
  {/if}
  {#if runner.error}<Note tone="error" size="md" class="error" role="alert"><ErrorText error={runner.error} /></Note
    >{/if}
  {#snippet buttons()}
    <Button onclick={() => dialog.close()}>{t('disks:ResizeDisk.cancel')}</Button>
    <Button variant="primary" disabled={!ready} onclick={ok} data-action="resize-ok">{t('disks:ResizeDisk.ok')}</Button>
  {/snippet}
</Modal>
