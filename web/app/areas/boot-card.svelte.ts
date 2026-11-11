// The boot card over the screen while a machine loads and boots (web/app/App.svelte): its title, progress and the
// boot's last line. web/app/main.ts writes it.
export const bootCard = $state({
  shown: true,
  /** The guest's screen has taken over (its console, the firmware's graphics): the card stays hidden. */
  done: false,
  title: '',
  /** How far a download is (0–1); undefined: indeterminate. */
  progress: undefined as number | undefined,
  line: '',
  /** The boot's output is on the serial console (a firmware machine booting): the card says so. */
  serial: false,
});
