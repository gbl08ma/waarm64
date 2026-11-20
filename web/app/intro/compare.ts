// The introduction's comparison with the other projects that run Linux in a browser (web/app/intro/IntroCompare.svelte):
// its columns, its rows and what the others do better. The facts are docs/comparison.md's (§2 the table, §3 and §4
// where they lead, §6 the sources), checked on `CHECKED`; a cell that page marks unverified says so here
// (`intro:IntroCompare.unconfirmed`). The other projects move fast: check that page's sources again before a deploy,
// and move the date with them.

/** The day the other projects' documentation and source were last read. */
export const CHECKED = '2026-11-18';

/**
 * A day written `yyyy-mm-dd`, as a date the visitor's locale writes as that day: its noon where the visitor is
 * (`new Date('2026-11-18')` is midnight in UTC, the day before in the Americas).
 */
export const day = (ymd: string) => new Date(`${ymd}T12:00`);

/** A project of the comparison: its name (a proper name, as its authors write it) and where its facts come from. */
export type Peer = { id: string; name: string; source?: string };
export const PEERS: Peer[] = [
  { id: 'ours', name: 'waarm64' }, // i18n-ignore
  { id: 'unkernel', name: 'unkernel', source: 'https://github.com/pithings/unkernel' }, // i18n-ignore
  { id: 'webvm', name: 'WebVM', source: 'https://github.com/leaningtech/webvm' }, // i18n-ignore
  { id: 'v86', name: 'v86', source: 'https://github.com/copy/v86' }, // i18n-ignore
  { id: 'jslinux', name: 'JSLinux', source: 'https://bellard.org/jslinux/tech.html' }, // i18n-ignore
];
