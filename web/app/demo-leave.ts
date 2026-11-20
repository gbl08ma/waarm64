// Leaving a demo whose download runs (docs/frontend.md "The demo store", "Start"): the download belongs to the demo's
// pane, so what takes the pane away stops it. A click that would (another demo's row, All demos, the toolbar's Home
// or wordmark) asks first, through the page's question dialog; the question goes if the download ends meanwhile.
import { ask } from './ask.svelte.ts';
import { demos } from './areas/demos.svelte.ts';
import { msg, t } from '../i18n.ts';

/** The question, while it shows. */
let question: { close: () => void } | undefined;

/**
 * Goes where the visitor clicked (`go`), asked first if that stops a demo's download. Nothing goes if the download
 * ended meanwhile (its machine opens instead) or the store's page closed.
 */
export async function leaveDemo(go: () => void): Promise<void> {
  if (!demos.open || !demos.starting) {
    go();
    return;
  }
  const q = ask.closableConfirm(msg('machines:demo-leave.stop', { demo: demos.startingName ?? '' }), {
    title: t('machines:demo-leave.stop.title'),
    ok: t('machines:demo-leave.stop.ok'),
    cancel: t('machines:demo-leave.stop.cancel'),
  });
  question = q;
  const yes = await q.answer;
  question = undefined;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the page may have closed while the question showed
  if (yes && demos.open) go();
}

/** The download ended (made, failed or stopped): a question still asking about it goes. */
export function downloadEnded() {
  question?.close();
}
