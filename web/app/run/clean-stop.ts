// A stop for a change that keeps the machine's disk (a disk's export, the Machines page's edits, its settings' Save and
// restart, another machine opened): where the run's agent can, the guest is asked to shut down first
// (web/app/run/soft-power.ts), with a dialog meanwhile whose one button powers off at once (`dialog`), so the disk the
// change works on is the guest's clean one, not a power cut's. The dialog goes when the guest's power-off ends the run,
// or at its button (Esc doesn't take it down: the button is the way out). A request the toolbar made already counts
// as asked; an agent that connects again meanwhile (the guest isn't shutting down after all) is asked once more.
// Refused, unanswered, or no agent that can: the user is asked whether to power off at once (`hard`), and a No leaves
// the machine running and the change undone. The user's design, 2026-11-14.

/** How often the wait looks whether the guest's power-off has stopped the machine. */
export const POLL_MS = 200;

export type CleanStopDeps = {
  /** The run's agent asks the guest to power off (web/app/run/soft-power.ts `request`); false: it didn't take it. */
  soft(): Promise<boolean>;
  /** A request is pending (the toolbar's, or this one's; an agent that connected again cleared it). */
  pending(): boolean;
  /** The run's agent can (its HELLO has `CAP.POWER`). */
  canSoft(): boolean;
  /** The guest still runs (its power-off, or a reboot's reset, ends it). */
  up(): boolean;
  /** The dialog meanwhile: `skipped` resolves at its Power off now; `close` takes it down. */
  dialog(): { skipped: Promise<void>; close(): void };
  /** Whether to power off at once, the guest not having taken it (`agent`: it was asked; false: no agent that can). */
  hard(agent: boolean): Promise<boolean>;
  /** The run stopped (the hard stop's; a run the guest powered off only goes). */
  stop(): Promise<void>;
  poll?: number;
};

/** What came of it: the guest shut down, the user cut it short or chose the hard stop, or chose to keep it running. */
export type CleanStop = 'clean' | 'skipped' | 'hard' | 'kept';

/** Stops the running machine, asking the guest first where it can; `kept`: the user said no, nothing stopped. */
export async function stopCleanly(d: CleanStopDeps): Promise<CleanStop> {
  if (!d.up()) {
    await d.stop();
    return 'clean';
  }
  if (!d.canSoft()) return hardOr(d, false);
  const dialog = d.dialog();
  const at = { skipped: false, again: true };
  const skip = dialog.skipped.then(() => {
    at.skipped = true;
  });
  const cut = () => at.skipped; // read anew after each await (the button's)
  const ask = () => (d.pending() ? Promise.resolve(true) : d.soft());
  let taken = await Promise.race([ask(), skip.then(() => false)]);
  while (taken && !cut() && d.up()) {
    await new Promise((r) => setTimeout(r, d.poll ?? POLL_MS));
    // Cleared while the guest runs on: its agent came back, so it isn't shutting down. Asked once more.
    if (!cut() && d.up() && !d.pending()) {
      taken = at.again && (await Promise.race([d.soft(), skip.then(() => false)]));
      at.again = false;
    }
  }
  dialog.close();
  if (cut() || !d.up()) {
    await d.stop();
    return cut() ? 'skipped' : 'clean';
  }
  return hardOr(d, true);
}

async function hardOr(d: CleanStopDeps, agent: boolean): Promise<CleanStop> {
  if (agent && !(await d.hard(true))) return 'kept';
  await d.stop();
  return 'hard';
}
