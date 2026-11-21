<!--
  A connection's Settings (docs/frontend.md "The Home page"): the pane of its page's Settings section, on the Home page
  one level under Connections (ConnectionPage.svelte). The connection's name, then what can change without a new node,
  by kind: a tailnet's hostname (its control server shown, not changed); tailcat's exit address, whether it serves, its
  relay and who is let in (ConnectionTailcatSettings.svelte); the local helper's link; the demo network's server; a
  room's two switches and, under Advanced, its key to copy and a new key (ConnectionRoomSettings.svelte). Save and
  Revert as a machine's Settings have them (SaveRow.svelte): Save writes the connection back through `page.netEdit`
  (an adapter here that runs it connects again with it), or renames it alone through `page.netRename`. The draft
  follows the stored connection unless it's being edited, and leaving the section drops it, as a machine's does.
  The form's logic is web/app/connection-settings.ts.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import ConnectionRoomSettings from './ConnectionRoomSettings.svelte';
  import ConnectionTailcatSettings from './ConnectionTailcatSettings.svelte';
  import NetLocalInstall from './NetLocalInstall.svelte';
  import SaveRow from './SaveRow.svelte';
  import Field from './ui/Field.svelte';
  import Fields from './ui/Fields.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import ValueField from './ui/ValueField.svelte';
  import type { Act } from './actions.svelte.ts';
  import {
    differs,
    draftOf,
    editedOf,
    emptyDraft,
    settingsChanged,
    type SettingsDraft,
  } from './connection-settings.ts';
  import { DEMO_URL } from '../demo-net.ts';
  import { t } from '../i18n.ts';
  import { MsgError } from '../msg.ts';
  import type { PageNetwork } from './net-live.ts';
  import { page } from './page.ts';

  type Props = { net: PageNetwork; id: string; act: Act; takeFocus: () => boolean };
  let { net, id, act, takeFocus }: Props = $props();

  const c = $derived(net.connections.find((x) => x.id === id));
  /** The connection's settings as last followed, and the draft the form edits. */
  let base = $state.raw<SettingsDraft>();
  let draft = $state<SettingsDraft>(emptyDraft());
  const dirty = $derived(!!c && !!base && differs(c.kind, base, draft));

  /** The draft from the stored connection (Revert, a save, and a change of the record while nothing is edited). */
  function reset() {
    if (!c) return;
    base = draftOf(c);
    draft = draftOf(c);
  }
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
    void c;
    untrack(() => {
      if (!dirty) reset();
    });
  });

  async function save() {
    const was = c;
    const d = $state.snapshot(draft);
    if (!was) return;
    const saved = await act(t('machines:machine-edit.saving'), async () => {
      const r = editedOf(was, d);
      if ('error' in r) throw new MsgError(r.error.key, r.error.params);
      if (settingsChanged(was, d)) await page.netEdit(r.connection);
      else await page.netRename(was, d.name);
    });
    if (saved) reset();
  }
  const edit = {
    get dirty() {
      return dirty;
    },
    save,
    revert: reset,
  };
</script>

{#if c && base}
  <Pane id="connection-settings" title={t('machines:ConnectionNav.settings')} {takeFocus}>
    <div class="settings" data-kind={c.kind}>
      <Fields>
        <Field label={t('machines:ConnectionSettings.name')}>
          <input id="settings-name" bind:value={draft.name} autocomplete="off" spellcheck="false" />
        </Field>
        {#if c.tailnet}
          <Field label={t('network:NetTailnetStep.hostname')}>
            <input
              id="settings-hostname"
              bind:value={draft.hostname}
              // i18n-ignore-next: the default hostname, not words
              placeholder="waarm64"
              autocomplete="off"
              spellcheck="false"
            />
          </Field>
          <Field label={t('network:NetTailnetStep.control')}>
            <input id="settings-control" value={c.tailnet.controlURL} disabled />
          </Field>
          <Note size="md">{t('network:ConnectionSettings.tailnet.control')}</Note>
        {:else if c.tailcat}
          <ConnectionTailcatSettings bind:draft />
        {:else if c.local}
          <ValueField
            id="settings-local-url"
            showId="settings-local-url-show"
            label={t('network:ConnectionSettings.local.link')}
            bind:value={draft.url}
            secret
            // i18n-ignore-next: an example of the link, not words
            placeholder="https://vm.tny.im/#net=ws://127.0.0.1:8740/…"
          />
          <Note size="md">{t('network:NetLocalStep.local.note')}</Note>
          <NetLocalInstall prefix="settings-local" open={false} />
        {:else if c.demo}
          <Field label={t('network:NetDemoStep.demo.server')}>
            <input
              id="settings-demo-url"
              bind:value={draft.url}
              placeholder={DEMO_URL}
              autocomplete="off"
              spellcheck="false"
            />
          </Field>
          <Note size="md">{t('network:NetDemoStep.demo.server.note')}</Note>
        {:else if c.room}
          <ConnectionRoomSettings {net} connection={c} {act} bind:draft />
        {/if}
        <SaveRow {edit} />
      </Fields>
    </div>
  </Pane>
{/if}

<style>
  /* A form's width, as the Details' column. */
  .settings {
    max-width: 720px;
  }
</style>
