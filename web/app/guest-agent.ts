// The guest agent (docs/devices.md "The guest's agent"; clipboard sharing: docs/plans/clipboard.md §3.1): the page hands
// a `firmware` machine with the agent on the binary (agent/, `images/build.sh agent`) as the fw_cfg file
// `opt/waarm64/agent`, and a unit (web/app/guest-unit.ts: SMBIOS credentials, systemd 256+) that copies it into /run and
// runs it as root; the agent connects to the page over the machine's vsock (web/vsock-device.ts `AGENT_PORT`). Nothing
// is installed: a boot without the agent has no unit and no binary, and /run is gone at the next boot.

import { guestUnit } from './guest-unit.ts';
import type { Credential } from './machine.ts';

/**
 * The binary's fw_cfg file (Linux's qemu_fw_cfg shows it under /sys/firmware/qemu_fw_cfg/by_name/), gzipped: Linux reads
 * fw_cfg a byte at a time, an MMIO exit each (3–12 µs a byte under the JIT: ~0.3 s for the ~83 KB gzipped binary of
 * 133 KB; docs/clipboard.md "What it costs").
 */
export const AGENT_FILE = 'opt/waarm64/agent';

/** Where the page fetches the binary from: the build's output (Vite copies it into the static copy, hashed). */
export const AGENT_BINARY = new URL('../../target/images/agent/waarm64-agent', import.meta.url).href;

/** An ELF file's first bytes: what a fetch of the binary must give (a server's page for a missing file isn't one). */
const ELF = [0x7f, 0x45, 0x4c, 0x46];

/**
 * The binary, gzipped (`AGENT_FILE`), or undefined (and why, on the console) if it can't be had: not built
 * (`images/build.sh agent`), or the server doesn't have it. The machine then starts without the agent: no unit, the port
 * never opened.
 */
export async function agentBinary(url = AGENT_BINARY): Promise<Uint8Array | undefined> {
  try {
    const r = await fetch(url);
    const b = r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
    if (b && ELF.every((x, i) => b[i] === x))
      return new Uint8Array(
        await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
      );
    console.warn(
      `clipboard sharing: no agent at ${url} (${r.status}${b ? ', not an ELF file' : ''}): images/build.sh agent builds it`, // i18n-ignore: a developer's (the console)
    );
  } catch (e) {
    console.warn(`clipboard sharing: the agent's fetch failed (${String(e)})`); // i18n-ignore: a developer's (the console)
  }
  return undefined;
}

/** The script the unit runs. POSIX sh: the binary out of fw_cfg (gunzipped) into the unit's own tmpfs, then run. */
export function agentScript(): string {
  return `# From waarm64: the machine's guest agent, run at every boot while it is on (docs/devices.md, "The guest's agent").
# The page gives the agent's binary as an fw_cfg file; it runs from /run/waarm64, a tmpfs of this unit's own.
f=/sys/firmware/qemu_fw_cfg/by_name/${AGENT_FILE}/raw
if [ ! -r "$f" ]; then
  echo "waarm64-agent: no $f (this kernel has no qemu_fw_cfg?)" >&2
  exit 0
fi
gzip -dc "$f" >/run/waarm64/agent && chmod 0500 /run/waarm64/agent || exit 1
# It connects to the page over vsock, and again whenever the connection ends.
exec /run/waarm64/agent
`;
}

/**
 * The [Service] lines (plan §3.1): a long-running root process, low priority, its memory capped (a cap for a bug, not
 * a budget: plan §3.3) and first to go when the guest runs out. Sandboxed as far as what it does allows: setting the
 * clock needs CAP_SYS_TIME (and no `ProtectClock`), TIOCSTI on the foreground console CAP_SYS_ADMIN, the session children
 * change uid (CAP_SETUID, CAP_SETGID; no NoNewPrivileges, which would stop them) and are the user's processes then, which
 * the agent stops (CAP_KILL); they read the session's files in /run/user and the home (read-only). Its sockets are Unix
 * ones (the session's) and vsock (the page): no `PrivateNetwork`, whose namespace a kernel with vsock namespaces would
 * keep from the host's CID. The private /tmp keeps the host's X11 sockets' directory, bound in read-only (an X session's
 * child connects to its display's socket there; `-`: a guest without it starts all the same).
 * `modprobe` runs outside the sandbox (`+`), before it: Debian loads qemu_fw_cfg from the DT already. /run/waarm64 is a
 * tmpfs of the unit's own (gone when it stops), mounted `exec`: Debian 13 mounts /run `noexec`, where a
 * `RuntimeDirectory` can't run the binary (measured 2026-11-06: `exec` gave EACCES).
 */
export const AGENT_SERVICE = `Type=simple
ExecStartPre=-+modprobe -q qemu_fw_cfg
TemporaryFileSystem=/run/waarm64:mode=0700,exec,nosuid
Restart=on-failure
RestartSec=5s
Nice=10
MemoryMax=32M
OOMScoreAdjust=500
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SYS_TIME CAP_SETUID CAP_SETGID CAP_KILL
UMask=0077
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
BindReadOnlyPaths=-/tmp/.X11-unix
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_UNIX AF_VSOCK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
`;

/** The systemd credentials that start the agent (the binary comes separately, as `AGENT_FILE`). */
export const agentCredentials = (description: string): Credential[] =>
  guestUnit({
    name: 'waarm64-agent.service',
    description,
    script: agentScript(),
    // The agent connects (and connects again) by itself; a failure that lasts (the binary unreadable, a crash) ends at
    // the start limit: 5 starts in 10 minutes, which starts RestartSec (5 s)
    // apart can reach (systemd's default, 5 in 10 s, they never do), rather than a restart every 5 s for the boot, each
    // reading the binary out of fw_cfg again (~0.3 s of a vCPU).
    unit: 'After=systemd-udev-trigger.service\nStartLimitIntervalSec=10min\nStartLimitBurst=5\n',
    wantedBy: 'multi-user.target',
    service: AGENT_SERVICE,
  });
