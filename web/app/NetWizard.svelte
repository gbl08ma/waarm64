<!--
  The Network wizard (docs/network-adapters.md §3.2), a dialog opened through `ui.netWizard`: attach a connection
  to a machine's adapter (one of the browser's, or a new one: New connection… first), make a new connection on its own,
  or edit one (what changes without a new node: a tailnet's hostname, tailcat's server and relay). A new connection is
  kept in this browser unless Keep is off (ephemeral: gone when the page closes). The toolbar's Network menu and the
  Machines page's Network tab and Connections open it; the page (web/app/main.ts) attaches and connects.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Check from './Check.svelte';
  import { preselect, type Connection } from './connections.ts';
  import type { PageNetwork } from './net-live.ts';
  import { DEFAULT_CONTROL, hasTailcatIdentity, parseControlURL, parseHostname, parseRelay, parseTailcatAddr, tailcatBuilt, tailscaleBuilt } from './network.ts';
  import { page, ui } from './ui.svelte.ts';
  import { parseLocalURL } from '../local-net.ts';
  import { installLines, RELEASE, SOURCE, targetName, TARGETS, thisTarget, type Target } from '../local-release.ts';

  let { net }: { net: PageNetwork } = $props();

  type Step = 'pick' | 'kind' | 'tailscale' | 'tailcat' | 'local';
  let wizard: HTMLDialogElement;
  let w = $state<NonNullable<typeof ui.netWizard>>({ mode: 'new' });
  let step = $state<Step>('kind');
  let formError = $state('');
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

  const kindText = (c: Connection) => `${c.kind === 'tailnet' ? `a tailnet (${new URL(c.tailnet!.controlURL).host})` : c.kind === 'local' ? 'the helper on this computer' : c.tailcat?.exit ? 'tailcat through a server' : 'tailcat, letting clients in'}${c.ephemeral ? ', ephemeral' : ''}`;

  async function begin(o: NonNullable<typeof ui.netWizard>) {
    w = o;
    formError = '';
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
    if (!wizard.open) wizard.showModal();
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
    formError = '';
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
      formError = String((err as Error).message ?? err);
    } finally {
      working = false;
    }
  }

  async function save() {
    if (step === 'local') {
      const u = parseLocalURL(localURL);
      if ('error' in u) return void (formError = u.error);
      formError = '';
      if (editing) {
        await page.netEdit({ ...editing, local: { url: u.url } });
        return close();
      }
      const c = await page.netCreate({ kind: 'local', ephemeral: !keep, local: { url: u.url } });
      return w.mode === 'attach' ? attach(c) : close();
    }
    if (step === 'pick') {
      const c = conns.find((x) => x.id === picked);
      if (!c) return void (formError = 'Choose a connection, or New connection….');
      return attach(c);
    }
    if (step === 'tailcat') {
      if (!tcExit && !tcServe) return void (formError = 'Choose at least one: going online through a computer of yours, or letting clients in.');
      const addr = tcExit ? parseTailcatAddr(tailcat) : { addr: '' };
      if ('error' in addr) return void (formError = addr.error);
      const r = tcServe && !tcExit ? parseRelay(relay) : { relay: relay.trim() };
      if ('error' in r) return void (formError = r.error);
      formError = '';
      if (!(await tailcatBuilt())) return void (formError = "The tailnet client isn't built on this server. Start the page with `npm run serve` or `npm start` (they build it), or run net/ts/build.sh.");
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
    if ('error' in url) return void (formError = url.error);
    if ('error' in host) return void (formError = host.error);
    formError = '';
    const key = authKey.trim();
    if (!(await tailscaleBuilt())) return void (formError = "The Tailscale client isn't built on this server. Start the page with `npm run serve` or `npm start` (they build it), or run net/ts/build.sh.");
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

  const title = $derived(editing ? `Edit ${editing.name}` : step === 'pick' ? `Network adapter ${(w.adapter ?? 0) + 1}` : step === 'kind' ? 'A new connection' : step === 'tailscale' ? 'A new connection: a tailnet' : step === 'local' ? 'A new connection: this computer' : 'A new connection: tailcat');
  /** The install lines shown first: this browser's platform's, else Linux x86-64's. */
  const shown = $derived(target ?? TARGETS[0]);
  const submitLabel = $derived(editing ? 'Save' : w.mode === 'new' ? 'Create' : here ? 'Connect' : 'Attach');
</script>

<dialog id="net-wizard" aria-labelledby="net-title" bind:this={wizard} onclose={() => { ui.netWizard = undefined; }}>
  <form id="net-form" onsubmit={submit}>
    <h2 id="net-title">{title}</h2>
    <section id="net-step-pick" class="net-step" hidden={step !== 'pick'}>
      <p class="net-note">Which connection should the adapter have? A connection is kept by this browser, for any of its machines: one running machine has it at a time.</p>
      <button type="button" class="net-choice" id="net-pick-new" onclick={() => showStep('kind')}><b>New connection…</b><span>A tailnet, tailcat, or this computer.</span></button>
      {#each conns as c (c.id)}
        <button type="button" class="net-choice" id={`net-pick-${c.id}`} data-connection={c.id} aria-pressed={picked === c.id} onclick={() => (picked = c.id)} ondblclick={() => { picked = c.id; wizard.querySelector<HTMLButtonElement>('#net-connect')?.click(); }}>
          <b>{c.name}</b><span>{kindText(c)}{net.held.has(c.id) ? `; in use by ${holders[c.id] ?? 'a machine in another tab'}` : ''}</span>
        </button>
      {/each}
    </section>
    <section id="net-step-kind" class="net-step" hidden={step !== 'kind'}>
      <p class="net-note">How should the machine reach a network? Its network adapter is always there: connecting doesn't restart it.</p>
      <button type="button" class="net-choice" id="net-pick-tailnet" onclick={() => showStep('tailscale')}><b>A tailnet</b><span>Tailscale, or your Headscale: the machine joins as a device of its own, reaches the other devices by name, and the internet through an exit node.</span></button>
      <button type="button" class="net-choice" id="net-pick-tailcat" onclick={() => showStep('tailcat')}><b>tailcat (no account)</b><span>A computer of yours shares its network with the machine, and other computers can reach the machine (ssh, any port) through an address of its own.</span></button>
      <button type="button" class="net-choice" id="net-pick-local" onclick={() => showStep('local')}><b>This computer (webpc-net)</b><span>A small program you run here gives the machine this computer's network: the internet and your LAN at this computer's own speed, no relay and no account.</span></button>
    </section>
    <section id="net-step-local" class="net-step" hidden={step !== 'local'}>
      <label>The helper's link<input id="net-local-url" bind:value={localURL} type="password" placeholder="https://vm.tny.im/#net=ws://127.0.0.1:8740/…" autocomplete="off" spellcheck="false"></label>
      <p class="net-note">Run <a href={SOURCE} target="_blank" rel="noopener">webpc-net</a> on this computer and paste the link it prints (opening the link does it too). The link has a secret in it: whoever has it, on a page the helper accepts, uses your network. The browser asks once whether this site may reach devices on your local network: allow it.</p>
      {#if !editing}
        {#if RELEASE}
          <details id="net-local-install" open={!localURL}><summary>Install webpc-net {RELEASE.version}</summary>
            <label>For<select id="net-local-target" value={`${shown.os}-${shown.arch}`} onchange={(e) => { target = TARGETS.find((t) => `${t.os}-${t.arch}` === e.currentTarget.value); }}>
              {#each TARGETS as t (`${t.os}-${t.arch}`)}<option value={`${t.os}-${t.arch}`}>{targetName(t)}</option>{/each}
            </select></label>
            <pre id="net-local-lines">{installLines(RELEASE, shown)}</pre>
            <p class="net-note">In a terminal{shown.os === 'windows' ? ' (PowerShell)' : ''}: it downloads webpc-net, checks it against its published SHA-256 and runs it.</p>
          </details>
        {:else}
          <p id="net-local-install" class="net-note">No release yet: build it from <a href={SOURCE} target="_blank" rel="noopener">its source</a> (webpc's <code>net/webpc-net</code>, <code>go run .</code>).</p>
        {/if}
      {/if}
    </section>
    <section id="net-step-tailnet" class="net-step" hidden={step !== 'tailscale'}>
      <label>Control server<input id="net-control" bind:value={control} disabled={!!editing} placeholder="Tailscale (default), or a Headscale's URL" autocomplete="off" spellcheck="false"></label>
      <label>Hostname<input id="net-hostname" bind:value={hostname} placeholder="webpc" autocomplete="off" spellcheck="false"></label>
      {#if here}
        <label>Auth key (optional, never saved)<input id="net-authkey" bind:value={authKey} type={reveal ? 'text' : 'password'} autocomplete="off" spellcheck="false"></label>
        <Check id="net-reveal" bind:checked={reveal}>Show the auth key</Check>
        <p class="net-note">Without an auth key you log in, in a new tab; with one there's no login, and the key isn't kept. A kept connection's node stays on the tailnet over reloads. A Headscale must answer <code>/key</code> with CORS headers.</p>
      {:else if editing}
        <p class="net-note">Another control server is another node: make a new connection for it.</p>
      {:else}
        <p class="net-note">The machine logs in, in a new tab, when it first connects. A Headscale must answer <code>/key</code> with CORS headers.</p>
      {/if}
    </section>
    <section id="net-step-tailcat" class="net-step" hidden={step !== 'tailcat'}>
      <Check id="net-tc-exit" bind:checked={tcExit}>Go online through a computer of mine</Check>
      <div id="net-tc-exit-fields" class="net-sub" hidden={!tcExit}>
        <label>Its tailcat address<input id="net-tailcat" bind:value={tailcat} type="password" placeholder="tc…" autocomplete="off" spellcheck="false"></label>
        <p class="net-note">On that computer run <code>tailcat serve exit-node</code> (<a href="https://github.com/tailscale/tailcat" target="_blank" rel="noopener">tailcat</a>) and paste the address it prints: the machine reaches what that computer reaches, its LAN and the internet. Keep the address to yourself: it lets anyone in. A kept connection keeps it in this browser.</p>
      </div>
      <Check id="net-tc-serve" bind:checked={tcServe}>Let tailcat clients in to this machine</Check>
      <div id="net-tc-serve-fields" class="net-sub" hidden={!tcServe}>
        <p class="net-note">The connection gets a tailcat address of its own. With it another computer runs <code>tailcat ssh &lt;address&gt;</code> to log in to the guest's sshd, or <code>tailcat &lt;address&gt; &lt;port&gt;</code> for any port the guest listens on.</p>
        <details id="net-tc-advanced" bind:open={advanced}><summary>Advanced</summary>
          <label>Relay for clients<input id="net-tc-relay" bind:value={relay} disabled={tcExit} placeholder="tailcat's public relays (the nearest)" autocomplete="off" spellcheck="false"></label>
          <p class="net-note">Your own <a href="https://github.com/tailscale/tailscale/tree/main/cmd/derper" target="_blank" rel="noopener">derper</a>'s host or host:port: faster than tailcat's public relays, which are rate-limited. Used when the machine doesn't go online through a computer of yours (that computer's relay serves then).</p>
          {#if editing}
            <div class="net-row"><button type="button" id="net-tc-forget" disabled={!identityKept} onclick={forget}>New address</button></div>
            <p class="net-note">Forgets the connection's address: whoever has it can't come in any more.</p>
          {/if}
        </details>
      </div>
    </section>
    {#if !editing && (step === 'tailscale' || step === 'tailcat' || step === 'local')}
      <Check id="net-keep" bind:checked={keep}>
        Keep this connection in this browser
        {#snippet note()}<span id="net-keep-note">{keep ? 'Any machine here can use it again, and it comes back after a reload without a login.' : "Ephemeral: kept nowhere, it goes when this page closes (a tailnet's node then leaves the tailnet, and a served address stops working)."}</span>{/snippet}
      </Check>
    {/if}
    <p id="net-error" class="net-note" hidden={!formError}>{formError}</p>
    <div class="net-buttons">
      <button type="button" id="net-back" hidden={!!editing || step === 'pick' || (step === 'kind' && !pickable)} onclick={back}>Back</button><span class="grow"></span>
      <button type="button" id="net-cancel" onclick={close}>Cancel</button>
      <button id="net-connect" type="submit" disabled={working} hidden={step === 'kind' || (step === 'pick' && !picked)}>{submitLabel}</button>
    </div>
  </form>
</dialog>
