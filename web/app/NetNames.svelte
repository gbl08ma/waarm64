<!--
  A room adapter's names in its section of the Network menu (NetAdapter.svelte; docs/networking/names.md "What the user
  sees"): each name its connection holds in the room with its state (Preparing, Reserved, public in about N hours,
  Active, kept until about a date, …: web/app/names-view.ts), and Name this machine…, which opens its dialog
  (NameDialog.svelte) and closes the menu. Changing where a name points, a label under it and letting it go are in the
  adapter's details.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import { t, text } from '../i18n.ts';
  import type { AdapterView } from './network-view.ts';
  import { pageNames } from './areas/names.svelte.ts';
  import { titleState } from './names-view.ts';

  type Props = { a: AdapterView; onname: () => void };
  let { a, onname }: Props = $props();
  const s = $derived(a.index ? `-${a.index}` : '');
  const room = $derived(a.connection?.room);
  const titles = $derived(room ? pageNames.of({ identityKey: room.identityKey, link: room.link }) : []);
  // Its names publish through the link the connection has now.
  $effect(() => {
    if (room && titles.some((v) => v.link !== room.link))
      void pageNames.relink({ identityKey: room.identityKey, link: room.link });
  });
</script>

{#if room}
  <div class="names" id={`net-names${s}`}>
    {#each titles as v (v.name)}
      <p class="name" data-name={v.name} data-state={v.state}>
        <strong>{v.name}</strong>
        <Note inline>{text(titleState(v))}</Note>
      </p>
    {/each}
    {#if a.view.room?.key}
      <div>
        <Button id={`net-name-open${s}`} onclick={onname}>{t('network:NetNames.name')}</Button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .names {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .name {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    margin: 0;
  }
</style>
