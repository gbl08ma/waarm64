<!--
  A connection's Edit… button, its tooltip saying what can be changed for its kind: on each of the Machines page's
  Connections (ConnectionsPane.svelte) and on each connection to choose in the Network wizard (NetPickStep.svelte).
  `onclick` opens the wizard's editor on it; other attributes (`id`, `data-*`) go on the button.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import type { Connection } from './connections.ts';
  import { t } from '../i18n.ts';

  type Props = { connection: Connection; onclick: () => void; [attr: string]: unknown };
  let { connection, onclick, ...rest }: Props = $props();

  const TITLES: Record<Connection['kind'], () => string> = {
    tailnet: () => t('network:ConnectionEditButton.title.tailnet'),
    local: () => t('network:ConnectionEditButton.title.local'),
    room: () => t('network:ConnectionEditButton.title.room'),
    tailcat: () => t('network:ConnectionEditButton.title.tailcat'),
  };
</script>

<Button type="button" {onclick} data-action="edit-connection" title={TITLES[connection.kind]()} {...rest}>
  {t('network:ConnectionEditButton.edit')}
</Button>
