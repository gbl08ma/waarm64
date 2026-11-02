// What the page has a guest do at boot (docs/frontend.md "What the page sets in the guest"): a machine setting becomes a
// systemd unit and its POSIX sh script, given as SMBIOS credentials (systemd 256+: `systemd.extra-unit.*`,
// `systemd.unit-dropin.*`), which PID 1 imports before anything else runs. Nothing is installed: a boot without the
// setting has no unit. Guests without systemd 256 ignore them. The keyboard layout (web/app/keyboard.ts) and the
// network's settings (web/app/guest-net.ts) are two; shared folders' mount (web/app/shares-mount.ts) gives units of its own.

import type { Credential } from './machine.ts';

/**
 * The credentials of unit `name` (`webpc-<what>.service`), a oneshot that runs `script` (a credential of its own: no
 * quoting in the unit). `unit`: its [Unit] lines past the description (ordering); `wantedBy`: the unit whose drop-in
 * wants it and orders itself after it (the generator can't read an [Install] section).
 */
export function guestUnit(o: { name: string; description: string; script: string; unit: string; wantedBy: string }): Credential[] {
  const what = o.name.replace(/\.service$/, '');
  const sh = `${what.replace(/-/g, '.')}.sh`;
  return [
    { name: sh, data: o.script },
    {
      name: `systemd.extra-unit.${o.name}`,
      data: `[Unit]
Description=${oneLine(o.description)}
ConditionPathExists=!/etc/initrd-release
${o.unit}
[Service]
Type=oneshot
ImportCredential=${sh}
ExecStart=/bin/sh %d/${sh}
`,
    },
    { name: `systemd.unit-dropin.${o.wantedBy}~${what}`, data: `[Unit]\nWants=${o.name}\nAfter=${o.name}\n` },
  ];
}

/** Words on one line (a unit's description ends at a newline). */
export const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

/** The units' descriptions, in the page's words (web/app/guest-words.ts renders them; the worker gets them with the start). */
export type GuestWords = { keyboard: string; network: string; shares: string; /** The keyboard layout's name, for the comment atop its script. */ layout?: string };

/** The fw_cfg file the core moves into SMBIOS type 11 (core/src/smbios.rs `OEM_STRINGS`, ABI 49): NUL-separated strings. */
export const OEM_STRINGS_FILE = 'opt/webpc/oem-strings';

/** Credentials as SMBIOS type 11 strings, systemd's binary form (base64: the contents have newlines). */
export const oemStrings = (credentials: Credential[]) =>
  credentials.map((c) => `io.systemd.credential.binary:${c.name}=${btoa(String.fromCharCode(...new TextEncoder().encode(c.data)))}`);
