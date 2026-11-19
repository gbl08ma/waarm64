// The guest agent (docs/devices.md "The guest's agent"; clipboard sharing: docs/plans/clipboard.md §3.1): the page hands
// a `firmware` machine with the agent on the binary (agent/, `images/build.sh agent`) as fw_cfg files
// `opt/waarm64/agent.000`, `.001`, …, and a unit (web/app/guest-unit.ts: SMBIOS credentials, systemd 256+) that copies it into /run and
// runs it as root; the agent connects to the page over the machine's vsock (web/vsock-device.ts `AGENT_PORT`). Nothing
// is installed: a boot without the agent has no unit and no binary, and /run is gone at the next boot. A guest with
// OpenRC (Alpine) has no such path: nothing in it reads fw_cfg, SMBIOS or credentials at boot, so its service
// (`agentOpenrc`) is in the image (ours: images/, docs/images.md) or installed once by the user from fw_cfg
// (`AGENT_OPENRC_FILE`, `agentInstaller`), and reads the binary from fw_cfg at each start as the unit does.

import { guestUnit } from './guest-unit.ts';
import type { Credential } from './machine.ts';

/**
 * The binary's fw_cfg files (Linux's qemu_fw_cfg shows them under /sys/firmware/qemu_fw_cfg/by_name/): its gzip in
 * pieces of `AGENT_PIECE` bytes, `<AGENT_FILE>.000` upwards. Linux reads fw_cfg a byte at a time, an MMIO read each,
 * and sysfs a page (4 KiB) per read call, for which the driver selects the file again and reads past the `pos` bytes
 * before it: one file of n bytes costs ~n²/8 KiB reads (1.44 million for 106 KB: ~0.41 s), pieces of a page n (~0.03 s;
 * docs/clipboard.md "What it costs").
 */
export const AGENT_FILE = 'opt/waarm64/agent';
export const AGENT_PIECE = 4096;

/** The fw_cfg files of the binary's gzip `gz`: its pieces, in order (three digits: up to 4 MB). */
export function agentFiles(gz: Uint8Array): { name: string; data: Uint8Array }[] {
  const n = Math.ceil(gz.length / AGENT_PIECE);
  if (n > 1000) throw new RangeError(`the agent's gzip is ${gz.length} bytes: past ${1000 * AGENT_PIECE}`);
  return Array.from({ length: n }, (_, i) => ({
    name: `${AGENT_FILE}.${String(i).padStart(3, '0')}`,
    data: gz.subarray(i * AGENT_PIECE, (i + 1) * AGENT_PIECE),
  }));
}

/**
 * Where the page fetches the binary from: the build's gzip of it (zopfli's, `images/build.sh agent`; Vite copies it into
 * the static copy, hashed), handed to fw_cfg as it is.
 */
export const AGENT_BINARY = new URL('../../target/images/agent/waarm64-agent.gz', import.meta.url).href;

/** An ELF file's first bytes, and a gzip stream's. */
const ELF = [0x7f, 0x45, 0x4c, 0x46];
const GZIP = [0x1f, 0x8b];

const starts = (b: Uint8Array, magic: number[]) => magic.every((x, i) => b[i] === x);

/**
 * The binary, gzipped (`AGENT_FILE`), or undefined (and why, on the console) if it can't be had: not built
 * (`images/build.sh agent`), or the server doesn't have it. The machine then starts without the agent: no unit, the port
 * never opened. A server that sends the gzip with `Content-Encoding: gzip` gives the page the ELF file itself: the page
 * gzips that (`CompressionStream`'s, ~7% larger than the build's).
 */
export async function agentBinary(url = AGENT_BINARY): Promise<Uint8Array | undefined> {
  try {
    const r = await fetch(url);
    const b = r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
    if (b && starts(b, GZIP)) return b;
    if (b && starts(b, ELF))
      return new Uint8Array(
        await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
      );
    console.warn(
      `clipboard sharing: no agent at ${url} (${r.status}${b ? ', not a gzip or an ELF file' : ''}): images/build.sh agent builds it`, // i18n-ignore: a developer's (the console)
    );
  } catch (e) {
    console.warn(`clipboard sharing: the agent's fetch failed (${String(e)})`); // i18n-ignore: a developer's (the console)
  }
  return undefined;
}

/**
 * The script the unit runs. POSIX sh: the binary out of fw_cfg (its pieces in order, which the glob sorts; gunzipped)
 * into the unit's own tmpfs, then run.
 */
export function agentScript(): string {
  return `# From waarm64: the machine's guest agent, run at every boot while it is on (docs/devices.md, "The guest's agent").
# The page gives the agent's binary as fw_cfg files, its gzip in pieces of a page (fw_cfg reads a file again up to
# where each read starts); it runs from /run/waarm64, a tmpfs of this unit's own.
f=/sys/firmware/qemu_fw_cfg/by_name/${AGENT_FILE}
if [ ! -r "$f.000/raw" ]; then
  echo "waarm64-agent: no $f.000 (this kernel has no qemu_fw_cfg?)" >&2
  exit 0
fi
cat "$f".[0-9][0-9][0-9]/raw | gzip -dc >/run/waarm64/agent && chmod 0500 /run/waarm64/agent || exit 1
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
 * child connects to its display's socket there; `-`: a guest without it starts all the same). What RENEW renews after a
template's restore (agent/src/renew.rs) is writable through `ProtectSystem=strict`: the machine id, the SSH host keys'
directory (ssh-keygen's new keys are renamed in), systemd's random seed (`-`: each may be missing); `/dev/random`'s
RNDADDENTROPY and RNDRESEEDCRNG take CAP_SYS_ADMIN, which it has. KEYMAP's `loadkeys` (the consoles' keymap,
agent/src/keymap.rs) takes CAP_SYS_TTY_CONFIG (KDSKBENT). POWER's request to logind (agent/src/power.rs) takes
CAP_SYS_BOOT: logind grants a power-off to a caller that has it (else polkit decides, and a guest may have none).
DROP (agent/src/drop.rs) writes `/proc/sys/vm/drop_caches`, the one file of `/proc/sys` writable through
`ProtectKernelTunables` (the deeper path's mount wins). GROW (agent/src/grow.rs) writes a disk's partition table on its
node (`/dev`, which `ProtectSystem=strict` leaves writable, and no DeviceAllow or PrivateDevices closes; the node is
root's, so no DAC override), tells the kernel by BLKPG (CAP_SYS_ADMIN) and grows the filesystem by its ioctl, which
wants a writable mount: the agent makes a detached clone of the read-only bind writable (`open_tree`, `mount_setattr`:
CAP_SYS_ADMIN), as resize2fs under this sandbox shows (EROFS without). ext4's resize takes CAP_SYS_RESOURCE too (EPERM
without; both measured 2026-11-15 on loop devices under these properties).
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
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SYS_TIME CAP_SETUID CAP_SETGID CAP_KILL CAP_SYS_TTY_CONFIG CAP_SYS_BOOT CAP_SYS_RESOURCE
UMask=0077
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
BindReadOnlyPaths=-/tmp/.X11-unix
ReadWritePaths=-/etc/machine-id -/etc/ssh -/var/lib/systemd/random-seed -/proc/sys/vm/drop_caches
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

/**
 * The OpenRC installer's fw_cfg file, given beside the binary: a POSIX sh script that installs the agent's service on a
 * guest with OpenRC (Alpine) once, run as root (`agentInstaller`).
 */
export const AGENT_OPENRC_FILE = 'opt/waarm64/openrc';

/** The service's name on OpenRC (`/etc/init.d/<name>`). */
export const AGENT_OPENRC_NAME = 'waarm64-agent';

/**
 * The agent's OpenRC service (`/etc/init.d/waarm64-agent`): what the systemd unit does (`agentScript`,
 * `AGENT_SERVICE`) as far as OpenRC has it. At each start the binary out of fw_cfg (`qemu_fw_cfg` loaded first: Alpine's
 * linux-virt has it as a module) into a tmpfs of its own at /run/waarm64 (mounted `exec`, gone when it stops), then run
 * under supervise-daemon: respawned 5 s after a crash, at most 5 times in 10 minutes (the unit's start limit), low
 * priority (nice 10) and first to go when the guest runs out (`oom_score_adj` 500), its memory capped at 32 MiB where
 * OpenRC has cgroups v2 (`rc_cgroup_settings`; a cap for a bug, not a budget). Not sandboxed: OpenRC has no namespaces
 * of its own, and the agent is root as under systemd. Without the machine's binary (the agent off, another
 * hypervisor) it says so and runs nothing, so the service may stay in an image that boots elsewhere. Its messages go to
 * /var/log/waarm64-agent.log (the journal's, on systemd).
 */
export function agentOpenrc(): string {
  return `#!/sbin/openrc-run
# From waarm64: the machine's guest agent (docs/devices.md, "The guest's agent"), at every boot while the machine gives
# it. The machine gives the agent's binary as fw_cfg files, its gzip in pieces of a page; it runs from /run/waarm64, a
# tmpfs of the service's own, gone when it stops. A machine without it (the agent off, another hypervisor): nothing runs.
description="waarm64's guest agent: the clock, the clipboard and the screen's size shared with the page"
supervisor=supervise-daemon
command=/run/waarm64/start
respawn_delay=5
respawn_max=5
respawn_period=600
error_log=/var/log/waarm64-agent.log
rc_cgroup_settings="memory.max 33554432"
fw=/sys/firmware/qemu_fw_cfg/by_name/${AGENT_FILE}

depend() {
	need localmount
	after modules hwdrivers
}

start() {
	modprobe -q qemu_fw_cfg 2>/dev/null
	modprobe -q vmw_vsock_virtio_transport 2>/dev/null
	if [ ! -r "$fw.000/raw" ]; then
		einfo "The machine gives no agent: not started"
		return 0
	fi
	mkdir -p /run/waarm64
	mountpoint -q /run/waarm64 || mount -t tmpfs -o mode=0700,size=16m,nosuid,nodev waarm64 /run/waarm64 || return 1
	if ! cat "$fw".[0-9][0-9][0-9]/raw | gzip -dc > /run/waarm64/agent; then
		eerror "Can't read the agent from the machine"
		umount /run/waarm64
		return 1
	fi
	printf '#!/bin/sh\\necho 500 > /proc/self/oom_score_adj\\nexec nice -n 10 /run/waarm64/agent\\n' > /run/waarm64/start
	chmod 0500 /run/waarm64/agent /run/waarm64/start
	default_start
}

stop() {
	mountpoint -q /run/waarm64 || return 0
	default_stop
	umount /run/waarm64
}
`;
}

/**
 * The installer the machine gives as `AGENT_OPENRC_FILE` (docs/devices.md "The guest's agent", "On OpenRC"): run once
 * as root on the guest,
 * `modprobe qemu_fw_cfg; sh /sys/firmware/qemu_fw_cfg/by_name/opt/waarm64/openrc/raw`, it writes the service
 * (`agentOpenrc`), adds it to the default runlevel and starts it (again: an update). What it writes is the service
 * alone: the binary comes from the machine at each start.
 */
export function agentInstaller(): string {
  return `# From waarm64: installs the guest agent's OpenRC service (docs/devices.md, "The guest's agent"). Run it once, as root:
#   modprobe qemu_fw_cfg; sh /sys/firmware/qemu_fw_cfg/by_name/${AGENT_OPENRC_FILE}/raw
# It writes /etc/init.d/${AGENT_OPENRC_NAME}, adds it to the default runlevel and starts it. The agent itself isn't
# installed: the service reads it from the machine at each start (a machine without it: nothing runs). To remove it:
#   rc-update del ${AGENT_OPENRC_NAME}; rm /etc/init.d/${AGENT_OPENRC_NAME}
set -e
if [ "$(id -u)" != 0 ]; then echo "waarm64: run it as root" >&2; exit 1; fi
if ! command -v openrc-run > /dev/null; then echo "waarm64: no OpenRC here (a guest with systemd gets the agent without this)" >&2; exit 1; fi
cat > /etc/init.d/${AGENT_OPENRC_NAME}.new << 'WAARM64_EOF'
${agentOpenrc()}WAARM64_EOF
chmod 0755 /etc/init.d/${AGENT_OPENRC_NAME}.new
mv /etc/init.d/${AGENT_OPENRC_NAME}.new /etc/init.d/${AGENT_OPENRC_NAME}
rc-update add ${AGENT_OPENRC_NAME} default
rc-service ${AGENT_OPENRC_NAME} restart
echo "waarm64: the agent's service is installed and started"
`;
}
