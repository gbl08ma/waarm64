// The copy editor's console commands (docs/i18n.md "Editing the copy on the page"): `copyEdit.start()` reloads the page
// with every message marked, so a click with Alt held edits the words where they're shown (web/app/copy-edit-ui.ts);
// `copyEdit.dump()` gives the words changed, by key, for tools/copy-apply.ts. A developer's tool: its words are its own.
import { COPY_EDITING, copyEdits } from '../i18n.ts';
import { CATALOGS } from '../messages/en/index.ts';

const EDIT_FLAG = 'copy-edit';
const EDITS = 'copy-edit.changes';

/** The words changed (kept in this browser) that differ from the catalog's, by full key. */
export function changed(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [full, words] of Object.entries(copyEdits())) {
    const [ns, k] = full.split(/:(.*)/s);
    if (CATALOGS[ns]?.[k] && CATALOGS[ns][k].message !== words) out[full] = words;
  }
  return out;
}

const commands = {
  /** Turns the editor on for this tab (a reload). */
  start() {
    sessionStorage.setItem(EDIT_FLAG, 'on');
    location.reload();
  },
  /** Turns it off (a reload); the changes are kept. */
  stop() {
    sessionStorage.removeItem(EDIT_FLAG);
    location.reload();
  },
  /** The changes as JSON (also copied to the clipboard when the page has focus). */
  dump(): string {
    const json = JSON.stringify(changed(), null, 2);
    void navigator.clipboard?.writeText(json).catch(() => {});
    return json;
  },
  /** Forgets the changes. */
  clear() {
    localStorage.removeItem(EDITS);
    if (COPY_EDITING) location.reload();
  },
  help() {
    return [
      'copyEdit.start()  turn the copy editor on (reloads); Alt+click any words to edit them', // i18n-ignore
      'copyEdit.dump()   the words changed as JSON, for node tools/copy-apply.ts <file>', // i18n-ignore
      'copyEdit.stop()   turn it off (reloads; the changes are kept)', // i18n-ignore
      'copyEdit.clear()  forget the changes', // i18n-ignore
    ].join('\n');
  },
};

/** Puts the commands on `globalThis.copyEdit`, and the editor on the page when it's on. */
export function installCopyEdit() {
  (globalThis as Record<string, unknown>).copyEdit = commands;
  if (COPY_EDITING) {
    void import('./copy-edit-ui.ts').then((m) => m.startEditor());
    console.info(`Copy editor on: Alt+click any words to edit them. ${commands.help()}`); // i18n-ignore
  }
}
