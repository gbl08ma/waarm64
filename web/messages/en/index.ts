// The English catalog (docs/i18n.md): one file per area of the page, each entry `{ message, note }` under a key that
// names the source file that uses it (`<Source>.<name>`). A new area's file is added here and in docs/i18n.md.
import clipboard from './clipboard.json' with { type: 'json' };
import common from './common.json' with { type: 'json' };
import disks from './disks.json' with { type: 'json' };
import display from './display.json' with { type: 'json' };
import folders from './folders.json' with { type: 'json' };
import guest from './guest.json' with { type: 'json' };
import machine from './machine.json' with { type: 'json' };
import machines from './machines.json' with { type: 'json' };
import network from './network.json' with { type: 'json' };
import osk from './osk.json' with { type: 'json' };
import snapshots from './snapshots.json' with { type: 'json' };
import sound from './sound.json' with { type: 'json' };
import statusbar from './statusbar.json' with { type: 'json' };
import toolbar from './toolbar.json' with { type: 'json' };
import usb from './usb.json' with { type: 'json' };

/** An entry: the words, and a note for whoever reviews or translates them (where and how they're shown). */
export type Entry = { message: string; note: string };
export type Catalog = Record<string, Entry>;

export const CATALOGS: Record<string, Catalog> = { clipboard, common, disks, display, folders, guest, machine, machines, network, osk, snapshots, sound, statusbar, toolbar, usb };

/**
 * A message's reference to another, i18next's nesting: `$t(common:product.name)` says that entry's words in its place
 * (the product's name, written once). A reference names a whole entry, without parameters or options.
 */
export const REF = /\$t\(([^()]*)\)/g;

/** Words with their references resolved, as the page renders them (for the tools and tests that read the catalog). */
export function expand(words: string, catalogs: Record<string, Record<string, { message: string }>> = CATALOGS, depth = 0): string {
  return words.replace(REF, (whole, key: string) => {
    const at = key.indexOf(':');
    const e = at > 0 ? catalogs[key.slice(0, at)]?.[key.slice(at + 1)] : undefined;
    return e && depth < 8 ? expand(e.message, catalogs, depth + 1) : whole;
  });
}
