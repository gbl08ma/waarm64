<!--
  The Network wizard's step for the local helper on this computer (NetWizard.svelte; docs/plans/networking-local.md):
  how to install and run it (this platform's lines first), then its pairing link pasted. Editing changes the link.
-->
<script lang="ts">
  import Disclosure from './ui/Disclosure.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import Steps from './ui/Steps.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import { installLines, RELEASE, SOURCE, targetName, TARGETS, thisTarget, type Target } from '../local-release.ts';
  import { parseLocalURL } from '../local-net.ts';
  import type { Flow } from './net-wizard.ts';
  import { page } from './ui.svelte.ts';

  type Props = { flow: Flow; active: boolean };
  let { flow, active }: Props = $props();

  let localURL = $state('');
  let target = $state<Target>();
  let urlInput = $state<HTMLInputElement>();
  void thisTarget().then((x) => {
    target = x;
  });
  /** The install lines shown first: this browser's platform's, else Linux x86-64's. */
  const shown = $derived(target ?? TARGETS[0]);
  const idOf = (x: Target) => `${x.os}-${x.arch}`;

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
  <Field {label}>
    <input
      id="net-local-url"
      bind:this={urlInput}
      bind:value={localURL}
      type="password"
      // i18n-ignore-next: an example of the link, not words
      placeholder="https://vm.tny.im/#net=ws://127.0.0.1:8740/…"
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
{/snippet}

<Step id="net-step-local" {active}>
  {#if flow.editing}
    {@render localField(t('network:NetLocalStep.local.link'))}
  {:else}
    <Steps>
      <li>
        <T k="network:NetLocalStep.local.run">
          {#snippet a(words: string)}<a href={SOURCE} target="_blank" rel="noopener">{words}</a>{/snippet}
        </T>
        <div class="install">
          <Disclosure
            id="net-local-install"
            open={!localURL}
            summary={t('network:NetLocalStep.install', { version: RELEASE.version })}
          >
            <Field label={t('network:NetLocalStep.install.for')}>
              <select
                id="net-local-target"
                value={idOf(shown)}
                onchange={(e) => {
                  target = TARGETS.find((x) => idOf(x) === e.currentTarget.value);
                }}
              >
                {#each TARGETS as x (idOf(x))}<option value={idOf(x)}>{targetName(x)}</option>{/each}
              </select>
            </Field>
            <Note size="md">
              {shown.os === 'windows'
                ? t('network:NetLocalStep.install.note.windows')
                : t('network:NetLocalStep.install.note')}
            </Note>
            <pre id="net-local-lines">{installLines(RELEASE, shown)}</pre>
          </Disclosure>
        </div>
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
  /* The commands as they're typed, a line each: they scroll rather than wrap. */
  pre {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
