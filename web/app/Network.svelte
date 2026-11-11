<!--
  The toolbar's Network menu (docs/frontend.md "Network", docs/network-adapters.md §3.3): a section per network
  adapter of the page's machine (one adapter: no heading), each showing its connection and what can be done with it
  (Log in…, the exit node, the peers' subnet routes, the machine's tailcat address and key, its name in a room and the
  room's link to copy, Connect, Retry, Disconnect, Log out, Change connection…, which is
  the Network wizard, web/app/NetWizard.svelte). Adapter 1's elements keep the ids they always had; adapter n's end in
  `-<n-1>`. Logic is web/app/net-live.ts's, through `page`.
-->
<script lang="ts">
  /* eslint-disable max-lines -- its styles moved in from index.html; a section per adapter (a NetAdapter.svelte, its
     keys renamed) would split it */
  import Menu from './ui/Menu.svelte';
  import Check from './ui/Check.svelte';
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import T from './T.svelte';
  import { describe, t, type Described } from '../i18n.ts';
  import { MsgError } from '../msg.ts';
  import { ask } from './ask.svelte.ts';
  import type { PageNetwork } from './net-live.ts';
  import { page, ui } from './ui.svelte.ts';

  let { net }: { net: PageNetwork } = $props();

  const views = $derived((void ui.net, net.views()));
  /** What the toolbar's dot shows: the default way out's state, else adapter 1's. */
  // None without an adapter (`views[0]` is undefined then).
  const shown = $derived<(typeof views)[number] | undefined>(views.find((a) => a.primary) ?? views[0]);
  /** A phase's light. */
  const TONES: Record<string, 'ok' | 'busy' | 'bad'> = {
    connecting: 'busy',
    login: 'busy',
    connected: 'ok',
    error: 'bad',
  };
  const tone = (phase: string | undefined) => (phase ? TONES[phase] : undefined) ?? 'off';

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
    if (ui.netMenu !== opened) {
      opened = ui.netMenu;
      open = true;
      errors = {};
    }
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
      () => {
        errors = { ...errors, [i]: undefined };
      },
      (err) => {
        errors = {
          ...errors,
          [i]: describe(
            id
              ? new MsgError('network:Network.exitNode.failed', undefined, { cause: err })
              : new MsgError('network:Network.exitNode.stopFailed', undefined, { cause: err }),
          ),
        };
      },
    );
  }
  async function logout(i: number) {
    if (!(await ask.confirm(t('network:Network.logout.confirm'), { ok: t('network:Network.logout'), danger: true })))
      return;
    await act(i, () => page.netLogout(i));
  }
  function copyKey(i: number, key: string) {
    void navigator.clipboard
      .writeText(key)
      .catch(() => (document.getElementById(`net-key-value${sfx(i)}`) as HTMLInputElement | null)?.select());
  }
  /** Copies a room's words (the machine's name, or the room's link); where the clipboard refuses, selects them in their field. */
  function copyRoom(i: number, words: string, link: boolean) {
    void navigator.clipboard.writeText(words).catch(() => {
      if (link) linkShown = { ...linkShown, [i]: true };
      queueMicrotask(() =>
        (
          document.getElementById(
            `${link ? 'net-room-link-value' : 'net-room-name'}${sfx(i)}`,
          ) as HTMLInputElement | null
        )?.select(),
      );
    });
  }
  function copyServed(i: number, addr: string) {
    void navigator.clipboard.writeText(addr).catch(() => {
      revealed = { ...revealed, [i]: true };
      queueMicrotask(() => (document.getElementById(`net-served-addr${sfx(i)}`) as HTMLInputElement | null)?.select());
    });
  }
</script>

<!-- A value to copy (an address, a key, a room's name or link), read-only in its field. -->
{#snippet copyable(id: string, label: string, value: string, type = 'text')}
  <Field {label}><input {id} {type} readonly spellcheck="false" {value} /></Field>
{/snippet}

<Menu
  id="network"
  icon="network"
  title={t('network:Network.title')}
  bind:open
  panel
  wide
  data-phase={shown?.view.phase ?? 'off'}
>
  {#snippet badge()}<StatusDot tone={tone(shown?.view.phase)} aria-hidden="true" />{/snippet}
  {#each views as a (a.index)}
    {@const v = a.view}
    {@const s = sfx(a.index)}
    <section class="net-adapter" data-adapter={a.index} data-phase={v.phase}>
      {#if views.length > 1}<h3 class="net-head">
          <StatusDot tone={tone(v.phase)} aria-hidden="true" />{a.primary
            ? t('network:Network.adapter.primary', { adapter: a.index + 1 })
            : t('network:Network.adapter', { adapter: a.index + 1 })}
        </h3>{/if}
      <p id={`net-status${s}`} class="net-status">
        {v.text}{#each v.details ?? [] as d, k (k)}<br /><span class="net-detail">{d}</span>{/each}
      </p>
      <Note id={`net-conn${s}`}>
        {a.connection
          ? a.connection.ephemeral
            ? t('network:Network.connection.ephemeral', { name: a.connection.name })
            : a.connection.name
          : t('network:Network.noConnection')}
      </Note>
      <a id={`net-login${s}`} class="net-login" target="_blank" rel="noopener" href={v.loginURL} hidden={!v.loginURL}
        >{t('network:Network.login')}</a
      >
      <div hidden={v.exitNodes.length === 0}>
        <Field id={`net-exit-label${s}`} label={t('network:Network.exitNode')}>
          <select
            id={`net-exit${s}`}
            value={v.exitNodes.find((e) => e.use)?.id ?? ''}
            onchange={(e) => chooseExit(a.index, e)}
          >
            <option value="">{t('network:Network.exitNode.none')}</option>
            {#each v.exitNodes as e (e.id)}<option value={e.id}
                >{e.online ? e.name : t('network:Network.exitNode.offline', { name: e.name })}</option
              >{/each}
          </select>
        </Field>
      </div>
      <div id={`net-routes-label${s}`} hidden={!v.subnets}>
        <Check
          id={`net-routes${s}`}
          checked={v.subnets?.on ?? true}
          onchange={(on) => act(a.index, () => page.netRoutes(a.index, on))}
          title={v.subnets?.routes.join(', ')}
        >
          {(v.subnets?.routes.length ?? 0) > 2
            ? t('network:Network.routes.more', { routes: v.subnets?.routes.slice(0, 2) })
            : t('network:Network.routes', { routes: v.subnets?.routes ?? [] })}
        </Check>
      </div>
      <div id={`net-served${s}`} class="net-group" hidden={!v.served}>
        {@render copyable(
          `net-served-addr${s}`,
          t('network:Network.served'),
          v.served ?? '',
          revealed[a.index] ? 'text' : 'password',
        )}
        <div class="net-row">
          <Button id={`net-served-copy${s}`} onclick={() => copyServed(a.index, v.served ?? '')}
            >{t('network:Network.copy')}</Button
          ><Button
            id={`net-served-show${s}`}
            onclick={() => (revealed = { ...revealed, [a.index]: !revealed[a.index] })}
            >{revealed[a.index] ? t('network:Network.hide') : t('network:Network.show')}</Button
          >
        </div>
        <Note>
          <T
            k="network:Network.served.note"
            params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}
            >{#snippet code(text)}<code>{text}</code>{/snippet}</T
          >
        </Note>
      </div>
      <div id={`net-key${s}`} class="net-group" hidden={!v.tailcatKey}>
        {@render copyable(`net-key-value${s}`, t('network:Network.key'), v.tailcatKey ?? '')}
        <div class="net-row">
          <Button id={`net-key-copy${s}`} onclick={() => copyKey(a.index, v.tailcatKey ?? '')}
            >{t('network:Network.copy')}</Button
          >
        </div>
        <Note>
          <T k="network:Network.key.note" params={{ allow: `tailcat serve --allow=${v.tailcatKey ?? ''} exit-node` }}
            >{#snippet code(text)}<code>{text}</code>{/snippet}</T
          >
        </Note>
      </div>
      <div id={`net-room${s}`} class="net-group" hidden={!v.room}>
        {@render copyable(`net-room-name${s}`, t('network:Network.room.name'), v.room?.name ?? '')}
        <div class="net-row">
          <Button id={`net-room-name-copy${s}`} onclick={() => copyRoom(a.index, v.room?.name ?? '', false)}
            >{t('network:Network.copy')}</Button
          ><Button
            id={`net-room-link-copy${s}`}
            title={t('network:Network.room.copyLink.title')}
            onclick={() => copyRoom(a.index, v.room?.link ?? '', true)}>{t('network:Network.room.copyLink')}</Button
          >
        </div>
        {#if linkShown[a.index]}{@render copyable(
            `net-room-link-value${s}`,
            t('network:Network.room.link'),
            v.room?.link ?? '',
          )}{/if}
        <Note>{v.room?.incoming ? t('network:Network.room.note') : t('network:Network.room.note.off')}</Note>
      </div>
      <Note tone="error" id={`net-menu-error${s}`} hidden={!errors[a.index]}>
        {errors[a.index]?.headline}{#each errors[a.index]?.details ?? [] as d, k (k)}<br />{d}{/each}
      </Note>
      <div id={`net-actions${s}`} class="net-actions">
        {#if a.connection && !a.active && a.on}<Button
            id={`net-connect-now${s}`}
            onclick={() => act(a.index, () => page.netConnect(a.index))}>{t('network:Network.connect')}</Button
          >{/if}
        {#if a.connection && a.active && v.phase === 'error'}<Button
            id={`net-retry${s}`}
            onclick={() =>
              act(a.index, async () => {
                await page.netDisconnect(a.index);
                await page.netConnect(a.index);
              })}>{t('network:Network.retry')}</Button
          >{/if}
        <Button id={`net-setup${s}`} onclick={() => wizard(a.index)}
          >{a.connection ? t('network:Network.change') : t('network:Network.setup')}</Button
        >
        <Button
          id={`net-disconnect${s}`}
          hidden={!a.active}
          onclick={() => act(a.index, () => page.netDisconnect(a.index))}>{t('network:Network.disconnect')}</Button
        >
        <Button
          id={`net-logout${s}`}
          title={t('network:Network.logout.title')}
          hidden={!a.active || a.connection?.kind !== 'tailnet'}
          onclick={() => logout(a.index)}>{t('network:Network.logout')}</Button
        >
      </div>
      <Note id={`net-hint${s}`}>{a.note ?? ''}</Note>
    </section>
  {/each}
</Menu>

<style>
  /* An adapter's section: its state, its connection, what can be done; a rule between adapters. */
  .net-adapter {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .net-adapter + .net-adapter {
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  .net-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-bold);
  }
  .net-status {
    margin: 0;
    font-weight: var(--weight-bold);
  }
  .net-detail {
    font-weight: var(--weight-normal);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  /* Log in…: a link (it opens the login page in a tab), framed as a button in the accent. */
  .net-login {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--control-h);
    padding: 0 var(--space-4);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    color: var(--accent);
    text-decoration: none;
  }
  .net-login:hover {
    background: var(--hover-bg);
  }
  .net-row,
  .net-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .net-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
</style>
