// A snapshot's header and the machine worker (web/app/worker.ts; docs/frontend.md "Snapshots"): the fields it writes
// beside the core's, and the machine a header read back says, made from what the page passed or refused with a
// `snapshot` problem.
import { splitError } from '../vm.ts';
import { msg, MsgError, type Msg } from '../msg.ts';
import type { SnapshotHeader } from '../snapshot-file.ts';
import { isCpuFeature } from '../cpu-features.ts';
import type { Machine, MachineName } from './machine.ts';
import type { CpuFeature, DeviceKind } from './shape.ts';
import { failure } from './worker-errors.ts';
import { device, layout, type Slot, type StartMessage } from './worker-devices.ts';
import type { Plan } from './worker-start.ts';

/** What this machine is, for a snapshot's header. */
export type Session = {
  name: MachineName;
  ncpus: number;
  disk: string | null;
  kinds: DeviceKind[];
  cpu: CpuFeature[];
  about?: StartMessage['about'];
};

/** A snapshot's header fields (beside the core's): what the machine is, its shape for a stored one, the terminal's tail. */
export function header(s: Session, label: string | undefined, serial: string) {
  const about = s.about
    ? { name: s.about.name, shape: s.about.shape, shapeHash: s.about.shapeHash, urls: s.about.urls, format: 2 }
    : {};
  return { machine: s.name, label, ncpus: s.ncpus, disk: s.disk, devices: s.kinds, cpu: s.cpu, serial, ...about };
}

/**
 * A snapshot of another machine is refused. A stored machine's snapshot is checked by its shape (docs/machines.md
 * §5.1): the page checked it first and offers to make a machine like it; here it is refused before anything is touched.
 */
function sameMachine(h: SnapshotHeader, m: StartMessage, machine: Machine, name: string | Msg) {
  if (m.about && typeof h.shapeHash === 'string' && h.shapeHash !== m.about.shapeHash)
    throw failure(
      'snapshot',
      msg('snapshots:worker-header.otherShape', { name }),
      new MsgError('snapshots:worker-header.otherShape.cause', { machine: m.about.name }),
    );
  if (h.machine !== m.config.machine) {
    const other = typeof h.label === 'string' ? h.label : String(h.machine);
    throw failure(
      'snapshot',
      msg('snapshots:worker-header.otherMachine', { name }),
      new MsgError('snapshots:worker-header.otherMachine.cause', {
        other,
        otherId: String(h.machine),
        machine: machine.title,
        id: m.config.machine,
      }),
    );
  }
}

/** The header's transports, as this start makes them; a snapshot whose devices can't be made here is refused. */
function slotsOf(h: SnapshotHeader, m: StartMessage, machine: Machine, name: string | Msg): Slot[] {
  const kinds = h.devices;
  const all = layout(m, machine);
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every((k) => typeof k === 'string'))
    throw failure(
      'snapshot',
      msg('snapshots:worker-header.devicesUnknown', { name }),
      new MsgError('snapshots:worker-header.devicesUnknown.cause', { machine: machine.title }),
    );
  if (kinds.join() !== all.map((s) => s.kind).join())
    throw failure(
      'snapshot',
      msg('snapshots:worker-header.otherDevices', { name }),
      new MsgError('snapshots:worker-header.otherDevices.cause', {
        kinds,
        here: all.map((s) => s.kind),
        machine: machine.title,
      }),
    );
  return all;
}

/** Memory 0's RAM, and the spill memories' (docs/spill-memories.md), as they were. */
function memoryOf(h: SnapshotHeader, machine: Machine, name: string | Msg) {
  const ramSize = Number(h.ramSize);
  const spill: unknown = h.spill ?? [];
  const sizes = Array.isArray(spill) && spill.every((n) => typeof n === 'number') ? spill : undefined;
  if (!Number.isSafeInteger(ramSize) || ramSize < 64 << 20 || !sizes || splitError(ramSize, sizes))
    throw failure(
      'snapshot',
      msg('snapshots:worker-header.memory', { name }),
      new MsgError('snapshots:worker-header.memory.cause', { machine: machine.title }),
    );
  return { ramSize, spill: sizes };
}

/**
 * The devices and vCPU count a snapshot's header says, made from what the page passed. Refuses (a
 * `snapshot` problem, with a message for the user) a snapshot of another machine, and one whose
 * devices can't be made here.
 */
export function fromHeader(h: SnapshotHeader, m: StartMessage, machine: Machine, name: string | Msg) {
  sameMachine(h, m, machine, name);
  const here = slotsOf(h, m, machine, name);
  const ncpus = h.ncpus;
  if (typeof ncpus !== 'number' || !Number.isInteger(ncpus) || ncpus < 1 || ncpus > 64)
    throw failure(
      'snapshot',
      msg('snapshots:worker-header.cpus', { name }),
      new MsgError('snapshots:worker-header.cpus.cause', { machine: machine.title }),
    );
  const specs = here.map((s) => device(s, m, machine));
  const split = memoryOf(h, machine, name);
  const ram = (split.ramSize + split.spill.reduce((a, b) => a + b, 0)) / 2 ** 20;
  const cpu: unknown = h.cpu;
  if (!Array.isArray(cpu) || !cpu.every(isCpuFeature))
    throw failure(
      'snapshot',
      msg('snapshots:worker-header.features', { name }),
      new MsgError('snapshots:worker-header.features.cause', { machine: machine.title }),
    );
  return { slots: here, specs, ncpus, ramMiB: ram, split, cpu };
}

/** What this machine is, for a snapshot's header. */
export function sessionOf(m: StartMessage, plan: Plan): Session {
  const first = m.disks.at(0);
  return {
    name: m.config.machine,
    ncpus: plan.ncpus,
    disk: first && !first.own ? first.name : null,
    kinds: plan.here.map((s) => s.kind),
    cpu: plan.cpu,
    about: m.about,
  };
}
