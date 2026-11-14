// A stop for a change that keeps the machine's disk (a disk's export, the Machines page's edits, its settings' Save and
// restart, another machine opened): where the run's agent can, the guest is asked to shut down first
// (web/app/run/soft-power.ts), with a dialog meanwhile whose one button powers off at once (`dialog`), so the disk the
// change works on is the guest's clean one, not a power cut's. The dialog goes when the guest's power-off ends the run,
// or at the button; refused, no answer, or no agent that can: the hard stop at once (the change's question was asked
// already). The user's design, 2026-11-14.

/** How often the wait looks whether the guest's power-off has stopped the machine. */
export const POLL_MS = 200;

export type CleanStopDeps = {
  /** The run's agent asks the guest to power off (web/app/run/soft-power.ts `request`); false: it didn't take it. */
  soft(): Promise<boolean>;
  /** The run's agent can (its HELLO has `CAP.POWER`). */
  canSoft(): boolean;
  /** The guest still runs (its power-off ends the run's `running`). */
  up(): boolean;
  /** The dialog meanwhile: `skipped` resolves at its Power off now; `close` takes it down. */
  dialog(): { skipped: Promise<void>; close(): void };
  /** The run stopped (the hard stop's; a run the guest powered off only goes). */
  stop(): Promise<void>;
  poll?: number;
};

/** What came of it: the guest shut down, the user cut it short, or the hard stop at once. */
export type CleanStop = 'clean' | 'skipped' | 'hard';

/** Stops the running machine, asking the guest first where it can. */
export async function stopCleanly(d: CleanStopDeps): Promise<CleanStop> {
  if (!d.up() || !d.canSoft()) {
    await d.stop();
    return 'hard';
  }
  const dialog = d.dialog();
  const at = { skipped: false };
  const skip = dialog.skipped.then(() => {
    at.skipped = true;
  });
  const taken = await Promise.race([d.soft(), skip.then(() => false)]);
  if (taken && !at.skipped)
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (at.skipped || !d.up()) {
          clearInterval(timer);
          resolve();
        }
      }, d.poll ?? POLL_MS);
    });
  dialog.close();
  await d.stop();
  return at.skipped ? 'skipped' : taken ? 'clean' : 'hard';
}
