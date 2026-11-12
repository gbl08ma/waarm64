<!--
  How to install and run the local helper (webpc-net, docs/networking/local-helper.md), folded under a line with its version:
  the platform to install it on (this browser's first, else Linux x86-64), its note, and the lines to type. The Network
  wizard's local step (NetLocalStep.svelte) and a local connection's details (NetDetails.svelte). `open`: unfolded at
  first; `prefix` names its elements (tests' handles): `<prefix>-install` (the Disclosure), `-target`, `-lines`.
-->
<script lang="ts">
  import Disclosure from './ui/Disclosure.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import { t } from '../i18n.ts';
  import { installLines, RELEASE, targetName, TARGETS, thisTarget, type Target } from '../local-release.ts';

  type Props = { prefix: string; open: boolean };
  let { prefix, open }: Props = $props();

  let target = $state<Target>();
  void thisTarget().then((x) => {
    target = x;
  });
  const shown = $derived(target ?? TARGETS[0]);
  const idOf = (x: Target) => `${x.os}-${x.arch}`;
</script>

<Disclosure
  id={`${prefix}-install`}
  {open}
  summary={t('network:NetLocalInstall.install', { version: RELEASE.version })}
>
  <Field label={t('network:NetLocalInstall.install.for')}>
    <select
      id={`${prefix}-target`}
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
      ? t('network:NetLocalInstall.install.note.windows')
      : t('network:NetLocalInstall.install.note')}
  </Note>
  <pre id={`${prefix}-lines`}>{installLines(RELEASE, shown)}</pre>
</Disclosure>

<style>
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
