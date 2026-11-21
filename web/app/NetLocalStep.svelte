<!--
  The Network wizard's step for the local helper on this computer (NetWizard.svelte; docs/networking/local-helper.md):
  how to install and run it (this platform's lines first), then its pairing link pasted. A connection's Settings on the
  Home page change the link (ConnectionSettings.svelte).
-->
<script lang="ts">
  import NetLocalInstall from './NetLocalInstall.svelte';
  import Step from './ui/Step.svelte';
  import Steps from './ui/Steps.svelte';
  import T from './T.svelte';
  import ValueField from './ui/ValueField.svelte';
  import Note from './ui/Note.svelte';
  import { t } from '../i18n.ts';
  import { SOURCE } from '../local-release.ts';
  import { parseLocalURL } from '../local-net.ts';
  import type { Flow } from './net-wizard.ts';
  import { page } from './page.ts';

  type Props = { flow: Flow; active: boolean };
  let { flow, active }: Props = $props();

  let localURL = $state('');
  let urlInput = $state<HTMLInputElement>();

  export function begin() {
    localURL = flow.opened.localURL ?? '';
  }
  export function enter() {
    queueMicrotask(() => urlInput?.focus());
  }
  export async function save() {
    const u = parseLocalURL(localURL);
    if ('error' in u) return flow.fail(u.error);
    await flow.made(await page.netCreate({ kind: 'local', ephemeral: !flow.keep, local: { url: u.url } }));
  }
</script>

<Step id="net-step-local" {active}>
  <Steps>
    <li>
      <T k="network:NetLocalStep.local.run">
        {#snippet a(words: string)}<a href={SOURCE} target="_blank" rel="noopener">{words}</a>{/snippet}
      </T>
      <div class="install"><NetLocalInstall prefix="net-local" open={!localURL} /></div>
    </li>
    <li>
      <ValueField
        id="net-local-url"
        showId="net-local-url-show"
        label={t('network:NetLocalStep.local.paste')}
        bind:ref={urlInput}
        bind:value={localURL}
        secret
        // i18n-ignore-next: an example of the link, not words
        placeholder="https://waarm64.com/#net=ws://127.0.0.1:8740/…"
      />
    </li>
  </Steps>
  <Note size="md">{t('network:NetLocalStep.local.note')}</Note>
</Step>

<style>
  .install {
    margin-top: var(--space-3);
  }
</style>
