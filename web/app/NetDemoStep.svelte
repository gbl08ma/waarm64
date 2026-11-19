<!--
  The Network wizard's step for the demo network (NetWizard.svelte; docs/networking/demo-network.md): what it is and
  reaches, and its server, the project's unless another is given (a server of one's own, `ws://` on this computer for
  testing). Editing changes the server.
-->
<script lang="ts">
  import Disclosure from './ui/Disclosure.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import { t } from '../i18n.ts';
  import { DEMO_URL, parseDemoURL } from '../demo-net.ts';
  import type { Flow } from './net-wizard.ts';
  import { page } from './page.ts';

  type Props = { flow: Flow; active: boolean };
  let { flow, active }: Props = $props();

  let server = $state('');
  let serverInput = $state<HTMLInputElement>();

  export function begin() {
    const url = flow.editing?.demo?.url;
    server = url && url !== DEMO_URL ? url : '';
  }
  export function enter() {
    queueMicrotask(() => serverInput?.focus());
  }
  export async function save() {
    const u = parseDemoURL(server);
    if ('error' in u) return flow.fail(u.error);
    const editing = flow.editing;
    if (editing) return flow.edited({ ...editing, demo: { url: u.url } });
    await flow.made(await page.netCreate({ kind: 'demo', ephemeral: !flow.keep, demo: { url: u.url } }));
  }
</script>

<Step id="net-step-demo" {active}>
  <Note size="md">{t('network:NetDemoStep.demo.note')}</Note>
  <Note size="md">{t('network:NetDemoStep.demo.limits')}</Note>
  <Disclosure id="net-demo-advanced" summary={t('network:NetDemoStep.demo.advanced')} open={!!server}>
    <Field label={t('network:NetDemoStep.demo.server')}>
      <input
        id="net-demo-url"
        bind:this={serverInput}
        bind:value={server}
        placeholder={DEMO_URL}
        autocomplete="off"
        spellcheck="false"
      />
    </Field>
    <Note size="md">{t('network:NetDemoStep.demo.server.note')}</Note>
  </Disclosure>
</Step>
