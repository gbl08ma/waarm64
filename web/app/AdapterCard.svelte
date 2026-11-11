<!--
  One network adapter of a machine (its Network tab, NetworkTab.svelte): its MAC, its connection (the record's: saved
  first) and, on this page's running machine, the connection's state; attach, change or detach the connection,
  connect or disconnect it here, whether it connects at the start, its place among the adapters, remove it.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import Check from './ui/Check.svelte';
  import Icon from './ui/Icon.svelte';
  import Note from './ui/Note.svelte';
  import MoveButtons from './MoveButtons.svelte';
  import { kindText } from './connection-kind.ts';
  import type { Act } from './actions.svelte.ts';
  import type { Connection } from './connections.ts';
  import { said, t } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { movedAdapter, withoutAdapter } from './machines.ts';
  import type { PageNetwork } from './net-live.ts';
  import { adaptersOf, type Adapter } from './shape.ts';
  import { network } from './areas/network.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  type Props = {
    edit: Editing;
    net: PageNetwork;
    adapter: Adapter;
    /** Its place in the draft's adapters, and how many there are. */
    index: number;
    count: number;
    act: Act;
  };
  let { edit, net, adapter, index, count, act }: Props = $props();

  const MOVE = t('machines:AdapterCard.adapter.move');
  /** Its place in the record (-1: added since the last save). */
  const saved = $derived(edit.record ? adaptersOf(edit.record) : []);
  const at = $derived(saved.findIndex((x) => x.id === adapter.id));
  /** Its connection, as saved. */
  const c = $derived(at >= 0 ? net.connections.find((x) => x.id === saved[at]?.connection) : undefined);
  /** Its state on this page, when the machine is this page's. */
  const here = $derived(edit.draft.id === current.id && at >= 0 ? net.views()[at] : undefined);
  /** The connection's line: its name and kind, then its state here and whether it's the default way out. */
  const line = $derived.by(() => {
    const parts = [
      c
        ? t('machines:AdapterCard.adapter.connection', { name: c.name, kind: kindText(c) })
        : t('machines:AdapterCard.adapter.noConnection'),
    ];
    if (here?.active) parts.push(said(here.view.text).headline, ...(here.view.details ?? []));
    if (here?.primary) parts.push(t('machines:AdapterCard.adapter.primary'));
    return parts.join(' · ');
  });

  async function setAtStart(conn: Connection, on: boolean) {
    await net.conns.put({ ...conn, connectAtStart: on });
    await net.refresh();
  }
  const attach = () => network.openWizard({ mode: 'attach', machine: edit.draft.id, adapter: at, here: !!here?.on });
</script>

<Card data-adapter={index}>
  <div class="named">
    <Icon name="network" size={18} />
    <div class="lines">
      <strong>{t('machines:AdapterCard.adapter', { n: index + 1 })}</strong>
      <Note inline class="meta">{t('machines:AdapterCard.adapter.mac', { mac: adapter.mac })}</Note>
      <Note inline class="meta" data-connection-name>{line}</Note>
      {#if here?.note}<Note inline tone="warn" class="meta">{said(here.note).headline}</Note>{/if}
    </div>
  </div>
  {#snippet actions()}
    {#if at >= 0}
      {#if c}
        {@const conn = c}
        <Check
          compact
          checked={conn.connectAtStart}
          onchange={(on: boolean) => void act(t('machines:machine-edit.saving'), () => setAtStart(conn, on))}
          field="connect-at-start"
          title={t('machines:AdapterCard.adapter.atStart.title')}
        >
          {t('machines:AdapterCard.adapter.atStart')}
        </Check>
      {/if}
      <Button onclick={attach} data-action="attach-connection" title={t('machines:AdapterCard.adapter.attach.title')}>
        {c ? t('machines:AdapterCard.adapter.change') : t('machines:AdapterCard.adapter.attach')}
      </Button>
      {#if c}
        <Button
          onclick={() => act(t('machines:AdapterCard.busy.detaching'), () => page.netDetach(edit.draft.id, at))}
          data-action="detach-connection"
          title={t('machines:AdapterCard.adapter.detach.title')}
        >
          {t('machines:AdapterCard.adapter.detach')}
        </Button>
      {/if}
      {#if here && c && here.active}
        <Button
          onclick={() => act(t('machines:AdapterCard.busy.disconnecting'), () => page.netDisconnect(at))}
          data-action="disconnect"
        >
          {t('machines:AdapterCard.adapter.disconnect')}
        </Button>
      {:else if here && c && here.on}
        <Button
          onclick={() => act(t('machines:AdapterCard.busy.connecting'), () => page.netConnect(at))}
          data-action="connect"
        >
          {t('machines:AdapterCard.adapter.connect')}
        </Button>
      {/if}
    {:else}
      <Note inline class="meta">{t('machines:AdapterCard.adapter.saveFirst')}</Note>
    {/if}
    <MoveButtons
      {index}
      {count}
      onmove={(by: number) => edit.set(movedAdapter(edit.draft, adapter.id, by))}
      upTitle={MOVE}
      downTitle={MOVE}
      action="adapter"
    />
    <Button
      icon="trash"
      onclick={() => edit.set(withoutAdapter(edit.draft, adapter.id))}
      title={t('machines:AdapterCard.adapter.remove.title')}
      data-action="remove-adapter"
    >
      {t('machines:AdapterCard.adapter.remove')}
    </Button>
  {/snippet}
</Card>

<style>
  /* Its icon beside its name and lines. */
  .named {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .lines {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
</style>
