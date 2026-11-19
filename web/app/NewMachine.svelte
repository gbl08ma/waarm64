<!--
  New machine (docs/frontend.md "The Home page", docs/machines.md §6.3): a dialog over the Home page that offers what a
  machine starts from. An empty machine (the default settings, no disks: what New machine always made), and the
  templates our demo store offers (`demo.template`: web/app/demo-store.ts `templatesOf`), each its machine and disks
  only (`machineFromStoreTemplate`: a cold boot from its disks, no snapshot, no demo network). The store is read when
  the dialog opens; while it loads, or when it can't be read (said, with Try again), the empty machine still works.
  A template's name and summary are the store's data, drawn as plain text.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './ui/Button.svelte';
  import Choice from './ui/Choice.svelte';
  import ErrorText from './ErrorText.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import { Actions, type Act } from './actions.svelte.ts';
  import { fetchStore, OUR_STORE, templatesOf, type StoreDemo } from './demo-store.ts';
  import { createMachine } from './machines.ts';
  import { machineFromStoreTemplate } from './template.ts';
  import { t } from '../i18n.ts';
  import type { Store } from './store.ts';

  type Props = {
    store: Store;
    /** The page's runner (what runs, in its words); the dialog's errors show in it. */
    act: Act;
    /** The machine made (its id), to choose; `toPick`: its disks that are files to pick at its first start. */
    onmade: (id: string, toPick?: { name: string; files: string[] }) => void;
    close: () => void;
  };
  let { store, act, onmade, close }: Props = $props();

  let dialog = $state<{ close: () => void }>();
  /** The store's reading: its loading and its failure. */
  const reading = new Actions();
  /** Making the machine: its failure shows in the dialog (the page's bar is behind it). */
  const runner = new Actions();
  let templates = $state.raw<StoreDemo[]>();

  function load() {
    templates = undefined;
    void reading.run(t('machines:NewMachine.loading'), async () => {
      templates = templatesOf(await fetchStore(OUR_STORE));
    });
  }
  onMount(load);

  /** Makes the machine `make` gives, then closes and chooses it. */
  type Made = { id: string; toPick?: { name: string; files: string[] } };
  async function make(f: () => Promise<Made>) {
    let made: Made | undefined;
    await act(t('machines:NewMachine.busy'), async () => {
      await runner.run('', async () => {
        made = await f();
      });
    });
    if (!made) return;
    dialog?.close();
    onmade(made.id, made.toPick);
  }
  const empty = () => make(async () => ({ id: (await createMachine(store)).id }));
  const fromTemplate = (d: StoreDemo) =>
    make(async () => {
      const r = await machineFromStoreTemplate(store, d);
      return { id: r.machine.id, ...(r.toPick.length ? { toPick: { name: r.machine.name, files: r.toPick } } : {}) };
    });
</script>

<Modal id="new-machine" bind:this={dialog} title={t('machines:NewMachine.title')} onclose={close}>
  <Choice
    label={t('machines:NewMachine.empty')}
    icon="square-dashed"
    disabled={runner.busy !== undefined}
    onclick={empty}
    data-template="empty">{t('machines:NewMachine.empty.text')}</Choice
  >
  <h3>{t('machines:NewMachine.templates')}</h3>
  <Note size="md">{t('machines:NewMachine.templates.text')}</Note>
  {#if reading.busy}<Note size="md" role="status">{reading.busy}</Note>{/if}
  {#if reading.error}
    <div class="error" role="alert" data-field="templates-error">
      <Note tone="error" size="md"><ErrorText error={reading.error} /></Note>
      <Button type="button" onclick={load} data-action="retry-templates">{t('machines:NewMachine.retry')}</Button>
    </div>
  {:else if templates?.length === 0}
    <Note size="md" data-field="no-templates">{t('machines:NewMachine.none')}</Note>
  {/if}
  {#each templates ?? [] as d (d.def.demo.id)}
    <Choice
      label={d.def.machine.name}
      icon={d.def.demo.view === 'screen' ? 'device-desktop' : 'terminal-2'}
      disabled={runner.busy !== undefined}
      onclick={() => fromTemplate(d)}
      data-template={d.def.demo.id}>{d.def.demo.summary}</Choice
    >
  {/each}
  {#if runner.error}<Note tone="error" size="md" role="alert" data-field="new-error"
      ><ErrorText error={runner.error} /></Note
    >{/if}
  {#snippet buttons()}
    <Button type="button" onclick={() => dialog?.close()}>{t('machines:NewMachine.cancel')}</Button>
  {/snippet}
</Modal>

<style>
  h3 {
    margin: var(--space-2) 0 0;
    font-size: var(--text-base);
  }
  .error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }
</style>
