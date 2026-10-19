<!--
  The toolbar's Network menu (docs/frontend.md "Network", docs/network-adapters.md §3.3): a section per network
  adapter of the page's machine (one adapter: no heading), each showing its connection and what can be done with it
  (Log in…, the exit node, the machine's tailcat address, Connect, Disconnect, Log out, Change connection…, which is
  the Network wizard, web/app/NetWizard.svelte). Adapter 1's elements keep the ids they always had; adapter n's end in
  `-<n-1>`. Logic is web/app/net-live.ts's, through `page`.
-->
<script lang="ts">
  import Menu from './Menu.svelte';
  import { ask } from './ask.svelte.ts';
  import type { PageNetwork } from './net-live.ts';
  import { page, ui } from './ui.svelte.ts';

  let { net }: { net: PageNetwork } = $props();

  const views = $derived((void ui.net, net.views()));
  /** What the toolbar's dot shows: the default way out's state, else adapter 1's. */
  const shown = $derived(views.find((a) => a.primary) ?? views[0]);

  let open = $state(false);
  let errors = $state<Record<number, string>>({});
  let revealed = $state<Record<number, boolean>>({});
  let lastPhases: string[] = [];
  $effect(() => {
    const phases = views.map((a) => a.view.phase);
    if (phases.some((p, i) => p === 'login' && lastPhases[i] !== 'login')) open = true; // the user has something to do
    lastPhases = phases;
  });
  let opened = 0;
  $effect(() => {
    if (ui.netMenu !== opened) { opened = ui.netMenu; open = true; errors = {}; }
  });

  const sfx = (i: number) => (i ? `-${i}` : '');
  async function act(i: number, f: () => Promise<unknown>) {
    try {
      await f();
      errors = { ...errors, [i]: '' };
    } catch (e) {
      errors = { ...errors, [i]: String((e as Error).message ?? e) };
    }
  }
  function wizard(i: number) {
    open = false;
    page.netWizard({ mode: 'attach', machine: ui.current, adapter: i, here: true });
  }
  function chooseExit(i: number, e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const id = select.value;
    select.blur();
    void page.netExit(i, id).then(
      () => { errors = { ...errors, [i]: '' }; },
      (err) => { errors = { ...errors, [i]: `Couldn't ${id ? 'use that exit node' : 'stop using the exit node'}: ${(err as Error).message ?? err}` }; },
    );
  }
  async function logout(i: number) {
    if (!(await ask.confirm('Log out? This machine is removed from the network and its keys are forgotten here; connecting again logs in as a new node.', { ok: 'Log out', danger: true }))) return;
    await act(i, () => page.netLogout(i));
  }
  function copyServed(i: number, addr: string) {
    void navigator.clipboard.writeText(addr).catch(() => {
      revealed = { ...revealed, [i]: true };
      queueMicrotask(() => (document.getElementById(`net-served-addr${sfx(i)}`) as HTMLInputElement | null)?.select());
    });
  }
</script>

<Menu id="network" icon="network" title="The machine's network: a tailnet, or tailcat, on each adapter" bind:open panel data-phase={shown?.view.phase ?? 'off'}>
  {#snippet badge()}<span class="dot" aria-hidden="true"></span>{/snippet}
  {#each views as a (a.index)}
    {@const v = a.view}
    {@const s = sfx(a.index)}
    <section class="net-adapter" data-adapter={a.index} data-phase={v.phase}>
      {#if views.length > 1}<h3 class="net-head"><span class="dot" aria-hidden="true"></span>Adapter {a.index + 1}{a.primary ? ' (the default way out)' : ''}</h3>{/if}
      <p id={`net-status${s}`} class="net-status">{v.text}</p>
      <p id={`net-conn${s}`} class="net-note">{a.connection ? `${a.connection.name}${a.connection.ephemeral ? ' (ephemeral: not kept)' : ''}` : 'No connection attached'}</p>
      <a id={`net-login${s}`} class="net-login" target="_blank" rel="noopener" href={v.loginURL} hidden={!v.loginURL}>Log in…</a>
      <label id={`net-exit-label${s}`} hidden={v.exitNodes.length === 0}>Internet through
        <select id={`net-exit${s}`} value={v.exitNodes.find((e) => e.use)?.id ?? ''} onchange={(e) => chooseExit(a.index, e)}>
          <option value="">Nothing: directly</option>
          {#each v.exitNodes as e (e.id)}<option value={e.id}>{e.online ? e.name : `${e.name} (offline)`}</option>{/each}
        </select>
      </label>
      <div id={`net-served${s}`} hidden={!v.served}>
        <label>This machine's tailcat address<input id={`net-served-addr${s}`} type={revealed[a.index] ? 'text' : 'password'} readonly spellcheck="false" value={v.served ?? ''}></label>
        <div class="net-row"><button id={`net-served-copy${s}`} onclick={() => copyServed(a.index, v.served ?? '')}>Copy</button><button id={`net-served-show${s}`} onclick={() => (revealed = { ...revealed, [a.index]: !revealed[a.index] })}>{revealed[a.index] ? 'Hide' : 'Show'}</button></div>
        <p class="net-note">On another computer: <code>tailcat ssh &lt;address&gt;</code> logs in to the guest's sshd, <code>tailcat &lt;address&gt; &lt;port&gt;</code> reaches any port it listens on. Anyone with the address gets in.</p>
      </div>
      <p id={`net-menu-error${s}`} class="net-note net-menu-error" hidden={!errors[a.index]}>{errors[a.index]}</p>
      <div id={`net-actions${s}`} class="net-actions">
        {#if a.connection && !a.active}<button id={`net-connect-now${s}`} onclick={() => act(a.index, () => page.netConnect(a.index))}>Connect</button>{/if}
        <button id={`net-setup${s}`} onclick={() => wizard(a.index)}>{a.connection ? 'Change connection…' : 'Connect…'}</button>
        <button id={`net-disconnect${s}`} hidden={!a.active} onclick={() => act(a.index, () => page.netDisconnect(a.index))}>Disconnect</button>
        <button id={`net-logout${s}`} title="Remove this machine from the tailnet and forget its keys" hidden={!a.active || a.connection?.kind !== 'tailnet'} onclick={() => logout(a.index)}>Log out</button>
      </div>
      <p id={`net-hint${s}`} class="net-note">{a.note ?? ''}</p>
    </section>
  {/each}
</Menu>
