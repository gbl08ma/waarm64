// The Machines page's panes that aren't a machine's (MachinesNav.svelte lists them, MachinesPage.svelte shows the
// chosen one): their ids, as web/app/areas/machines-nav.svelte.ts `selected` and each pane's `data-selected` say them.

/** The page's own machine (a transient one: PagePane.svelte). */
export const PAGE = 'page';
/** The browser's network connections (ConnectionsPane.svelte). */
export const CONNECTIONS = 'connections';
/** The browser's shared folders (FoldersPane.svelte). */
export const FOLDERS = 'folders';
/** The browser's disks (DisksPane.svelte). */
export const DISKS = 'disks';
/** The page's preferences (this browser's, for every machine: PreferencesPane.svelte). */
export const PREFERENCES = 'preferences';
/** webpc's own: its source, build and the third-party software in it (About.svelte). */
export const ABOUT = 'about';
/** The panes that aren't a machine's. */
export const PANES: ReadonlySet<string> = new Set([PAGE, CONNECTIONS, FOLDERS, DISKS, PREFERENCES, ABOUT]);
