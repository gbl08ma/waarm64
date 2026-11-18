<!--
  Export's steps (docs/machines.md §4): what goes in the file (the changes only, or the whole disk), then its format
  (qcow2 compressed or not; the whole disk also raw), each choice explained. The last choice saves. The steps' content
  only: a dialog hosts them (ExportWizard.svelte; Overlays.svelte, whose list is the step before), its title and Back
  from `title()` and `back()`. Without `changes` (a blank disk, a stored disk without an overlay) it starts at the format.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Choice from './ui/Choice.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import { msg, t, type Msg } from '../i18n.ts';
  import type { ExportMode } from './export.ts';

  type Props = {
    /** The disk's (or overlay's) name, for the first step's title. */
    name: string;
    /** Offers Changes only. */
    changes: boolean;
    /** Saves (called from the choice's click: the file picker needs its user activation). */
    save: (mode: ExportMode, compress: boolean) => void;
    /** What saving does to the machine, under the formats. */
    hint: Snippet;
  };
  let { name, changes, save, hint }: Props = $props();

  type Step = 'what' | 'changes' | 'whole';
  // The first step, from the props the steps open with.
  // svelte-ignore state_referenced_locally
  let step = $state<Step>(changes ? 'what' : 'whole');

  /** The dialog's title for this step. */
  export function title(): string | Msg {
    if (step === 'changes') return t('disks:ExportSteps.title.changes');
    if (step === 'whole') return t('disks:ExportSteps.title.whole');
    return msg('disks:ExportSteps.title', { name });
  }
  /** Whether Back has a step to go to here (else it's the host's: close, or its own step before). */
  export function canBack() {
    return step !== 'what' && changes;
  }
  /** Back one step; false at the first, where the host decides. */
  export function back() {
    if (!canBack()) return false;
    step = 'what';
    return true;
  }

  const focus = (el: HTMLElement) => {
    queueMicrotask(() => el.focus());
  };
  function pick(compress: boolean, raw = false) {
    save(step === 'changes' ? 'changes' : raw ? 'raw' : 'qcow2', compress && !raw);
  }
</script>

{#if step === 'what'}
  <Note size="md">{t('disks:ExportSteps.what')}</Note>
  <Choice
    label={t('disks:ExportSteps.changes')}
    icon="file-plus"
    data-export="changes"
    onclick={() => (step = 'changes')}
    {@attach focus}><T k="disks:ExportSteps.changes.text" /></Choice
  >
  <Choice label={t('disks:ExportSteps.whole')} icon="database" data-export="whole" onclick={() => (step = 'whole')}
    >{t('disks:ExportSteps.whole.text')}</Choice
  >
{:else}
  <Note size="md">{t('disks:ExportSteps.format')}</Note>
  <Choice label={t('disks:ExportSteps.compressed')} data-save="compressed" onclick={() => pick(true)} {@attach focus}
    >{t('disks:ExportSteps.compressed.text')}</Choice
  >
  <Choice label={t('disks:ExportSteps.qcow2')} data-save="qcow2" onclick={() => pick(false)}
    >{step === 'changes' ? t('disks:ExportSteps.qcow2.changes.text') : t('disks:ExportSteps.qcow2.text')}</Choice
  >
  {#if step === 'whole'}<Choice label={t('disks:ExportSteps.raw')} data-save="raw" onclick={() => pick(false, true)}
      >{t('disks:ExportSteps.raw.text')}</Choice
    >{/if}
  <Note>{@render hint()}</Note>
{/if}
