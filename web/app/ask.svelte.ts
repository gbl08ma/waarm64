// The page's questions and notices (docs/frontend.md "Dialogs"): in-page dialogs instead of the browser's confirm, alert
// and prompt, shown one at a time by Ask.svelte (`<dialog id="ask">`). Each resolves when answered; Esc is Cancel.
// The words are the caller's, rendered (`t(…)`, web/i18n.ts); the defaults are the catalog's.
import { t } from '../i18n.ts';

export type Question = {
  kind: 'confirm' | 'alert' | 'prompt' | 'wait';
  title: string;
  text: string;
  ok: string;
  cancel: string;
  /** The OK button does something that can't be undone (it's drawn as a warning). */
  danger: boolean;
  /** A prompt's first text. */
  value: string;
  resolve(answer: boolean | string | undefined): void;
};
type Options = { title?: string; ok?: string; cancel?: string; danger?: boolean };

export const asking = $state({ current: undefined as Question | undefined, serial: 0 });
const queue: Question[] = [];

function show(q: Omit<Question, 'resolve'>, shown?: (q: Question) => void) {
  return new Promise<boolean | string | undefined>((resolve) => {
    const full = { ...q, resolve };
    shown?.(full);
    queue.push(full);
    if (!asking.current) next();
  });
}
function next() {
  asking.current = queue.shift();
  asking.serial++;
}
/** Answers the question shown (Ask.svelte): OK (`true`, or a prompt's `text`) or Cancel (`false`, a prompt's `undefined`). */
export function answer(ok: boolean, text = '') {
  const q = asking.current;
  if (!q) return;
  q.resolve(q.kind === 'prompt' ? (ok ? text : undefined) : ok);
  next();
}

/** Takes question `q` down, shown or queued, as a Cancel (a question already answered stays answered). */
function takeDown(q: Question | undefined) {
  if (!q) return;
  if (asking.current === q) answer(false);
  else {
    const i = queue.indexOf(q);
    if (i >= 0) queue.splice(i, 1);
    q.resolve(false);
  }
}

export const ask = {
  /** OK or Cancel. */
  confirm: (text: string, o: Options = {}) =>
    show({
      kind: 'confirm',
      title: o.title ?? t('common:ask.confirmTitle'),
      text,
      ok: o.ok ?? t('common:ask.ok'),
      cancel: o.cancel ?? t('common:ask.cancel'),
      danger: o.danger ?? false,
      value: '',
    }) as Promise<boolean>,
  /** A notice: OK only. */
  alert: (text: string, o: Options = {}) =>
    show({
      kind: 'alert',
      title: o.title ?? t('common:ask.title'),
      text,
      ok: o.ok ?? t('common:ask.ok'),
      cancel: '',
      danger: false,
      value: '',
    }).then(() => undefined),
  /** OK or Cancel, which the caller can also take down (`close`: as a Cancel, `answer` false). */
  closableConfirm(text: string, o: Options = {}): { answer: Promise<boolean>; close(): void } {
    let q: Question | undefined;
    const answer = show(
      {
        kind: 'confirm',
        title: o.title ?? t('common:ask.confirmTitle'),
        text,
        ok: o.ok ?? t('common:ask.ok'),
        cancel: o.cancel ?? t('common:ask.cancel'),
        danger: o.danger ?? false,
        value: '',
      },
      (shown) => (q = shown),
    ) as Promise<boolean>;
    return { answer, close: () => takeDown(q) };
  },
  /**
   * A wait the caller ends (`close`): its one button (`ok`, drawn as a warning, not focused) resolves `skipped`; Esc
   * does nothing (Ask.svelte: taken down, it would leave no way to cut the wait short).
   */
  wait(text: string, o: Options = {}): { skipped: Promise<void>; close(): void } {
    let q: Question | undefined;
    const answered = show(
      {
        kind: 'wait',
        title: o.title ?? t('common:ask.title'),
        text,
        ok: o.ok ?? t('common:ask.ok'),
        cancel: '',
        danger: true,
        value: '',
      },
      (shown) => (q = shown),
    );
    return {
      skipped: answered.then((ok) => (ok ? undefined : new Promise<void>(() => undefined))),
      close: () => takeDown(q),
    };
  },
  /** A line of text, or undefined if cancelled. */
  prompt: (text: string, value = '', o: Options = {}) =>
    show({
      kind: 'prompt',
      title: o.title ?? t('common:ask.title'),
      text,
      ok: o.ok ?? t('common:ask.ok'),
      cancel: o.cancel ?? t('common:ask.cancel'),
      danger: false,
      value,
    }) as Promise<string | undefined>,
};
