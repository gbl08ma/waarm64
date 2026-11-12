<!--
  The Network wizard's step for the local helper on this computer (NetWizard.svelte; docs/plans/networking-local.md):
  how to install and run it (this platform's lines first), then its pairing link pasted. Editing changes the link (the install
  lines folded under it).
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
    localURL = flow.editing?.local?.url ?? flow.opened.localURL ?? '';
  }
  export function enter() {
    queueMicrotask(() => urlInput?.focus());
  }
  export async function save() {
    const u = parseLocalURL(localURL);
    if ('error' in u) return flow.fail(u.error);
    const editing = flow.editing;
    if (editing) return flow.edited({ ...editing, local: { url: u.url } });
    await flow.made(await page.netCreate({ kind: 'local', ephemeral: !flow.keep, local: { url: u.url } }));
  }
</script>

{#snippet localField(label: string)}
  <ValueField
    id="net-local-url"
    showId="net-local-url-show"
    {label}
    bind:ref={urlInput}
    bind:value={localURL}
    secret
    // i18n-ignore-next: an example of the link, not words
    placeholder="https://vm.tny.im/#net=ws://127.0.0.1:8740/…"
  />
{/snippet}

<!-- Editing, the link comes first (what Save changes); the helper's install lines stay at hand, folded. -->
<Step id="net-step-local" {active}>
  {#if flow.editing}
    {@render localField(t('network:NetLocalStep.local.link'))}
    <NetLocalInstall prefix="net-local" open={false} />
  {:else}
    <Steps>
      <li>
        <T k="network:NetLocalStep.local.run">
          {#snippet a(words: string)}<a href={SOURCE} target="_blank" rel="noopener">{words}</a>{/snippet}
        </T>
        <div class="install"><NetLocalInstall prefix="net-local" open={!localURL} /></div>
      </li>
      <li>{@render localField(t('network:NetLocalStep.local.paste'))}</li>
    </Steps>
  {/if}
  <Note size="md">{t('network:NetLocalStep.local.note')}</Note>
</Step>

<style>
  .install {
    margin-top: var(--space-3);
  }
</style>
