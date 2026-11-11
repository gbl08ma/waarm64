<!--
  Add a disk (docs/machines.md §4.2): a wizard over the Machines page. First the kind of source, each explained;
  then its details (the URL and the server's check, the file, the size) and whether the machine may write to it.
-->
<script lang="ts">
  import type { Act } from './actions.svelte.ts';
  import Check from './ui/Check.svelte';
  import { onMount } from 'svelte';
  import DiskInfo from './DiskInfo.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Choice from './ui/Choice.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Modal from './ui/Modal.svelte';
  import { ask } from './ask.svelte.ts';
  import { errorText, MsgError, t, text } from '../i18n.ts';
  import { causes } from '../msg.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { askPersist, attach, bytesText, createDisk, knownDisk, type NewDisk } from './machines.ts';
  import { estimateStored, importStored } from './disks.ts';
  import { checkUrl, URL_SLOW, type UrlCheck } from './urlcheck.ts';
  import type { IconName } from './icons.ts';

  type Props = {
    store: Store;
    machine: MachineRecord;
    act: Act;
    offFirst(m: MachineRecord): Promise<boolean>;
    close(): void;
  };
  let { store, machine, act, offFirst, close }: Props = $props();

  type Source = 'known' | 'url' | 'file' | 'stored' | 'blank' | 'ramdisk';
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

  let dialog: Modal;
  let source = $state<Source | undefined>();
  let error = $state('');
  let url = $state('');
  let urlCheck = $state<UrlCheck | undefined>();
  let checking = $state(false);
  let sizeMiB = $state(1024);
  let readOnly = $state(false);
  let picked = $state<{ file: File; handle?: FileSystemFileHandle } | undefined>();
  let fileInput = $state<HTMLInputElement>();
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

  /** Attaches a disk the browser has. */
  async function attachKnown(k: Known) {
    const m = $state.snapshot(machine) as MachineRecord;
    let ok = false;
    await act(t('disks:AddDisk.busy'), async () => {
      if (!(await offFirst(m))) return;
      try {
        await attach(store, m, k.disk, { readOnly: readOnly || undefined });
        ok = true;
      } catch (e) {
        error = errorText(e);
      }
    });
    if (ok) dialog.close();
  }
  function choose(kind: Source) {
    source = kind;
    error = '';
    readOnly = false;
  }
  async function pick() {
    const picker = (window as unknown as { showOpenFilePicker?: () => Promise<FileSystemFileHandle[]> })
      .showOpenFilePicker;
    if (!picker) return fileInput?.click();
    try {
      const [handle] = await picker.call(window);
      picked = { file: await handle.getFile(), handle };
      if (/\.iso$/i.test(picked.file.name)) readOnly = true;
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') error = errorText(e);
    }
  }
  const picked1 = () => {
    const f = fileInput?.files?.[0];
    if (f) picked = { file: f };
    if (f && /\.iso$/i.test(f.name)) readOnly = true;
    fileInput!.value = '';
  };
  async function check() {
    checking = true;
    try {
      urlCheck = await checkUrl(url);
    } finally {
      checking = false;
    }
  }

  /** A disk image's virtual size from its first bytes (a qcow2's header), else its length. */
  const virtualSize = (head: Uint8Array | undefined, bytes: number) =>
    head && head.length >= 32 && new DataView(head.buffer, head.byteOffset).getUint32(0) === 0x514649fb
      ? Number(new DataView(head.buffer, head.byteOffset).getBigUint64(24))
      : bytes;

  async function add(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    const m = $state.snapshot(machine) as MachineRecord;
    let ok = false;
    await act(t('disks:AddDisk.busy'), async () => {
      if (!(await offFirst(m))) return;
      let d: DiskRecord;
      try {
        // A file or URL the browser knows is the same disk again, with its overlays (its handle renewed, if picked with one).
        const reuse = async (n: NewDisk) => {
          const k = await knownDisk(store, n);
          if (k && machine.attachments.some((a) => a.disk === k.id))
            throw new MsgError('disks:AddDisk.attachedAlready', { name: k.name });
          if (k && n.kind === 'file' && n.handle) await store.put('disks', { ...k, handle: n.handle });
          return k ?? createDisk(store, n);
        };
        if (source === 'url') {
          urlCheck = await checkUrl(url);
          if (!urlCheck.ok)
            throw new MsgError('disks:AddDisk.urlProblems', undefined, { cause: causes(urlCheck.problems) });
          d = await reuse({
            kind: 'url',
            url,
            name: urlCheck.name,
            size: virtualSize(urlCheck.head, urlCheck.bytes!),
            bytes: urlCheck.bytes!,
            etag: urlCheck.etag,
            lastModified: urlCheck.lastModified,
          });
        } else if (source === 'file' || source === 'stored') {
          if (!picked) throw new MsgError('disks:AddDisk.pickFirst');
          if (source === 'file') {
            const head = new Uint8Array(await picked.file.slice(0, 32).arrayBuffer());
            d = await reuse({
              kind: 'file',
              file: picked.file,
              handle: picked.handle,
              size: virtualSize(head, picked.file.size),
            });
          } else {
            const est = await estimateStored(picked.file);
            const free = await navigator.storage.estimate();
            if (
              !(await ask.confirm(
                t('disks:AddDisk.store.confirm', {
                  name: picked.file.name,
                  size: bytesText(est.estimate),
                  free: bytesText((free.quota ?? 0) - (free.usage ?? 0)),
                }),
                { title: t('disks:AddDisk.store.title'), ok: t('disks:AddDisk.store.ok') },
              ))
            )
              return;
            await askPersist();
            const name = picked.file.name;
            d = await importStored(store, picked.file, (f) => {
              error = t('disks:AddDisk.storing', { name, percent: Math.floor(100 * f) });
            });
            error = '';
          }
        } else {
          if (source !== 'blank' && source !== 'ramdisk') return;
          d = await createDisk(store, { kind: source, size: sizeMiB * 2 ** 20 });
        }
        await attach(store, m, d, { readOnly: source === 'blank' || source === 'ramdisk' ? false : readOnly });
        ok = true;
      } catch (e) {
        error = errorText(e);
      }
    });
    if (ok) dialog.close();
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
      <Field label={t('disks:AddDisk.url')}
        ><span class="line"
          ><input
            type="url"
            // i18n-ignore-next: an example URL
            placeholder="https://…/disk.qcow2"
            bind:value={url}
            data-field="url"
            required
          />
          <Button type="button" onclick={check} disabled={!url || checking}
            >{checking ? t('disks:AddDisk.url.checking') : t('disks:AddDisk.url.check')}</Button
          ></span
        ></Field
      >
      {#if urlCheck}
        {#if urlCheck.ok}<Note tone="ok" size="md" class="ok">
            {urlCheck.bytes
              ? t('disks:AddDisk.url.ok', { size: bytesText(urlCheck.bytes) })
              : t('disks:AddDisk.url.okUnknown')}
            {text(URL_SLOW)}
          </Note>
        {:else}<ul class="problems">
            {#each urlCheck.problems as p, i (i)}<li>{text(p)}</li>{/each}
          </ul>{/if}
      {/if}
    {:else if source === 'file' || source === 'stored'}
      <div class="line">
        <Button type="button" icon="file" onclick={pick}>{t('disks:AddDisk.pick')}</Button><span data-field="picked"
          >{picked
            ? t('disks:AddDisk.picked', { name: picked.file.name, size: bytesText(picked.file.size) })
            : t('disks:AddDisk.picked.none')}</span
        >
      </div>
      <input type="file" hidden bind:this={fileInput} onchange={picked1} data-field="file" />
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
  {#if error}<Note tone="error" size="md" class="error" role="alert">{error}</Note>{/if}
  {#snippet back()}
    {#if source}<Button
        type="button"
        onclick={() => {
          source = undefined;
          error = '';
        }}>{t('disks:AddDisk.back')}</Button
      >{/if}
  {/snippet}
  {#snippet buttons()}
    <Button type="button" onclick={() => dialog.close()}>{t('disks:AddDisk.cancel')}</Button>
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
    flex: 1;
  }
  .line input[type='number'] {
    flex: 0 1 140px;
  }
  .problems {
    margin: 0;
    color: var(--warn-fg);
  }
</style>
