// The page's file pickers (FilePickers.svelte owns their hidden inputs, `#load-snapshot-input`, `#open-disk-input` and
// `#load-changes-input`, which the tests use): what a button calls to open one (`openPicker('snapshot')`), wherever it is.
import type { Attachment } from 'svelte/attachments';

/** A snapshot to load, a disk image to open, a disk's changes to import. */
export type Picker = 'snapshot' | 'disk' | 'changes';

const inputs = new Map<Picker, HTMLInputElement>();

/** Makes the element it's on picker `kind`'s input (FilePickers.svelte's), for as long as it's mounted. */
export const pickerInput =
  (kind: Picker): Attachment<HTMLInputElement> =>
  (el) => {
    inputs.set(kind, el);
    return () => {
      if (inputs.get(kind) === el) inputs.delete(kind);
    };
  };

/** Opens picker `kind` (the browser's file dialog; the page takes the file it gives). */
export function openPicker(kind: Picker) {
  inputs.get(kind)?.click();
}
