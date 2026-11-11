<!--
  The Network wizard's tailcat step (NetWizard.svelte; docs/tailcat.md): an exit through a tailcat address, and or a
  server others reach the machine at (its relay and who's let in, under Advanced; editing: a new address).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Disclosure from './ui/Disclosure.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import Steps from './ui/Steps.svelte';
  import T from './T.svelte';
  import { msg, t } from '../i18n.ts';
  import type { Flow } from './net-wizard.ts';
  import { hasTailcatIdentity, parseAllow, parseRelay, parseTailcatAddr, tailcatBuilt } from './network.ts';
  import { page } from './ui.svelte.ts';

  type Props = { flow: Flow; active: boolean };
  let { flow, active }: Props = $props();

  const DERPER = 'https://github.com/tailscale/tailscale/tree/main/cmd/derper';
  let exit = $state(true);
  let serve = $state(false);
  let address = $state('');
  let relay = $state('');
  let allow = $state('');
  let advanced = $state(false);
  /** The connection being edited keeps its identity: New address can drop it. */
  let identityKept = $state(false);
  let exitBox = $state<HTMLInputElement>();

  export function begin() {
    const cat = flow.editing?.tailcat;
    exit = cat ? !!cat.exit : true;
    serve = cat?.serve ?? false;
    address = cat?.exit ?? '';
    relay = cat?.relay ?? '';
    allow = (cat?.allow ?? []).join('\n');
    advanced = !!relay || !!allow;
  }
  export function enter() {
    const cat = flow.editing?.tailcat;
    if (!cat) identityKept = false;
    else if (cat.identity) identityKept = true;
    else
      void hasTailcatIdentity(cat.identityKey).then((kept) => {
        identityKept = kept;
      });
    queueMicrotask(() => exitBox?.focus());
  }
  export async function save() {
    if (!exit && !serve) return flow.fail(msg('network:NetTailcatStep.chooseTailcat'));
    const addr = exit ? parseTailcatAddr(address) : { addr: '' };
    if ('error' in addr) return flow.fail(addr.error);
    const r = serve && !exit ? parseRelay(relay) : { relay: relay.trim() };
    if ('error' in r) return flow.fail(r.error);
    const letIn = serve ? parseAllow(allow) : { allow: [] };
    if ('error' in letIn) return flow.fail(letIn.error);
    if (!(await tailcatBuilt())) return flow.fail(msg('network:NetTailcatStep.tailcatNotBuilt'));
    const settings = {
      exit: addr.addr || undefined,
      serve,
      relay: r.relay,
      allow: letIn.allow.length ? letIn.allow : undefined,
    };
    const editing = flow.editing;
    if (editing?.tailcat) return flow.edited({ ...editing, tailcat: { ...editing.tailcat, ...settings } });
    await flow.made(await page.netCreate({ kind: 'tailcat', ephemeral: !flow.keep, tailcat: settings }));
  }
  async function forget() {
    if (await flow.forget()) identityKept = false;
  }
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

<Step id="net-step-tailcat" {active}>
  <Check id="net-tc-exit" bind:checked={exit} bind:ref={exitBox}>{t('network:NetTailcatStep.tailcat.exit')}</Check>
  <div id="net-tc-exit-fields" class="sub" hidden={!exit}>
    <Steps>
      <li>
        <T k="network:NetTailcatStep.tailcat.exit.install">
          {#snippet a(words: string)}
            <a href="https://github.com/tailscale/tailcat" target="_blank" rel="noopener">{words}</a>
          {/snippet}
        </T>
      </li>
      <li><T k="network:NetTailcatStep.tailcat.exit.run" {code} /></li>
      <li>
        <Field label={t('network:NetTailcatStep.tailcat.exit.paste')}>
          <input
            id="net-tailcat"
            bind:value={address}
            type="password"
            // i18n-ignore-next: how an address starts, not words
            placeholder="tc…"
            autocomplete="off"
            spellcheck="false"
          />
        </Field>
      </li>
    </Steps>
    <Note size="md">{t('network:NetTailcatStep.tailcat.exit.note')}</Note>
  </div>
  <Check id="net-tc-serve" bind:checked={serve}>{t('network:NetTailcatStep.tailcat.serve')}</Check>
  <div id="net-tc-serve-fields" class="sub" hidden={!serve}>
    <Note size="md">
      <T
        k="network:NetTailcatStep.tailcat.serve.note"
        params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}
        {code}
      />
    </Note>
    <Disclosure id="net-tc-advanced" bind:open={advanced} summary={t('network:NetTailcatStep.advanced')}>
      <Field label={t('network:NetTailcatStep.relay')}>
        <input
          id="net-tc-relay"
          bind:value={relay}
          disabled={exit}
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
          id="net-tc-allow"
          bind:value={allow}
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
      {#if flow.editing}
        <div class="row">
          <Button type="button" id="net-tc-forget" disabled={!identityKept} onclick={forget}>
            {t('network:NetTailcatStep.newAddress')}
          </Button>
        </div>
        <Note size="md">{t('network:NetTailcatStep.newAddress.note')}</Note>
      {/if}
    </Disclosure>
  </div>
</Step>

<style>
  /* What a switch opens: under it, past its box. */
  .sub {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-left: var(--space-6);
  }
  .row {
    display: flex;
    gap: var(--space-3);
  }
  textarea {
    resize: vertical;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
