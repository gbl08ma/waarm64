// The introduction's one speed figure (web/app/intro/IntroSpeed.svelte; INTRO-KICKOFF.md "The comparison"): how much
// faster waarm64 is than the next best of the projects it's compared with, on one named workload. None until
// docs/comparison.md §3's rows are measured (docs/benchmarking.md "Rules": no claim without a run behind it); it is
// taken out again if a peer measures faster.

/** A measured lead: `percent` faster than `peer` at `workload` (words as the page says them), measured on `date`. */
export type SpeedLead = { percent: number; peer: string; workload: string; date: string };

/** The figure shown, or none. */
export const SPEED_LEAD: SpeedLead | undefined = undefined;
