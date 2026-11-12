<!--
  A machine's Network tab (docs/networking/adapters.md §3.2): its adapters (AdapterCard.svelte), add one, and whether the
  page sets the guest's network up at every boot. Adding, moving and removing adapters change the shape: saved with
  Save (machine-edit.svelte.ts).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import CardList from './ui/CardList.svelte';
  import Check from './ui/Check.svelte';
  import Note from './ui/Note.svelte';
  import AdapterCard from './AdapterCard.svelte';
  import SaveRow from './SaveRow.svelte';
  import type { Act } from './actions.svelte.ts';
  import { t } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { withAdapter } from './machines.ts';
  import type { PageNetwork } from './net-live.ts';
  import { adaptersOf, MAX_ADAPTERS } from './shape.ts';

  type Props = { edit: Editing; net: PageNetwork; act: Act };
  let { edit, net, act }: Props = $props();

  const adapters = $derived(adaptersOf(edit.draft));
  const netConfig = $derived(edit.draft.netConfig !== false);
  function setNetConfig(on: boolean) {
    edit.draft.netConfig = on ? undefined : false;
    edit.touch();
  }
</script>

<div class="network">
  <CardList class="adapters" empty={adapters.length ? undefined : t('machines:NetworkTab.adapters.none')}>
    {#each adapters as a, i (a.id)}
      <AdapterCard {edit} {net} adapter={a} index={i} count={adapters.length} {act} />
    {/each}
  </CardList>
  {#if adapters.length < MAX_ADAPTERS}
    <div class="row">
      <Button icon="plus" onclick={() => edit.set(withAdapter(edit.draft))} data-action="add-adapter">
        {t('machines:NetworkTab.adapters.add')}
      </Button>
    </div>
  {/if}
  <Note>{t('machines:NetworkTab.adapters.note', { max: MAX_ADAPTERS })}</Note>
  <Check
    checked={netConfig}
    onchange={setNetConfig}
    field="net-config"
    title={t('machines:NetworkTab.netConfig.title')}
  >
    {t('machines:NetworkTab.netConfig')}
    {#snippet note()}
      <span data-net-config-note>
        {netConfig ? t('machines:NetworkTab.netConfig.on') : t('machines:NetworkTab.netConfig.off')}
      </span>
    {/snippet}
  </Check>
  <SaveRow {edit} />
</div>

<style>
  .network {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }
</style>
