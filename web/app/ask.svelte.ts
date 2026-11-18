// The page's questions and notices (docs/frontend.md "Dialogs"): in-page dialogs instead of the browser's confirm, alert
// and prompt, shown one at a time by Ask.svelte (`<dialog id="ask">`). Each resolves when answered; Esc is Cancel.
// The words are the caller's: rendered (`t(…)`, web/i18n.ts), or a message (`msg(…)`), drawn with its names' and the
// page's elements' markers (T.svelte); the defaults are the catalog's.
import { t, type Msg } from '../i18n.ts';

/** A question's words: rendered, or a message. */
export type Words = string | Msg;

export type Question = {
  kind: 'confirm' | 'alert' | 'prompt' | 'wait';
  title: Words;
  text: Words;
  ok: string;
  cancel: string;
  /** The OK button does something that can't be undone (it's drawn as a warning). */
  danger: boolean;
  /** A prompt's first text. */
  value: string;
  resolve(answer: boolean | string | undefined): void;
};
type Options = { title?: Words; ok?: string; cancel?: string; danger?: boolean };

export const asking = $state({ current: undefined as Question | undefined, serial: 0 });
const queue: Question[] = [];
/** The question shown, as given: `asking.current` holds Svelte's proxy of it, which never equals it (`takeDown`). */
let shownRaw: Question | undefined;

function show(q: Omit<Question, 'resolve'>, shown?: (q: Question) => void) {
  return new Promise<boolean | string | undefined>((resolve) => {
    const full = { ...q, resolve };
    shown?.(full);
    queue.push(full);
    if (!asking.current) next();
  });
}
function next() {
  shownRaw = queue.shift();
  asking.current = shownRaw;
  asking.serial++;
}
/** Answers the question shown (Ask.svelte): OK (`true`, or a prompt's `text`) or Cancel (`false`, a prompt's `undefined`). */
export function answer(ok: boolean, text = '') {
  const q = shownRaw;
  if (!q) return;
  q.resolve(q.kind === 'prompt' ? (ok ? text : undefined) : ok);
  next();
}

/** Takes question `q` down, shown or queued, as a Cancel (a question already answered stays answered). */
function takeDown(q: Question | undefined) {
  if (!q) return;
  if (shownRaw === q) answer(false);
  else {
    const i = queue.indexOf(q);
    if (i >= 0) queue.splice(i, 1);
    q.resolve(false);
  }
}

export const ask = {
  /** OK or Cancel. */
  confirm: (text: Words, o: Options = {}) =>
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
  alert: (text: Words, o: Options = {}) =>
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
  closableConfirm(text: Words, o: Options = {}): { answer: Promise<boolean>; close(): void } {
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
  wait(text: Words, o: Options = {}): { skipped: Promise<void>; close(): void } {
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
  /** A line of text, or undefined if cancelled (`danger`: OK does what can't be undone; the text is one to copy first). */
  prompt: (text: Words, value = '', o: Options = {}) =>
    show({
      kind: 'prompt',
      title: o.title ?? t('common:ask.title'),
      text,
      ok: o.ok ?? t('common:ask.ok'),
      cancel: o.cancel ?? t('common:ask.cancel'),
      danger: o.danger ?? false,
      value,
    }) as Promise<string | undefined>,
};
