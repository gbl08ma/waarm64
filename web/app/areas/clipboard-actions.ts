// Clipboard sharing's glue (docs/plans/clipboard.md): each run's sharing over its agent's port, the browser's
// clipboard as it uses it, the events it follows (focus, the paste chord, a key or click on the screen), and the
// clipboard menu's actions (web/app/page.ts's `clipboard*`), "Copy the screen" among them.
import type { DisplayFromPage } from '../../gpu-present.ts';
import type { ToGpuWorker } from '../../gpu-worker.ts';
import { AgentLink } from '../agent-link.ts';
import { ClipboardShare, isPasteChord, onMac, PNG, watchReadPermission, type Host } from '../clipboard.ts';
import type { Grab } from '../hooks.ts';
import type { Page } from '../page.ts';
import { rgbaPng, toPng } from '../png.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { Replies } from '../run/replies.ts';
import { clipboard } from './clipboard.svelte.ts';

type ClipboardPage = Pick<
  Page,
  'clipboardAsk' | 'clipboardPause' | 'clipboardSend' | 'clipboardType' | 'clipboardScreen'
>;

/** The browser runs on a Mac: its paste chord is Cmd+V. */
const MAC = onMac(navigator);

/** The browser's clipboard as clipboard sharing uses it (no `navigator.clipboard` outside a secure context). */
function clipboardHost(): Host {
  const c = navigator.clipboard as Clipboard | undefined;
  return {
    clipboard: {
      writeText: (s) => (c ? c.writeText(s) : Promise.reject(new Error('no clipboard'))),
      readText: c?.readText && (() => c.readText()),
      read: c?.read && (() => c.read()),
      // The promise form: the browser awaits the bytes at the write (Safari keeps the activation over the wait).
      write:
        c?.write && typeof ClipboardItem !== 'undefined' ? (item) => c.write([new ClipboardItem(item)]) : undefined,
    },
    hasFocus: () => document.hasFocus(),
    changeEvents: !!c && 'onclipboardchange' in c,
    mac: MAC,
    toPng,
  };
}

export class ClipboardActions {
  readonly #m: PageMachine;
  readonly #replies: { grabs: Replies<Grab>; screens: Replies<Blob | undefined> };
  readonly #canvas: () => HTMLCanvasElement;
  /** The running machine's end of the agent's port (web/app/agent-link.ts), while it has clipboard sharing. */
  #agent: AgentLink | undefined;

  constructor(
    m: PageMachine,
    replies: { grabs: Replies<Grab>; screens: Replies<Blob | undefined> },
    canvas: () => HTMLCanvasElement,
  ) {
    [this.#m, this.#replies, this.#canvas] = [m, replies, canvas];
  }

  /** A run's sharing over the agent's port `port` (none: the machine has no clipboard sharing). */
  begin(port: MessagePort | undefined) {
    this.#agent?.close();
    this.#agent = port && new AgentLink(port);
    window.__agent = this.#agent; // the tests' hook
    return this.#agent && new ClipboardShare(this.#agent, clipboardHost());
  }

  /** Follows what sharing follows: the focus, the paste chord, the clipboard's changes, the read permission. */
  listen() {
    // The paste chord's text, image and HTML (docs/plans/clipboard.md §4.1, way 2, §4.4): the browser's own paste
    // event while the screen holds a chord (web/input.ts), taken at the document (Firefox fires it at <body>, not at
    // the focused canvas); the image is a `File` among its items, taken during the event (the data is gone after it).
    document.addEventListener('paste', (e) => {
      if (!clipboard.share?.held || document.activeElement !== this.#canvas()) return;
      const items = [...(e.clipboardData?.items ?? [])];
      const image = items.find((i) => i.kind === 'file' && i.type === PNG)?.getAsFile() ?? undefined;
      clipboard.share.pasted(
        e.clipboardData?.getData('text/plain') ?? '',
        image,
        e.clipboardData?.getData('text/html'),
      );
    });
    // Sync on focus (plan §4.1, way 1): each time the page has focus again, and where the browser says the clipboard
    // changed; the read permission, followed (its `change` updates the button at once; granted, it syncs).
    window.addEventListener('focus', () => void clipboard.share?.focused());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void clipboard.share?.focused();
    });
    const c = navigator.clipboard as Clipboard | undefined;
    if (c && 'onclipboardchange' in c) c.addEventListener('clipboardchange', () => clipboard.share?.clipboardChanged());
    void watchReadPermission(navigator.permissions, !!c, (p) => {
      clipboard.permission = p;
      clipboard.share?.setPermission(p);
    });
    // A key or pointer down on the screen (plan §4.2): the guest's pending text is written with its activation; a
    // paste chord drops it (the host's copy goes to the guest). At the document's capture, before web/input.ts takes
    // the key: an addEventListener of its own, as <svelte:document> can't order it before the canvas's.
    const capture = { capture: true };
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.target === this.#canvas()) clipboard.share?.activated(isPasteChord(e, MAC));
      },
      capture,
    );
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target === this.#canvas()) clipboard.share?.activated(false);
      },
      capture,
    );
  }

  /**
   * The screen as it shows now, as a PNG (docs/plans/clipboard.md §4.4): a 3D machine's read back by its GPU worker and
   * encoded in a worker of its own; a 2D machine's (virtio-gpu or the framebuffer) from whoever draws it, over the
   * display port. Undefined: nothing shown yet, or no machine.
   */
  async screenPng(): Promise<Blob | undefined> {
    const r = this.#m.run;
    if (!r) return undefined;
    const gpu = r.gpu;
    if (gpu) {
      // A GPU worker that doesn't answer (busy for good, or replaced by a restart): no picture, as the 2D path.
      const g = await this.#replies.grabs.ask((id) => gpu.postMessage({ type: 'grab', id } satisfies ToGpuWorker), {
        ms: 10_000,
        fallback: { width: 0, height: 0, pixels: new Uint8Array(0) },
      });
      return g.width && g.height ? rgbaPng(g.width, g.height, new Uint8Array(g.pixels)) : undefined;
    }
    return this.#replies.screens.ask((id) => r.display.postMessage({ type: 'png', id } satisfies DisplayFromPage), {
      ms: 10_000,
      fallback: undefined,
    });
  }

  page(): ClipboardPage {
    return {
      // A read while the permission is `prompt` is what makes Chromium ask; the text it gives is the sync's (granted: `setPermission`).
      clipboardAsk: () => {
        if (clipboard.permission === 'prompt') void navigator.clipboard.readText().catch(() => undefined);
      },
      clipboardPause: (paused) => (paused ? clipboard.share?.pause() : clipboard.share?.resume()),
      clipboardSend: async () => {
        clipboard.failed = (await clipboard.share?.send()) ? undefined : 'send';
      },
      clipboardType: async () => {
        clipboard.failed = (await clipboard.share?.typeIt()) ? undefined : 'type';
      },
      clipboardScreen: async () => {
        // The promise form keeps the click's activation (and the focus) over the read-back; Chromium awaits it at the write.
        clipboard.failed = undefined;
        const png = this.screenPng().then(
          (b) => b ?? Promise.reject(new DOMException('no picture of the screen', 'DataError')),
        );
        try {
          await navigator.clipboard.write([new ClipboardItem({ [PNG]: png })]);
        } catch {
          clipboard.failed = 'screen'; // the menu says so
        }
      },
    };
  }
}
