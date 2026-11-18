<!--
  How the guest mounts the shared folders (docs/shares.md §5): a dialog opened by the toolbar's Folders menu (Details…,
  web/app/areas/shares.svelte.ts `openMount`), with what the menu leaves out to stay short. Where the guest's systemd
  mounts them when this emulator has it do so (`shares.path`, the page's machine's mount point), and the command that
  mounts them by hand (a guest with an older systemd or none, or the mount turned off), to copy. Always mounted, as the
  wizards are.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import ValueField from './ui/ValueField.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import { SHARES_BY_HAND, SHARES_BY_HAND_AT } from './shares-mount.ts';
  import { shares } from './areas/shares.svelte.ts';

  /** The dialog (Modal.svelte's exports). */
  let dialog = $state<{ open: () => void; close: () => void }>();
  /** The command's field: the dialog's focus lands on it, which would show the command's end; its start is shown. */
  let field = $state<HTMLInputElement>();

  $effect(() =>
    shares.mount.handle(() => {
      dialog?.open();
      field?.setSelectionRange(0, 0);
      if (field) field.scrollLeft = 0;
    }),
  );
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

<Modal id="folders-mount" bind:this={dialog} auto={false} title={t('folders:FoldersMount.title')}>
  {#if shares.path}
    <Note size="md" id="folders-mount-auto">
      <T k="folders:FoldersMount.auto" params={{ path: shares.path }} {code} />
    </Note>
    <Note size="md">{t('folders:FoldersMount.byHand.older')}</Note>
  {:else}
    <Note size="md" id="folders-mount-off">{t('folders:FoldersMount.off')}</Note>
    <Note size="md">{t('folders:FoldersMount.byHand')}</Note>
  {/if}
  <ValueField
    id="folders-mount-command"
    copyId="folders-mount-command-copy"
    value={SHARES_BY_HAND}
    bind:ref={field}
    readonly
    copy
    mono
  />
  <Note size="md">
    <T k="folders:FoldersMount.byHand.where" params={{ path: SHARES_BY_HAND_AT }} {code} />
  </Note>
  {#snippet buttons()}
    <Button type="button" variant="primary" id="folders-mount-close" onclick={() => dialog?.close()}>
      {t('folders:FoldersMount.close')}
    </Button>
  {/snippet}
</Modal>
