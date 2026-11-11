<!--
  Add a disk's file (AddDisk.svelte): the image picked, with the browser's file picker where it has one (the machine
  keeps the file's handle), else the plain input. An ISO is read-only.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import type { Picked } from './add-disk.ts';
  import { t } from '../i18n.ts';
  import { bytesText } from './machines.ts';

  type Props = { picked: Picked | undefined; readOnly: boolean; onfail: (e: unknown) => void };
  let { picked = $bindable(), readOnly = $bindable(), onfail }: Props = $props();

  let fileInput = $state<HTMLInputElement>();
  function take(p: Picked) {
    picked = p;
    if (/\.iso$/i.test(p.file.name)) readOnly = true;
  }
  async function pick() {
    const picker = (window as unknown as { showOpenFilePicker?: () => Promise<FileSystemFileHandle[]> })
      .showOpenFilePicker;
    if (!picker) return fileInput?.click();
    try {
      const [handle] = await picker.call(window);
      take({ file: await handle.getFile(), handle });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) onfail(e); // the picker's Cancel isn't an error
    }
  }
  function chosen(e: Event & { currentTarget: HTMLInputElement }) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (f) take({ file: f });
  }
</script>

<div class="line">
  <Button type="button" icon="file" onclick={pick}>{t('disks:AddDiskFile.pick')}</Button>
  <span data-field="picked">
    {picked
      ? t('disks:AddDiskFile.picked', { name: picked.file.name, size: bytesText(picked.file.size) })
      : t('disks:AddDiskFile.picked.none')}
  </span>
</div>
<input type="file" hidden bind:this={fileInput} onchange={chosen} data-field="file" />

<style>
  .line {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
</style>
