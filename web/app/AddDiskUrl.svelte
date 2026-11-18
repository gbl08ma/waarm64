<!--
  Add a disk's URL (AddDisk.svelte): the image's address, and the server's check (its size, or what's wrong: CORS,
  ranges), run with Check or at Add.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import { t, text } from '../i18n.ts';
  import { bytesText } from './machines.ts';
  import { checkUrl, URL_SLOW, type UrlCheck } from './urlcheck.ts';
  import T from './T.svelte';

  type Props = { url: string; check: UrlCheck | undefined };
  let { url = $bindable(), check = $bindable() }: Props = $props();

  let checking = $state(false);
  async function run() {
    checking = true;
    try {
      check = await checkUrl(url);
    } finally {
      checking = false;
    }
  }
</script>

<Field label={t('disks:AddDiskUrl.url')}>
  <span class="line">
    <input
      type="url"
      // i18n-ignore-next: an example URL
      placeholder="https://…/disk.qcow2"
      bind:value={url}
      data-field="url"
      required
    />
    <Button type="button" onclick={run} disabled={!url || checking}>
      {checking ? t('disks:AddDiskUrl.url.checking') : t('disks:AddDiskUrl.url.check')}
    </Button>
  </span>
</Field>
{#if check?.ok}
  <Note tone="ok" size="md" class="ok">
    {check.bytes ? t('disks:AddDiskUrl.url.ok', { size: bytesText(check.bytes) }) : t('disks:AddDiskUrl.url.okUnknown')}
    <T m={URL_SLOW} />
  </Note>
{:else if check}
  <ul class="problems">
    {#each check.problems as p, i (i)}<li>{text(p)}</li>{/each}
  </ul>
{/if}

<style>
  .line {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  input {
    flex: 1;
  }
  .problems {
    margin: 0;
    color: var(--warn-fg);
  }
</style>
