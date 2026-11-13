// The page's machines (docs/frontend.md), in one place: image URLs, the
// command line, RAM, the screen and the devices. `uefi` is the page's machine:
// the user brings the disk (PLAN.md, M8 decision 1); `debian` is the tests' and
// benchmarks' guest on it; `buildroot` is the small test guest, for the page's
// smoke test (tests/browser.test.ts) and quick looks. URLs are relative to this module, so
// nothing here depends on the dev server's layout beyond where target/ is.
import { msg, type Msg } from '../msg.ts';
import { MAX_MEMORY0_RAM, splitError, splitRam, VENUS_RESERVE, type SplitProblem } from '../ram.ts';

export type Machine = {
  /** Its name as the snapshots it makes record it (their header's `label`), and in developers' messages. */
  label: string;
  /** Its name on the page, in words. */
  title: Msg;
  /** What makes its images, for the page's message when one is missing. */
  prepare: string;
  /**
   * The kernel to boot directly, or (with `firmware`) the firmware image: EDK2's QEMU_EFI.fd, loaded
   * as a kernel is, which boots the disk's own loader (docs/firmware.md).
   */
  kernel: string;
  initrd?: string;
  /** Boot through UEFI: `kernel` is the firmware, there's no initrd and no command line (the disk's loader has its own). */
  firmware?: boolean;
  /** The root disk (virtio-blk over HTTP ranges); none for a guest that lives in its initrd. */
  disk?: string;
  /** The OPFS overlay that makes `disk` writable (web/overlay.ts); read-only without one. */
  overlay?: string;
  cmdline: string;
  /**
   * What the machine changes when it has a network card (a tailnet, docs/frontend.md "Network"):
   * systemd credentials, which have the guest configure the card itself (`firmware` machines get
   * them over fw_cfg, see {@link credentialFiles}). Absent: the machine can't have one.
   */
  network?: { credentials: Credential[] };
  ramMiB: number;
  /** The screen's size at the start (a `simple-framebuffer` of it, or the display's first size). */
  framebuffer: { width: number; height: number };
  /**
   * `gpu`: a virtio-gpu draws the screen (web/gpu.ts: the guest sets its own mode, the firmware has a
   * graphics output); absent: the `simple-framebuffer` (guests without the driver). The page's
   * `?display=simple` makes a `gpu` machine use the framebuffer (the firmware's menus then stay on the serial console).
   */
  display?: 'gpu';
  /**
   * Serial output that means the machine is up (a login prompt, a shell's prompt), matched by
   * `readyWatcher` against the output so far: not only at its end, since the kernel may print a
   * line right after the prompt. With clipboard sharing, the guest's agent saying HELLO is a sign too, whichever
   * comes first (docs/clipboard.md "The machine's state"); absent, it's the only one.
   */
  ready?: RegExp;
};

/** A systemd credential (`systemd.import-credentials`): its name and contents. */
export type Credential = { name: string; data: string };

/** A machine's credentials as fw_cfg files, where systemd reads them (docs/platform.md "The firmware configuration's devices"). */
export const credentialFiles = (credentials: Credential[]) =>
  credentials.map((c) => ({ name: `opt/io.systemd.credentials/${c.name}`, data: c.data }));

/** A disk other than the machine's own, chosen on the page: a URL or a local file, with the OPFS overlay (and variable store) that belongs to it. */
/** A disk chosen for a transient machine; `name`, a chunked image's manifest's, names the machine. */
export type DiskChoice = { url?: string; file?: File; overlay: string; name?: string };

/**
 * The overlay a chosen disk gets: `waarm64-disk-` and a hash of the disk's identity (a file's name,
 * size and modification time; a URL), so the same disk, chosen again, finds its changes, and a
 * different one never shares them. The device worker checks the identity again when it opens the
 * overlay (web/overlay.ts `openOverlay`).
 */
export async function diskOverlay(d: { url: string } | { file: File }) {
  const id =
    'file' in d
      ? `file:${d.file.name}:${d.file.size}:${d.file.lastModified}`
      : `url:${new URL(d.url, 'http://x').pathname}`;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  return `waarm64-disk-${[...hash.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// The tests' guest images, served by the dev server (a concatenation: a template would have the bundler take in every
// file under target/images/). The firmware is the static copy's (written out, so the build carries it).
const images = (path: string) => new URL('../../target/images/' + path, import.meta.url).href;
const FIRMWARE = new URL('../../target/images/edk2/QEMU_EFI.fd', import.meta.url).href;

/**
 * What a firmware machine with a card gives the guest: a systemd credential with a .network file for networkd (DHCP from
 * the gateway, v4 and v6: its lease is the tailnet addresses; resolved does MagicDNS). Not `ip=dhcp`: an initramfs that
 * reads it waits for a lease before it boots, and a machine that isn't connected yet has none. UseDomains: the lease's
 * search domain (MagicDNS's) for resolved; UseMTU: its MTU (the tunnel's 1280) on the link, for UDP too (the gateway
 * clamps TCP's MSS anyway). networkd's defaults leave both out (Arch's does).
 */
const NETWORKD = {
  credentials: [
    {
      name: 'network.network.card',
      data: '[Match]\nName=e*\n[Network]\nDHCP=yes\n[DHCPv4]\nUseDomains=yes\nUseMTU=yes\n[DHCPv6]\nUseDomains=yes\n',
    },
  ],
};

export const MACHINES = {
  // The page's machine (docs/frontend.md): EDK2 and no disk of its own. It waits for the user's disk (Open disk, a drop,
  // `?disk=<url>`), whose loader it boots; a guest without systemd-networkd configures its card itself.
  uefi: {
    label: 'AArch64 machine', // i18n-ignore: the snapshots' record of it (`title` is its words)
    title: msg('machines:machine.uefi'),
    prepare: '`npm start` (it builds the firmware)',
    kernel: FIRMWARE,
    firmware: true,
    cmdline: '',
    network: NETWORKD,
    ramMiB: 2048,
    framebuffer: { width: 1024, height: 768 },
    display: 'gpu',
    ready: /(?:^|\n)\r*\S+ login: /, // agetty's prompt; busybox's getty (Alpine) puts a \r before it
  },
  // The tests' and benchmarks' guest (`?machine=debian`, tests/debian-unattended.ts): Debian's published image, unmodified: EDK2 boots its shim and GRUB (docs/firmware.md, docs/images.md "Debian for interaction").
  // No first-boot answers are passed: its first boot asks on the serial console, as on a regular machine.
  debian: {
    label: 'Debian 13', // i18n-ignore: the snapshots' record of it (`title` is its words)
    title: msg('machines:machine.debian'),
    prepare: '`images/build.sh debian edk2`',
    kernel: FIRMWARE,
    firmware: true,
    disk: images('debian/disk.qcow2'),
    overlay: 'waarm64-debian',
    cmdline: '',
    network: NETWORKD,
    ramMiB: 1024,
    framebuffer: { width: 1024, height: 768 },
    display: 'gpu',
    ready: /(?:^|\n)\S+ login: /, // agetty's prompt ("localhost login: ")
  },
  // A shell on the serial console. No fbcon in its kernel: the screen stays black. The root is
  // mounted read-only; the overlay is there so a restart exercises its hand-over (the OPFS locks).
  buildroot: {
    label: 'Buildroot (test guest)', // i18n-ignore: the snapshots' record of it (`title` is its words)
    title: msg('machines:machine.buildroot'),
    prepare: '`images/build.sh` (docs/images.md)',
    kernel: images('linux/Image'),
    disk: images('buildroot/rootfs.ext4'),
    overlay: 'waarm64-buildroot',
    cmdline: 'console=ttyAMA0 panic=-1 root=/dev/vda ro init=/init -- /bin/sh',
    ramMiB: 256,
    framebuffer: { width: 640, height: 480 },
    ready: /# $/,
  },
  // The sound test guest (images/snd/init.c, audio S2): plays a 440/660 Hz tone through virtio-snd for
  // `snd_seconds` (?params=snd_seconds=60; 1.024 s without), then powers off. No disk, no screen.
  snd: {
    label: 'Sound test guest', // i18n-ignore: the snapshots' record of it (`title` is its words)
    title: msg('machines:machine.snd'),
    prepare: '`images/build.sh linux-snd` (docs/images.md)',
    kernel: images('linux-snd/Image'),
    initrd: images('linux-snd/initramfs.cpio'),
    cmdline: 'console=ttyAMA0 panic=-1',
    ramMiB: 256,
    framebuffer: { width: 640, height: 480 },
    ready: /snd: hw params/,
  },
} satisfies Record<string, Machine>;

export type MachineName = keyof typeof MACHINES;

/** The default vCPU count: the host's cores minus two (the page and the device worker), at most 4. */
export const defaultCpus = (cores: number) => Math.max(1, Math.min(4, cores - 2));

/**
 * The RAM the page offers, MiB (a transient machine's Machine menu, a stored one's Settings). Up to
 * `MEMORY0_MIB` it all lives in memory 0, beside the core; past it the rest goes to spill memories, which the guest
 * sees as NUMA nodes (docs/spill-memories.md). 3 GiB isn't offered: it would spill 1 MiB.
 */
export const RAM_CHOICES = [512, 1024, 1536, 2048, 2560, 4096, 6144, 8192, 12288, 16384];
/** The most RAM memory 0 holds, MiB (web/ram.ts `MAX_MEMORY0_RAM`). */
export const MEMORY0_MIB = MAX_MEMORY0_RAM / 2 ** 20;
/**
 * A machine's split, MiB: memory 0 first, then each spill memory. `split` is the user's own (a stored machine's
 * `ramSplit`, `?split=`); without it, memory 0 as large as it goes and spill memories of up to 4 GiB, the first less
 * Venus's arena and window on a machine with Vulkan (memory 1 holds them before node 1, as web/app/worker.ts splits it).
 */
export function ramSplitMiB(ramMiB: number, split?: number[], vulkan = false): number[] {
  if (split) return split;
  const s = splitRam(ramMiB * 2 ** 20, vulkan ? VENUS_RESERVE : 0);
  return [s.ramSize, ...s.spill].map((n) => n / 2 ** 20);
}
/**
 * Why `split` (MiB, memory 0 first) isn't one a machine (with Vulkan or not) can have, for the user; undefined when it is.
 * Past whole MiB, web/ram.ts `splitError` decides, and `splitMsg` says its code.
 */
export function ramSplitError(split: number[], vulkan = false): Msg | undefined {
  if (!split.length || split.some((n) => !Number.isInteger(n))) return msg('machines:machine.split.whole');
  const [ram, ...spill] = split.map((n) => n * 2 ** 20);
  const p = splitError(ram, spill, vulkan ? VENUS_RESERVE : 0);
  return p && splitMsg(p);
}
/** What web/ram.ts `splitError`'s code says (the Machines page's Memory split, a machine that can't start with its split). */
export function splitMsg(p: SplitProblem): Msg {
  switch (p.code) {
    case 'memory0-min':
      return msg('machines:machine.split.memory0Min');
    case 'memory0-max':
      return msg('machines:machine.split.memory0Max', { max: p.max });
    case 'nodes':
      return msg('machines:machine.split.nodes', { max: p.max });
    case 'node':
      return msg('machines:machine.split.node', { max: p.max, mib: p.mib });
    case 'vulkan':
      return msg('machines:machine.split.vulkan', { max: p.max });
  }
}
/** The note for a machine whose RAM goes past memory 0: undefined when it all fits there. */
export function numaNote(ramMiB: number, split?: number[], vulkan = false): Msg | undefined {
  const [m0, ...spill] = ramSplitMiB(ramMiB, split, vulkan);
  if (!spill.length) return undefined;
  return msg('machines:machine.numa', { count: spill.length, fast: m0, rest: ramMiB - m0 });
}
/**
 * The host memory a machine needs, GiB: its RAM, ~1 GiB for the browser and the first vCPU's
 * worker, ~0.3 GiB per vCPU (bench/boot/REPORT.md "M8 loop 0": 2.3 GiB of RSS on 1 vCPU, 3.1 on
 * 4, with 1 GiB of guest RAM). Chromium has no catchable out-of-memory error (its renderer is
 * killed: PLAN.md §4 "Guest RAM ceiling"), so the page compares this with
 * `navigator.deviceMemory` before it starts a machine.
 */
export const hostMemoryGiB = (ramMiB: number, ncpus: number, jitMiB = JIT_DEFAULT_MIB) =>
  ramMiB / 1024 + 1 + 0.3 * ncpus + jitHostGiB(jitMiB);

/** The JIT's code cache budget when a machine sets none, MiB (the core's `jit::MAX_BYTES`, docs/jit.md "Memory"). */
export const JIT_DEFAULT_MIB = 320;
/** The budgets a stored machine's Settings offer, MiB (past ~320 MiB a browser's code fills the cache's 262,144 slots first). */
export const JIT_CHOICES = [64, 128, 160, 256, 320, 512];
/**
 * What a JIT budget adds to `hostMemoryGiB`'s rule, GiB. The rule was measured with up to 160 MiB of budget (a
 * mixed load, and Firefox's pages session at 160: renderer 4.6-4.7 GiB median with 2.5 GiB of RAM on 4 vCPUs, the
 * rule's 4.7); at 320 the same session's renderer was 5.1-5.4 (`bench/boot/REPORT.md` "M8: the carry timed, and a
 * larger code cache"): ~4 bytes of the renderer's for each byte of budget past 160 MiB. A smaller budget saves less
 * than that (the measured loads didn't fill 160 MiB), so the saving stops at a quarter of a GiB.
 */
export const jitHostGiB = (jitMiB: number) => Math.max(-0.25, (4 * (jitMiB - 160)) / 1024);

/**
 * Watches a machine's serial output, given in chunks as it comes, for its `ready` marker: true
 * once the marker has shown (also when split across chunks, or followed by more output in the
 * same chunk).
 */
export function readyWatcher(ready: RegExp) {
  let tail = '';
  let seen = false;
  return (text: string) => {
    if (seen) return true;
    const s = tail + text;
    tail = s.slice(-256);
    return (seen = ready.test(s));
  };
}

/**
 * Whether the machine is up (`running`, at the start: a restored machine): its `ready` marker in the serial output
 * (`serial`, none without a marker) or another sign (`up`: the guest's agent's HELLO, docs/clipboard.md "The machine's
 * state"), whichever comes first; `onUp` once.
 */
export function readiness(ready: RegExp | undefined, running: boolean, onUp: () => void) {
  const marker = ready && readyWatcher(ready);
  const up = () => {
    if (running) return;
    running = true;
    onUp();
  };
  return {
    up,
    serial: (text: string) => {
      if (!running && marker?.(text)) up();
    },
  };
}

/** `cmdline` with `extra` kernel parameters, before a `--` (whatever follows it goes to init). */
export function withParams(cmdline: string, extra: string) {
  if (!extra.trim()) return cmdline;
  const at = cmdline.indexOf(' -- ');
  return at < 0 ? `${cmdline} ${extra.trim()}` : `${cmdline.slice(0, at)} ${extra.trim()}${cmdline.slice(at)}`;
}
