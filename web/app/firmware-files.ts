// What a `firmware` machine's fw_cfg holds at a start (docs/frontend.md "What the page sets in the guest"): the
// systemd credentials (the machine's network card's, the page's `?credential=`), the units the page has the guest run
// as OEM strings in SMBIOS (the keyboard layout, the network's settings, the shared folders' mount, swap ramdisks, the
// clipboard agent; too long for fw_cfg's names: core/src/smbios.rs), and the agent's binary. Pure: the worker's start
// (web/app/worker.ts) calls it with the agent's bytes once fetched; tests/firmware-files.test.ts pins its bytes.
import { AGENT_FILE, agentCredentials } from './guest-agent.ts';
import { netCredentials } from './guest-net.ts';
import { swapCredentials } from './guest-swap.ts';
import { OEM_STRINGS_FILE, oemStrings } from './guest-unit.ts';
import { keyboardCredentials, keyboardLayout } from './keyboard.ts';
import { credentialFiles, MACHINES, type Machine } from './machine.ts';
import type { ToWorker } from './protocol.ts';
import { sharesCredentials } from './shares-mount.ts';

type Start = Extract<ToWorker, { type: 'start' }>;

/**
 * The fw_cfg files of the machine `start` makes (none for a direct-boot machine): `agentBytes` is clipboard sharing's
 * agent, when the machine has it and it was built (web/app/guest-agent.ts `agentBinary`).
 */
export function firmwareFiles(
  start: Pick<Start, 'config' | 'words' | 'disks'>,
  agentBytes?: Uint8Array,
): { name: string; data: string | Uint8Array }[] | undefined {
  const { config, words, disks } = start;
  const machine: Machine = MACHINES[config.machine];
  if (!machine.firmware) return undefined;
  const guest = config.guest;
  const network = machine.network;
  const net = !!config.devices.nets && !!network && guest.netConfig;
  const credentials = [...(net ? network.credentials : []), ...guest.credentials];
  const keys = keyboardLayout(guest.keyLayout);
  const units = [
    ...(keys ? keyboardCredentials(keys, words.keyboard, words.layout) : []),
    ...(net ? netCredentials(words.network) : []),
    ...(guest.sharesPath ? sharesCredentials(guest.sharesPath, words.shares) : []),
    ...swapCredentials(disks.flatMap((d) => ('swap' in d.source && d.source.swap ? [d.source.swap] : []))),
    ...(agentBytes ? agentCredentials(words.agent) : []),
  ];
  const oem = units.length ? [{ name: OEM_STRINGS_FILE, data: oemStrings(units).join('\0') }] : [];
  return [...credentialFiles(credentials), ...oem, ...(agentBytes ? [{ name: AGENT_FILE, data: agentBytes }] : [])];
}
