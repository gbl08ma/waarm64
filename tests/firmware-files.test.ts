// What a firmware machine's fw_cfg holds (web/app/firmware-files.ts `firmwareFiles`): byte for byte what the machine
// worker's start built before it was a function of its own (pinned here as it was), for the settings that change it.
// The guest reads these: a byte that moved is a guest-visible change (the notify socket's credential was one, added here).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firmwareFiles } from '../web/app/firmware-files.ts';
import { AGENT_FILE, agentCredentials } from '../web/app/guest-agent.ts';
import { netCredentials } from '../web/app/guest-net.ts';
import { swapCredentials } from '../web/app/guest-swap.ts';
import { OEM_STRINGS_FILE, oemStrings } from '../web/app/guest-unit.ts';
import { guestWords } from '../web/app/guest-words.ts';
import { keyboardCredentials, keyboardLayout } from '../web/app/keyboard.ts';
import { credentialFiles, MACHINES, type Machine, type MachineName } from '../web/app/machine.ts';
import { parseDevKnobs } from '../web/app/run/dev-knobs.ts';
import type { MachineConfig, StartDisk } from '../web/app/protocol.ts';
import { sharesCredentials } from '../web/app/shares-mount.ts';

type Case = { machine: MachineName; nets: number; netConfig: boolean; keyLayout?: string; sharesPath?: string; credentials: { name: string; data: string }[]; swaps: string[]; agent?: Uint8Array };

/** web/app/worker.ts's start before `firmwareFiles` (with the start message's fields as they were). */
function before(c: Case) {
  const machine: Machine = MACHINES[c.machine];
  const m = { nets: Array.from({ length: c.nets }), netConfig: c.netConfig, credentials: c.credentials, keyLayout: c.keyLayout, sharesPath: c.sharesPath, guest: guestWords(keyboardLayout(c.keyLayout)), disks: disks(c) };
  const net = !!m.nets.length && !!machine.network && m.netConfig;
  // Since: systemd's notify socket first, unless a `?credential=` names it (docs/devices.md "vsock").
  const notify = m.credentials.some((x) => x.name === 'vmm.notify_socket') ? [] : [{ name: 'vmm.notify_socket', data: 'vsock-stream:2:8573' }];
  const credentials = [...notify, ...(net ? machine.network!.credentials : []), ...m.credentials];
  const keys = keyboardLayout(m.keyLayout);
  const agentBytes = c.agent;
  const units = [
    ...(keys ? keyboardCredentials(keys, m.guest.keyboard, m.guest.layout) : []),
    ...(net ? netCredentials(m.guest.network) : []),
    ...(m.sharesPath ? sharesCredentials(m.sharesPath, m.guest.shares) : []),
    ...swapCredentials(m.disks.flatMap((d) => ('swap' in d.source && d.source.swap ? [d.source.swap] : []))),
    ...(agentBytes ? agentCredentials(m.guest.agent) : []),
  ];
  const oem = units.length ? [{ name: OEM_STRINGS_FILE, data: oemStrings(units).join('\0') }] : [];
  return machine.firmware ? [...credentialFiles(credentials), ...oem, ...(agentBytes ? [{ name: AGENT_FILE, data: agentBytes }] : [])] : undefined;
}

const disks = (c: Case): StartDisk[] => [
  { name: 'root', source: { url: '/disk.qcow2' }, overlay: 'overlays/x' },
  ...c.swaps.map((swap, i): StartDisk => ({ name: `swap${i}`, source: { ramdisk: 64 << 20, swap } })),
  { name: 'scratch', source: { ramdisk: 32 << 20 } },
];
function start(c: Case) {
  const config: MachineConfig = {
    machine: c.machine, ncpus: 2, ram: { mib: 1024 }, cpu: [], display: '2d', vulkan: false,
    devices: { nets: c.nets, mouse: false, touch: false, clock: true, shares: !!c.sharesPath, clipboard: !!c.agent, usb: false },
    guest: { keyLayout: c.keyLayout, netConfig: c.netConfig, sharesPath: c.sharesPath, credentials: c.credentials },
    dev: parseDevKnobs(new URLSearchParams()),
  };
  return { config, words: guestWords(keyboardLayout(c.keyLayout)), disks: disks(c) };
}
/** The files as bytes: a string as UTF-8, so the comparison is of what the guest reads. */
const bytes = (files: { name: string; data: string | Uint8Array }[] | undefined) =>
  files?.map((f) => [f.name, Buffer.from(typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data).toString('hex')]);

test('firmwareFiles: the fw_cfg files as the worker made them, byte for byte', () => {
  const agent = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
  const cred = [{ name: 'login.noauth', data: 'yes' }, { name: 'firstboot.locale', data: 'C.UTF-8' }];
  const cases: Case[] = [
    { machine: 'uefi', nets: 0, netConfig: true, credentials: [], swaps: [] },
    { machine: 'uefi', nets: 1, netConfig: true, credentials: [], swaps: [] },
    { machine: 'uefi', nets: 2, netConfig: false, credentials: cred, swaps: [] },
    { machine: 'uefi', nets: 1, netConfig: true, keyLayout: 'gb', sharesPath: '/mnt/shared', credentials: cred, swaps: ['webpc-swap0', 'webpc-swap1'], agent },
    { machine: 'uefi', nets: 0, netConfig: true, keyLayout: 'de', credentials: [], swaps: [], agent },
    { machine: 'uefi', nets: 1, netConfig: true, keyLayout: 'none', sharesPath: '/home/user/shared folders', credentials: [], swaps: ['webpc-swap0'] },
    { machine: 'debian', nets: 1, netConfig: true, keyLayout: 'fr', credentials: cred, swaps: [] },
    { machine: 'buildroot', nets: 1, netConfig: true, credentials: cred, swaps: [] },
    { machine: 'snd', nets: 0, netConfig: true, credentials: [], swaps: [] },
  ];
  for (const c of cases) {
    const old = before(c);
    const now = firmwareFiles(start(c), c.agent);
    assert.deepEqual(bytes(now), bytes(old), JSON.stringify({ ...c, agent: !!c.agent }));
    if ((MACHINES[c.machine] as Machine).firmware) assert.ok(now && now.length > 0 || (!c.nets && !c.credentials.length && !c.keyLayout && !c.agent && !c.swaps.length));
  }
});
