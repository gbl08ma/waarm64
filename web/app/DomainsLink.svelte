<!--
  A room connection's one status link to its Domains pane (docs/networking/names.md "What the user sees"): Register a
  domain… with none, how many it holds, and how many need attention in the warning tone (web/app/names-view.ts
  `domainsLink`). It opens the connection's Domains on the Home page, Back leading to `from` (the machine's screen from
  the toolbar's Network menu, its Network tab from an adapter's card, Connections from a Connections card); `onopen`
  first (the menu it is in closes). Where it is placed decides whether a connection gets one: none for an ephemeral
  connection with a key of its own.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import { text } from '../i18n.ts';
  import type { From } from './home-route.ts';
  import { page } from './page.ts';
  import { pageNames } from './areas/names.svelte.ts';
  import { domainsLink } from './names-view.ts';

  type Props = {
    id: string;
    room: { identityKey: string; link: string };
    from: From;
    onopen?: () => void;
    [attr: string]: unknown;
  };
  let { id, room, from, onopen, ...rest }: Props = $props();

  const link = $derived(domainsLink(pageNames.of({ identityKey: room.identityKey, link: room.link })));
  function open() {
    onopen?.();
    page.openConnection(id, 'domains', from);
  }
</script>

<Button
  variant="link"
  tone={link.warn ? 'warn' : undefined}
  data-action="domains-link"
  data-warn={link.warn}
  onclick={open}
  {...rest}>{text(link.m)}</Button
>
