<!--
  A room connection's Domains (docs/networking/names.md "What the user sees"): the pane of its page's Domains section,
  on the Home page one level under Connections (ConnectionPage.svelte), whether or not the connection is connected. Its
  head names the connection, the room and the room's domain, with Register a domain… (NameDialog.svelte, for this
  connection). With no domains, the first explainer in the cards' place (DomainsIntro.svelte) and a second Register a
  domain… under it; with some, the upkeep line (by when this web app must be reopened, or which need renewing now), a
  card a domain (DomainCard.svelte) and the second explainer, collapsed (DomainsHow.svelte). The registry's line
  while the connection is connected on this page. An ephemeral connection with a key of its own can't hold a domain:
  the pane says so and holds nothing else. The key a domain points at and the room's domain are the names agent's
  `member` (the stored key and the room's ID), so nothing here waits for a running machine; when it can't be read, the
  pane says why in the domains' place (shown again, it tries again).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import CardList from './ui/CardList.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import DomainCard from './DomainCard.svelte';
  import DomainsHow from './DomainsHow.svelte';
  import DomainsIntro from './DomainsIntro.svelte';
  import ErrorText from './ErrorText.svelte';
  import T from './T.svelte';
  import { errorView } from './usb-problems.ts';
  import { msg, t, text } from '../i18n.ts';
  import type { RoomConnection } from './connections.ts';
  import type { PageNetwork } from './net-live.ts';
  import { roomName, roomOf } from '../room.ts';
  import { network } from './areas/network.ts';
  import { memberOf, pageNames } from './areas/names.svelte.ts';
  import { namesLine, upkeepLine } from './names-view.ts';

  type Props = { net: PageNetwork; id: string; name: string; room: RoomConnection; takeFocus: () => boolean };
  let { net, id, name, room, takeFocus }: Props = $props();

  const conn = $derived({ identityKey: room.identityKey, link: room.link });
  const ephemeral = $derived(!!room.identity);
  /** The connection as its room sees it (web/names.ts `Member`): the key a domain points at, its own name, the room's
   * domain. Undefined until the names agent has said. */
  const member = $derived(ephemeral ? undefined : pageNames.member(memberOf(room)));
  /** Why `member` couldn't be read, if it couldn't. */
  const failed = $derived(ephemeral ? undefined : pageNames.memberError(memberOf(room)));
  const titles = $derived(ephemeral ? [] : pageNames.of(conn));
  const upkeep = $derived(upkeepLine(titles));
  /** The adapter of this page's machine that has it connected, and the registry's line it reports. */
  const names = $derived.by(() => {
    const at = net.runs(id);
    return at >= 0 ? net.views()[at]?.view.room?.names : undefined;
  });
  const meta = $derived(
    member && msg('network:DomainsPane.meta', { name, room: roomName(roomOf(room.link)), domain: member.domain }),
  );
  const register = () => network.openNaming(id);
</script>

<Pane id="connection-domains" title={t('machines:ConnectionNav.domains')} {meta} {takeFocus}>
  {#snippet actions()}
    {#if !ephemeral}
      <Button icon="plus" onclick={register} data-action="register-domain" disabled={!member}>
        {t('network:DomainsPane.register')}
      </Button>
    {/if}
  {/snippet}
  <div class="domains" id="domains" data-count={titles.length}>
    {#if ephemeral}
      <Note size="md" id="domains-ephemeral">{t('network:DomainsPane.ephemeral')}</Note>
    {:else if member}
      {#if !titles.length}
        <DomainsIntro member={member.name} />
        <div>
          <Button variant="primary" icon="plus" onclick={register} data-action="register-domain-intro">
            {t('network:DomainsPane.register')}
          </Button>
        </div>
      {:else}
        {#if upkeep}
          <Note size="md" tone={upkeep.warn ? 'warn' : 'dim'} id="domains-upkeep" data-warn={upkeep.warn}
            ><T m={upkeep.m} /></Note
          >
        {/if}
        <CardList>
          {#each titles as v (v.name)}
            <DomainCard {v} {conn} domain={member.domain} here={member.key} />
          {/each}
        </CardList>
        <DomainsHow />
      {/if}
      {#if names}<Note size="md" id="domains-names-line">{text(namesLine(names))}</Note>{/if}
    {:else if failed}
      <Note size="md" tone="error" id="domains-member-error"><ErrorText error={errorView(failed)} /></Note>
    {/if}
  </div>
</Pane>

<style>
  .domains {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
