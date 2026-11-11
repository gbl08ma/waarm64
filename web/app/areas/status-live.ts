// What the status bar's elements show besides the statuses (web/app/statusbar.ts `Live`), read from the areas: the
// power state, the mouse and keys, the microphone, the disks', the screen's and the network adapters' states. Reactive
// when read in a `$derived` (the status bar's, the Preferences' editor's).
import { adapterName, type Live } from '../statusbar-piece.ts';
import type { PageNetwork } from '../net-live.ts';
import { t } from '../../i18n.ts';
import { keys } from './keys.svelte.ts';
import { mouse } from './mouse.svelte.ts';
import { power } from './power.svelte.ts';
import { sound } from './sound.svelte.ts';
import { status } from './status.svelte.ts';

/** What the page knows besides the statuses, for the elements, at time `now`. */
export function liveNow(net: PageNetwork, now: number): Live {
  return {
    state: power.state,
    stateText: power.stateText,
    now,
    mouseLock: mouse.lock,
    mouseLocked: mouse.locked,
    keyboardLocked: keys.locked,
    keysFocused: keys.focused,
    mic: sound.mic,
    disks: status.disks,
    gpu: status.gpu?.g,
    nets: net.views().map((a) => ({
      name: adapterName(a.index + 1),
      phase: a.view.phase,
      text: a.connection
        ? t('statusbar:status-live.link', { connection: a.connection.name, state: a.view.text })
        : t('statusbar:status-live.link.none', { state: a.view.text }),
      details: a.view.details,
    })),
  };
}
