// The page's shared folders as the toolbar shows them (docs/shares.md §4), and their commands: the Folders menu
// (web/app/FoldersMenu.svelte), the Folder wizard (web/app/FolderWizard.svelte) and how the guest mounts them
// (web/app/FoldersMount.svelte, the menu's Details…) open themselves when called. The
// live side (which folders the running machine has) is web/app/folders-live.ts's.
import { Command } from '../command.ts';
import type { FolderAttachment } from '../shape.ts';

/** How the Folder wizard was opened: for `machine`, which has `attached`; none: it only makes a folder. */
export type FolderWizardOpened = { machine?: string; attached?: FolderAttachment[] };

class Shares {
  /** Where the guest finds the running machine's folders (its mount point). */
  path = $state('');
  /** Answered by the Folders menu, the wizard and the mount dialog. */
  readonly menu = new Command();
  readonly wizard = new Command<[FolderWizardOpened]>();
  readonly mount = new Command();
  /** Opens the Folders menu (something to do there: Allow access…, Use it here; a folder just attached). */
  openMenu() {
    this.menu.call();
  }
  openWizard(o: FolderWizardOpened) {
    this.wizard.call(o);
  }
  /** Opens how the guest mounts the folders: where, and the command to mount them by hand. */
  openMount() {
    this.mount.call();
  }
}
export const shares = new Shares();
