<!--
  The page's hidden file inputs (web/app/file-pickers.ts opens them: the toolbar's Load snapshot…, a Snapshots tab's
  Restore from a file, the Machines page's Import changes…, Open disk… without the File System Access picker): each
  hands the file it's given to `page`. Their ids are the tests' handles.
-->
<script lang="ts">
  import { pickerInput } from './file-pickers.ts';
  import { page } from './ui.svelte.ts';

  /** A change handler that takes the input's file (once: the input is emptied, so the same file can be picked again). */
  const take = (f: (file: File) => void) => (e: Event & { currentTarget: HTMLInputElement }) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file) f(file);
  };
</script>

<input
  type="file"
  id="load-snapshot-input"
  hidden
  {@attach pickerInput('snapshot')}
  onchange={take((f) => page.loadSnapshot(f))}
/>
<input
  type="file"
  id="open-disk-input"
  hidden
  {@attach pickerInput('disk')}
  onchange={take((f) => page.openDiskFile(f))}
/>
<input
  type="file"
  id="load-changes-input"
  hidden
  {@attach pickerInput('changes')}
  onchange={take((f) => page.importChanges(f))}
/>
