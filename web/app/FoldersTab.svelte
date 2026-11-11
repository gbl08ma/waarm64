<!--
  A machine's Shared folders tab (docs/shares.md): its shares device on or off, whether the page mounts the folders in
  the guest and where (saved with Save), then the folders attached to it (Folders.svelte).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Fields from './ui/Fields.svelte';
  import Note from './ui/Note.svelte';
  import Folders from './Folders.svelte';
  import SaveRow from './SaveRow.svelte';
  import type { Act } from './actions.svelte.ts';
  import type { PageFolders } from './folders-live.ts';
  import { said, t } from '../i18n.ts';
  import type { Editing } from './machine-edit.svelte.ts';
  import type { MachineRecord } from './shape.ts';
  import { DEFAULT_SHARES_PATH, sharesPathError } from './shares-mount.ts';
  import { ui } from './ui.svelte.ts';

  type Props = { edit: Editing; machine: MachineRecord; folders: PageFolders; act: Act };
  let { edit, machine, folders, act }: Props = $props();
  const d = $derived(edit.draft);

  const path = $derived(d.sharesPath ?? DEFAULT_SHARES_PATH);
  const pathError = $derived(sharesPathError(path));
  const mounts = $derived(d.sharesMount !== false);
  function setMount(on: boolean) {
    d.sharesMount = on ? undefined : false;
    edit.touch();
  }
  function setPath(e: Event & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    d.sharesPath = v === DEFAULT_SHARES_PATH ? undefined : v;
  }
</script>

<Fields class="folders-switch" oninput={edit.touch} onchange={edit.touch}>
  <Check bind:checked={d.shares} field="shares" title={t('machines:FoldersTab.shares.title')}>
    {t('machines:FoldersTab.shares')}
  </Check>
  {#if edit.orphans('shares')}
    <Note tone="warn" data-shares-orphans>
      {d.shares ? t('machines:FoldersTab.shares.orphans.on') : t('machines:FoldersTab.shares.orphans.off')}
    </Note>
  {/if}
  {#if d.shares}
    <Check checked={mounts} onchange={setMount} field="shares-mount" title={t('machines:FoldersTab.sharesMount.title')}>
      {t('machines:FoldersTab.sharesMount')}
    </Check>
    {#if mounts}
      <Field label={t('machines:FoldersTab.sharesPath')}>
        <input value={path} oninput={setPath} data-field="shares-path" spellcheck="false" />
      </Field>
      {#if pathError}<Note tone="warn" data-shares-path-error>{said(pathError).headline}</Note>{/if}
      <Note data-shares-path-note>
        {d.id === ui.current && ui.state === 'running'
          ? t('machines:FoldersTab.sharesPath.noteRunning')
          : t('machines:FoldersTab.sharesPath.note')}
      </Note>
    {/if}
  {/if}
  {#if edit.dirty}<SaveRow {edit} />{/if}
</Fields>
<div class="below"><Folders {folders} {machine} {act} /></div>

<style>
  /* The folders' list under the switches. */
  .below {
    margin-top: var(--space-4);
  }
</style>
