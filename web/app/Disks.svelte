<!--
  A machine's disks on the Machines page (docs/machines.md §4): in slot order, read-only or not, a ramdisk as swap, moved, detached;
  per writable disk its overlays (switch, new empty; Overlays… opens the disk's overlays, Overlays.svelte: rename, delete,
  merge into a stored disk, export each), export (the Export wizard: the changes or the whole disk) and import (a changes file becomes a new
  overlay). Add a disk… opens the wizard (AddDisk.svelte).
-->
<script lang="ts">
  import type { Act } from './actions.svelte.ts';
  import Check from './ui/Check.svelte';
  import AddDisk from './AddDisk.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Icon from './ui/Icon.svelte';
  import Note from './ui/Note.svelte';
  import MoveButtons from './MoveButtons.svelte';
  import ExportButton from './ExportButton.svelte';
  import Overlays from './Overlays.svelte';
  import { ask } from './ask.svelte.ts';
  import { msg, MsgError, t, text } from '../i18n.ts';
  import type { Store, OverlayRecord } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { MAX_DISKS } from './shape.ts';
  import { bytesText, editAttachment } from './machines.ts';
  import { createOverlay, switchOverlay } from './disks.ts';
  import { URL_SLOW } from './urlcheck.ts';
  import { inBar, page } from './page.ts';
  import { diskKind } from './disk-kind.ts';

  type Props = {
    store: Store;
    machine: MachineRecord;
    /** Every machine in this browser (the Overlays dialog says which write to each overlay). */
    machines: MachineRecord[];
    disks: Map<string, DiskRecord>;
    overlays: OverlayRecord[];
    act: Act;
    offFirst: (m: MachineRecord) => Promise<boolean>;
  };
  let { store, machine, machines, disks, overlays, act, offFirst }: Props = $props();

  const plain = (m: MachineRecord) => $state.snapshot(m);
  const overlaysOf = (disk: string) => overlays.filter((o) => o.disk === disk).sort((a, b) => a.created - b.created);
  async function newOverlay(attachment: string, disk: DiskRecord) {
    const name = await ask.prompt(t('disks:Disks.newOverlay.text'), t('disks:Disks.newOverlay.name'), {
      title: t('disks:Disks.newOverlay.title'),
      ok: t('disks:Disks.newOverlay.ok'),
    });
    if (!name) return;
    await act(t('disks:Disks.busy.newOverlay'), async () => {
      if (!(await offFirst(machine))) return;
      try {
        const o = await createOverlay(store, disk, name);
        await switchOverlay(store, plain(machine), attachment, o.id);
      } catch (e) {
        throw new MsgError('disks:Disks.failed.newOverlay', {}, { cause: e });
      }
    });
  }
  async function switchTo(attachment: string, overlay: string) {
    await act(t('disks:Disks.busy.switch'), async () => {
      if (!(await offFirst(machine))) return;
      await switchOverlay(store, plain(machine), attachment, overlay).catch((e: unknown) => {
        throw new MsgError('disks:Disks.failed.switch', {}, { cause: e });
      });
    });
  }
  /**
   * An attachment's read-only, in-place or swap box. Its value is taken from the event at once: Svelte's delegated events lose
   * `currentTarget` once dispatched, so read after an await (the power-off question) it was null and nothing was saved.
   */
  function setFlag(id: string, flag: { readOnly?: boolean; inPlace?: boolean; swap?: boolean }) {
    void act(t('disks:Disks.busy.change'), async () => {
      if (await offFirst(machine)) await editAttachment(store, plain(machine), id, flag);
    });
  }
  async function detach(id: string, d: DiskRecord | undefined) {
    const mine = d ? overlaysOf(d.id) : [];
    const bytes = mine.reduce((n, o) => n + o.bytes, 0);
    const kept =
      d?.kind === 'ramdisk'
        ? msg('disks:Disks.detach.keptRamdisk')
        : mine.length
          ? msg('disks:Disks.detach.keptOverlays', { count: mine.length, size: bytesText(bytes) })
          : msg('disks:Disks.detach.kept');
    if (
      !(await ask.confirm(
        t('disks:Disks.detach.confirm', {
          disk: d?.name ?? msg('disks:Disks.detach.theDisk'),
          machine: machine.name,
          kept,
        }),
        { title: t('disks:Disks.detach.title'), ok: t('disks:Disks.detach.ok') },
      ))
    )
      return;
    await act(t('disks:Disks.busy.detach'), async () => {
      if (await offFirst(machine)) await editAttachment(store, plain(machine), id, { detach: true });
    });
  }

  // Import.
  let importInputs = $state<Record<string, HTMLInputElement | undefined>>({});
  const imported = (attachment: string) => (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) inBar(() => page.importChanges(f, { machine: plain(machine), attachment }));
  };

  let adding = $state(false);
  /** The disk whose Overlays dialog is open. */
  let overlaysOpen = $state<string>();
  const overlaysShown = $derived(overlaysOpen ? disks.get(overlaysOpen) : undefined);
</script>

<CardList empty={machine.attachments.length ? undefined : t('disks:Disks.none')}>
  {#each machine.attachments as a, i (a.id)}
    {@const d = disks.get(a.disk)}
    <Card data-attachment={a.id}>
      <div class="row">
        <span class="kind" title={d ? diskKind(d.kind).text : ''}
          ><Icon name={d ? diskKind(d.kind).icon : 'x'} size={18} /></span
        >
        <strong>{d?.name ?? t('disks:Disks.missing')}</strong>
        <Note inline class="meta"
          >{d
            ? t('disks:Disks.meta', {
                kind: diskKind(d.kind).text,
                size: bytesText(d.size),
                letter: String.fromCharCode(97 + i),
              })
            : t('disks:Disks.meta.missing', { letter: String.fromCharCode(97 + i) })}</Note
        >
        <span class="grow"></span>
        <Check
          compact
          checked={a.readOnly}
          disabled={d?.kind === 'blank' || d?.kind === 'ramdisk'}
          onchange={(on: boolean) => setFlag(a.id, { readOnly: on })}>{t('disks:Disks.readOnly')}</Check
        >
        {#if d?.kind === 'ramdisk'}
          <Check
            compact
            checked={!!a.swap}
            onchange={(on: boolean) => setFlag(a.id, { swap: on })}
            title={t('disks:Disks.swap.title')}>{t('disks:Disks.swap')}</Check
          >
        {/if}
        {#if d?.kind === 'stored' && !a.readOnly}
          <Check
            compact
            checked={!!a.inPlace}
            onchange={(on: boolean) => setFlag(a.id, { inPlace: on })}
            title={t('disks:Disks.inPlace.title')}>{t('disks:Disks.inPlace')}</Check
          >
        {/if}
        <MoveButtons
          index={i}
          count={machine.attachments.length}
          onmove={(by: -1 | 1) =>
            act(t('disks:Disks.busy.move'), () => editAttachment(store, plain(machine), a.id, { move: by }))}
          upTitle={t('disks:Disks.moveUp.title')}
          downTitle={t('disks:Disks.moveDown.title')}
        />
        <Button onclick={() => detach(a.id, d)} title={t('disks:Disks.detach.button.title')}
          >{t('disks:Disks.detach.button')}</Button
        >
      </div>
      {#if d?.kind === 'url'}<div class="url-note"><Note>{text(URL_SLOW)}</Note></div>{/if}
      {#if d && !a.readOnly && d.kind !== 'ramdisk' && !a.inPlace}
        <div class="overlays">
          <label
            >{t('disks:Disks.overlays.label')}
            <select
              value={a.overlay ?? ''}
              onchange={(e) => switchTo(a.id, e.currentTarget.value)}
              data-field="overlay"
            >
              {#if !a.overlay}<option value="">{t('disks:Disks.overlays.none')}</option>{/if}
              {#each overlaysOf(d.id) as o (o.id)}<option value={o.id}
                  >{o.fork
                    ? t('disks:Disks.overlays.forked', { name: o.name, size: bytesText(o.bytes) })
                    : t('disks:Disks.overlays.option', { name: o.name, size: bytesText(o.bytes) })}</option
                >{/each}
            </select>
          </label>
          <Button icon="plus" onclick={() => newOverlay(a.id, d)} title={t('disks:Disks.newEmpty.title')}
            >{t('disks:Disks.newEmpty')}</Button
          >
          {#if overlaysOf(d.id).length}<Button
              onclick={() => (overlaysOpen = d.id)}
              title={t('disks:Disks.overlaysButton.title')}
              data-action="disk-overlays">{t('disks:Disks.overlaysButton')}</Button
            >{/if}
          {#if a.overlay && overlays.some((x) => x.id === a.overlay)}<ExportButton
              disk={d}
              overlay={a.overlay}
              changes={d.kind !== 'blank'}
            />{/if}
          {#if d.kind !== 'blank'}
            <Button
              icon="upload"
              onclick={() => importInputs[a.id]?.click()}
              title={t('disks:Disks.importChanges.title')}>{t('disks:Disks.importChanges')}</Button
            >
            <input
              type="file"
              hidden
              bind:this={importInputs[a.id]}
              onchange={imported(a.id)}
              data-field="import-changes"
            />
          {/if}
        </div>
      {:else if d?.kind === 'stored'}
        <div class="overlays">
          {#if overlaysOf(d.id).length}<Button
              onclick={() => (overlaysOpen = d.id)}
              title={t('disks:Disks.overlaysButton.title')}
              data-action="disk-overlays">{t('disks:Disks.overlaysButton')}</Button
            >{/if}
          <ExportButton disk={d} overlay={undefined} changes={false} />
        </div>
      {/if}
    </Card>
  {/each}
</CardList>
<div class="after">
  {#if machine.attachments.length < MAX_DISKS}
    <Button icon="plus" onclick={() => (adding = true)} data-action="add-disk-open">{t('disks:Disks.add')}</Button>
  {:else}
    <Note>{t('disks:Disks.full', { max: MAX_DISKS })}</Note>
  {/if}
</div>
{#if adding}<AddDisk {store} {machine} {act} {offFirst} close={() => (adding = false)} />{/if}
{#if overlaysShown}<Overlays
    {store}
    disk={overlaysShown}
    {overlays}
    {machines}
    {act}
    close={() => (overlaysOpen = undefined)}
  />{/if}

<style>
  .row,
  .overlays {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }
  .overlays {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .grow {
    flex: 1;
  }
  .kind {
    display: inline-flex;
    color: var(--text-dim);
  }
  .overlays > label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }
  .url-note {
    margin-top: var(--space-2);
  }
  .after {
    margin-top: var(--space-4);
  }
</style>
