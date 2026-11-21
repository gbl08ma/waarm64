<!--
  A tailcat connection's part of its Settings (ConnectionSettings.svelte; docs/tailcat.md), in its Fields grid: an exit
  through a tailcat address, and or a server others reach the machine at, with its relay and who's let in. The words
  are the wizard's tailcat step's (NetTailcatStep.svelte); its New address is a command in the connection's column
  (ConnectionNav.svelte).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import ValueField from './ui/ValueField.svelte';
  import { t } from '../i18n.ts';
  import type { SettingsDraft } from './connection-settings.ts';

  type Props = { draft: SettingsDraft };
  let { draft = $bindable() }: Props = $props();

  const DERPER = 'https://github.com/tailscale/tailscale/tree/main/cmd/derper';
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

<Check id="settings-tc-exit" bind:checked={draft.exit}>{t('network:NetTailcatStep.tailcat.exit')}</Check>
{#if draft.exit}
  <ValueField
    id="settings-tc-address"
    showId="settings-tc-address-show"
    label={t('network:ConnectionTailcatSettings.address')}
    bind:value={draft.address}
    secret
    // i18n-ignore-next: how an address starts, not words
    placeholder="tc…"
  />
  <Note size="md">{t('network:NetTailcatStep.tailcat.exit.note')}</Note>
{/if}
<Check id="settings-tc-serve" bind:checked={draft.serve}>{t('network:NetTailcatStep.tailcat.serve')}</Check>
{#if draft.serve}
  <Note size="md">
    <T
      k="network:NetTailcatStep.tailcat.serve.note"
      params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}
      {code}
    />
  </Note>
  <Field label={t('network:NetTailcatStep.relay')}>
    <input
      id="settings-tc-relay"
      bind:value={draft.relay}
      disabled={draft.exit}
      placeholder={t('network:NetTailcatStep.relay.placeholder')}
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
  <Note size="md">
    <T k="network:NetTailcatStep.relay.note">
      {#snippet a(words: string)}<a href={DERPER} target="_blank" rel="noopener">{words}</a>{/snippet}
    </T>
  </Note>
  <Field label={t('network:NetTailcatStep.allow')}>
    <textarea
      id="settings-tc-allow"
      bind:value={draft.allow}
      rows="3"
      placeholder={t('network:NetTailcatStep.allow.placeholder')}
      autocomplete="off"
      spellcheck="false"></textarea>
  </Field>
  <Note size="md">
    <T
      k="network:NetTailcatStep.allow.note"
      params={{ genkey: 'tailcat genkey --client --key=client-default' }}
      {code}
    />
  </Note>
{/if}

<style>
  textarea {
    resize: vertical;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
