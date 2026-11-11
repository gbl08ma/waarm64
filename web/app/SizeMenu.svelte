<!--
  The toolbar's machine size menu, for a transient machine (a stored machine's is in its Settings): vCPUs, RAM (a
  note past memory 0: its NUMA nodes) and the display, applied with a restart. It shows what runs until a choice is made.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Menu from './ui/Menu.svelte';
  import Note from './ui/Note.svelte';
  import { t, text } from '../i18n.ts';
  import { numaNote } from './machine.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  let open = $state(false);
  // What runs, until a choice is made (and again when what runs changes).
  let ncpus = $derived(current.size.ncpus);
  let ramMiB = $derived(current.size.ramMiB);
  let gpu = $derived(current.size.gpu);
  /** The note for a size past memory 0 (its NUMA nodes); the running split (`?split=`) while the size is unchanged. */
  const numa = $derived(
    numaNote(ramMiB, ramMiB === current.size.ramMiB ? current.size.split : undefined, current.size.vulkan),
  );
  const ramText = (n: number) => (n >= 1024 && n % 512 === 0 ? `${n / 1024} GiB` : `${n} MiB`); // i18n-ignore: a size and its unit
  function apply() {
    open = false;
    page.applySize(ncpus, ramMiB, gpu);
  }
</script>

<Menu id="machine-menu" icon="cpu" title={t('toolbar:SizeMenu.size.title')} bind:open panel>
  <Field label={t('toolbar:SizeMenu.size.cpus')}>
    <select id="machine-cpus" bind:value={ncpus}>
      {#each current.size.cpuChoices as n (n)}<option value={n}>{t('toolbar:SizeMenu.size.cpu', { count: n })}</option
        >{/each}
    </select>
  </Field>
  <Field label={t('toolbar:SizeMenu.size.ram')}>
    <select id="machine-ram" bind:value={ramMiB}>
      {#each current.size.ramChoices as n (n)}<option value={n}>{ramText(n)}</option>{/each}
    </select>
  </Field>
  {#if numa}<Note tone="warn" id="machine-numa">{text(numa)}</Note>{/if}
  {#if current.hasGpu}
    <Field id="machine-gpu-label" title={t('toolbar:SizeMenu.size.gpu.title')} label={t('toolbar:SizeMenu.size.gpu')}>
      <select id="machine-gpu" bind:value={gpu} disabled={!!current.size.gpuLock} title={current.size.gpuLock}>
        <option value="3d">{t('toolbar:SizeMenu.size.gpu.3d')}</option>
        <option value="2d">{t('toolbar:SizeMenu.size.gpu.2d')}</option>
      </select>
    </Field>
  {/if}
  <Button id="machine-apply" onclick={apply}>{t('toolbar:SizeMenu.size.apply')}</Button>
  <Note>{t('toolbar:SizeMenu.size.hint')}</Note>
</Menu>
