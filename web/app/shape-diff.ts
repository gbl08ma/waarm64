// What differs between two shapes (web/app/shape.ts; docs/machines.md §5.1), in words: an orphaned snapshot's reason
// in the snapshots view, a refused restore's. One comparer per part of the shape, in the order the words are said.
import { msg, type Msg } from '../msg.ts';
import {
  canonical,
  hashed,
  hashedCpu,
  macsOf,
  type CpuFeature,
  type DiskIdentity,
  type Shape,
  type ShapeDisk,
} from './shape.ts';

/** What differs between two shapes, as messages for the snapshots view (an orphaned snapshot's reason): empty when they're the same. */
export function shapeDiff(was: Shape, now: Shape): Msg[] {
  if (was.version !== now.version) return [msg('machines:shape-diff.version')];
  const out = COMPARERS.flatMap((c) => c(was, now));
  if (!out.length && canonical(hashed(was)) !== canonical(hashed(now))) out.push(msg('machines:shape-diff.order'));
  return out;
}

type Comparer = (was: Shape, now: Shape) => Msg[];

const cpus: Comparer = (was, now) =>
  was.ncpus !== now.ncpus ? [msg('machines:shape-diff.ncpus', { was: was.ncpus, now: now.ncpus })] : [];

/** The RAM, or with the same RAM, its split. */
const ram: Comparer = (was, now) => {
  if (was.ramMiB !== now.ramMiB) return [msg('machines:shape-diff.ram', { was: was.ramMiB, now: now.ramMiB })];
  if (canonical(was.split ?? []) === canonical(now.split ?? [])) return [];
  const split = (s?: number[]) =>
    s ? msg('machines:shape-diff.split.sizes', { sizes: s.join(' + ') }) : msg('machines:shape-diff.split.automatic');
  return [msg('machines:shape-diff.split', { was: split(was.split), now: split(now.split) })];
};

const display: Comparer = (was, now) =>
  was.display !== now.display ? [msg('machines:shape-diff.display', { was: was.display, now: now.display })] : [];

const vulkan: Comparer = (was, now) => {
  if (!!was.vulkan === !!now.vulkan) return [];
  return [was.vulkan ? msg('machines:shape-diff.vulkan.had') : msg('machines:shape-diff.vulkan.hadNo')];
};

/** The hashed features only: the others don't orphan a snapshot. */
const cpu: Comparer = (was, now) => {
  if (canonical(hashedCpu(was.cpu)) === canonical(hashedCpu(now.cpu))) return [];
  const features = (cpu: CpuFeature[]) => (cpu.length ? cpu.join(', ') : msg('machines:shape-diff.cpu.none'));
  return [msg('machines:shape-diff.cpu', { was: features(was.cpu), now: features(now.cpu) })];
};

/** How many adapters, or with as many, each one's MAC. */
const adapters: Comparer = (was, now) => {
  const [macsWas, macsNow] = [macsOf(was), macsOf(now)];
  if (macsWas.length !== macsNow.length)
    return [msg('machines:shape-diff.adapters', { was: macsWas.length, now: macsNow.length })];
  return macsWas.flatMap((mac, i) =>
    mac !== macsNow[i] ? [msg('machines:shape-diff.mac', { n: i + 1, was: mac, now: macsNow[i] })] : [],
  );
};

const usb: Comparer = (was, now) => {
  if (!!was.usb === !!now.usb) return [];
  return [was.usb ? msg('machines:shape-diff.usb.had') : msg('machines:shape-diff.usb.hadNo')];
};

/** The devices a shape has or not, as `shapeDiff` says it (its words for each way round). */
const HAD = {
  mouse: [msg('machines:shape-diff.mouse.had'), msg('machines:shape-diff.mouse.hadNo')],
  touch: [msg('machines:shape-diff.touch.had'), msg('machines:shape-diff.touch.hadNo')],
  clock: [msg('machines:shape-diff.clock.had'), msg('machines:shape-diff.clock.hadNo')],
  '9p': [msg('machines:shape-diff.shares.had'), msg('machines:shape-diff.shares.hadNo')],
  // The agent's virtio-console, in snapshots from before the agent went over vsock (2026-11-13): no machine has it now.
  agent: [msg('machines:shape-diff.clipboard.had'), msg('machines:shape-diff.clipboard.hadNo')],
} as const;

const devices: Comparer = (was, now) =>
  (['mouse', 'touch', 'clock', '9p', 'agent'] as const).flatMap((k) =>
    (was.devices as string[]).includes(k) !== (now.devices as string[]).includes(k)
      ? [HAD[k][(was.devices as string[]).includes(k) ? 0 : 1]]
      : [],
  );

/** How many disks, then each one both have. */
const disks: Comparer = (was, now) => [
  ...(was.disks.length !== now.disks.length
    ? [msg('machines:shape-diff.disks', { was: was.disks.length, now: now.disks.length })]
    : []),
  ...was.disks.slice(0, now.disks.length).flatMap((a, i) => diskDiff(a, now.disks[i], i + 1)),
];

/** Disk `n`: another disk (or, the same, another size), its access, its serial, swap. */
function diskDiff(a: ShapeDisk, b: ShapeDisk, n: number): Msg[] {
  const out: Msg[] = [];
  if (canonical(a.identity) !== canonical(b.identity))
    out.push(
      msg('machines:shape-diff.disk.other', {
        n,
        was: describeIdentity(a.identity),
        now: describeIdentity(b.identity),
      }),
    );
  else if (a.size !== b.size) out.push(msg('machines:shape-diff.disk.size', { n, was: a.size, now: b.size }));
  if (a.readOnly !== b.readOnly)
    out.push(
      a.readOnly
        ? msg('machines:shape-diff.disk.readOnlyThen', { n })
        : msg('machines:shape-diff.disk.writableThen', { n }),
    );
  if (a.serial !== b.serial) out.push(msg('machines:shape-diff.disk.serial', { n }));
  if (!!a.swap !== !!b.swap)
    out.push(
      a.swap ? msg('machines:shape-diff.disk.swapThen', { n }) : msg('machines:shape-diff.disk.notSwapThen', { n }),
    );
  return out;
}

const COMPARERS: Comparer[] = [cpus, ram, display, vulkan, cpu, adapters, usb, devices, disks];

/** A disk identity in words: a URL's file name as it is, else a message. */
export function describeIdentity(d: DiskIdentity): string | Msg {
  switch (d.kind) {
    case 'url':
      if ('chunked' in d) return msg('machines:shape-diff.identity.chunked', { id: d.chunked.slice(0, 12) });
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a path ending in '/' names no file
      return d.path.split('/').pop() || d.path;
    case 'file':
      return msg('machines:shape-diff.identity.file', { name: d.name });
    case 'stored':
      return msg('machines:shape-diff.identity.stored');
    case 'blank':
      return msg('machines:shape-diff.identity.blank');
    case 'ramdisk':
      return msg('machines:shape-diff.identity.ramdisk');
  }
}
