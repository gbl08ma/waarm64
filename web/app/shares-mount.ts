// The shared folders' mount in the guest (docs/shares.md "The guest"): a systemd automount at the machine's mount point,
// given as SMBIOS credentials (web/app/guest-unit.ts: systemd 256+, read at boot), so the first access mounts the
// device and a guest without the module or the device boots on. Nothing is installed in the guest's disk.
import type { Credential } from './machine.ts';

export const DEFAULT_SHARES_PATH = '/mnt/shared';
/** The device's tag. */
export const SHARES_TAG = 'webpc';
/** The options: `cache=none`, so that a folder attached while the guest runs is in its next `ls`. */
export const SHARES_OPTIONS = 'trans=virtio,version=9p2000.L,cache=none,msize=1048576,access=user,nofail';

/** A guest's own trees: not a mount point, nor is anything under the last three. */
const OWN = ['/bin', '/boot', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/run', '/sbin', '/tmp', '/usr', '/var'];
const UNDER = ['/dev', '/proc', '/sys'];

/** Why `path` can't be a mount point, in words; undefined if it can. */
export function sharesPathError(path: string): string | undefined {
  if (!path.startsWith('/')) return 'The mount point is an absolute path.';
  if (path === '/') return "The mount point can't be the guest's root.";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return "The mount point can't have control characters.";
  if (new TextEncoder().encode(path).length > 255) return 'The mount point is too long (255 bytes at most).';
  if (path.endsWith('/') || path.includes('//') || path.split('/').some((p) => p === '.' || p === '..')) return 'Write the mount point plainly: no "." or "..", no "//", no "/" at the end.';
  if (OWN.includes(path) || UNDER.some((d) => path === d || path.startsWith(`${d}/`))) return `${path} is the guest's own: mounting there would hide it.`;
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

/** The hand-made equivalent, for a guest without systemd 256. */
export const SHARES_BY_HAND = `mount -t 9p -o trans=virtio,version=9p2000.L,cache=none ${SHARES_TAG} /mnt`;

/** The credentials that have the guest automount the device at `path`. */
export function sharesCredentials(path: string): Credential[] {
  const unit = mountUnit(path);
  return [
    { name: `systemd.extra-unit.${unit}.mount`, data: `[Unit]\nDescription=Shared folders from webpc\n\n[Mount]\nWhat=${SHARES_TAG}\nWhere=${path}\nType=9p\nOptions=${SHARES_OPTIONS}\n` },
    { name: `systemd.extra-unit.${unit}.automount`, data: `[Unit]\nDescription=Shared folders from webpc\n\n[Automount]\nWhere=${path}\n` },
    { name: 'systemd.unit-dropin.remote-fs.target~webpc-shares', data: `[Unit]\nWants=${unit}.automount\n` },
  ];
}
