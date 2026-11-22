// The introduction's speed figures (web/app/intro/IntroSpeed.svelte; docs/frontend.md "The introduction"): how many
// times as fast waarm64 ran one workload as the projects it's compared with: the next fastest, named so, and v86,
// the oldest and best known of them (the user, 2026-11-20). The numbers are bench/compare/REPORT.md's on the Mac
// host (the user: those, not the dev VM's), the ratio of the medians (docs/benchmarking.md "Rules": no claim without a run behind it); a figure is taken out again if its
// peer measures faster, and all of them when the workload changes. What was run is the page's words
// (`intro:IntroSpeed.basis`), not data.

/** A measured lead over `peer` (a project's name): waarm64 ran the workload `times` times as fast. */
export type SpeedLead = { peer: string; times: number; next?: true };
/** The figures of one measurement, made on `date`; the next fastest peer first. */
export type Speed = { date: string; leads: SpeedLead[] };

/** The figures shown, or none. */
export const SPEED: Speed | undefined = {
  date: '2026-11-20',
  leads: [
    { peer: 'unkernel', times: 1.8, next: true }, // i18n-ignore: 18.03 s against 10.11 on the Mac host (1.783)
    { peer: 'v86', times: 3.9 }, // i18n-ignore: 39.34 s against 10.11 (3.891)
  ],
};
