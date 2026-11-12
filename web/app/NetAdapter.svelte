<!--
  One network adapter's section of a toolbar Network menu (web/app/Network.svelte): its number and connection on one
  line, its state, and what can be done with it (Log in…, the exit node, the peers' subnet routes, the machine's
  tailcat address and key, its name in a room and the room's link to copy, Connect, Retry, Disconnect, Log out, Change
  connection…). What they're for and how to use them is in its details (Details…: NetDetails.svelte), so the menu stays
  short. Adapter 1's elements keep the ids they always had; adapter n's end in `-<n-1>`. `heading`: the machine has more
  than one adapter. `onwizard`: Change connection… (or Set up…), `ondetails`: Details…; both close the menu. Logic is
  web/app/net-live.ts's, through `page`.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import ValueField from './ui/ValueField.svelte';
  import { Actions } from './actions.svelte.ts';
  import { t } from '../i18n.ts';
  import { MsgError } from '../msg.ts';
  import { ask } from './ask.svelte.ts';
  import { phaseTone } from './network-view.ts';
  import type { AdapterView } from './network-view.ts';
  import { page } from './page.ts';

  type Props = { a: AdapterView; heading: boolean; onwizard: () => void; ondetails: () => void };
  let { a, heading, onwizard, ondetails }: Props = $props();
  const v = $derived(a.view);
  const i = $derived(a.index);
  const s = $derived(i ? `-${i}` : '');

  const runner = new Actions();
  const act = (f: () => Promise<unknown>) => runner.run('', f);

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
</script>

<section class="net-adapter" data-adapter={i} data-phase={v.phase}>
  <!-- The adapter and its connection: on one line where they fit, else the connection under it. -->
  <div class="net-head">
    {#if heading}
      <h3>
        <StatusDot tone={phaseTone(v.phase)} aria-hidden="true" />{a.primary
          ? t('network:NetAdapter.adapter.primary', { adapter: i + 1 })
          : t('network:NetAdapter.adapter', { adapter: i + 1 })}
      </h3>
    {/if}
    <Note id={`net-conn${s}`}>{connection}</Note>
  </div>
  <p id={`net-status${s}`} class="net-status">
    {v.text}{#each v.details ?? [] as d, k (k)}<br /><span class="net-detail">{d}</span>{/each}
  </p>
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
  {#if v.served}
    <div id={`net-served${s}`}>
      <ValueField
        id={`net-served-addr${s}`}
        copyId={`net-served-copy${s}`}
        showId={`net-served-show${s}`}
        label={t('network:NetAdapter.served')}
        value={v.served}
        readonly
        copy
        secret
      />
    </div>
  {/if}
  {#if v.tailcatKey}
    <div id={`net-key${s}`}>
      <ValueField
        id={`net-key-value${s}`}
        copyId={`net-key-copy${s}`}
        label={t('network:NetAdapter.key')}
        value={v.tailcatKey}
        readonly
        copy
        mono
      />
    </div>
  {/if}
  {#if v.room}
    <div id={`net-room${s}`} class="net-group">
      <ValueField
        id={`net-room-name${s}`}
        copyId={`net-room-name-copy${s}`}
        label={t('network:NetAdapter.room.name')}
        value={v.room.name}
        readonly
        copy
      />
      <ValueField
        id={`net-room-link-value${s}`}
        copyId={`net-room-link-copy${s}`}
        showId={`net-room-link-show${s}`}
        label={t('network:NetAdapter.room.link')}
        value={v.room.link}
        readonly
        copy
        secret
      />
    </div>
  {/if}
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
  {#if a.connection}
    <Button
      variant="link"
      id={`net-details-open${s}`}
      title={t('network:NetAdapter.details.title')}
      onclick={ondetails}
    >
      {t('network:NetAdapter.details')}
    </Button>
  {/if}
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
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
  }
  h3 {
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
