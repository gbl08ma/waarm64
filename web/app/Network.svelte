<!--
  The toolbar's Network menu (docs/frontend.md "Network", docs/network-adapters.md §3.3): a section per network
  adapter of the page's machine (one adapter: no heading), each showing its connection and what can be done with it
  (Log in…, the exit node, the peers' subnet routes, the machine's tailcat address and key, its name in a room and the
  room's link to copy, Connect, Retry, Disconnect, Log out, Change connection…, which is
  the Network wizard, web/app/NetWizard.svelte). Adapter 1's elements keep the ids they always had; adapter n's end in
  `-<n-1>`. Logic is web/app/net-live.ts's, through `page`.
-->
<script lang="ts">
  import Menu from './Menu.svelte';
  import Check from './Check.svelte';
  import T from './T.svelte';
  import { describe, t, type Described } from '../i18n.ts';
  import { MsgError } from '../msg.ts';
  import { ask } from './ask.svelte.ts';
  import type { PageNetwork } from './net-live.ts';
  import { page, ui } from './ui.svelte.ts';

  let { net }: { net: PageNetwork } = $props();

  const views = $derived((void ui.net, net.views()));
  /** What the toolbar's dot shows: the default way out's state, else adapter 1's. */
  const shown = $derived(views.find((a) => a.primary) ?? views[0]);

  let open = $state(false);
  let errors = $state<Record<number, Described | undefined>>({});
  let revealed = $state<Record<number, boolean>>({});
  /** Adapters whose room link is shown in a field: the clipboard refused it, so the user copies it from there. */
  let linkShown = $state<Record<number, boolean>>({});
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
      errors = { ...errors, [i]: undefined };
    } catch (e) {
      errors = { ...errors, [i]: describe(e) };
    }
  }
  function wizard(i: number) {
    open = false;
    page.netWizard({ mode: 'attach', machine: ui.current, adapter: i, here: views[i]?.on });
  }
  function chooseExit(i: number, e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const id = select.value;
    select.blur();
    void page.netExit(i, id).then(
      () => { errors = { ...errors, [i]: undefined }; },
      (err) => { errors = { ...errors, [i]: describe(id ? new MsgError('network:Network.exitNode.failed', undefined, { cause: err }) : new MsgError('network:Network.exitNode.stopFailed', undefined, { cause: err })) }; },
    );
  }
  async function logout(i: number) {
    if (!(await ask.confirm(t('network:Network.logout.confirm'), { ok: t('network:Network.logout'), danger: true }))) return;
    await act(i, () => page.netLogout(i));
  }
  function copyKey(i: number, key: string) {
    void navigator.clipboard.writeText(key).catch(() => (document.getElementById(`net-key-value${sfx(i)}`) as HTMLInputElement | null)?.select());
  }
  /** Copies a room's words (the machine's name, or the room's link); where the clipboard refuses, selects them in their field. */
  function copyRoom(i: number, words: string, link: boolean) {
    void navigator.clipboard.writeText(words).catch(() => {
      if (link) linkShown = { ...linkShown, [i]: true };
      queueMicrotask(() => (document.getElementById(`${link ? 'net-room-link-value' : 'net-room-name'}${sfx(i)}`) as HTMLInputElement | null)?.select());
    });
  }
  function copyServed(i: number, addr: string) {
    void navigator.clipboard.writeText(addr).catch(() => {
      revealed = { ...revealed, [i]: true };
      queueMicrotask(() => (document.getElementById(`net-served-addr${sfx(i)}`) as HTMLInputElement | null)?.select());
    });
  }
</script>

<Menu id="network" icon="network" title={t('network:Network.title')} bind:open panel data-phase={shown?.view.phase ?? 'off'}>
  {#snippet badge()}<span class="dot" aria-hidden="true"></span>{/snippet}
  {#each views as a (a.index)}
    {@const v = a.view}
    {@const s = sfx(a.index)}
    <section class="net-adapter" data-adapter={a.index} data-phase={v.phase}>
      {#if views.length > 1}<h3 class="net-head"><span class="dot" aria-hidden="true"></span>{a.primary ? t('network:Network.adapter.primary', { adapter: a.index + 1 }) : t('network:Network.adapter', { adapter: a.index + 1 })}</h3>{/if}
      <p id={`net-status${s}`} class="net-status">{v.text}{#each v.details ?? [] as d, k (k)}<br><span class="net-detail">{d}</span>{/each}</p>
      <p id={`net-conn${s}`} class="net-note">{a.connection ? (a.connection.ephemeral ? t('network:Network.connection.ephemeral', { name: a.connection.name }) : a.connection.name) : t('network:Network.noConnection')}</p>
      <a id={`net-login${s}`} class="net-login" target="_blank" rel="noopener" href={v.loginURL} hidden={!v.loginURL}>{t('network:Network.login')}</a>
      <label id={`net-exit-label${s}`} hidden={v.exitNodes.length === 0}>{t('network:Network.exitNode')}
        <select id={`net-exit${s}`} value={v.exitNodes.find((e) => e.use)?.id ?? ''} onchange={(e) => chooseExit(a.index, e)}>
          <option value="">{t('network:Network.exitNode.none')}</option>
          {#each v.exitNodes as e (e.id)}<option value={e.id}>{e.online ? e.name : t('network:Network.exitNode.offline', { name: e.name })}</option>{/each}
        </select>
      </label>
      <div id={`net-routes-label${s}`} hidden={!v.subnets}>
        <Check id={`net-routes${s}`} checked={v.subnets?.on ?? true} onchange={(on) => act(a.index, () => page.netRoutes(a.index, on))} title={v.subnets?.routes.join(', ')}>
          {(v.subnets?.routes.length ?? 0) > 2 ? t('network:Network.routes.more', { routes: v.subnets?.routes.slice(0, 2) }) : t('network:Network.routes', { routes: v.subnets?.routes ?? [] })}
        </Check>
      </div>
      <div id={`net-served${s}`} class="net-group" hidden={!v.served}>
        <label>{t('network:Network.served')}<input id={`net-served-addr${s}`} type={revealed[a.index] ? 'text' : 'password'} readonly spellcheck="false" value={v.served ?? ''}></label>
        <div class="net-row"><button id={`net-served-copy${s}`} onclick={() => copyServed(a.index, v.served ?? '')}>{t('network:Network.copy')}</button><button id={`net-served-show${s}`} onclick={() => (revealed = { ...revealed, [a.index]: !revealed[a.index] })}>{revealed[a.index] ? t('network:Network.hide') : t('network:Network.show')}</button></div>
        <p class="net-note"><T k="network:Network.served.note" params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}>{#snippet code(text)}<code>{text}</code>{/snippet}</T></p>
      </div>
      <div id={`net-key${s}`} class="net-group" hidden={!v.tailcatKey}>
        <label>{t('network:Network.key')}<input id={`net-key-value${s}`} type="text" readonly spellcheck="false" value={v.tailcatKey ?? ''}></label>
        <div class="net-row"><button id={`net-key-copy${s}`} onclick={() => copyKey(a.index, v.tailcatKey ?? '')}>{t('network:Network.copy')}</button></div>
        <p class="net-note"><T k="network:Network.key.note" params={{ allow: `tailcat serve --allow=${v.tailcatKey ?? ''} exit-node` }}>{#snippet code(text)}<code>{text}</code>{/snippet}</T></p>
      </div>
      <div id={`net-room${s}`} class="net-group" hidden={!v.room}>
        <label>{t('network:Network.room.name')}<input id={`net-room-name${s}`} type="text" readonly spellcheck="false" value={v.room?.name ?? ''}></label>
        <div class="net-row"><button id={`net-room-name-copy${s}`} onclick={() => copyRoom(a.index, v.room?.name ?? '', false)}>{t('network:Network.copy')}</button><button id={`net-room-link-copy${s}`} title={t('network:Network.room.copyLink.title')} onclick={() => copyRoom(a.index, v.room?.link ?? '', true)}>{t('network:Network.room.copyLink')}</button></div>
        {#if linkShown[a.index]}<label>{t('network:Network.room.link')}<input id={`net-room-link-value${s}`} type="text" readonly spellcheck="false" value={v.room?.link ?? ''}></label>{/if}
        <p class="net-note">{v.room?.incoming ? t('network:Network.room.note') : t('network:Network.room.note.off')}</p>
      </div>
      <p id={`net-menu-error${s}`} class="net-note net-menu-error" hidden={!errors[a.index]}>{errors[a.index]?.headline}{#each errors[a.index]?.details ?? [] as d, k (k)}<br>{d}{/each}</p>
      <div id={`net-actions${s}`} class="net-actions">
        {#if a.connection && !a.active && a.on}<button id={`net-connect-now${s}`} onclick={() => act(a.index, () => page.netConnect(a.index))}>{t('network:Network.connect')}</button>{/if}
        {#if a.connection && a.active && v.phase === 'error'}<button id={`net-retry${s}`} onclick={() => act(a.index, async () => { await page.netDisconnect(a.index); await page.netConnect(a.index); })}>{t('network:Network.retry')}</button>{/if}
        <button id={`net-setup${s}`} onclick={() => wizard(a.index)}>{a.connection ? t('network:Network.change') : t('network:Network.setup')}</button>
        <button id={`net-disconnect${s}`} hidden={!a.active} onclick={() => act(a.index, () => page.netDisconnect(a.index))}>{t('network:Network.disconnect')}</button>
        <button id={`net-logout${s}`} title={t('network:Network.logout.title')} hidden={!a.active || a.connection?.kind !== 'tailnet'} onclick={() => logout(a.index)}>{t('network:Network.logout')}</button>
      </div>
      <p id={`net-hint${s}`} class="net-note">{a.note ?? ''}</p>
    </section>
  {/each}
</Menu>
