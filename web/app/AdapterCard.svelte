<!--
  One network adapter of a machine (its Network tab, NetworkTab.svelte): its MAC (edited where it is, or a new random
  one: in the draft, saved with Save), its connection (the record's: saved
  first) and, on this page's running machine, the connection's state; attach, change or detach the connection,
  connect or disconnect it here, whether it connects at the start, its place among the adapters, remove it. A room
  connection's line ends with its link to its Domains (DomainsLink.svelte; Back leads to this tab).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import Check from './ui/Check.svelte';
  import Icon from './ui/Icon.svelte';
  import Note from './ui/Note.svelte';
  import MoveButtons from './MoveButtons.svelte';
  import T from './T.svelte';
  import { kindText } from './connection-kind.ts';
  import type { Act } from './actions.svelte.ts';
  import type { Connection } from './connections.ts';
  import { msg, said, t } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import { macFor, movedAdapter, withMac, withNewMac, withoutAdapter } from './machines.ts';
  import type { PageNetwork } from './net-live.ts';
  import { adaptersOf, DEFAULT_MAC, type Adapter } from './shape.ts';
  import { defaultsOf } from './network-view.ts';
  import { network } from './areas/network.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';
  import { hasDomainsLink } from './names-view.ts';
  import DomainsLink from './DomainsLink.svelte';

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
  const head = $derived(
    c
      ? msg('machines:AdapterCard.adapter.connection', { name: c.name, kind: kindText(c) })
      : msg('machines:AdapterCard.adapter.noConnection'),
  );
  /** What follows the name and kind on that line, after a " · " each. */
  const rest = $derived.by(() => {
    const parts: string[] = [];
    if (here?.active) parts.push(said(here.view.text).headline, ...(here.view.details ?? []));
    const defaults = here && defaultsOf(here);
    if (defaults === 'both') parts.push(t('machines:AdapterCard.adapter.primary'));
    else if (defaults === 'v4') parts.push(t('machines:AdapterCard.adapter.primary4'));
    else if (defaults === 'v6') parts.push(t('machines:AdapterCard.adapter.primary6'));
    return parts.map((p) => ` · ${p}`).join('');
  });

  /** Why the MAC last typed wasn't taken (the field went back to the draft's). */
  let macError = $state<'bad' | 'taken'>();
  function typeMac(input: HTMLInputElement) {
    const r = macFor(edit.draft, adapter.id, input.value);
    if ('error' in r) {
      macError = r.error;
      input.value = adapter.mac;
      return;
    }
    macError = undefined;
    input.value = r.mac;
    if (r.mac !== adapter.mac) edit.set(withMac(edit.draft, adapter.id, r.mac));
  }
  function newMac() {
    macError = undefined;
    edit.set(withNewMac(edit.draft, adapter.id));
  }

  async function setAtStart(conn: Connection, on: boolean) {
    await net.conns.put({ ...conn, connectAtStart: on });
    await net.refresh();
  }
  // Change… on an adapter that has a connection asks first whether to edit it (on its page, Back leading here).
  const attach = () =>
    network.openWizard({
      mode: 'attach',
      machine: edit.draft.id,
      adapter: at,
      here: !!here?.on,
      attached: c?.id,
      from: { to: 'tab', machine: edit.draft.id },
    });
</script>

<Card data-adapter={index}>
  <div class="named">
    <Icon name="network" size={18} />
    <div class="lines">
      <strong>{t('machines:AdapterCard.adapter', { n: index + 1 })}</strong>
      <Note inline class="meta"
        ><T k="machines:AdapterCard.adapter.mac" params={{ mac: adapter.mac }}
          >{#snippet mac(text: string)}<span class="mac-edit"
              ><input
                class="mac"
                value={text}
                onchange={(e) => typeMac(e.currentTarget)}
                aria-label={t('machines:AdapterCard.adapter.mac.label')}
                data-field="mac"
                autocomplete="off"
                spellcheck="false"
              /><Button
                variant="inline"
                icon="refresh"
                onclick={newMac}
                data-action="new-mac"
                aria-label={t('machines:AdapterCard.adapter.newMac')}
                title={t('machines:AdapterCard.adapter.newMac.title')}
              /></span
            >{/snippet}</T
        ></Note
      >
      {#if macError}<Note inline tone="warn" class="meta" data-mac-error
          >{macError === 'bad'
            ? t('machines:AdapterCard.adapter.mac.bad')
            : t('machines:AdapterCard.adapter.mac.taken')}</Note
        >{:else if adapter.mac.toLowerCase() === DEFAULT_MAC}<Note inline tone="warn" class="meta" data-mac-default
          >{t('machines:AdapterCard.adapter.mac.default')}</Note
        >{/if}
      <Note inline class="meta" data-connection-name><T m={head} />{rest}</Note>
      {#if c?.room && hasDomainsLink(c)}<span class="meta"
          ><DomainsLink id={c.id} room={c.room} from={{ to: 'tab', machine: edit.draft.id }} /></span
        >{/if}
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
  /* The MAC's field and its icon, centered on each other; the field's text on the line's baseline (an inline-flex's). */
  .mac-edit {
    display: inline-flex;
    align-items: center;
  }
  .mac-edit :global(button) {
    min-height: 0;
    align-self: center;
  }
  /* The MAC reads as the line's words, its frame on hover and focus (as NameInput's). */
  .mac {
    width: calc(17ch + 2 * var(--space-2) + 2px);
    min-height: 0;
    font: inherit;
    color: inherit;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    padding: 0 var(--space-2);
  }
  /* As wide as the MAC (the width above, where a browser can't size a field to its text). */
  @supports (field-sizing: content) {
    .mac {
      field-sizing: content;
      width: auto;
    }
  }
  .mac:hover,
  .mac:focus {
    color: var(--text);
    border-color: var(--border);
  }
</style>
