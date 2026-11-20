// The key a Ctrl+click on a toolbar menu's button is made with (ui/Menu.svelte's `quick`), as its tooltip names it:
// Cmd on a Mac (where a Ctrl+click is the context menu's), else Ctrl.
import { onMac } from './clipboard-host.ts';

/** The key's name in a tooltip's hint ("Ctrl+click to…"). */
export const quickKey = (): string => (onMac(navigator) ? 'Cmd' : 'Ctrl'); // i18n-ignore: the keys' own names
