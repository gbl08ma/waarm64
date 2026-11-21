<!--
  A machine's Settings tab (docs/machines.md §7): its name and shape (vCPUs, RAM and its split, the JIT's budget, the
  display, Vulkan, USB, the input and clock devices, clipboard sharing) and its keyboard layout. A change of shape
  warns where it orphans the machine's snapshots; Save asks before it does (machine-edit.svelte.ts). While the machine
  runs on this page, a "visualize" link beside RAM's label opens its RAM's map (RamWindow.svelte), as the status bar's
  RAM does. The box beside the RAM slider sets the split by hand, its fields (RamSplit.svelte) the rows under it.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Fields from './ui/Fields.svelte';
  import Note from './ui/Note.svelte';
  import Slider from './ui/Slider.svelte';
  import DeviceSwitches from './DeviceSwitches.svelte';
  import KeyboardField from './KeyboardField.svelte';
  import RamSplit from './RamSplit.svelte';
  import SaveRow from './SaveRow.svelte';
  import UsbSwitch from './UsbSwitch.svelte';
  import { t, text } from '../i18n.ts';
  import { current } from './areas/current.svelte.ts';
  import { ramHost, ramWindow } from './areas/ram.svelte.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { CPU_SLIDER, JIT_DEFAULT_MIB, JIT_SLIDER, numaNote, RAM_SLIDER, ramSplitMiB } from './machine.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();
  const d = $derived(edit.draft);

  /** This browser offers WebGPU (a Vulkan machine's renderer draws on it; without it, Vulkan programs draw nothing). */
  const hasWebgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

  const cpuLabel = (n: number) => String(n);
  const mibLabel = (n: number) => t('machines:SettingsTab.mib', { n });
  /** The page's default budget reads as such; a machine left at it keeps none of its own (it follows the default). */
  const jitLabel = (n: number) =>
    n === JIT_DEFAULT_MIB ? t('machines:SettingsTab.jit.default', { n }) : t('machines:SettingsTab.mib', { n });
  const jitGet = () => d.jitMiB ?? JIT_DEFAULT_MIB;
  const jitSet = (n: number) => (d.jitMiB = n === JIT_DEFAULT_MIB ? undefined : n);
  /** The machine runs on this page: its RAM's map can open from here (RamWindow.svelte), as from the status bar. */
  const ramLive = $derived(d.id === current.id && !!ramHost());
  const numa = $derived(numaNote(d.ramMiB, d.ramSplit, !!d.vulkan));
  /** The RAM slider's id, for its label (which holds only its words beside the "visualize" link). */
  const ramId = $props.id();

  /** A split set by hand starts from the automatic one; turned off, it's the automatic one again. */
  function custom(on: boolean) {
    d.ramSplit = on ? ramSplitMiB(d.ramMiB, undefined, !!d.vulkan) : undefined;
    edit.splitProblem = undefined;
    edit.touch();
  }

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

{#snippet visualize()}
  <Button
    variant="link"
    data-action="ram-open"
    title={t('machines:SettingsTab.ram.visualize.title')}
    onclick={() => ramWindow.show()}>{t('machines:SettingsTab.ram.visualize')}</Button
  >
{/snippet}
{#snippet customSplit()}
  <Check checked={!!d.ramSplit} onchange={custom} field="custom-split">{t('machines:SettingsTab.ram.custom')}</Check>
{/snippet}

<Fields oninput={edit.touch} onchange={edit.touch}>
  <Field label={t('machines:SettingsTab.name')}><input bind:value={d.name} data-field="name" /></Field>
  <Field label={t('machines:SettingsTab.ncpus')}>
    <Slider bind:value={d.ncpus} field="ncpus" --slider-value-w="15ch" {...CPU_SLIDER} label={cpuLabel} />
  </Field>
  <Field
    label={t('machines:SettingsTab.ram')}
    for={ramId}
    labelAfter={ramLive ? visualize : undefined}
    after={customSplit}
  >
    <Slider
      bind:value={d.ramMiB}
      id={ramId}
      field="ram"
      --slider-value-w="15ch"
      {...RAM_SLIDER}
      label={mibLabel}
      disabled={!!d.ramSplit}
      title={d.ramSplit ? t('machines:SettingsTab.ram.title') : ''}
    />
  </Field>
  <RamSplit {edit} />
  {#if numa}<Note tone="warn" data-numa>{text(numa)}</Note>{/if}
  <Field label={t('machines:SettingsTab.jit')}>
    <Slider
      bind:value={jitGet, jitSet}
      field="jit"
      --slider-value-w="15ch"
      {...JIT_SLIDER}
      label={jitLabel}
      title={t('machines:SettingsTab.jit.title')}
    />
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
