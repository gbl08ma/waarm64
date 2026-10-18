// What the tests give Debian over fw_cfg (`opt/io.systemd.credentials/*`, systemd credentials) to boot
// it unattended through UEFI: no first-boot questions (timezone, locale), and root without a password
// on the serial console and on tty1. The page passes none of them (docs/frontend.md): a user
// answers the first boot's questions, as on a regular machine. A test that relies on them reads
// one back, so a shifted fw_cfg directory can't pass unnoticed (docs/firmware.md).
import type { Credential } from '../web/app/machine.ts';

export const UNATTENDED: Credential[] = [
  { name: 'login.noauth', data: 'yes' },
  { name: 'firstboot.timezone', data: 'Etc/UTC' },
  { name: 'firstboot.locale', data: 'C.UTF-8' },
  { name: 'passwd.hashed-password.root', data: '' },
];

/** The same as the page's `?credential=` parameters. */
export const credentialsQuery = () => UNATTENDED.map((c) => `credential=${encodeURIComponent(`${c.name}:${c.data}`)}`).join('&');

/**
 * The tests' Debian on the page (`?machine=debian`: the page's own machine has no disk and waits for one), unattended. A
 * query that names another machine before it keeps that one (the page reads the first `machine`).
 */
export const unattendedQuery = () => `machine=debian&${credentialsQuery()}`;
