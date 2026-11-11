<!--
  One network adapter's section of the toolbar's Network menu (web/app/Network.svelte): its state, its connection and
  what can be done with it (Log in…, the exit node, the peers' subnet routes, the machine's tailcat address and key,
  its name in a room and the room's link to copy, Connect, Retry, Disconnect, Log out, Change connection…). Adapter 1's
  elements keep the ids they always had; adapter n's end in `-<n-1>`. `heading`: the menu has more than one adapter.
  `onwizard`: Change connection… (or Set up…), which closes the menu. Logic is web/app/net-live.ts's, through `page`.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import CopyField from './CopyField.svelte';
  import T from './T.svelte';
  import { Actions } from './actions.svelte.ts';
  import { t } from '../i18n.ts';
  import { MsgError } from '../msg.ts';
  import { ask } from './ask.svelte.ts';
  import { phaseTone } from './network-view.ts';
  import type { AdapterView } from './net-live.ts';
  import { page } from './page.ts';

  type Props = { a: AdapterView; heading: boolean; onwizard: () => void };
  let { a, heading, onwizard }: Props = $props();
  const v = $derived(a.view);
  const i = $derived(a.index);
  const s = $derived(i ? `-${i}` : '');

  /** A field that selects its value (CopyField.svelte). */
  type Selectable = { select: () => void };
  const runner = new Actions();
  const act = (f: () => Promise<unknown>) => runner.run('', f);
  /** The tailcat address shown in clear. */
  let revealed = $state(false);
  /** The room link is shown in a field: the clipboard refused it, so the user copies it from there. */
  let linkShown = $state(false);
  let servedField = $state<Selectable>();
  let keyField = $state<Selectable>();
  let nameField = $state<Selectable>();
  let linkField = $state<Selectable>();

  const connection = $derived.by(() => {
    if (!a.connection) return t('network:NetAdapter.noConnection');
    if (a.connection.ephemeral) return t('network:NetAdapter.connection.ephemeral', { name: a.connection.name });
    return a.connection.name;
  });
  const routes = $derived(v.subnets?.routes ?? []);
  const routesText = $derived(
    routes.length > 2
      ? t('network:NetAdapter.routes.more', { routes: routes.slice(0, 2) })
      : t('network:NetAdapter.routes', { routes }),
  );

  function chooseExit(e: Event & { currentTarget: HTMLSelectElement }) {
    const select = e.currentTarget;
    const id = select.value;
    select.blur();
    void act(async () => {
      try {
        await page.netExit(i, id);
      } catch (err) {
        throw id
          ? new MsgError('network:NetAdapter.exitNode.failed', undefined, { cause: err })
          : new MsgError('network:NetAdapter.exitNode.stopFailed', undefined, { cause: err });
      }
    });
  }
  async function logout() {
    const sure = await ask.confirm(t('network:NetAdapter.logout.confirm'), {
      ok: t('network:NetAdapter.logout'),
      danger: true,
    });
    if (sure) await act(() => page.netLogout(i));
  }
  async function retry() {
    await page.netDisconnect(i);
    await page.netConnect(i);
  }
  /** Copies `words`; where the clipboard refuses, `refused` shows their field and they're selected in it. */
  function copy(words: string, field: () => Selectable | undefined, refused?: () => void) {
    void navigator.clipboard.writeText(words).catch(() => {
      refused?.();
      queueMicrotask(() => field()?.select());
    });
  }
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

<section class="net-adapter" data-adapter={i} data-phase={v.phase}>
  {#if heading}
    <h3 class="net-head">
      <StatusDot tone={phaseTone(v.phase)} aria-hidden="true" />{a.primary
        ? t('network:NetAdapter.adapter.primary', { adapter: i + 1 })
        : t('network:NetAdapter.adapter', { adapter: i + 1 })}
    </h3>
  {/if}
  <p id={`net-status${s}`} class="net-status">
    {v.text}{#each v.details ?? [] as d, k (k)}<br /><span class="net-detail">{d}</span>{/each}
  </p>
  <Note id={`net-conn${s}`}>{connection}</Note>
  <a id={`net-login${s}`} class="net-login" target="_blank" rel="noopener" href={v.loginURL} hidden={!v.loginURL}>
    {t('network:NetAdapter.login')}
  </a>
  <div hidden={v.exitNodes.length === 0}>
    <Field id={`net-exit-label${s}`} label={t('network:NetAdapter.exitNode')}>
      <select id={`net-exit${s}`} value={v.exitNodes.find((e) => e.use)?.id ?? ''} onchange={chooseExit}>
        <option value="">{t('network:NetAdapter.exitNode.none')}</option>
        {#each v.exitNodes as e (e.id)}
          <option value={e.id}>{e.online ? e.name : t('network:NetAdapter.exitNode.offline', { name: e.name })}</option>
        {/each}
      </select>
    </Field>
  </div>
  <div id={`net-routes-label${s}`} hidden={!v.subnets}>
    <Check
      id={`net-routes${s}`}
      checked={v.subnets?.on ?? true}
      onchange={(on: boolean) => act(() => page.netRoutes(i, on))}
      title={routes.join(', ')}
    >
      {routesText}
    </Check>
  </div>
  <div id={`net-served${s}`} class="net-group" hidden={!v.served}>
    <CopyField
      bind:this={servedField}
      id={`net-served-addr${s}`}
      label={t('network:NetAdapter.served')}
      value={v.served ?? ''}
      type={revealed ? 'text' : 'password'}
    />
    <div class="net-row">
      <Button
        id={`net-served-copy${s}`}
        onclick={() =>
          copy(
            v.served ?? '',
            () => servedField,
            () => (revealed = true),
          )}
      >
        {t('network:NetAdapter.copy')}
      </Button>
      <Button id={`net-served-show${s}`} onclick={() => (revealed = !revealed)}>
        {revealed ? t('network:NetAdapter.hide') : t('network:NetAdapter.show')}
      </Button>
    </div>
    <Note>
      <T
        k="network:NetAdapter.served.note"
        params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}
        {code}
      />
    </Note>
  </div>
  <div id={`net-key${s}`} class="net-group" hidden={!v.tailcatKey}>
    <CopyField
      bind:this={keyField}
      id={`net-key-value${s}`}
      label={t('network:NetAdapter.key')}
      value={v.tailcatKey ?? ''}
    />
    <div class="net-row">
      <Button id={`net-key-copy${s}`} onclick={() => copy(v.tailcatKey ?? '', () => keyField)}>
        {t('network:NetAdapter.copy')}
      </Button>
    </div>
    <Note>
      <T
        k="network:NetAdapter.key.note"
        params={{ allow: `tailcat serve --allow=${v.tailcatKey ?? ''} exit-node` }}
        {code}
      />
    </Note>
  </div>
  <div id={`net-room${s}`} class="net-group" hidden={!v.room}>
    <CopyField
      bind:this={nameField}
      id={`net-room-name${s}`}
      label={t('network:NetAdapter.room.name')}
      value={v.room?.name ?? ''}
    />
    <div class="net-row">
      <Button id={`net-room-name-copy${s}`} onclick={() => copy(v.room?.name ?? '', () => nameField)}>
        {t('network:NetAdapter.copy')}
      </Button>
      <Button
        id={`net-room-link-copy${s}`}
        title={t('network:NetAdapter.room.copyLink.title')}
        onclick={() =>
          copy(
            v.room?.link ?? '',
            () => linkField,
            () => (linkShown = true),
          )}
      >
        {t('network:NetAdapter.room.copyLink')}
      </Button>
    </div>
    {#if linkShown}
      <CopyField
        bind:this={linkField}
        id={`net-room-link-value${s}`}
        label={t('network:NetAdapter.room.link')}
        value={v.room?.link ?? ''}
      />
    {/if}
    <Note>{v.room?.incoming ? t('network:NetAdapter.room.note') : t('network:NetAdapter.room.note.off')}</Note>
  </div>
  <Note tone="error" id={`net-menu-error${s}`} hidden={!runner.error}>{runner.error?.text}</Note>
  <div id={`net-actions${s}`} class="net-actions">
    {#if a.connection && !a.active && a.on}
      <Button id={`net-connect-now${s}`} onclick={() => act(() => page.netConnect(i))}>
        {t('network:NetAdapter.connect')}
      </Button>
    {/if}
    {#if a.connection && a.active && v.phase === 'error'}
      <Button id={`net-retry${s}`} onclick={() => act(retry)}>{t('network:NetAdapter.retry')}</Button>
    {/if}
    <Button id={`net-setup${s}`} onclick={onwizard}>
      {a.connection ? t('network:NetAdapter.change') : t('network:NetAdapter.setup')}
    </Button>
    <Button id={`net-disconnect${s}`} hidden={!a.active} onclick={() => act(() => page.netDisconnect(i))}>
      {t('network:NetAdapter.disconnect')}
    </Button>
    <Button
      id={`net-logout${s}`}
      title={t('network:NetAdapter.logout.title')}
      hidden={!a.active || a.connection?.kind !== 'tailnet'}
      onclick={logout}
    >
      {t('network:NetAdapter.logout')}
    </Button>
  </div>
  <Note id={`net-hint${s}`}>{a.note ?? ''}</Note>
</section>

<style>
  /* An adapter's section: its state, its connection, what can be done. */
  .net-adapter {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
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
