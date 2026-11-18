// The shared folders' mount in the guest (docs/shares.md "The guest"): a systemd automount at the machine's mount point,
// given as SMBIOS credentials (web/app/guest-unit.ts: systemd 256+, read at boot), so the first access mounts the
// device and a guest without the module or the device boots on. Nothing is installed in the guest's disk.
import { msg, type Msg } from '../msg.ts';
import type { Credential } from './machine.ts';
import { oneLine } from './guest-unit.ts';

export const DEFAULT_SHARES_PATH = '/mnt/shared';
/** The device's tag. */
export const SHARES_TAG = 'waarm64';
/** The options: `cache=none`, so that a folder attached while the guest runs is in its next `ls`. */
export const SHARES_OPTIONS = 'trans=virtio,version=9p2000.L,cache=none,msize=1048576,access=user,nofail';

/** A guest's own trees: not a mount point, nor is anything under the last three. */
const OWN = ['/bin', '/boot', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/run', '/sbin', '/tmp', '/usr', '/var'];
const UNDER = ['/dev', '/proc', '/sys'];

/** Why `path` can't be a mount point, as a message (the page renders it: this runs in the machine's worker too); undefined if it can. */
export function sharesPathError(path: string): Msg | undefined {
  if (!path.startsWith('/')) return msg('folders:shares-mount.absolute');
  if (path === '/') return msg('folders:shares-mount.root');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return msg('folders:shares-mount.control');
  if (new TextEncoder().encode(path).length > 255 || mountUnit(path).length + '.automount'.length > 255)
    return msg('folders:shares-mount.tooLong');
  if (/[%]|\s$|\\$/.test(path)) return msg('folders:shares-mount.characters');
  if (path.endsWith('/') || path.includes('//') || path.split('/').some((p) => p === '.' || p === '..'))
    return msg('folders:shares-mount.plainly');
  if (OWN.includes(path) || UNDER.some((d) => path === d || path.startsWith(`${d}/`)))
    return msg('folders:shares-mount.guestOwn', { path });
  return undefined;
}

/** The unit name of `path`, as `systemd-escape --path` makes it. */
export function mountUnit(path: string): string {
  const out: string[] = [];
  const bytes = new TextEncoder().encode(path.replace(/^\/+/, ''));
  bytes.forEach((b, k) => {
    const c = String.fromCharCode(b);
    if (c === '/') out.push('-');
    else if (/[A-Za-z0-9:_]/.test(c) || (c === '.' && k > 0)) out.push(c);
    else out.push(`\\x${b.toString(16).padStart(2, '0')}`);
  });
  return out.join('');
}

/** Where the hand-made mount puts the folders. */
export const SHARES_BY_HAND_AT = '/mnt';
/** The hand-made equivalent, for a guest without systemd 256 (the Folders menu's Details…, FoldersMount.svelte). */
export const SHARES_BY_HAND = `mount -t 9p -o trans=virtio,version=9p2000.L,cache=none ${SHARES_TAG} ${SHARES_BY_HAND_AT}`;

/** The credentials that have the guest automount the device at `path`. */
export function sharesCredentials(path: string, description: string): Credential[] {
  const unit = mountUnit(path);
  return [
    {
      name: `systemd.extra-unit.${unit}.mount`,
      data: `[Unit]\nDescription=${oneLine(description)}\n\n[Mount]\nWhat=${SHARES_TAG}\nWhere=${path}\nType=9p\nOptions=${SHARES_OPTIONS}\n`,
    },
    {
      name: `systemd.extra-unit.${unit}.automount`,
      data: `[Unit]\nDescription=${oneLine(description)}\n\n[Automount]\nWhere=${path}\n`,
    },
    { name: 'systemd.unit-dropin.remote-fs.target~waarm64-shares', data: `[Unit]\nWants=${unit}.automount\n` },
  ];
}
