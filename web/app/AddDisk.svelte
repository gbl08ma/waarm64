<!--
  Add a disk (docs/plans/machines.md §4.2): a wizard over the Machines page. First the kind of source, each explained;
  then its details (the URL and the server's check, the file, the size) and whether the machine may write to it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { ask } from './ask.svelte.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { askPersist, attach, bytesText, createDisk, knownDisk, type NewDisk } from './machines.ts';
  import { estimateStored, importStored } from './disks.ts';
  import { checkUrl, URL_SLOW, type UrlCheck } from './urlcheck.ts';
  import type { IconName } from './icons.ts';

  type Props = {
    store: Store;
    machine: MachineRecord;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
    offFirst(m: MachineRecord): Promise<boolean>;
    close(): void;
  };
  let { store, machine, act, offFirst, close }: Props = $props();

  type Source = 'known' | 'url' | 'file' | 'stored' | 'blank' | 'ramdisk';
  const SOURCES: { kind: Source; icon: IconName; name: string; text: string }[] = [
    { kind: 'known', icon: 'database', name: 'A disk already in this browser', text: 'A disk another machine has, or one detached: with its overlays, as it was. A disk no machine has can be deleted here, with its overlays, to free the space it takes.' },
    { kind: 'file', icon: 'file', name: 'A file on this computer', text: 'A disk image (qcow2, raw, or an installer or live ISO) read where it is: nothing is copied. The machine\'s writes go into an overlay in this browser. In a later session the browser asks again before the page reads the file.' },
    { kind: 'stored', icon: 'database-import', name: 'A file, copied into the browser', text: 'The image is copied into this browser\'s storage: no picking again, and it can take an overlay\'s changes into itself or be written in place. It duplicates the file, in storage you can\'t easily see outside this page.' },
    { kind: 'url', icon: 'world-www', name: 'From a URL', text: 'An image on a web server, read in pieces as the guest needs them and kept in this browser (the server must allow this page\'s origin, and range requests unless it is a chunked image\'s manifest). Its first reads go over the network.' },
    { kind: 'blank', icon: 'square-dashed', name: 'Blank', text: 'An empty disk of the size you choose, for the guest to partition and format. It takes space in this browser only as the guest writes.' },
    { kind: 'ramdisk', icon: 'bolt', name: 'Ramdisk', text: 'An empty disk in this computer\'s memory, empty again at every boot (the guest\'s reboot too): fast scratch space. It takes memory as the guest fills it, and gives it back when the guest trims (fstrim).' },
  ];

  let dialog: HTMLDialogElement;
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
    const [disks, overlays, machines] = await Promise.all([store.all('disks'), store.all('overlays'), store.all('machines')]);
    const mine = new Set(machine.attachments.map((a) => a.disk));
    known = disks.filter((d) => !mine.has(d.id)).sort((a, b) => a.name.localeCompare(b.name))
      .map((disk) => ({ disk, overlays: overlays.filter((o) => o.disk === disk.id), users: machines.filter((m) => m.attachments.some((a) => a.disk === disk.id)) }));
  }
  const sources = $derived(SOURCES.filter((s) => s.kind !== 'known' || known.length));
  const KIND_TEXT: Record<string, string> = { url: 'from a URL', file: 'a file on this computer', stored: 'stored in the browser', blank: 'blank', ramdisk: 'ramdisk' };

  onMount(() => { dialog.showModal(); void readKnown(); });

  /** Attaches a disk the browser has. */
  async function attachKnown(k: Known) {
    const m = $state.snapshot(machine) as MachineRecord;
    let ok = false;
    await act('Adding the disk', async () => {
      if (!(await offFirst(m))) return;
      try {
        await attach(store, m, k.disk, { readOnly: readOnly || undefined });
        ok = true;
      } catch (e) {
        error = String((e as Error).message ?? e);
      }
    });
    if (ok) dialog.close();
  }
  /** Deletes a disk no machine has, with its overlays. */
  async function deleteKnown(k: Known) {
    const bytes = k.overlays.reduce((n, o) => n + o.bytes, 0);
    const what = k.disk.kind === 'stored' ? `the disk (${bytesText(k.disk.size)}, its copy in this browser)` : k.disk.kind === 'file' || k.disk.kind === 'url' ? `what this browser keeps of it (the file or URL itself isn't touched)` : 'the disk';
    if (!(await ask.confirm(`Delete ${k.disk.name}? This deletes ${what} and its ${k.overlays.length} overlay${k.overlays.length === 1 ? '' : 's'}${bytes ? ` (${bytesText(bytes)})` : ''}: what machines wrote to it is lost.`, { title: 'Delete a disk', ok: 'Delete', danger: true }))) return;
    try {
      await store.deleteDisk(k.disk.id);
    } catch (e) {
      error = String((e as Error).message ?? e);
    }
    await readKnown();
    if (!known.length) source = undefined;
  }

  function choose(kind: Source) {
    source = kind;
    error = '';
    readOnly = false;
  }
  async function pick() {
    const picker = (window as unknown as { showOpenFilePicker?: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
    if (!picker) return fileInput?.click();
    try {
      const [handle] = await picker.call(window);
      picked = { file: await handle.getFile(), handle };
      if (/\.iso$/i.test(picked.file.name)) readOnly = true;
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') error = String(e);
    }
  }
  const picked1 = () => { const f = fileInput?.files?.[0]; if (f) picked = { file: f }; if (f && /\.iso$/i.test(f.name)) readOnly = true; fileInput!.value = ''; };
  async function check() {
    checking = true;
    try { urlCheck = await checkUrl(url); } finally { checking = false; }
  }

  /** A disk image's virtual size from its first bytes (a qcow2's header), else its length. */
  const virtualSize = (head: Uint8Array | undefined, bytes: number) => (head && head.length >= 32 && new DataView(head.buffer, head.byteOffset).getUint32(0) === 0x514649fb ? Number(new DataView(head.buffer, head.byteOffset).getBigUint64(24)) : bytes);

  async function add(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    const m = $state.snapshot(machine) as MachineRecord;
    let ok = false;
    await act('Adding the disk', async () => {
      if (!(await offFirst(m))) return;
      let d: DiskRecord;
      try {
        // A file or URL the browser knows is the same disk again, with its overlays (its handle renewed, if picked with one).
        const reuse = async (n: NewDisk) => {
          const k = await knownDisk(store, n);
          if (k && machine.attachments.some((a) => a.disk === k.id)) throw new Error(`${k.name} is attached to this machine already.`);
          if (k && n.kind === 'file' && n.handle) await store.put('disks', { ...k, handle: n.handle });
          return k ?? createDisk(store, n);
        };
        if (source === 'url') {
          urlCheck = await checkUrl(url);
          if (!urlCheck.ok) throw new Error(`The URL can't be a disk:\n${urlCheck.problems.join('\n')}`);
          d = await reuse({ kind: 'url', url, size: virtualSize(urlCheck.head, urlCheck.bytes!), bytes: urlCheck.bytes!, etag: urlCheck.etag, lastModified: urlCheck.lastModified });
        } else if (source === 'file' || source === 'stored') {
          if (!picked) throw new Error('Pick a file first.');
          if (source === 'file') {
            const head = new Uint8Array(await picked.file.slice(0, 32).arrayBuffer());
            d = await reuse({ kind: 'file', file: picked.file, handle: picked.handle, size: virtualSize(head, picked.file.size) });
          } else {
            const est = await estimateStored(picked.file);
            const free = await navigator.storage.estimate();
            if (!(await ask.confirm(`Store a copy of ${picked.file.name} in this browser? It takes about ${bytesText(est.estimate)} of the browser's storage (${bytesText((free.quota ?? 0) - (free.usage ?? 0))} free), which you can't easily see outside this page, and duplicates the file you have.`, { title: 'Copy into the browser', ok: 'Copy it' }))) return;
            await askPersist();
            const name = picked.file.name;
            d = await importStored(store, picked.file, (f) => { error = `Storing ${name}: ${Math.floor(100 * f)}%`; });
            error = '';
          }
        } else {
          if (source !== 'blank' && source !== 'ramdisk') return;
          d = await createDisk(store, { kind: source, size: sizeMiB * 2 ** 20 });
        }
        await attach(store, m, d, { readOnly: source === 'blank' || source === 'ramdisk' ? false : readOnly });
        ok = true;
      } catch (e) {
        error = String((e as Error).message ?? e);
      }
    });
    if (ok) dialog.close();
  }
</script>

<dialog id="add-disk" bind:this={dialog} onclose={close} aria-labelledby="add-disk-title">
  <form onsubmit={add}>
    <h2 id="add-disk-title">{chosen ? `Add a disk: ${chosen.name.toLowerCase()}` : `Add a disk to ${machine.name}`}</h2>
    {#if !source}
      <p class="note">Where does the disk come from?</p>
      <div class="choices">
        {#each sources as s (s.kind)}
          <button type="button" class="choice" data-source={s.kind} onclick={() => choose(s.kind)}>
            <b><Icon name={s.icon} size={18} />{s.name}</b><span>{s.text}</span>
          </button>
        {/each}
      </div>
    {:else}
      <p class="note">{chosen?.text}</p>
      {#if source === 'known'}
        <ul class="known">
          {#each known as k (k.disk.id)}
            {@const bytes = k.overlays.reduce((n, o) => n + o.bytes, 0)}
            <li data-disk={k.disk.id}>
              <div class="what">
                <strong>{k.disk.name}</strong>
                <span class="meta">{KIND_TEXT[k.disk.kind]}, {bytesText(k.disk.size)} · {k.overlays.length} overlay{k.overlays.length === 1 ? '' : 's'}{bytes ? ` (${bytesText(bytes)})` : ''} · {k.users.length ? `on ${k.users.map((u) => u.name).join(', ')}` : 'on no machine'}</span>
              </div>
              <button type="button" class="primary" onclick={() => attachKnown(k)} data-action="attach-known">Attach</button>
              {#if !k.users.length}<button type="button" onclick={() => deleteKnown(k)} data-action="delete-known" title="Delete it and its overlays: frees the space they take in this browser"><Icon name="trash" size={16} />Delete</button>{/if}
            </li>
          {/each}
        </ul>
      {:else if source === 'url'}
        <label>URL<span class="line"><input type="url" placeholder="https://…/disk.qcow2" bind:value={url} data-field="url" required>
          <button type="button" onclick={check} disabled={!url || checking}>{checking ? 'Checking…' : 'Check'}</button></span></label>
        {#if urlCheck}
          {#if urlCheck.ok}<p class="ok">The server can serve it ({urlCheck.bytes ? bytesText(urlCheck.bytes) : 'size unknown'}). {URL_SLOW}</p>
          {:else}<ul class="problems">{#each urlCheck.problems as p}<li>{p}</li>{/each}</ul>{/if}
        {/if}
      {:else if source === 'file' || source === 'stored'}
        <div class="line"><button type="button" onclick={pick}><Icon name="file" size={16} />Pick a file…</button><span data-field="picked">{picked ? `${picked.file.name} (${bytesText(picked.file.size)})` : 'No file yet'}</span></div>
        <input type="file" hidden bind:this={fileInput} onchange={picked1} data-field="file">
      {:else}
        <label>Size<span class="line"><input type="number" min="1" bind:value={sizeMiB} data-field="size"> MiB</span></label>
      {/if}
      {#if source !== 'blank' && source !== 'ramdisk' && source !== 'known'}
        <label class="check" title="The guest can read it but not write it: no overlay. An installer ISO is read-only."><input type="checkbox" bind:checked={readOnly}> Read-only</label>
      {/if}
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="buttons">
      {#if source}<button type="button" onclick={() => { source = undefined; error = ''; }}>Back</button>{/if}
      <span class="grow"></span>
      <button type="button" onclick={() => dialog.close()}>Cancel</button>
      {#if source && source !== 'known'}<button type="submit" class="primary" data-action="add-disk">Add</button>{/if}
    </div>
  </form>
</dialog>

<style>
  dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; }
  form { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .choices { display: flex; flex-direction: column; gap: 8px; }
  .choice b { display: flex; align-items: center; gap: 8px; }
  .note { margin: 0; color: var(--dim); font-size: 13px; }
  label { display: flex; flex-direction: column; gap: 4px; color: var(--dim); font-size: 12px; }
  label.check { flex-direction: row; align-items: center; gap: 6px; color: var(--text); font-size: 14px; }
  .line { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 14px; }
  .line input { flex: 1; }
  .line input[type=number] { flex: 0 1 140px; }
  .ok { color: #8fd18f; margin: 0; }
  .problems { color: #ffb36b; margin: 0; }
  .error { color: #ff8f8f; white-space: pre-wrap; margin: 0; }
  .known { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow: auto; }
  .known li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
  .known .what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .known .meta { color: var(--dim); font-size: 12px; }
  .known button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .buttons { display: flex; gap: 8px; }
  .grow { flex: 1; }
  .buttons button, .line button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px; background: var(--bg); }
  .primary { background: #24406b !important; border-color: #3b6db3 !important; color: #fff; }
</style>
