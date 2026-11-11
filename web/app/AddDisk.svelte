<!--
  Add a disk (docs/machines.md §4.2): a wizard over the Machines page. First the kind of source, each explained;
  then its details (the URL and the server's check, the file, the size) and whether the machine may write to it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import AddDiskFile from './AddDiskFile.svelte';
  import AddDiskUrl from './AddDiskUrl.svelte';
  import DiskInfo from './DiskInfo.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Check from './ui/Check.svelte';
  import Choice from './ui/Choice.svelte';
  import Field from './ui/Field.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import { Actions, type Act } from './actions.svelte.ts';
  import { makeDisk, type Picked, type Source } from './add-disk.ts';
  import { t } from '../i18n.ts';
  import { attach } from './machines.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import type { UrlCheck } from './urlcheck.ts';
  import type { IconName } from './icons.ts';

  type Props = {
    store: Store;
    machine: MachineRecord;
    act: Act;
    offFirst(m: MachineRecord): Promise<boolean>;
    close(): void;
  };
  let { store, machine, act, offFirst, close }: Props = $props();

  const SOURCES: { kind: Source; icon: IconName; name: string; text: string; title: string }[] = [
    {
      kind: 'known',
      icon: 'database',
      name: t('disks:AddDisk.source.known'),
      text: t('disks:AddDisk.source.known.text'),
      title: t('disks:AddDisk.title.known'),
    },
    {
      kind: 'file',
      icon: 'file',
      name: t('disks:AddDisk.source.file'),
      text: t('disks:AddDisk.source.file.text'),
      title: t('disks:AddDisk.title.file'),
    },
    {
      kind: 'stored',
      icon: 'database-import',
      name: t('disks:AddDisk.source.stored'),
      text: t('disks:AddDisk.source.stored.text'),
      title: t('disks:AddDisk.title.stored'),
    },
    {
      kind: 'url',
      icon: 'world-www',
      name: t('disks:AddDisk.source.url'),
      text: t('disks:AddDisk.source.url.text'),
      title: t('disks:AddDisk.title.url'),
    },
    {
      kind: 'blank',
      icon: 'square-dashed',
      name: t('disks:AddDisk.source.blank'),
      text: t('disks:AddDisk.source.blank.text'),
      title: t('disks:AddDisk.title.blank'),
    },
    {
      kind: 'ramdisk',
      icon: 'bolt',
      name: t('disks:AddDisk.source.ramdisk'),
      text: t('disks:AddDisk.source.ramdisk.text'),
      title: t('disks:AddDisk.title.ramdisk'),
    },
  ];

  let dialog = $state<{ close: () => void }>();
  let source = $state<Source | undefined>();
  let url = $state('');
  let urlCheck = $state<UrlCheck | undefined>();
  let sizeMiB = $state(1024);
  let readOnly = $state(false);
  let picked = $state<Picked | undefined>();
  /** A copy into the browser's progress, in words. */
  let progress = $state('');
  /** The dialog's own runner: its errors show here (the page's bar is behind the dialog); the page's `act` says what runs. */
  const runner = new Actions();
  const chosen = $derived(SOURCES.find((s) => s.kind === source));

  // The disks the browser has that this machine doesn't attach: with their overlays, and the machines that do.
  type Known = { disk: DiskRecord; overlays: OverlayRecord[]; users: MachineRecord[] };
  let known = $state<Known[]>([]);
  async function readKnown() {
    const [disks, overlays, machines] = await Promise.all([
      store.all('disks'),
      store.all('overlays'),
      store.all('machines'),
    ]);
    const mine = new Set(machine.attachments.map((a) => a.disk));
    known = disks
      .filter((d) => !mine.has(d.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((disk) => ({
        disk,
        overlays: overlays.filter((o) => o.disk === disk.id),
        users: machines.filter((m) => m.attachments.some((a) => a.disk === disk.id)),
      }));
  }
  const sources = $derived(SOURCES.filter((s) => s.kind !== 'known' || known.length));

  onMount(() => void readKnown());

  /** Powers the machine off if it must (asking), then attaches what `make` gives; closes when it's attached. */
  async function attachWith(make: () => Promise<DiskRecord | undefined>, ro: boolean | undefined) {
    const m = $state.snapshot(machine) as MachineRecord;
    let ok = false;
    await act(t('disks:AddDisk.busy'), async () => {
      if (!(await offFirst(m))) return;
      ok = await runner.run('', async () => {
        const d = await make();
        if (!d) throw new Declined();
        await attach(store, m, d, { readOnly: ro });
      });
    });
    if (ok) dialog?.close();
  }
  /** The user said no (to a copy into the browser): nothing to show. */
  class Declined extends Error {
    override name = 'AbortError';
  }
  const attachKnown = (k: Known) => attachWith(() => Promise.resolve(k.disk), readOnly || undefined);
  function choose(kind: Source) {
    source = kind;
    runner.clear();
    readOnly = false;
  }
  function add(e: SubmitEvent) {
    e.preventDefault();
    const s = source;
    if (!s || s === 'known') return;
    const writable = s === 'blank' || s === 'ramdisk';
    void attachWith(
      () =>
        makeDisk(
          store,
          machine,
          { source: s, url, picked, sizeMiB },
          (c) => (urlCheck = c),
          (words) => (progress = words),
        ),
      writable ? false : readOnly,
    );
  }
</script>

<Modal
  id="add-disk"
  bind:this={dialog}
  title={chosen ? chosen.title : t('disks:AddDisk.title', { machine: machine.name })}
  onclose={close}
  onsubmit={add}
>
  {#if !source}
    <Note size="md">{t('disks:AddDisk.where')}</Note>
    {#each sources as s (s.kind)}
      <Choice label={s.name} icon={s.icon} data-source={s.kind} onclick={() => choose(s.kind)}>{s.text}</Choice>
    {/each}
  {:else}
    <Note size="md">{chosen?.text}</Note>
    {#if source === 'known'}
      <CardList>
        {#each known as k (k.disk.id)}
          <Card data-disk={k.disk.id}>
            <DiskInfo disk={k.disk} overlays={k.overlays} users={k.users.map((u) => u.name)} />
            {#snippet actions()}
              <Button type="button" variant="primary" onclick={() => attachKnown(k)} data-action="attach-known"
                >{t('disks:AddDisk.known.attach')}</Button
              >
            {/snippet}
          </Card>
        {/each}
      </CardList>
    {:else if source === 'url'}
      <AddDiskUrl bind:url bind:check={urlCheck} />
    {:else if source === 'file' || source === 'stored'}
      <AddDiskFile bind:picked bind:readOnly onfail={(e: unknown) => runner.fail(e)} />
    {:else}
      <Field label={t('disks:AddDisk.size')}
        ><span class="line"
          ><input type="number" min="1" bind:value={sizeMiB} data-field="size" /> {t('disks:AddDisk.size.unit')}</span
        ></Field
      >
    {/if}
    {#if source !== 'blank' && source !== 'ramdisk' && source !== 'known'}
      <Check bind:checked={readOnly} title={t('disks:AddDisk.readOnly.title')}>{t('disks:AddDisk.readOnly')}</Check>
    {/if}
  {/if}
  {#if progress}<Note size="md" data-progress>{progress}</Note>{/if}
  {#if runner.error}<Note tone="error" size="md" class="error" role="alert">{runner.error.text}</Note>{/if}
  {#snippet back()}
    {#if source}<Button
        type="button"
        onclick={() => {
          source = undefined;
          runner.clear();
        }}>{t('disks:AddDisk.back')}</Button
      >{/if}
  {/snippet}
  {#snippet buttons()}
    <Button type="button" onclick={() => dialog?.close()}>{t('disks:AddDisk.cancel')}</Button>
    {#if source && source !== 'known'}<Button type="submit" variant="primary" data-action="add-disk"
        >{t('disks:AddDisk.add')}</Button
      >{/if}
  {/snippet}
</Modal>

<style>
  .line {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .line input {
    flex: 0 1 140px;
  }
</style>
