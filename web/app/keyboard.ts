// The guest's keyboard layout (docs/frontend.md "The keyboard layout"): the page sends `KeyboardEvent.code`, the keys'
// positions on a PC keyboard (web/input.ts), so the guest has to be told which characters the user's keys carry. A
// machine with the setting on gives the guest, as SMBIOS credentials, a unit that sets it at every boot: localed's X11
// keymap (Xorg, GNOME, KDE, display managers) and the console's (or Debian's /etc/default/keyboard), and
// libxkbcommon's `XKB_DEFAULT_*` in /etc/environment (wlroots compositors such as sway; every PAM login and the user
// manager read it). Both stay in the guest's disk: turning the setting off leaves the last layout set.

import type { Credential } from './machine.ts';

/**
 * A layout the setting offers: XKB's names for it (xkeyboard-config's base.lst), and `vc`, the console's (kbd's keymap):
 * localed's conversion takes the first match in systemd's kbd-model-map, which for `de` is kbd's 7-bit map (`ö` types
 * `[`), and has none for `ch`, `cz`, Dvorak, Colemak or US international.
 */
export type KeyboardLayout = { id: string; label: string; layout: string; variant?: string; model?: string; vc: string };

/**
 * Latin-script layouts only (a guest's login and shell need Latin letters; a layout that toggles needs its own
 * options). `sig`: a few keys' unshifted characters as `navigator.keyboard.getLayoutMap()` gives them, for "Match this
 * browser" (`detectLayout`).
 */
const TABLE: (KeyboardLayout & { sig: Record<string, string> })[] = [
  { id: 'us', label: 'English (US)', vc: 'us', layout: 'us', sig: { KeyQ: 'q', KeyY: 'y', KeyW: 'w', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Slash: '/' } },
  { id: 'us-intl', label: 'English (US, international with dead keys)', vc: 'us-acentos', layout: 'us', variant: 'intl', sig: {} },
  { id: 'gb', label: 'English (UK)', vc: 'uk', layout: 'gb', sig: { KeyY: 'y', Semicolon: ';', Quote: "'", BracketLeft: '[', Backslash: '#', IntlBackslash: '\\', Minus: '-', Backquote: '`' } },
  { id: 'us-dvorak', label: 'English (Dvorak)', vc: 'dvorak', layout: 'us', variant: 'dvorak', sig: { KeyQ: "'", KeyW: ',', KeyE: '.', KeyS: 'o', Semicolon: 's', Minus: '[', BracketLeft: '/' } },
  { id: 'us-colemak', label: 'English (Colemak)', vc: 'colemak', layout: 'us', variant: 'colemak', sig: { KeyE: 'f', KeyR: 'p', KeyS: 'r', KeyD: 's', Semicolon: 'o', KeyJ: 'n', KeyK: 'e' } },
  { id: 'pt', label: 'Portuguese', vc: 'pt-latin1', layout: 'pt', sig: { Semicolon: 'ç', Quote: 'º', BracketLeft: '+', BracketRight: '´', Backslash: '~', Minus: "'", Equal: '«', Backquote: '\\' } },
  { id: 'br', label: 'Portuguese (Brazil, ABNT2)', vc: 'br-abnt2', layout: 'br', model: 'abnt2', sig: { Semicolon: 'ç', Quote: '~', BracketLeft: '´', BracketRight: '[', Backslash: ']', Minus: '-', Equal: '=', Backquote: "'", IntlRo: '/' } },
  { id: 'es', label: 'Spanish', vc: 'es', layout: 'es', sig: { Semicolon: 'ñ', Quote: '´', BracketLeft: '`', BracketRight: '+', Backslash: 'ç', Minus: "'", Equal: '¡', Backquote: 'º' } },
  { id: 'latam', label: 'Spanish (Latin American)', vc: 'la-latin1', layout: 'latam', sig: { Semicolon: 'ñ', Quote: '{', BracketLeft: '´', BracketRight: '+', Backslash: '}', Minus: "'", Equal: '¿', Backquote: '|' } },
  { id: 'fr', label: 'French (AZERTY)', vc: 'fr-latin1', layout: 'fr', sig: { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', Semicolon: 'm', KeyM: ',', Digit2: 'é', Quote: 'ù', BracketLeft: '^', Minus: ')', Equal: '=', Backquote: '²', Backslash: '*' } },
  { id: 'be', label: 'Belgian (AZERTY)', vc: 'be-latin1', layout: 'be', sig: { KeyQ: 'a', KeyA: 'q', KeyW: 'z', Semicolon: 'm', Digit2: 'é', Quote: 'ù', BracketLeft: '^', Minus: ')', Equal: '-', Backquote: '²', Backslash: 'µ' } },
  { id: 'de', label: 'German', vc: 'de-latin1', layout: 'de', sig: { KeyY: 'z', KeyZ: 'y', Semicolon: 'ö', Quote: 'ä', BracketLeft: 'ü', BracketRight: '+', Minus: 'ß', Equal: '´', Backquote: '^', Backslash: '#', Slash: '-' } },
  { id: 'ch', label: 'German (Switzerland)', vc: 'de_CH-latin1', layout: 'ch', sig: { KeyY: 'z', KeyZ: 'y', Semicolon: 'ö', Quote: 'ä', BracketLeft: 'ü', BracketRight: '¨', Minus: "'", Equal: '^', Backquote: '§', Backslash: '$', Slash: '-' } },
  { id: 'ch-fr', label: 'French (Switzerland)', vc: 'fr_CH-latin1', layout: 'ch', variant: 'fr', sig: { KeyY: 'z', KeyZ: 'y', Semicolon: 'é', Quote: 'à', BracketLeft: 'è', BracketRight: '¨', Minus: "'", Equal: '^', Backquote: '§', Backslash: '$' } },
  { id: 'it', label: 'Italian', vc: 'it', layout: 'it', sig: { Semicolon: 'ò', Quote: 'à', BracketLeft: 'è', BracketRight: '+', Backslash: 'ù', Minus: "'", Equal: 'ì', Backquote: '\\' } },
  { id: 'se', label: 'Swedish', vc: 'sv-latin1', layout: 'se', sig: { Semicolon: 'ö', Quote: 'ä', BracketLeft: 'å', BracketRight: '¨', Backslash: "'", Minus: '+', Equal: '´', Backquote: '§' } },
  { id: 'fi', label: 'Finnish', vc: 'fi', layout: 'fi', sig: {} },
  { id: 'no', label: 'Norwegian', vc: 'no', layout: 'no', sig: { Semicolon: 'ø', Quote: 'æ', BracketLeft: 'å', BracketRight: '¨', Backslash: "'", Minus: '+', Equal: '\\', Backquote: '|' } },
  { id: 'dk', label: 'Danish', vc: 'dk-latin1', layout: 'dk', sig: { Semicolon: 'æ', Quote: 'ø', BracketLeft: 'å', BracketRight: '¨', Backslash: "'", Minus: '+', Equal: '´', Backquote: '½' } },
  { id: 'pl', label: 'Polish', vc: 'pl2', layout: 'pl', sig: {} },
  { id: 'cz', label: 'Czech', vc: 'cz-qwertz', layout: 'cz', sig: { KeyY: 'z', KeyZ: 'y', Digit2: 'ě', Semicolon: 'ů', Quote: '§', BracketLeft: 'ú', BracketRight: ')', Minus: '=', Equal: '´', Backquote: ';' } },
  { id: 'hu', label: 'Hungarian', vc: 'hu', layout: 'hu', sig: { KeyY: 'z', KeyZ: 'y', Digit0: 'ö', Minus: 'ü', Equal: 'ó', BracketLeft: 'ő', BracketRight: 'ú', Semicolon: 'é', Quote: 'á', Backslash: 'ű', Backquote: '0' } },
  { id: 'tr', label: 'Turkish (Q)', vc: 'tr_q-latin5', layout: 'tr', sig: { KeyI: 'ı', Semicolon: 'ş', Quote: 'i', BracketLeft: 'ğ', BracketRight: 'ü', Comma: 'ö', Period: 'ç', Minus: '*', Equal: '-', Backquote: '"' } },
  { id: 'jp', label: 'Japanese', vc: 'jp106', layout: 'jp', model: 'jp106', sig: { Minus: '-', Equal: '^', BracketLeft: '@', BracketRight: '[', Semicolon: ';', Quote: ':', Backslash: ']', IntlYen: '¥', IntlRo: '\\' } },
];

export const KEYBOARD_LAYOUTS: readonly KeyboardLayout[] = TABLE.map(({ sig: _, ...l }) => l);
export const keyboardLayout = (id: string | undefined) => KEYBOARD_LAYOUTS.find((l) => l.id === id);

/** The setting's value that follows the browser: the layout it reports, looked up at every start (a new machine's default). */
export const FOLLOW_BROWSER = 'browser';
/** A value the setting can hold: a layout's id or `FOLLOW_BROWSER`. */
export const validKeyboard = (id: string) => id === FOLLOW_BROWSER || !!keyboardLayout(id);
/** The layout a start gives the guest for the setting `id`: `FOLLOW_BROWSER` is the browser's, or none where it doesn't say. */
export async function resolveKeyboard(id: string | undefined, detect = browserLayout): Promise<KeyboardLayout | undefined> {
  return id === FOLLOW_BROWSER ? detect() : keyboardLayout(id);
}

/**
 * The layout whose keys best match `map` (`navigator.keyboard.getLayoutMap()`'s code → character), or undefined
 * when none matches most of its keys. Layouts that differ only past what the map shows (US and its international
 * variant, Swedish and Finnish, US and Polish) come out as the first: the user confirms.
 */
export function detectLayout(map: ReadonlyMap<string, string>): KeyboardLayout | undefined {
  let best: { l: KeyboardLayout; score: number } | undefined;
  for (const { sig, ...l } of TABLE) {
    const keys = Object.keys(sig).filter((k) => map.has(k));
    if (keys.length < 4) continue;
    const hits = keys.filter((k) => map.get(k) === sig[k]).length;
    const score = hits / keys.length;
    if (score >= 0.75 && (!best || score > best.score)) best = { l, score };
  }
  return best?.l;
}

/** The layout this browser reports, if it can (Chromium's Keyboard API; not in Firefox or over plain HTTP). */
export async function browserLayout(): Promise<KeyboardLayout | undefined> {
  const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } }).keyboard;
  if (!kb?.getLayoutMap) return undefined;
  return detectLayout(await kb.getLayoutMap().catch(() => new Map()));
}

const UNIT = 'webpc-keyboard.service';

/** The script the unit runs (a credential of its own: no quoting in the unit). POSIX sh: Debian's is dash. */
export function keyboardScript(l: KeyboardLayout): string {
  const model = l.model ?? 'pc105';
  const variant = l.variant ?? '';
  const env = [`XKB_DEFAULT_LAYOUT=${l.layout}`, `XKB_DEFAULT_MODEL=${model}`, ...(variant ? [`XKB_DEFAULT_VARIANT=${variant}`] : [])].join('\n');
  return `# From webpc: the machine's keyboard layout setting (${l.label}), run at every boot while it is on.
# Sets KEY="VALUE" in a file, unless it says so already.
set_kv() {
  grep -qx "$2=\\"$3\\"" "$1" 2>/dev/null && return
  if grep -q "^$2=" "$1" 2>/dev/null; then sed -i "s|^$2=.*|$2=\\"$3\\"|" "$1"; else printf '%s="%s"\\n' "$2" "$3" >>"$1"; fi
}
if [ -e /etc/default/keyboard ] || [ -e /usr/share/dbus-1/system.d/systemd-localed-read-only.conf ]; then
  # Debian and Ubuntu: /etc/default/keyboard, which Xorg, localed (read-only on Debian 13: GNOME and KDE read it there) and console-setup read.
  set_kv /etc/default/keyboard XKBMODEL ${model}
  set_kv /etc/default/keyboard XKBLAYOUT ${l.layout}
  set_kv /etc/default/keyboard XKBVARIANT '${variant}'
  if command -v setupcon >/dev/null 2>&1; then setupcon -k --force || true; fi
elif command -v localectl >/dev/null 2>&1; then
  # Elsewhere localed's X11 keymap (Xorg, GNOME, KDE, display managers) and the console's, each named (its conversion
  # picks some consoles' wrongly); setting the console's reloads it. Without that keymap, the conversion's.
  localectl set-x11-keymap --no-convert ${l.layout} ${model} '${variant}' || echo 'webpc-keyboard: localectl failed' >&2
  localectl set-keymap --no-convert ${l.vc} || localectl set-x11-keymap ${l.layout} ${model} '${variant}'
fi
# wlroots compositors (sway) and anything else on libxkbcommon's defaults: XKB_DEFAULT_* for every login (pam_env).
want='${env}'
if [ "$(grep '^XKB_DEFAULT_' /etc/environment 2>/dev/null)" != "$want" ]; then
  sed -i '/^XKB_DEFAULT_/d' /etc/environment 2>/dev/null
  printf '%s\\n' "$want" >>/etc/environment
fi
`;
}

/** The systemd credentials (SMBIOS type 11, `oemStrings`) that set `l` in the guest: systemd 256+. */
export function keyboardCredentials(l: KeyboardLayout): Credential[] {
  return [
    { name: 'webpc.keyboard.sh', data: keyboardScript(l) },
    {
      name: `systemd.extra-unit.${UNIT}`,
      data: `[Unit]
Description=Keyboard layout from webpc's machine settings
ConditionPathExists=!/etc/initrd-release
After=dbus.service local-fs.target
Before=systemd-user-sessions.service display-manager.service

[Service]
Type=oneshot
ImportCredential=webpc.keyboard.sh
ExecStart=/bin/sh %d/webpc.keyboard.sh
`,
    },
    // What starts it: the generator can't read an [Install] section, so a drop-in has the logins' gate want it.
    { name: `systemd.unit-dropin.systemd-user-sessions.service~${UNIT.replace('.service', '')}`, data: `[Unit]\nWants=${UNIT}\nAfter=${UNIT}\n` },
  ];
}

/** The fw_cfg file the core moves into SMBIOS type 11 (core/src/smbios.rs `OEM_STRINGS`, ABI 49): NUL-separated strings. */
export const OEM_STRINGS_FILE = 'opt/webpc/oem-strings';

/** Credentials as SMBIOS type 11 strings, systemd's binary form (base64: the contents have newlines). */
export const oemStrings = (credentials: Credential[]) =>
  credentials.map((c) => `io.systemd.credential.binary:${c.name}=${btoa(String.fromCharCode(...new TextEncoder().encode(c.data)))}`);
