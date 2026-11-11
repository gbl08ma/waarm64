<!--
  A machine's Settings tab (docs/machines.md §7): its name and shape (vCPUs, RAM and its split, the JIT's budget, the
  display, Vulkan, USB, the input and clock devices, clipboard sharing) and its keyboard layout. A change of shape
  warns where it orphans the machine's snapshots; Save asks before it does (machine-edit.svelte.ts).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Fields from './ui/Fields.svelte';
  import Note from './ui/Note.svelte';
  import DeviceSwitches from './DeviceSwitches.svelte';
  import KeyboardField from './KeyboardField.svelte';
  import RamSplit from './RamSplit.svelte';
  import SaveRow from './SaveRow.svelte';
  import UsbSwitch from './UsbSwitch.svelte';
  import { t, text } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { JIT_CHOICES, JIT_DEFAULT_MIB, numaNote, RAM_CHOICES } from './machine.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();
  const d = $derived(edit.draft);

  const CPU_CHOICES = [1, 2, 3, 4, 6, 8];
  /** This browser offers WebGPU (a Vulkan machine's renderer draws on it; without it, Vulkan programs draw nothing). */
  const hasWebgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

  /** The sizes offered, the one set among them. */
  const ramChoices = $derived([...new Set([...RAM_CHOICES, d.ramMiB])].sort((a, b) => a - b));
  /** The JIT's budgets: the page's default (undefined), then the sizes, the one set among them. */
  const jitChoices = $derived([
    undefined,
    ...[...new Set([...JIT_CHOICES, ...(d.jitMiB ? [d.jitMiB] : [])])].sort((a, b) => a - b),
  ]);
  const jitLabel = (n: number | undefined) =>
    n ? t('machines:SettingsTab.mib', { n }) : t('machines:SettingsTab.jit.default', { n: JIT_DEFAULT_MIB });
  const numa = $derived(numaNote(d.ramMiB, d.ramSplit, !!d.vulkan));

  /** What turning Vulkan on or off says: it orphans the snapshots, or this browser can't draw what it renders. */
  function vulkanNoteOf(): { words: string; hook: string } | undefined {
    if (!edit.flipped('vulkan')) return undefined;
    if (edit.hasSnapshots) {
      if (!d.vulkan) return { words: t('machines:SettingsTab.vulkan.orphans.off'), hook: 'orphans' };
      if (hasWebgpu) return { words: t('machines:SettingsTab.vulkan.orphans.on'), hook: 'orphans' };
      return { words: t('machines:SettingsTab.vulkan.orphans.onNoWebgpu'), hook: 'orphans' };
    }
    if (d.vulkan && !hasWebgpu) return { words: t('machines:SettingsTab.vulkan.noWebgpu'), hook: 'no-webgpu' };
    return undefined;
  }
  const vulkanNote = $derived(vulkanNoteOf());
</script>

<Fields oninput={edit.touch} onchange={edit.touch}>
  <Field label={t('machines:SettingsTab.name')}><input bind:value={d.name} data-field="name" /></Field>
  <Field label={t('machines:SettingsTab.ncpus')}>
    <select bind:value={d.ncpus} data-field="ncpus">
      {#each CPU_CHOICES as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  </Field>
  <Field label={t('machines:SettingsTab.ram')}>
    <select
      bind:value={d.ramMiB}
      data-field="ram"
      disabled={!!d.ramSplit}
      title={d.ramSplit ? t('machines:SettingsTab.ram.title') : ''}
    >
      {#each ramChoices as n (n)}<option value={n}>{t('machines:SettingsTab.mib', { n })}</option>{/each}
    </select>
  </Field>
  {#if numa}<Note tone="warn" data-numa>{text(numa)}</Note>{/if}
  <RamSplit {edit} />
  <Field label={t('machines:SettingsTab.jit')}>
    <select bind:value={d.jitMiB} data-field="jit" title={t('machines:SettingsTab.jit.title')}>
      {#each jitChoices as n (n)}<option value={n}>{jitLabel(n)}</option>{/each}
    </select>
  </Field>
  <Field label={t('machines:SettingsTab.display')}>
    <select bind:value={d.display} data-field="display">
      <option value="3d">{t('machines:SettingsTab.display.3d')}</option>
      <option value="2d">{t('machines:SettingsTab.display.2d')}</option>
    </select>
  </Field>
  {#if d.display === '3d'}
    <Check bind:checked={d.vulkan} field="vulkan" title={t('machines:SettingsTab.vulkan.title')}>
      {t('machines:SettingsTab.vulkan')}
    </Check>
    {#if vulkanNote?.hook === 'orphans'}
      <Note tone="warn" data-vulkan-orphans>{vulkanNote.words}</Note>
    {:else if vulkanNote}
      <Note tone="warn" data-vulkan-no-webgpu>{vulkanNote.words}</Note>
    {/if}
  {/if}
  <KeyboardField {edit} />
  <UsbSwitch {edit} />
  <DeviceSwitches {edit} />
  <SaveRow {edit} />
  <Note>{t('machines:SettingsTab.shape.note')}</Note>
</Fields>
