<!--
  Back up key and domains (docs/networking/adapters.md §2.1, docs/networking/names.md "What the user sees"): a dialog
  from a room connection's left column (ConnectionNav.svelte), opened when it mounts. The connection's export
  (room-export.ts `roomExportOf`: its key, then its domains after a dot) in a secret field to copy, with what it is, that
  it must stay secret, and how to restore it (the wizard's room step, a key to paste). A stored connection's key is
  made under its entry when first asked for (the names agent's `member`), so the field has it whether or not the
  connection ever connected.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import ValueField from './ui/ValueField.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import type { Connection, RoomConnection } from './connections.ts';
  import type { Dialog } from './ui/dialog.ts';
  import type { PageNetwork } from './net-live.ts';
  import { memberOf, pageNames } from './areas/names.svelte.ts';

  type Props = { net: PageNetwork; connection: Connection & { room: RoomConnection }; onclose: () => void };
  let { net, connection, onclose }: Props = $props();

  let dialog = $state<Dialog>();
  /** The export ('' until read), and whether it carries domains (a dot after the key). */
  let exported = $state('');
  const key = $derived(pageNames.member(memberOf(connection.room))?.key);
  $effect(() => {
    if (!key) return;
    let live = true;
    void net.conns.exportKey(connection).then(
      (k) => live && (exported = k),
      () => live && (exported = ''),
    );
    return () => (live = false);
  });
  const withDomains = $derived(exported.includes('.'));
</script>

<Modal id="connection-backup" bind:this={dialog} title={t('network:ConnectionBackup.title')} {onclose}>
  <Note size="md" id="connection-backup-intro" data-domains={withDomains}>
    {#if withDomains}<T k="network:ConnectionBackup.intro" params={{ name: connection.name }} />{:else}<T
        k="network:ConnectionBackup.intro.none"
        params={{ name: connection.name }}
      />{/if}
  </Note>
  <ValueField
    id="connection-backup-value"
    copyId="connection-backup-copy"
    showId="connection-backup-show"
    label={t('network:ConnectionBackup.label')}
    value={exported}
    readonly
    copy
    secret
    mono
  />
  <Note size="md" tone="warn">{t('network:ConnectionBackup.warning')}</Note>
  <Note size="md"><T k="network:ConnectionBackup.restore" /></Note>
  {#snippet buttons()}
    <Button variant="primary" id="connection-backup-close" onclick={() => dialog?.close()}>
      {t('network:ConnectionBackup.close')}
    </Button>
  {/snippet}
</Modal>
