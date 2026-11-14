// The page's questions (web/app/ask.svelte.ts: `<dialog id="ask">`, not the browser's confirm, alert and prompt), answered
// from a test the way a user does: by clicking the dialog's buttons. `answer` gets each question as it opens and returns
// what to do: false clicks Cancel, a string types it into a prompt and clicks OK, anything else clicks OK.
import type { Page } from 'playwright-core';

export type Question = { kind: 'confirm' | 'alert' | 'prompt' | 'wait'; text: string };
let names = 0;

/** Answers every question the page asks from now on (call it before `goto`; it also takes over a page already loaded). */
export async function answerAsks(page: Page, answer: (q: Question) => boolean | string | void = () => true) {
  const fn = `__waarm64Answer${names++}`;
  await page.exposeFunction(fn, (q: Question) => answer(q) ?? true);
  const watch = (fn: string) => {
    const tick = () => {
      const d = document.getElementById('ask') as HTMLDialogElement | null;
      if (!d?.open || d.dataset.answered === d.dataset.serial) return;
      d.dataset.answered = d.dataset.serial;
      const q = { kind: d.dataset.kind, text: d.querySelector('.ask-text')?.textContent ?? '' };
      void (window as unknown as Record<string, (q: unknown) => Promise<boolean | string>>)[fn](q).then((a) => {
        const input = d.querySelector('input');
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
  await page.addInitScript(watch, fn);
  if (page.url().startsWith('http')) await page.evaluate(watch, fn);
}
