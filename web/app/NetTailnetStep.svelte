<!--
  The Network wizard's tailnet step (NetWizard.svelte; docs/networking/tailnet.md): the control server (Tailscale's unless
  given), the machine's hostname, and an auth key when it connects now. A connection's Settings on the Home page
  change its hostname (ConnectionSettings.svelte).
-->
<script lang="ts">
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import T from './T.svelte';
  import ValueField from './ui/ValueField.svelte';
  import { msg, t } from '../i18n.ts';
  import type { Flow } from './net-wizard.ts';
  import { parseControlURL, parseHostname, tailscaleBuilt } from './network.ts';
  import { page } from './page.ts';

  type Props = { flow: Flow; active: boolean };
  let { flow, active }: Props = $props();

  let control = $state('');
  let hostname = $state('');
  let authKey = $state('');
  let reveal = $state(false);
  let controlInput = $state<HTMLInputElement>();

  export function begin() {
    control = '';
    hostname = '';
    authKey = '';
    reveal = false;
  }
  export function enter() {
    queueMicrotask(() => controlInput?.focus());
  }
  export async function save() {
    const url = parseControlURL(control);
    const host = parseHostname(hostname);
    if ('error' in url) return flow.fail(url.error);
    if ('error' in host) return flow.fail(host.error);
    const key = authKey.trim();
    if (!(await tailscaleBuilt())) return flow.fail(msg('network:NetTailnetStep.tailscaleNotBuilt'));
    const c = await page.netCreate({
      kind: 'tailnet',
      ephemeral: !flow.keep,
      tailnet: { controlURL: url.url, hostname: host.hostname, exitNode: '' },
    });
    authKey = '';
    await flow.made(c, key || undefined);
  }
</script>

<Step id="net-step-tailnet" {active}>
  <Field label={t('network:NetTailnetStep.control')}>
    <input
      id="net-control"
      bind:this={controlInput}
      bind:value={control}
      placeholder={t('network:NetTailnetStep.control.placeholder')}
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
  <Note size="md">
    <T k="network:NetTailnetStep.control.note">{#snippet code(words: string)}<code>{words}</code>{/snippet}</T>
  </Note>
  <Field label={t('network:NetTailnetStep.hostname')}>
    <input
      id="net-hostname"
      bind:value={hostname}
      // i18n-ignore-next: the default hostname, not words
      placeholder="waarm64"
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
  {#if flow.here}
    <ValueField
      id="net-authkey"
      showId="net-authkey-show"
      label={t('network:NetTailnetStep.authKey')}
      bind:value={authKey}
      bind:shown={reveal}
      secret
    />
    <Note size="md">{t('network:NetTailnetStep.authKey.note')}</Note>
  {:else}
    <Note size="md">{t('network:NetTailnetStep.login.note')}</Note>
  {/if}
</Step>
