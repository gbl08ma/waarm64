// The page's questions (docs/frontend.md "Dialogs and the message bar"): in-page dialogs instead of the browser's confirm
// and prompt, shown one at a time by Ask.svelte (`<dialog id="ask">`). Each resolves when answered; Esc is Cancel. Only
// what the user must decide or answer is asked: an outcome or a refusal, with nothing to choose, is the message bar's
// (`Messages.notify`), so there is no alert.
// The words are the caller's: rendered (`t(…)`, web/i18n.ts), a message (`msg(…)`), drawn with its names' and the
// page's elements' markers (T.svelte), or an error's (`describe(e)`: its headline and causes, drawn as ErrorText draws
// them); the defaults are the catalog's.
import { t, type Described, type Msg } from '../i18n.ts';

/** A title's words: rendered, or a message. */
export type Title = string | Msg;
/** A question's words: rendered, a message, or an error's (web/i18n.ts `describe`). */
export type Words = Title | Described;

export type Question = {
  kind: 'confirm' | 'prompt' | 'wait';
  title: Title;
  text: Words;
  ok: string;
  cancel: string;
  /** The OK button does something that can't be undone (it's drawn as a warning). */
  danger: boolean;
  /** A prompt's first text. */
  value: string;
  /** A confirm's other way to go on, a button between Cancel and OK (`ask.choose`: answered `'alt'`). */
  alt?: string;
  resolve(answer: boolean | string | undefined): void;
};
type Options = { title?: Title; ok?: string; cancel?: string; danger?: boolean };
/** OK's answer, Cancel's, or the other button's (`ask.choose`). */
export type Choice = boolean | 'alt';

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
/**
 * Answers the question shown (Ask.svelte): OK (`true`, or a prompt's `text`), Cancel (`false`, a prompt's
 * `undefined`), or a confirm's other button (`'alt'`).
 */
export function answer(ok: Choice, text = '') {
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
  /** OK, Cancel, or another way to go on (`alt`, its button's words; answered `'alt'`). */
  choose: (text: Words, o: Options & { alt: string }) =>
    show({
      kind: 'confirm',
      title: o.title ?? t('common:ask.confirmTitle'),
      text,
      ok: o.ok ?? t('common:ask.ok'),
      cancel: o.cancel ?? t('common:ask.cancel'),
      danger: o.danger ?? false,
      value: '',
      alt: o.alt,
    }) as Promise<Choice>,
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
