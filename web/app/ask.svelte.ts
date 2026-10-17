// The page's questions and notices (docs/frontend.md "Dialogs"): in-page dialogs instead of the browser's confirm, alert
// and prompt, shown one at a time by Ask.svelte (`<dialog id="ask">`). Each resolves when answered; Esc is Cancel.

export type Question = {
  kind: 'confirm' | 'alert' | 'prompt';
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

function show(q: Omit<Question, 'resolve'>) {
  return new Promise<boolean | string | undefined>((resolve) => {
    queue.push({ ...q, resolve });
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

export const ask = {
  /** OK or Cancel. */
  confirm: (text: string, o: Options = {}) => show({ kind: 'confirm', title: o.title ?? 'Are you sure?', text, ok: o.ok ?? 'OK', cancel: o.cancel ?? 'Cancel', danger: o.danger ?? false, value: '' }) as Promise<boolean>,
  /** A notice: OK only. */
  alert: (text: string, o: Options = {}) => show({ kind: 'alert', title: o.title ?? 'webpc', text, ok: o.ok ?? 'OK', cancel: '', danger: false, value: '' }).then(() => {}),
  /** A line of text, or undefined if cancelled. */
  prompt: (text: string, value = '', o: Options = {}) => show({ kind: 'prompt', title: o.title ?? 'webpc', text, ok: o.ok ?? 'OK', cancel: o.cancel ?? 'Cancel', danger: false, value }) as Promise<string | undefined>,
};
