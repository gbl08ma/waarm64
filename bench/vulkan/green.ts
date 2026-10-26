// VK3 L4b: one session of bench/vulkan/green.sh classified and appended to its results file as a JSON line.
// The green signature (VK3 L4): the VA-API picture with its chroma at zero, i.e. most of its bytes off from the software
// picture by more than 24 and the picture far greener (mean G less the mean of R and B). Verdicts: `green`, `right`
// (VA-API within 0.1% of the bytes of software), `odd` (neither), `error` (no screenshot, no VA-API, the run failed).
// mpv's screenshot decides; the page's screen (the same frame as the page draws it) is classified alike and kept beside.
//   node bench/vulkan/green.ts <session dir> <results.jsonl> <arm> <knobs> <mpv options> <commit> <seconds> <rc>
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [dir, out, arm, knobs, extra, commit, seconds, rc] = process.argv.slice(2);
type Cmp = { bytes: number; off24: number; mean: number; greenness?: number[] } | undefined;
type Arm = { hardwareDecoding?: boolean; size?: string; placebo?: string; seconds?: number; shotSeconds?: number; page?: { greenness?: number } };
const r = existsSync(`${dir}/results.json`) ? JSON.parse(readFileSync(`${dir}/results.json`, 'utf8')) as Record<string, unknown> : {};
const va = r.vkva as Arm | undefined, no = r.vkno as Arm | undefined;
const mpv = r['vkva ~ vkno'] as (Cmp & { page?: Cmp }) | undefined;

/** green, right or odd from a comparison and the two pictures' greenness (VA-API's, software's). */
function classify(c: Cmp, greenVa?: number, greenNo?: number) {
  if (!c || !c.bytes || !Number.isFinite(c.off24)) return 'error';
  const share = c.off24 / c.bytes;
  if (share > 0.3 && greenVa !== undefined && greenNo !== undefined && greenVa - greenNo > 20) return 'green';
  if (share <= 0.001) return 'right';
  return 'odd';
}
let why = '';
let verdict = 'error';
if (Number(rc)) why = `the run's exit ${rc}`;
else if (!va || !no || !mpv) why = 'no results';
else if (!va.hardwareDecoding) why = 'VA-API not used';
else if (va.size !== no.size) why = `sizes ${va.size} / ${no.size}`;
else verdict = classify(mpv, mpv.greenness?.[0], mpv.greenness?.[1]);
const page = verdict === 'error' ? undefined : classify(mpv?.page, va?.page?.greenness, no?.page?.greenness);
const log = existsSync(`${dir}.log`) ? readFileSync(`${dir}.log`, 'utf8') : '';
const line = {
  date: new Date().toISOString(), session: basename(dir), arm, knobs, mpv: extra, commit, verdict, page, ...(why ? { why } : {}),
  mpvShot: mpv && { off24: mpv.off24, bytes: mpv.bytes, mean: mpv.mean, greenness: mpv.greenness },
  pageShot: mpv?.page && { ...mpv.page, greenness: [va?.page?.greenness, no?.page?.greenness] },
  seconds: Number(seconds), vkvaSeconds: va?.seconds, vkvaShotSeconds: va?.shotSeconds, placebo: va?.placebo || undefined,
  chromium: r.chromium, macos: existsSync(`${dir}.macos`) ? readFileSync(`${dir}.macos`, 'utf8').trim() : undefined,
  pageErrors: (log.match(/\[page error\]|pageerror/g) ?? []).length,
};
appendFileSync(out, JSON.stringify(line) + '\n');
// The tally so far, by arm.
const all = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { arm: string; verdict: string });
const tally = new Map<string, Record<string, number>>();
for (const x of all) { const t = tally.get(x.arm) ?? {}; t[x.verdict] = (t[x.verdict] ?? 0) + 1; tally.set(x.arm, t); }
console.log(`${line.session}: ${verdict}${page && page !== verdict ? ` (page: ${page})` : ''}${why ? ` (${why})` : ''}, ${seconds} s |`,
  [...tally].map(([a, t]) => `${a} ${t.green ?? 0} green of ${Object.values(t).reduce((n, k) => n + k, 0) - (t.error ?? 0)}${t.error ? ` (+${t.error} error)` : ''}`).join(', '));
