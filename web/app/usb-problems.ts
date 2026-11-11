// The page's words for what a USB device's worker reports (`UsbProblem`, docs/usb.md "What the browser allows"): each
// problem in plain words with the host OS's remedy, and an attach's error with its problems. DOM-free: Node's tests
// use it. The entries and their matching are web/app/usb-ports.ts.
import { describe, errorText, msg, t, type Msg } from '../i18n.ts';
import type { UsbProblem } from '../usb-device.ts';
import { hex4 } from './usb-ports.ts';

/** The host's OS, for the remedies (they differ). */
export type HostOs = 'linux' | 'mac' | 'windows' | 'chromeos' | 'other';
export function hostOs(
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no navigator in Node's tests
  nav: { userAgent?: string; userAgentData?: { platform?: string } } = globalThis.navigator ?? {},
): HostOs {
  const p = `${nav.userAgentData?.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase();
  if (p.includes('cros')) return 'chromeos';
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  if (p.includes('linux') || p.includes('x11')) return 'linux';
  return 'other';
}

/** USB interface classes by number, as the messages name them (their keys). */
const CLASSES: Record<number, string> = {
  0x01: 'usb:usb-problems.class.audio',
  0x02: 'usb:usb-problems.class.cdc',
  0x03: 'usb:usb-problems.class.hid',
  0x06: 'usb:usb-problems.class.stillImage',
  0x07: 'usb:usb-problems.class.printer',
  0x08: 'usb:usb-problems.class.massStorage',
  0x09: 'usb:usb-problems.class.hub',
  0x0a: 'usb:usb-problems.class.cdcData',
  0x0b: 'usb:usb-problems.class.smartCard',
  0x0e: 'usb:usb-problems.class.video',
  0x10: 'usb:usb-problems.class.audioVideo',
  0xe0: 'usb:usb-problems.class.bluetooth',
  0xfe: 'usb:usb-problems.class.dfu',
  0xff: 'usb:usb-problems.class.vendor',
};
const className = (c: number): Msg =>
  CLASSES[c] ? msg(CLASSES[c]) : msg('usb:usb-problems.class.other', { code: `0x${c.toString(16).padStart(2, '0')}` });

/** The HID top-level collections the browser protects, as the messages name them (usage page:usage → key). */
const HID_USAGES: Record<string, string> = {
  '1:1': 'usb:usb-problems.usage.pointer',
  '1:2': 'usb:usb-problems.usage.mouse',
  '1:6': 'usb:usb-problems.usage.keyboard',
  '1:7': 'usb:usb-problems.usage.keypad',
  '1:128': 'usb:usb-problems.usage.systemControl',
};

/**
 * What WebUSB keeps from pages, with where to go instead by class (docs/usb.md "What WebUSB can't attach, and where it
 * goes instead"): a message per route.
 */
function protectedInterface(iface: number, c: number): string {
  const p = { interface: iface, class: className(c) };
  switch (c) {
    case 0x03:
      return t('usb:usb-problems.protectedInterface.hid', p);
    case 0x08:
      return t('usb:usb-problems.protectedInterface.disk', p);
    case 0x01:
    case 0x0e:
    case 0x10:
      return t('usb:usb-problems.protectedInterface.sound', p);
    case 0xe0:
      return t('usb:usb-problems.protectedInterface.bluetooth', p);
    default:
      return t('usb:usb-problems.protectedInterface', p);
  }
}

/** The udev rule that opens a device to the user (Linux), for the messages. */
const udevRule = (d: ProblemDevice) =>
  d.api === 'hid'
    ? `KERNEL=="hidraw*", ATTRS{idVendor}=="${hex4(d.vendorId)}", ATTRS{idProduct}=="${hex4(d.productId)}", TAG+="uaccess"`
    : `SUBSYSTEM=="usb", ATTRS{idVendor}=="${hex4(d.vendorId)}", ATTRS{idProduct}=="${hex4(d.productId)}", TAG+="uaccess"`;

/** A step of a remedy: what to do, then a command or a line to copy (`code`), or a page to open (`link`). */
export type FixStep = { text: string; code?: string; link?: string };
/**
 * A problem in words: `text` first, short and plain; `fix`, the host OS's remedy, which the page shows folded (a
 * title, numbered steps, a note: UsbProblems.svelte); `said`, the browser's own message, folded with it.
 */
export type ProblemWords = { text: string; fix?: { title: string; steps: FixStep[]; note?: FixStep }; said?: string };

/** The words as plain text: `text` alone, or (`all`) everything in them. */
export function wordsText(w: ProblemWords, all = false): string {
  if (!all) return w.text;
  const f = w.fix;
  const step = (s: FixStep) => [s.text, s.code, s.link].filter(Boolean).join(' ');
  const fix = f
    ? [`${f.title}:`, ...f.steps.map((s, i) => `${i + 1}. ${step(s)}`), ...(f.note ? [step(f.note)] : [])]
    : [];
  return [w.text, ...fix, ...(w.said ? [browserSaid(w.said)] : [])].join('\n');
}

/** The browser's own message, as the page quotes it under a problem. */
export const browserSaid = (said: string) => t('usb:usb-problems.browserSaid', { said });

/** Zadig's steps for the WinUSB driver on an interface (Windows: a browser uses a device only through WinUSB). */
const zadig = (iface?: number): FixStep[] => [
  {
    text:
      iface === undefined ? t('usb:usb-problems.zadig') : t('usb:usb-problems.zadig.interface', { interface: iface }),
    link: 'https://zadig.akeo.ie',
  },
  { text: t('usb:usb-problems.replug') },
];

/** The device a problem is of, as far as its remedies need it. */
type ProblemDevice = { api: 'usb' | 'hid'; vendorId: number; productId: number };

/**
 * A problem the device worker reported, in words for the user, with the host OS's remedy where there is one
 * (docs/usb.md "What the browser allows": the host's drivers come first, and the page can't change that).
 */
export function problemText(p: UsbProblem, d: ProblemDevice, os: HostOs = hostOs()): ProblemWords {
  switch (p.kind) {
    case 'protected-interface':
      return { text: protectedInterface(p.interface, p.class) };
    case 'claim-failed':
      return claimFailed(p.interface, p.message, os);
    case 'protected-collection':
      return protectedCollection(p);
    case 'no-collections':
      return { text: t('usb:usb-problems.noCollections') };
    case 'open-failed':
      return openFailed(p.message, d, os);
  }
}

/** An interface the host's driver holds: by OS, how to let it go (Linux), what holds it (macOS), WinUSB (Windows). */
function claimFailed(iface: number, said: string, os: HostOs): ProblemWords {
  const text = t('usb:usb-problems.claimFailed', { interface: iface });
  switch (os) {
    case 'linux':
      return { text, said, fix: unbindSteps(iface) };
    case 'mac':
      return {
        text,
        said,
        fix: {
          title: t('usb:usb-problems.claimFailed.mac'),
          steps: [{ text: t('usb:usb-problems.claimFailed.mac.quit') }],
          note: { text: t('usb:usb-problems.claimFailed.mac.note') },
        },
      };
    case 'windows':
      return {
        text,
        said,
        fix: {
          title: t('usb:usb-problems.claimFailed.windows'),
          steps: zadig(iface),
          note: { text: t('usb:usb-problems.claimFailed.windows.note') },
        },
      };
    default:
      return { text: t('usb:usb-problems.claimFailed.other', { interface: iface }), said };
  }
}

/** Linux's remedy for a held interface: find its driver, unbind it, and (the note) keep it off. */
const unbindSteps = (iface: number): NonNullable<ProblemWords['fix']> => {
  const name = `1-2:1.${iface}`;
  return {
    title: t('usb:usb-problems.claimFailed.linux'),
    steps: [
      { text: t('usb:usb-problems.claimFailed.linux.driver'), code: 'lsusb -t' }, // i18n-ignore: a command
      {
        text: t('usb:usb-problems.claimFailed.linux.name', { name }),
        code: 'ls /sys/bus/usb/drivers/<driver>/', // i18n-ignore: a command
      },
      {
        text: t('usb:usb-problems.claimFailed.linux.unbind'),
        code: `echo -n ${name} | sudo tee /sys/bus/usb/drivers/<driver>/unbind`, // i18n-ignore: a command
      },
      { text: t('usb:usb-problems.claimFailed.linux.again') },
    ],
    note: { text: t('usb:usb-problems.claimFailed.linux.blacklist'), code: 'blacklist <driver>' }, // i18n-ignore: a line of a file
  };
};

/** A HID collection the browser keeps from pages (`kept`: the device's other collections still reach the guest). */
function protectedCollection(p: Extract<UsbProblem, { kind: 'protected-collection' }>): ProblemWords {
  const usage = HID_USAGES[`${p.usagePage}:${p.usage}`];
  const what = usage
    ? msg(usage)
    : msg('usb:usb-problems.usage.other', { usage: `${hex4(p.usagePage)}:${hex4(p.usage)}` });
  return {
    text: p.kept
      ? t('usb:usb-problems.protectedCollection.kept', { what })
      : t('usb:usb-problems.protectedCollection', { what }),
  };
}

/** A device the host doesn't let the browser open: a udev rule (Linux), WinUSB (Windows, WebUSB's devices). */
function openFailed(said: string, d: ProblemDevice, os: HostOs): ProblemWords {
  if (os === 'linux')
    return {
      text: t('usb:usb-problems.openFailed.linux'),
      said,
      fix: {
        title: t('usb:usb-problems.openFailed.linux.title'),
        steps: [
          { text: t('usb:usb-problems.openFailed.linux.udev'), code: udevRule(d) },
          { text: t('usb:usb-problems.openFailed.linux.reload'), code: 'sudo udevadm control --reload' }, // i18n-ignore: a command
          { text: t('usb:usb-problems.replug') },
        ],
      },
    };
  if (os === 'windows' && d.api === 'usb')
    return {
      text: t('usb:usb-problems.openFailed.windows'),
      said,
      fix: { title: t('usb:usb-problems.openFailed.windows.title'), steps: zadig() },
    };
  return { text: t('usb:usb-problems.openFailed.other'), said };
}

/**
 * An error as the page shows it: its words (a headline and its causes, a line each), or, for an attach's that has the
 * problems' words (a `UsbError`), its headline and those.
 */
export type ErrorView = { text: string; words?: ProblemWords[] };
export function errorView(e: unknown): ErrorView {
  const words = (e as { words?: ProblemWords[] } | undefined)?.words;
  return words?.length ? { text: describe(e).headline, words } : { text: errorText(e) };
}

/** An error's view as plain text, a line each: its text, then each problem's (for the message bar). */
export function errorLines(e: unknown): string {
  const v = errorView(e);
  return [v.text, ...(v.words ?? []).map((w) => w.text)].join('\n');
}
