// The copy editor on the page (docs/i18n.md "Editing the copy on the page"), loaded only while it's on
// (web/app/copy-edit.ts): it finds the marks web/i18n.ts puts on every message rendered, takes them out of the page's
// text and attributes and remembers which message each piece of text is; a click with Alt held opens a panel with the
// messages of what was clicked, their notes and their words to edit. A change shows at once where the words are
// plain text, and is kept in this browser for `copyEdit.dump()`. A developer's tool: its words are its own.
import { copyEdits, copyEditor } from '../i18n.ts';
import { changed } from './copy-edit.ts';

/** The attributes whose words the user reads. */
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'label'];
/** The messages in each text node, and in each element's attributes (by attribute). */
const inText = new WeakMap<Text, number[]>();
const inAttrs = new WeakMap<Element, Map<string, number[]>>();
let host: HTMLElement;

/** Takes the marks out of the page under `root`, remembering where each message is. */
export function scan(root: Node = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n === host ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const v = (n as Text).data;
      if (!v.includes('⁣')) continue;
      const ids = copyEditor.marks(v);
      inText.set(n as Text, ids);
      (n as Text).data = strip(v);
      n.parentElement?.setAttribute('data-copy-edit', '');
    } else {
      const el = n as Element;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (!v?.includes('⁣')) continue;
        let m = inAttrs.get(el);
        if (!m) inAttrs.set(el, (m = new Map<string, number[]>()));
        m.set(a, copyEditor.marks(v));
        el.setAttribute(a, strip(v));
        el.setAttribute('data-copy-edit', '');
      }
    }
  }
  if (document.title.includes('⁣')) document.title = strip(document.title);
}

const strip = (s: string) => s.replace(/⁣[​‌]+⁤/g, '');

/** The messages shown in `el` and under it: in its text and its attributes. */
function messagesIn(el: Element): number[] {
  const ids = new Set<number>();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) for (const id of inText.get(n as Text) ?? []) ids.add(id);
    else for (const list of inAttrs.get(n as Element)?.values() ?? []) for (const id of list) ids.add(id);
  }
  return [...ids];
}

/** The messages of what was clicked: of the nearest element (it, or one around it) that shows some. */
function messagesAt(target: Element): number[] {
  for (let el: Element | null = target; el && el !== document.documentElement; el = el.parentElement) {
    const ids = messagesIn(el);
    if (ids.length) return ids.slice(0, 40);
  }
  return [];
}

/** Puts message `id`'s new words where its old ones are shown (where they're plain text). */
function redraw(id: number) {
  const { was, now } = copyEditor.again(id);
  if (was === now || !was) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (inText.get(n as Text)?.includes(id)) (n as Text).data = (n as Text).data.replace(was, now);
    } else {
      for (const [a, list] of inAttrs.get(n as Element) ?? [])
        if (list.includes(id)) (n as Element).setAttribute(a, ((n as Element).getAttribute(a) ?? '').replace(was, now));
    }
  }
}

/** The parameters and markers words use (`{{name}}`, `{{name, format}}`, `<tag>`). */
const usesOf = (s: string) =>
  new Set(
    [...s.matchAll(/\{\{\s*([\w.]+)/g)]
      .map((m) => `{{${m[1]}}}`)
      .concat([...s.matchAll(/<\/?([a-z][a-z0-9-]*)>/g)].map((m) => `<${m[1]}>`)),
  );

/** What new words `now` lose or add of the parameters and markers `was` used. */
function slips(was: string, now: string): string {
  const a = usesOf(was),
    b = usesOf(now);
  const lost = [...a].filter((x) => !b.has(x)),
    added = [...b].filter((x) => !a.has(x));
  // i18n-ignore-next: the copy editor's own (a translator's tool, in English)
  return [lost.length ? `missing ${lost.join(' ')}` : '', added.length ? `unknown ${added.join(' ')}` : '']
    .filter(Boolean)
    .join('; ');
}

const STYLE = `
:host { all: initial; }
.panel { position: fixed; z-index: 2147483647; right: 12px; top: 12px; width: min(460px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
  overflow: auto; box-sizing: border-box; padding: 10px 12px; font: 13px/1.4 system-ui, sans-serif; color: var(--text, #d7dce3);
  background: var(--panel, #15181d); border: 1px solid var(--accent, #5b9dff); border-radius: 8px; box-shadow: 0 8px 30px #0008; }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.head b { flex: 1; }
.entry { border-top: 1px solid var(--line, #262b33); padding: 8px 0; }
.key { font: 12px ui-monospace, monospace; color: var(--accent, #5b9dff); word-break: break-all; }
.note, .was, .shown { color: var(--dim, #8a93a0); font-size: 12px; margin: 2px 0; }
.slip { color: var(--bad, #e5484d); font-size: 12px; }
textarea { box-sizing: border-box; width: 100%; min-height: 3.2em; margin: 4px 0; font: 13px/1.4 system-ui, sans-serif; color: inherit;
  background: var(--bg, #0b0d10); border: 1px solid var(--line, #262b33); border-radius: 4px; padding: 4px 6px; resize: vertical; }
textarea.edited { border-color: var(--busy, #e0b341); }
button { font: inherit; color: inherit; background: var(--bg, #0b0d10); border: 1px solid var(--line, #262b33); border-radius: 4px; padding: 2px 10px; cursor: pointer; }
button:hover { background: var(--hover, #262c34); }
.row { display: flex; gap: 6px; align-items: center; }
.row .slip { flex: 1; }
`;

/** Element `tag` with class `cls` and text `text`. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let panel: HTMLElement | undefined;

/** The panel with messages `ids`' entries. */
function open(ids: number[]) {
  panel?.remove();
  const root = host.shadowRoot!;
  panel = el('div', 'panel');
  panel.setAttribute('data-copy-panel', '');
  const head = el('div', 'head');
  const count = el('b');
  const close = el('button', '', '×');
  close.title = 'Close (Esc)'; // i18n-ignore
  close.onclick = () => {
    panel?.remove();
    panel = undefined;
  };
  head.append(count, close);
  panel.append(head);
  const counted = () => {
    count.textContent = `Copy editor · ${Object.keys(changed()).length} changed`; // i18n-ignore
  };
  counted();
  if (!ids.length) panel.append(el('div', 'note', 'No message here.')); // i18n-ignore
  const keys = [...new Set(ids.map((id) => copyEditor.shown(id)?.key).filter((k): k is string => !!k))];
  for (const key of keys) {
    const shown = copyEditor.shownOf(key).map((id) => copyEditor.shown(id)!);
    for (const entry of copyEditor.entries(key)) {
      const box = el('div', 'entry');
      box.setAttribute('data-key', entry.key);
      const area = el('textarea');
      const current = () => copyEdits()[entry.key] ?? entry.message;
      area.value = current();
      const was = el('div', 'was');
      const slip = el('span', 'slip');
      const show = () => {
        const edited = current() !== entry.message;
        was.textContent = edited ? `catalog: ${entry.message}` : ''; // i18n-ignore
        area.classList.toggle('edited', edited);
        slip.textContent = slips(entry.message, area.value);
      };
      area.oninput = () => {
        slip.textContent = slips(entry.message, area.value);
        fit(area);
      };
      const save = el('button', '', 'Save');
      save.setAttribute('data-save', '');
      save.onclick = () => {
        copyEditor.change(entry.key, area.value);
        for (const id of copyEditor.shownOf(key)) redraw(id);
        show();
        counted();
      };
      const revert = el('button', '', 'Revert');
      revert.onclick = () => {
        copyEditor.change(entry.key, undefined);
        area.value = entry.message;
        for (const id of copyEditor.shownOf(key)) redraw(id);
        show();
        counted();
      };
      area.onkeydown = (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
      };
      const row = el('div', 'row');
      row.append(slip, revert, save);
      box.append(el('div', 'key', entry.key), el('div', 'note', entry.note), area, was, row);
      const rich = shown.some((s) => s.rich);
      const sample = shown.at(-1)?.words;
      // As shown, where it isn't the words as they are (parameters filled in, markers drawn).
      if (sample && (sample !== entry.message || rich))
        box.append(
          el(
            'div',
            'shown',
            `shown as: ${sample}${rich ? ' (with markers: changes show when it is drawn again)' : ''}`, // i18n-ignore
          ),
        );
      show();
      panel.append(box);
    }
  }
  root.append(panel);
  for (const area of panel.querySelectorAll('textarea')) fit(area);
  const first = panel.querySelector('textarea');
  first?.focus();
  first?.setSelectionRange(0, 0);
}

/** Textarea `area` as tall as its words (up to a point). */
function fit(area: HTMLTextAreaElement) {
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight + 2, 240)}px`;
}

/** Starts the editor: the marks taken out now and as the page changes, Alt+click to edit. */
export function startEditor() {
  host = document.createElement('div');
  host.id = 'copy-edit';
  host.attachShadow({ mode: 'open' }).append(Object.assign(document.createElement('style'), { textContent: STYLE }));
  // The page's keys (the screen's, its shortcuts) don't see what's typed in the panel.
  for (const type of ['keydown', 'keyup', 'keypress'])
    host.addEventListener(type, (e) => {
      if (type === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
        panel?.remove();
        panel = undefined;
      }
      e.stopPropagation();
    });
  document.body.append(host);
  document.head.append(
    Object.assign(document.createElement('style'), {
      textContent: '[data-copy-edit] { outline: 1px dashed #ff00aa88; outline-offset: 1px; }',
    }),
  );
  scan();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      scan();
    });
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
  // On pointerdown too: a click's target may be gone (a menu that closes) by the time the click lands.
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    document.addEventListener(
      type,
      (e) => {
        const ev = e as MouseEvent;
        if (!ev.altKey || ev.composedPath().includes(host)) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (type === 'click') open(messagesAt(ev.target as Element));
      },
      { capture: true },
    );
  }
}
