// The introduction's guest alone on a page (bench/demo/intro.html; bench/demo/targets.ts `waarm64-intro-guest`): the
// runner the first screen uses (web/app/intro/guest.ts), its frame's canvas, and what the harness reads: the serial
// port's text, when each of the tour's marks came (ms from the navigation), the guest's counters.
//   ?w=&h=   the framebuffer's pixels (512×320)
import { MARKS, markText, type GuestStats } from '../../web/app/intro/guest-protocol.ts';
import { canRunGuest, startGuest } from '../../web/app/intro/guest.ts';

const query = new URLSearchParams(location.search);
const marks: Record<string, number> = {};
let text = '';
let stats: GuestStats | undefined;
let ended: string | undefined;
const can = canRunGuest();
const guest = can
  ? startGuest({
      canvas: document.querySelector('canvas')!,
      width: Number(query.get('w') ?? 512),
      height: Number(query.get('h') ?? 320),
      cols: 64,
      rows: 12,
      onOutput: (t) => {
        text += t;
        for (const m of MARKS) if (!(m in marks) && text.includes(markText(m))) marks[m] = performance.now();
      },
      onScreen: () => (marks.screen = performance.now()),
      onStats: (s) => (stats = s),
      onEnd: (state, detail) => (ended = detail ? `${state}: ${detail}` : state),
    })
  : undefined;
Object.assign(window, { __intro: { can, guest, marks, text: () => text, stats: () => stats, ended: () => ended } });
