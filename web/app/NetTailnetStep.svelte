<!--
  The Network wizard's tailnet step (NetWizard.svelte; docs/tailnet.md): the control server (Tailscale's unless
  given), the machine's hostname, and an auth key when it connects now. Editing changes the hostname alone.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import T from './T.svelte';
  import { msg, t } from '../i18n.ts';
  import type { Flow } from './net-wizard.ts';
  import { DEFAULT_CONTROL, parseControlURL, parseHostname, tailscaleBuilt } from './network.ts';
  import { page } from './ui.svelte.ts';

  type Props = { flow: Flow; active: boolean };
  let { flow, active }: Props = $props();

  let control = $state('');
  let hostname = $state('');
  let authKey = $state('');
  let reveal = $state(false);
  let controlInput = $state<HTMLInputElement>();
  let hostnameInput = $state<HTMLInputElement>();

  export function begin() {
    const tn = flow.editing?.tailnet;
    control = tn && tn.controlURL !== DEFAULT_CONTROL ? tn.controlURL : '';
    hostname = tn?.hostname ?? '';
    authKey = '';
    reveal = false;
  }
  export function enter() {
    queueMicrotask(() => (flow.editing ? hostnameInput : controlInput)?.focus());
  }
  export async function save() {
    const url = parseControlURL(control);
    const host = parseHostname(hostname);
    if ('error' in url) return flow.fail(url.error);
    if ('error' in host) return flow.fail(host.error);
    const key = authKey.trim();
    if (!(await tailscaleBuilt())) return flow.fail(msg('network:NetTailnetStep.tailscaleNotBuilt'));
    const editing = flow.editing;
    if (editing?.tailnet) return flow.edited({ ...editing, tailnet: { ...editing.tailnet, hostname: host.hostname } });
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
      disabled={!!flow.editing}
      placeholder={t('network:NetTailnetStep.control.placeholder')}
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
  {#if !flow.editing}
    <Note size="md">
      <T k="network:NetTailnetStep.control.note">{#snippet code(words: string)}<code>{words}</code>{/snippet}</T>
    </Note>
  {/if}
  <Field label={t('network:NetTailnetStep.hostname')}>
    <input
      id="net-hostname"
      bind:this={hostnameInput}
      bind:value={hostname}
      // i18n-ignore-next: the default hostname, not words
      placeholder="webpc"
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
  {#if flow.here}
    <Field label={t('network:NetTailnetStep.authKey')}>
      <input
        id="net-authkey"
        bind:value={authKey}
        type={reveal ? 'text' : 'password'}
        autocomplete="off"
        spellcheck="false"
      />
    </Field>
    <Check id="net-reveal" bind:checked={reveal}>{t('network:NetTailnetStep.authKey.show')}</Check>
    <Note size="md">{t('network:NetTailnetStep.authKey.note')}</Note>
  {:else if flow.editing}
    <Note size="md">{t('network:NetTailnetStep.control.edit')}</Note>
  {:else}
    <Note size="md">{t('network:NetTailnetStep.login.note')}</Note>
  {/if}
</Step>
