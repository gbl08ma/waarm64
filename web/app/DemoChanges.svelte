<!--
  Whether the visitor's machine from a demo has changes since the demo started (web/app/demo-open.ts `changesOf`: none,
  its disk, suspended), a line under "started before" in the demo's pane (DemoStart.svelte; docs/frontend.md "The demo
  store"). Nothing until it's read.
-->
<script lang="ts">
  import Note from './ui/Note.svelte';
  import { changesOf } from './demo-open.ts';
  import type { MachineRecord } from './shape.ts';
  import type { Store } from './store.ts';
  import { t } from '../i18n.ts';

  let { store, machine }: { store: Store; machine: MachineRecord } = $props();

  const words = {
    none: 'machines:DemoChanges.none',
    disk: 'machines:DemoChanges.disk',
    suspended: 'machines:DemoChanges.suspended',
  } as const;
  let changes = $state<keyof typeof words>();
  $effect(() => {
    const m = machine;
    void changesOf(store, m).then((c) => {
      if (m === machine) changes = c;
    });
  });
</script>

{#if changes}
  <Note size="md" data-field="changes" data-changes={changes}>{t(words[changes])}</Note>
{/if}
