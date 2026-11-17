// A single shared pair of crossfade `send`/`receive` references, so components that mount
// and unmount in different parents (the floating message bar and the Machines page's banner)
// crossfade into each other instead of appearing/disappearing instantly.
import { crossfade } from 'svelte/transition';

export const [send, receive] = crossfade({ duration: 500 });
