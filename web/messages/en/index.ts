// The English catalog (docs/i18n.md): one file per area of the page, each entry `{ message, note }` under a key that
// names the source file that uses it (`<Source>.<name>`). A new area's file is added here and in docs/i18n.md.
import common from './common.json' with { type: 'json' };
import disks from './disks.json' with { type: 'json' };
import display from './display.json' with { type: 'json' };
import folders from './folders.json' with { type: 'json' };
import guest from './guest.json' with { type: 'json' };
import machine from './machine.json' with { type: 'json' };
import machines from './machines.json' with { type: 'json' };
import network from './network.json' with { type: 'json' };
import snapshots from './snapshots.json' with { type: 'json' };
import sound from './sound.json' with { type: 'json' };
import statusbar from './statusbar.json' with { type: 'json' };
import toolbar from './toolbar.json' with { type: 'json' };
import usb from './usb.json' with { type: 'json' };

/** An entry: the words, and a note for whoever reviews or translates them (where and how they're shown). */
export type Entry = { message: string; note: string };
export type Catalog = Record<string, Entry>;

export const CATALOGS: Record<string, Catalog> = { common, disks, display, folders, guest, machine, machines, network, snapshots, sound, statusbar, toolbar, usb };
