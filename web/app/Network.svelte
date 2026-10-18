<!--
  The network (docs/frontend.md "Network"): a machine with `network` always has a card (it costs no boot time). The
  Network wizard (a dialog) picks a tailnet or tailcat and takes its settings; the Network menu shows the connection and
  what can be done with it (the exit node, the machine's tailcat address, Disconnect, Log out, Change…).
-->
<script lang="ts">
  import Menu from './Menu.svelte';
  import { ask } from './ask.svelte.ts';
  import { DEFAULT_SETTINGS, forgetTailcatIdentity, hasTailcatIdentity, parseControlURL, parseHostname, parseRelay, parseTailcatAddr, tailcatBuilt, tailscaleBuilt, type Network, type NetworkSettings } from './network.ts';
  import { remember, settings } from './settings.ts';
  import { ui } from './ui.svelte.ts';

  let { network }: { network: Network } = $props();

  const netSettings = (): NetworkSettings => ({ ...DEFAULT_SETTINGS, ...settings().net });
  // The menu redraws when the client says something changed (`ui.net`), and when the settings do (`saved`).
  let saved = $state(0);
  const keep = (s: Partial<NetworkSettings>) => { remember({ net: { ...netSettings(), ...s } }); saved++; };
  const v = $derived((void ui.net, network.view()));
  const s = $derived((void saved, void ui.net, netSettings()));
  const active = $derived((void ui.net, void saved, network.active()));

  let open = $state(false);
  let menuError = $state('');
  let lastPhase = '';
  $effect(() => {
    if (v.phase === 'login' && lastPhase !== 'login') open = true; // the user has something to do
    lastPhase = v.phase;
  });

  let servedShown = $state(false);
  let servedInput = $state<HTMLInputElement>();
  let exitSelect = $state<HTMLSelectElement>();
  const exitValue = $derived(v.exitNodes.find((e) => e.use)?.id ?? '');

  // The wizard.
  let wizard: HTMLDialogElement;
  let step = $state<'kind' | 'tailscale' | 'tailcat'>('kind');
  let formError = $state('');
  let control = $state(''), hostname = $state(''), authKey = $state(''), reveal = $state(false);
  let tcExit = $state(true), tcServe = $state(false), tailcat = $state(''), relay = $state('');
  let advanced = $state(false);
  let identityKept = $state(false);

  function showStep(to: typeof step) {
    step = to;
    formError = '';
    if (to === 'tailcat') void hasTailcatIdentity().then((kept) => { identityKept = kept; });
    queueMicrotask(() => document.getElementById(to === 'kind' ? `net-pick-${netSettings().kind === 'tailcat' ? 'tailcat' : 'tailnet'}` : to === 'tailscale' ? 'net-control' : 'net-tc-exit')?.focus());
  }
  /** Opens the wizard with the saved settings: at the choice, or at a kind's step. */
  function openWizard(at: typeof step = 'kind') {
    const n = netSettings();
    control = n.controlURL;
    hostname = n.hostname;
    authKey = '';
    tcExit = n.tailcatExit;
    tcServe = n.tailcatServe;
    tailcat = '';
    relay = n.tailcatRelay;
    advanced = !!n.tailcatRelay;
    open = false;
    if (!wizard.open) wizard.showModal();
    showStep(at);
  }
  /** Connects with the wizard's settings, after the running client (if any) stops; then the menu shows how it goes. */
  async function connectWith(c: Parameters<Network['connect']>[0]) {
    try {
      if (network.active()) await network.disconnect();
      network.connect(c);
      wizard.close();
      menuError = '';
      open = true;
    } catch (err) {
      formError = String((err as Error).message ?? err);
    }
    saved++;
  }
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (step === 'tailcat') {
      if (!tcExit && !tcServe) return void (formError = 'Choose at least one: going online through a computer of yours, or letting clients in.');
      const addr = tcExit ? parseTailcatAddr(tailcat) : { addr: '' };
      if ('error' in addr) return void (formError = addr.error);
      const r = tcServe && !tcExit ? parseRelay(relay) : { relay: '' };
      if ('error' in r) return void (formError = r.error);
      formError = '';
      if (!(await tailcatBuilt())) return void (formError = "The tailnet client isn't built on this server. Start the page with `npm run serve` or `npm start` (they build it), or run net/ts/build.sh.");
      // The server's address is a secret and isn't kept; a served machine's own address is, so it reconnects by itself.
      keep({ kind: 'tailcat', tailcatExit: tcExit, tailcatServe: tcServe, tailcatRelay: relay.trim(), autoconnect: tcServe && !tcExit });
      return connectWith({ controlURL: '', hostname: '', tailcat: addr.addr || undefined, tailcatServe: tcServe ? { relay: tcExit ? '' : r.relay } : undefined });
    }
    const url = parseControlURL(control);
    const host = parseHostname(hostname);
    if ('error' in url) return void (formError = url.error);
    if ('error' in host) return void (formError = host.error);
    formError = '';
    const key = authKey.trim();
    if (!(await tailscaleBuilt())) return void (formError = "The Tailscale client isn't built on this server. Start the page with `npm run serve` or `npm start` (they build it), or run net/ts/build.sh.");
    keep({ kind: 'tailscale', controlURL: control.trim(), hostname: hostname.trim(), autoconnect: !key, keyed: !!key });
    authKey = '';
    return connectWith({ controlURL: url.url, hostname: host.hostname, authKey: key || undefined, exitNode: netSettings().exitNode });
  }
  function chooseExit() {
    const id = exitSelect!.value;
    exitSelect!.blur();
    network.setExitNode(id).then(
      () => { keep({ exitNode: id }); menuError = ''; },
      (err) => { menuError = `Couldn't ${id ? 'use that exit node' : 'stop using the exit node'}: ${(err as Error).message ?? err}`; },
    ).finally(() => saved++);
  }
  async function forget() {
    if (!(await ask.confirm("Forget this machine's tailcat address? Whoever has it can't come in any more, and the machine gets a new one when it next lets clients in.", { ok: 'Forget it', danger: true }))) return;
    await forgetTailcatIdentity();
    identityKept = await hasTailcatIdentity();
  }
  async function logout() {
    if (!(await ask.confirm('Log out? This machine is removed from the network and its keys are forgotten here; connecting again logs in as a new node.', { ok: 'Log out', danger: true }))) return;
    keep({ autoconnect: false });
    await network.logout();
    saved++;
  }
  const copyServed = () => { void navigator.clipboard.writeText(v.served ?? '').catch(() => { servedShown = true; queueMicrotask(() => servedInput?.select()); }); };
</script>

<Menu id="network" icon="network" title="The machine's network: a tailnet, or tailcat" bind:open panel data-phase={v.phase}>
  {#snippet badge()}<span class="dot" aria-hidden="true"></span>{/snippet}
  <p id="net-status">{v.text}</p>
  <a id="net-login" target="_blank" rel="noopener" href={v.loginURL} hidden={!v.loginURL}>Log in…</a>
  <label id="net-exit-label" hidden={v.exitNodes.length === 0}>Internet through
    <select id="net-exit" bind:this={exitSelect} value={exitValue} onchange={chooseExit}>
      <option value="">Nothing: directly</option>
      {#each v.exitNodes as e (e.id)}<option value={e.id}>{e.online ? e.name : `${e.name} (offline)`}</option>{/each}
    </select>
  </label>
  <div id="net-served" hidden={!v.served}>
    <label>This machine's tailcat address<input id="net-served-addr" type={servedShown ? 'text' : 'password'} readonly spellcheck="false" value={v.served ?? ''} bind:this={servedInput}></label>
    <div class="net-row"><button id="net-served-copy" onclick={copyServed}>Copy</button><button id="net-served-show" onclick={() => (servedShown = !servedShown)}>{servedShown ? 'Hide' : 'Show'}</button></div>
    <p class="net-note">On another computer: <code>tailcat ssh &lt;address&gt;</code> logs in to the guest's sshd, <code>tailcat &lt;address&gt; &lt;port&gt;</code> reaches any port it listens on. Anyone with the address gets in.</p>
  </div>
  <p id="net-menu-error" class="net-note" hidden={!menuError}>{menuError}</p>
  <div id="net-actions">
    <button id="net-setup" onclick={() => openWizard()}>{active ? 'Change…' : 'Connect…'}</button>
    <button id="net-disconnect" hidden={!active} onclick={() => { keep({ autoconnect: false }); void network.disconnect().then(() => saved++); }}>Disconnect</button>
    <button id="net-logout" title="Remove this machine from the tailnet and forget its keys" hidden={!active || s.keyed || s.kind === 'tailcat'} onclick={logout}>Log out</button>
  </div>
  <p id="net-hint" class="net-note">{!active && s.kind === 'tailscale' && s.keyed ? "An auth key isn't kept: enter it again to connect." : ''}</p>
</Menu>

<dialog id="net-wizard" aria-labelledby="net-title" bind:this={wizard}>
  <form id="net-form" onsubmit={submit}>
    <h2 id="net-title">{step === 'kind' ? 'Network' : step === 'tailscale' ? 'Network: a tailnet' : 'Network: tailcat'}</h2>
    <section id="net-step-kind" class="net-step" hidden={step !== 'kind'}>
      <p class="net-note">How should this machine reach a network? Its network card is always there: connecting doesn't restart it.</p>
      <button type="button" class="net-choice" id="net-pick-tailnet" onclick={() => { keep({ kind: 'tailscale' }); showStep('tailscale'); }}><b>A tailnet</b><span>Tailscale, or your Headscale: the machine joins as a device of its own, reaches the other devices by name, and the internet through an exit node.</span></button>
      <button type="button" class="net-choice" id="net-pick-tailcat" onclick={() => { keep({ kind: 'tailcat' }); showStep('tailcat'); }}><b>tailcat (no account)</b><span>A computer of yours shares its network with the machine, and other computers can reach the machine (ssh, any port) through an address of its own.</span></button>
    </section>
    <section id="net-step-tailnet" class="net-step" hidden={step !== 'tailscale'}>
      <label>Control server<input id="net-control" bind:value={control} placeholder="Tailscale (default), or a Headscale's URL" autocomplete="off" spellcheck="false"></label>
      <label>Hostname<input id="net-hostname" bind:value={hostname} placeholder="webpc" autocomplete="off" spellcheck="false"></label>
      <label>Auth key (optional, never saved)<input id="net-authkey" bind:value={authKey} type={reveal ? 'text' : 'password'} autocomplete="off" spellcheck="false"></label>
      <label class="net-check"><input id="net-reveal" type="checkbox" bind:checked={reveal}> Show the auth key</label>
      <p class="net-note">Without an auth key you log in, in a new tab, and the machine stays on the tailnet over reloads. With one there's no login, the key isn't kept and the node is ephemeral. A Headscale must answer <code>/key</code> with CORS headers.</p>
    </section>
    <section id="net-step-tailcat" class="net-step" hidden={step !== 'tailcat'}>
      <label class="net-check"><input id="net-tc-exit" type="checkbox" bind:checked={tcExit}> Go online through a computer of mine</label>
      <div id="net-tc-exit-fields" class="net-sub" hidden={!tcExit}>
        <label>Its tailcat address (never saved)<input id="net-tailcat" bind:value={tailcat} type="password" placeholder="tc…" autocomplete="off" spellcheck="false"></label>
        <p class="net-note">On that computer run <code>tailcat serve exit-node</code> (<a href="https://github.com/tailscale/tailcat" target="_blank" rel="noopener">tailcat</a>) and paste the address it prints: the machine reaches what that computer reaches, its LAN and the internet. Keep the address to yourself: it lets anyone in.</p>
      </div>
      <label class="net-check"><input id="net-tc-serve" type="checkbox" bind:checked={tcServe}> Let tailcat clients in to this machine</label>
      <div id="net-tc-serve-fields" class="net-sub" hidden={!tcServe}>
        <p class="net-note">The machine gets a tailcat address of its own, kept in this browser. With it another computer runs <code>tailcat ssh &lt;address&gt;</code> to log in to the guest's sshd, or <code>tailcat &lt;address&gt; &lt;port&gt;</code> for any port the guest listens on.</p>
        <details id="net-tc-advanced" bind:open={advanced}><summary>Advanced</summary>
          <label>Relay for clients<input id="net-tc-relay" bind:value={relay} disabled={tcExit} placeholder="tailcat's public relays (the nearest)" autocomplete="off" spellcheck="false"></label>
          <p class="net-note">Your own <a href="https://github.com/tailscale/tailscale/tree/main/cmd/derper" target="_blank" rel="noopener">derper</a>'s host or host:port: faster than tailcat's public relays, which are rate-limited. Used when the machine doesn't go online through a computer of yours (that computer's relay serves then).</p>
          <div class="net-row"><button type="button" id="net-tc-forget" disabled={!identityKept} onclick={forget}>New address</button></div>
          <p class="net-note">Forgets the machine's address: whoever has it can't come in any more.</p>
        </details>
      </div>
    </section>
    <p id="net-error" class="net-note" hidden={!formError}>{formError}</p>
    <div class="net-buttons">
      <button type="button" id="net-back" hidden={step === 'kind'} onclick={() => showStep('kind')}>Back</button><span class="grow"></span>
      <button type="button" id="net-cancel" onclick={() => wizard.close()}>Cancel</button>
      <button id="net-connect" type="submit" hidden={step === 'kind'}>Connect</button>
    </div>
  </form>
</dialog>
