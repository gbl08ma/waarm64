<!--
  The Network wizard (docs/network-adapters.md §3.2), a dialog opened through `ui.netWizard`: attach a connection
  to a machine's adapter (one of the browser's, or a new one: New connection… first), make a new connection on its own,
  or edit one (what changes without a new node: a tailnet's hostname, tailcat's server and relay). A new connection is
  kept in this browser unless Keep is off (ephemeral: gone when the page closes). The toolbar's Network menu and the
  Machines page's Network tab and Connections open it; the page (web/app/main.ts) attaches and connects.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from './Modal.svelte';
  import Check from './Check.svelte';
  import T from './T.svelte';
  import { describe, msg, t, text, type Described, type Msg } from '../i18n.ts';
  import { preselect, type Connection } from './connections.ts';
  import type { PageNetwork } from './net-live.ts';
  import { DEFAULT_CONTROL, hasTailcatIdentity, parseControlURL, parseHostname, parseRelay, parseTailcatAddr, tailcatBuilt, tailscaleBuilt } from './network.ts';
  import { page, ui } from './ui.svelte.ts';
  import { parseLocalURL } from '../local-net.ts';
  import { installLines, RELEASE, SOURCE, targetName, TARGETS, thisTarget, type Target } from '../local-release.ts';

  let { net }: { net: PageNetwork } = $props();

  type Step = 'pick' | 'kind' | 'tailscale' | 'tailcat' | 'local';
  let wizard: Modal;
  let w = $state<NonNullable<typeof ui.netWizard>>({ mode: 'new' });
  let step = $state<Step>('kind');
  let formError = $state<Described>();
  let working = $state(false);
  const conns = $derived((void ui.net, net.connections));
  let picked = $state<string>();
  let holders = $state<Record<string, string>>({});
  let editing = $state<Connection>();
  let control = $state(''), hostname = $state(''), authKey = $state(''), reveal = $state(false);
  let tcExit = $state(true), tcServe = $state(false), tailcat = $state(''), relay = $state('');
  let advanced = $state(false), identityKept = $state(false);
  let keep = $state(true);
  let localURL = $state(''), target = $state<Target>();
  void thisTarget().then((t) => { target = t; });
  const pickable = $derived(w.mode === 'attach' && conns.length > 0);
  /** Whether what the wizard attaches connects now (the machine is the page's): an auth key is asked for then. */
  const here = $derived(w.mode === 'attach' && !!w.here);

  $effect(() => {
    const o = ui.netWizard;
    if (!o) return;
    void o.tick;
    untrack(() => void begin(o));
  });

  const kindMsg = (c: Connection): Msg => {
    const kind = c.kind === 'tailnet' ? msg('network:NetWizard.kind.tailnet', { host: new URL(c.tailnet!.controlURL).host }) : c.kind === 'local' ? msg('network:NetWizard.kind.local') : c.tailcat?.exit ? msg('network:NetWizard.kind.tailcatExit') : msg('network:NetWizard.kind.tailcatServe');
    return c.ephemeral ? msg('network:NetWizard.kind.ephemeral', { kind }) : kind;
  };
  /** A connection's line under its name: its kind, and the machine that has it, if one does. */
  const kindText = (c: Connection) => {
    const kind = kindMsg(c);
    if (!net.held.has(c.id)) return text(kind);
    const holder = holders[c.id];
    return holder ? t('network:NetWizard.kind.held', { kind, holder }) : t('network:NetWizard.kind.heldElsewhere', { kind });
  };
  /** An error the form shows (a message, or an error with its details). */
  const fail = (e: Msg | unknown) => void (formError = describe(e));

  async function begin(o: NonNullable<typeof ui.netWizard>) {
    w = o;
    formError = undefined;
    authKey = '';
    reveal = false;
    keep = true;
    editing = o.mode === 'edit' ? conns.find((c) => c.id === o.connection) : undefined;
    const t = editing?.tailnet, cat = editing?.tailcat;
    control = t && t.controlURL !== DEFAULT_CONTROL ? t.controlURL : '';
    hostname = t?.hostname ?? '';
    tcExit = cat ? !!cat.exit : true;
    tcServe = cat?.serve ?? false;
    tailcat = cat?.exit ?? '';
    relay = cat?.relay ?? '';
    advanced = !!relay;
    localURL = editing?.local?.url ?? o.localURL ?? '';
    wizard.open();
    if (editing) return showStep(editing.kind === 'tailnet' ? 'tailscale' : editing.kind === 'local' ? 'local' : 'tailcat');
    if (o.localURL) return showStep('local'); // the helper's pairing link opened the page
    if (!pickable) return showStep('kind');
    const attached = o.machine === ui.current ? net.views()[o.adapter ?? 0]?.connection?.id : undefined;
    picked = attached ?? preselect(conns, (id) => net.held.has(id));
    holders = {};
    showStep('pick');
    for (const id of net.held) void page.netHolder(id).then((name) => { if (name) holders = { ...holders, [id]: name }; });
  }

  function showStep(to: Step) {
    step = to;
    formError = undefined;
    if (to === 'tailcat') {
      const cat = editing?.tailcat;
      if (!cat) identityKept = false;
      else if (cat.identity) identityKept = true;
      else void hasTailcatIdentity(cat.identityKey).then((kept) => { identityKept = kept; });
    }
    queueMicrotask(() => document.getElementById(to === 'pick' ? (picked ? `net-pick-${picked}` : 'net-pick-new') : to === 'kind' ? 'net-pick-tailnet' : to === 'tailscale' ? (editing ? 'net-hostname' : 'net-control') : to === 'local' ? 'net-local-url' : 'net-tc-exit')?.focus());
  }
  const back = () => showStep(step === 'kind' ? 'pick' : 'kind');
  const close = () => { wizard.close(); ui.netWizard = undefined; };

  /** Attaches `c` (and connects it, on the page's machine); the menu then shows how it goes. */
  async function attach(c: Connection, key?: string) {
    await page.netAttach(w.machine, w.adapter ?? 0, c, key);
    close();
    if (here) ui.netMenu++;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (working) return;
    working = true;
    try {
      await save();
    } catch (err) {
      fail(err);
    } finally {
      working = false;
    }
  }

  async function save() {
    if (step === 'local') {
      const u = parseLocalURL(localURL);
      if ('error' in u) return fail(u.error);
      formError = undefined;
      if (editing) {
        await page.netEdit({ ...editing, local: { url: u.url } });
        return close();
      }
      const c = await page.netCreate({ kind: 'local', ephemeral: !keep, local: { url: u.url } });
      return w.mode === 'attach' ? attach(c) : close();
    }
    if (step === 'pick') {
      const c = conns.find((x) => x.id === picked);
      if (!c) return fail(msg('network:NetWizard.choose'));
      return attach(c);
    }
    if (step === 'tailcat') {
      if (!tcExit && !tcServe) return fail(msg('network:NetWizard.chooseTailcat'));
      const addr = tcExit ? parseTailcatAddr(tailcat) : { addr: '' };
      if ('error' in addr) return fail(addr.error);
      const r = tcServe && !tcExit ? parseRelay(relay) : { relay: relay.trim() };
      if ('error' in r) return fail(r.error);
      formError = undefined;
      if (!(await tailcatBuilt())) return fail(msg('network:NetWizard.tailcatNotBuilt'));
      const settings = { exit: addr.addr || undefined, serve: tcServe, relay: r.relay };
      if (editing) {
        await page.netEdit({ ...editing, tailcat: { ...editing.tailcat!, ...settings } });
        return close();
      }
      const c = await page.netCreate({ kind: 'tailcat', ephemeral: !keep, tailcat: settings });
      return w.mode === 'attach' ? attach(c) : close();
    }
    const url = parseControlURL(control);
    const host = parseHostname(hostname);
    if ('error' in url) return fail(url.error);
    if ('error' in host) return fail(host.error);
    formError = undefined;
    const key = authKey.trim();
    if (!(await tailscaleBuilt())) return fail(msg('network:NetWizard.tailscaleNotBuilt'));
    if (editing) {
      await page.netEdit({ ...editing, tailnet: { ...editing.tailnet!, hostname: host.hostname } });
      return close();
    }
    const c = await page.netCreate({ kind: 'tailnet', ephemeral: !keep, tailnet: { controlURL: url.url, hostname: host.hostname, exitNode: '' } });
    authKey = '';
    return w.mode === 'attach' ? attach(c, key || undefined) : close();
  }

  async function forget() {
    if (!editing || !(await page.netNewAddress(editing))) return;
    identityKept = false;
  }

  const title = $derived(editing ? t('network:NetWizard.title.edit', { name: editing.name }) : step === 'pick' ? t('network:NetWizard.title.pick', { adapter: (w.adapter ?? 0) + 1 }) : step === 'kind' ? t('network:NetWizard.title.kind') : step === 'tailscale' ? t('network:NetWizard.title.tailnet') : step === 'local' ? t('network:NetWizard.title.local') : t('network:NetWizard.title.tailcat'));
  /** The install lines shown first: this browser's platform's, else Linux x86-64's. */
  const shown = $derived(target ?? TARGETS[0]);
  const submitLabel = $derived(editing ? t('network:NetWizard.save') : w.mode === 'new' ? t('network:NetWizard.create') : here ? t('network:NetWizard.connect') : t('network:NetWizard.attach'));
</script>

<Modal id="net-wizard" bodyId="net-form" bind:this={wizard} {title} auto={false} onclose={() => { ui.netWizard = undefined; }} onsubmit={submit}>
    <section id="net-step-pick" class="net-step" hidden={step !== 'pick'}>
      <p class="note">{t('network:NetWizard.pick.note')}</p>
      <button type="button" class="net-choice" id="net-pick-new" onclick={() => showStep('kind')}><b>{t('network:NetWizard.pick.new')}</b><span>{t('network:NetWizard.pick.new.note')}</span></button>
      {#each conns as c (c.id)}
        <button type="button" class="net-choice" id={`net-pick-${c.id}`} data-connection={c.id} aria-pressed={picked === c.id} onclick={() => (picked = c.id)} ondblclick={() => { picked = c.id; document.getElementById('net-connect')?.click(); }}>
          <b>{c.name}</b><span>{kindText(c)}</span>
        </button>
      {/each}
    </section>
    <section id="net-step-kind" class="net-step" hidden={step !== 'kind'}>
      <p class="note">{t('network:NetWizard.kind.note')}</p>
      <button type="button" class="net-choice" id="net-pick-tailnet" onclick={() => showStep('tailscale')}><b>{t('network:NetWizard.kind.pickTailnet')}</b><span>{t('network:NetWizard.kind.pickTailnet.note')}</span></button>
      <button type="button" class="net-choice" id="net-pick-tailcat" onclick={() => showStep('tailcat')}><b>{t('network:NetWizard.kind.pickTailcat')}</b><span>{t('network:NetWizard.kind.pickTailcat.note')}</span></button>
      <button type="button" class="net-choice" id="net-pick-local" onclick={() => showStep('local')}><b>{t('network:NetWizard.kind.pickLocal')}</b><span>{t('network:NetWizard.kind.pickLocal.note')}</span></button>
    </section>
    <section id="net-step-local" class="net-step" hidden={step !== 'local'}>
      {#snippet localField(label: string)}
        <!-- i18n-ignore-next: the placeholder is an example of the link, not words -->
        <label>{label}<input id="net-local-url" bind:value={localURL} type="password" placeholder="https://vm.tny.im/#net=ws://127.0.0.1:8740/…" autocomplete="off" spellcheck="false"></label>
      {/snippet}
      {#if editing}
        {@render localField(t('network:NetWizard.local.link'))}
      {:else}
        <ol class="net-steps">
          <li>
            <T k="network:NetWizard.local.run">{#snippet a(text)}<a href={SOURCE} target="_blank" rel="noopener">{text}</a>{/snippet}</T>
            <details id="net-local-install" open={!localURL}><summary>{t('network:NetWizard.install', { version: RELEASE.version })}</summary>
              <label>{t('network:NetWizard.install.for')}<select id="net-local-target" value={`${shown.os}-${shown.arch}`} onchange={(e) => { target = TARGETS.find((t) => `${t.os}-${t.arch}` === e.currentTarget.value); }}>
                {#each TARGETS as t (`${t.os}-${t.arch}`)}<option value={`${t.os}-${t.arch}`}>{targetName(t)}</option>{/each}
              </select></label>
              <p class="note">{shown.os === 'windows' ? t('network:NetWizard.install.note.windows') : t('network:NetWizard.install.note')}</p>
              <pre id="net-local-lines">{installLines(RELEASE, shown)}</pre>
            </details>
          </li>
          <li>{@render localField(t('network:NetWizard.local.paste'))}</li>
        </ol>
      {/if}
      <p class="note">{t('network:NetWizard.local.note')}</p>
    </section>
    <section id="net-step-tailnet" class="net-step" hidden={step !== 'tailscale'}>
      <label>{t('network:NetWizard.control')}<input id="net-control" bind:value={control} disabled={!!editing} placeholder={t('network:NetWizard.control.placeholder')} autocomplete="off" spellcheck="false"></label>
      {#if !editing}<p class="note"><T k="network:NetWizard.control.note">{#snippet code(text)}<code>{text}</code>{/snippet}</T></p>{/if}
      <!-- i18n-ignore-next: the placeholder is the default hostname, not words -->
      <label>{t('network:NetWizard.hostname')}<input id="net-hostname" bind:value={hostname} placeholder="webpc" autocomplete="off" spellcheck="false"></label>
      {#if here}
        <label>{t('network:NetWizard.authKey')}<input id="net-authkey" bind:value={authKey} type={reveal ? 'text' : 'password'} autocomplete="off" spellcheck="false"></label>
        <Check id="net-reveal" bind:checked={reveal}>{t('network:NetWizard.authKey.show')}</Check>
        <p class="note">{t('network:NetWizard.authKey.note')}</p>
      {:else if editing}
        <p class="note">{t('network:NetWizard.control.edit')}</p>
      {:else}
        <p class="note">{t('network:NetWizard.login.note')}</p>
      {/if}
    </section>
    <section id="net-step-tailcat" class="net-step" hidden={step !== 'tailcat'}>
      <Check id="net-tc-exit" bind:checked={tcExit}>{t('network:NetWizard.tailcat.exit')}</Check>
      <div id="net-tc-exit-fields" class="net-sub" hidden={!tcExit}>
        <ol class="net-steps">
          <li><T k="network:NetWizard.tailcat.exit.install">{#snippet a(text)}<a href="https://github.com/tailscale/tailcat" target="_blank" rel="noopener">{text}</a>{/snippet}</T></li>
          <li><T k="network:NetWizard.tailcat.exit.run">{#snippet code(text)}<code>{text}</code>{/snippet}</T></li>
          <!-- i18n-ignore-next: the placeholder is how an address starts, not words -->
          <li><label>{t('network:NetWizard.tailcat.exit.paste')}<input id="net-tailcat" bind:value={tailcat} type="password" placeholder="tc…" autocomplete="off" spellcheck="false"></label></li>
        </ol>
        <p class="note">{t('network:NetWizard.tailcat.exit.note')}</p>
      </div>
      <Check id="net-tc-serve" bind:checked={tcServe}>{t('network:NetWizard.tailcat.serve')}</Check>
      <div id="net-tc-serve-fields" class="net-sub" hidden={!tcServe}>
        <p class="note"><T k="network:NetWizard.tailcat.serve.note" params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}>{#snippet code(text)}<code>{text}</code>{/snippet}</T></p>
        <details id="net-tc-advanced" bind:open={advanced}><summary>{t('network:NetWizard.advanced')}</summary>
          <label>{t('network:NetWizard.relay')}<input id="net-tc-relay" bind:value={relay} disabled={tcExit} placeholder={t('network:NetWizard.relay.placeholder')} autocomplete="off" spellcheck="false"></label>
          <p class="note"><T k="network:NetWizard.relay.note">{#snippet a(text)}<a href="https://github.com/tailscale/tailscale/tree/main/cmd/derper" target="_blank" rel="noopener">{text}</a>{/snippet}</T></p>
          {#if editing}
            <div class="net-row"><button type="button" id="net-tc-forget" disabled={!identityKept} onclick={forget}>{t('network:NetWizard.newAddress')}</button></div>
            <p class="note">{t('network:NetWizard.newAddress.note')}</p>
          {/if}
        </details>
      </div>
    </section>
    {#if !editing && (step === 'tailscale' || step === 'tailcat' || step === 'local')}
      <Check id="net-keep" bind:checked={keep}>
        {t('network:NetWizard.keep')}
        {#snippet note()}<span id="net-keep-note">{keep ? t('network:NetWizard.keep.note') : t('network:NetWizard.keep.ephemeral')}</span>{/snippet}
      </Check>
    {/if}
    <p id="net-error" class="error" hidden={!formError}>{formError?.headline}{#each formError?.details ?? [] as d, i (i)}<br>{d}{/each}</p>
    {#snippet buttons()}
      <button type="button" id="net-back" hidden={!!editing || step === 'pick' || (step === 'kind' && !pickable)} onclick={back}>{t('network:NetWizard.back')}</button><span class="grow"></span>
      <button type="button" id="net-cancel" onclick={close}>{t('network:NetWizard.cancel')}</button>
      <button id="net-connect" class="primary" type="submit" disabled={working} hidden={step === 'kind' || (step === 'pick' && !picked)}>{submitLabel}</button>
    {/snippet}
  </Modal>

<style>
  /* A choice's numbered steps, which end at its field: the steps' words at the dialog's size, the field's label too. */
  .net-steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding-left: 20px; }
  .net-steps li > :is(details, p) { margin-top: 6px; }
  :global(#net-wizard) .net-steps label { color: var(--text); font-size: inherit; gap: 4px; }
</style>
