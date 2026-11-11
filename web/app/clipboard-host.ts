// Clipboard sharing's view of the browser (docs/plans/clipboard.md §4; web/app/clipboard.ts `ClipboardShare`): the
// types that cross, the browser's clipboard and permission as the page takes them, the paste chord, the hashes the page
// remembers of a clipboard's content, and what `read()`'s items hold.

/** The type text crosses as. */
export const TEXT = 'text/plain;charset=utf-8';
/** The page's one image type, both ways (plan §4.4). */
export const PNG = 'image/png';
/** HTML, both ways beside the text (plan §3.2), within `TEXT_CAP`. */
export const HTML = 'text/html';
/** The most text that crosses (plan §3.2), checked against an offer's size before any bytes do. */
export const TEXT_CAP = 16 << 20;
/** The most image bytes that cross (plan §4.4), checked as `TEXT_CAP` is. */
export const IMAGE_CAP = 64 << 20;

/** A clipboard item as `read()` gives it: its types, and its data by type where the browser gives it. */
export type HostItem = { types: readonly string[]; getType?: (type: string) => Promise<Blob> };

/**
 * What the clipboard needs of the browser: its clipboard (`readText`, `read` and `write` where it has them) and
 * whether the document has focus.
 */
export type Host = {
  clipboard: {
    writeText(text: string): Promise<void>;
    readText?: () => Promise<string>;
    read?: () => Promise<readonly HostItem[]>;
    /** One `ClipboardItem` of these types, whose promises the browser awaits at the write (`write([new ClipboardItem(…)])`). */
    write?: (item: Record<string, Promise<Blob>>) => Promise<void>;
  };
  hasFocus: () => boolean;
  /** The browser fires `clipboardchange` (the page then reads on it, not on every focus). */
  changeEvents?: boolean;
  /** The browser runs on a Mac: its paste chord is Cmd+V (`isPasteChord`). */
  mac?: boolean;
  /** An image (a JPEG, a BMP, …) as a PNG, converted in a worker (web/app/png.ts `toPng`). */
  toPng?(image: Blob): Promise<Blob>;
};

/** What a side's clipboard holds as the page passes it: text, an image (a PNG), or both; HTML beside either. */
export type Content = { text?: string; image?: Blob; html?: string };

/**
 * Chromium's `clipboard-read` permission as the page knows it; `none` where the browser has no such permission (Firefox,
 * Safari: a read wants a click and shows their Paste button) or there is no clipboard (not a secure context).
 */
export type ReadPermission = 'granted' | 'prompt' | 'denied' | 'none';

/** What the toolbar's button shows (plan §5): sharing, paused for the run, or waiting for the guest's program (before its HELLO, or since its port closed). */
export type ShareState = 'sharing' | 'paused' | 'waiting';

/**
 * The read permission, followed: `onChange` with each state, the first at once (`none` if the browser can't say).
 * Resolves with the first.
 */
export async function watchReadPermission(
  permissions: Pick<Permissions, 'query'> | undefined,
  hasClipboard: boolean,
  onChange: (s: ReadPermission) => void,
): Promise<ReadPermission> {
  let status: PermissionStatus | undefined;
  try {
    // Firefox and Safari throw: `clipboard-read` isn't a permission name there.
    status = hasClipboard ? await permissions?.query({ name: 'clipboard-read' as PermissionName }) : undefined;
  } catch {
    status = undefined;
  }
  const state = (): ReadPermission => (status ? status.state : 'none');
  status?.addEventListener('change', () => onChange(state()));
  onChange(state());
  return state();
}

/**
 * Whether a key event is the browser's paste chord on this host (by the key, as the browser's shortcut is): Ctrl+V,
 * Ctrl+Shift+V and Shift+Insert; on a Mac (`mac`), Cmd+V and Cmd+Shift+V only (Ctrl+V is the guest's own key there,
 * and no paste event would come for it).
 */
export function isPasteChord(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  mac = false,
): boolean {
  if (e.altKey) return false;
  if (e.key === 'v' || e.key === 'V') return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return !mac && e.code === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey;
}

/** Whether the browser runs on a Mac (its paste chord is Cmd+V): its client hints' platform, else `navigator.platform`. */
export function onMac(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- no platform said ('') is unset
  return /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
}

/** A 53-bit hash of a string (cyrb53): what the page remembers of the last text each way. */
export function textHash(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** An image's bytes, hashed (SHA-256, its first 96 bits in hex): what the page remembers of an image. */
export async function imageHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the page remembers of a clipboard's content: its text's hash and its image's (`imageHash`), either absent. */
export function contentHash(text?: string, image?: string): string {
  return `${text ? textHash(text) : ''}/${image ?? ''}`;
}

export const isText = (t: string) => t === TEXT || t === 'text/plain';
export const isImage = (t: string) => /^image\/./i.test(t);

/** The PNG of `read()`'s items, if one has it (and the browser gives its data). */
export async function pngOf(items: readonly HostItem[] | undefined): Promise<Blob | undefined> {
  const item = items?.find((i) => i.types.includes(PNG) && i.getType);
  return item?.getType?.(PNG).catch(() => undefined);
}

/** Text as HTML that shows it. */
export const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** The text of `read()`'s items as `type` (`text/plain`, `text/html`), if one has it. */
export async function textOf(items: readonly HostItem[] | undefined, type = 'text/plain'): Promise<string | undefined> {
  const item = items?.find((i) => i.types.includes(type) && i.getType);
  return (
    (await item?.getType?.(type).then(
      (b) => b.text(),
      () => undefined,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty text is none
    )) || undefined
  );
}

/**
 * The host's clipboard from a click's read; undefined if the browser gave nothing (refused, nothing, a dismissed
 * Paste button). With `image`, `read()` first, for the PNG and the text; else (or with neither) `readText`.
 */
export async function readClick(host: Host, image: boolean): Promise<Content | undefined> {
  try {
    if (image && host.clipboard.read) {
      const items = await host.clipboard.read();
      const [text, png, html] = [await textOf(items), await pngOf(items), await textOf(items, HTML)];
      if (text || png) return { text, image: png, html };
    }
    const text = await host.clipboard.readText?.();
    return text ? { text } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host's clipboard for a focus read: `got` undefined if there's nothing to sync (empty, no text or image); none at
 * all if the browser refused. An empty `readText` asks `read()` for the types: text among them is a hidden read
 * (`hidden`, §4.3). After a `clipboardchange` (the only reads there are where it fires), `read()` is asked anyway, for an
 * image (taken with `images`).
 */
export async function readHost(host: Host, images: boolean): Promise<{ got?: Content; hidden: boolean } | undefined> {
  try {
    const text = await host.clipboard.readText?.();
    const items = !text || host.changeEvents ? await host.clipboard.read?.().catch(() => undefined) : undefined;
    const png = images ? await pngOf(items) : undefined;
    const image = png && png.size <= IMAGE_CAP ? png : undefined;
    const html = await textOf(items, HTML);
    if (text) return { got: { text, image, html }, hidden: false };
    // Text among the types, yet none read: hidden. No types, or others (an image): nothing to sync, a run broken.
    const hidden = !!items?.some((i) => i.types.some(isText));
    return { got: image ? { image, html } : undefined, hidden };
  } catch {
    // A refusal (NotAllowedError, DataError) is never an error mid-work.
    return undefined;
  }
}

/** The hash of content the host's clipboard has (its image's bytes read for it). */
export async function hashOf(c: Content): Promise<string> {
  return contentHash(c.text, c.image && (await imageHash(new Uint8Array(await c.image.arrayBuffer()))));
}
