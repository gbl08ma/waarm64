// The page's questions (web/app/ask.svelte.ts: `<dialog id="ask">`, not the browser's confirm, alert and prompt), answered
// from a test the way a user does: by clicking the dialog's buttons. `answer` gets each question as it opens and returns
// what to do: false clicks Cancel, `ALT` the other way on (`ask.choose`), a string types it into a prompt and clicks OK,
// anything else clicks OK.
import type { Page } from 'playwright-core';

/** A question as it opened: a prompt's `value` is its field's first text (one to copy, or to change). */
export type Question = { kind: 'confirm' | 'prompt' | 'wait'; text: string; value?: string };
let names = 0;
/** `answer`'s word for a choice's other button (`ask.choose`'s `alt`). */
export const ALT = '\u0000alt';

/** Answers every question the page asks from now on (call it before `goto`; it also takes over a page already loaded). */
export async function answerAsks(page: Page, answer: (q: Question) => boolean | string | void = () => true) {
  const fn = `__waarm64Answer${names++}`;
  await page.exposeFunction(fn, (q: Question) => answer(q) ?? true);
  const watch = ([fn, alt]: [string, string]) => {
    const tick = () => {
      const d = document.getElementById('ask') as HTMLDialogElement | null;
      if (!d?.open || d.dataset.answered === d.dataset.serial) return;
      d.dataset.answered = d.dataset.serial;
      const q = { kind: d.dataset.kind, text: d.querySelector('.ask-text')?.textContent ?? '', value: d.querySelector('input')?.value };
      void (window as unknown as Record<string, (q: unknown) => Promise<boolean | string>>)[fn](q).then((a) => {
        const input = d.querySelector('input');
        if (a === alt) {
          d.querySelector<HTMLButtonElement>('[data-answer=alt]')?.click();
          return;
        }
        if (input && typeof a === 'string') {
          input.value = a;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        d.querySelector<HTMLButtonElement>(a === false ? '[data-answer=cancel]' : '[data-answer=ok]')?.click();
      });
    };
    new MutationObserver(tick).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'data-serial'] });
    tick();
  };
  await page.addInitScript(watch, [fn, ALT] as [string, string]);
  if (page.url().startsWith('http')) await page.evaluate(watch, [fn, ALT] as [string, string]);
}

/**
 * Waits for the message bar (or the Home page's banner, which shows its message there) to say `text` (its headline)
 * and, if given, `details` (the lines under it): an outcome or a refusal the page says there, not in a dialog
 * (docs/frontend.md "Dialogs and the message bar"). Fails with what the bar says.
 */
export async function barSays(page: Page, text: RegExp, details?: RegExp, timeout = 10_000) {
  const said = () => page.evaluate(() => `${document.getElementById('message-text')?.textContent ?? ''} | ${document.getElementById('message-details')?.textContent ?? ''}`);
  await page.waitForFunction(([t, d]) => new RegExp(t).test(document.getElementById('message-text')?.textContent ?? '')
    && (d === null || new RegExp(d).test(document.getElementById('message-details')?.textContent ?? '')), [text.source, details?.source ?? null] as const, { timeout })
    .catch(async (e: unknown) => { throw new Error(`${String(e)}; the bar says: ${await said()}`); });
}
