// The page's machines (docs/frontend.md), in one place: image URLs, the
// command line, RAM, the screen and the devices. `debian` is the page's VM (M8
// decision 1); `buildroot` is the small test guest, for the page's smoke test
// (tests/browser.test.ts) and quick looks. URLs are relative to this module, so
// nothing here depends on the dev server's layout beyond where target/ is.

export type Machine = {
  /** Its name on the page. */
  label: string;
  /** What makes its images, for the page's message when one is missing. */
  prepare: string;
  /**
   * The kernel to boot directly, or (with `firmware`) the firmware image: EDK2's QEMU_EFI.fd, loaded
   * as a kernel is, which boots the disk's own loader (docs/plans/uefi.md).
   */
  kernel: string;
  initrd?: string;
  /** Boot through UEFI: `kernel` is the firmware, there's no initrd and no command line (the disk's loader has its own). */
  firmware?: boolean;
  /** The root disk (virtio-blk over HTTP ranges). */
  disk: string;
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
   * line right after the prompt.
   */
  ready: RegExp;
};

/** A systemd credential (`systemd.import-credentials`): its name and contents. */
export type Credential = { name: string; data: string };

/** A machine's credentials as fw_cfg files, where systemd reads them (docs/platform.md "The firmware configuration's devices"). */
export const credentialFiles = (credentials: Credential[]) => credentials.map((c) => ({ name: `opt/io.systemd.credentials/${c.name}`, data: c.data }));

/** A disk other than the machine's own, chosen on the page: a URL or a local file, with the OPFS overlay (and variable store) that belongs to it. */
export type DiskChoice = { url?: string; file?: File; overlay: string };

/**
 * The overlay a chosen disk gets: `webpc-disk-` and a hash of the disk's identity (a file's name,
 * size and modification time; a URL), so the same disk, chosen again, finds its changes, and a
 * different one never shares them. The device worker checks the identity again when it opens the
 * overlay (web/overlay.ts `openOverlay`).
 */
export async function diskOverlay(d: { url: string } | { file: File }) {
  const id = 'file' in d ? `file:${d.file.name}:${d.file.size}:${d.file.lastModified}` : `url:${new URL(d.url, 'http://x').pathname}`;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  return `webpc-disk-${[...hash.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const images = (path: string) => new URL(`../../target/images/${path}`, import.meta.url).href;

export const MACHINES = {
  // Debian's published image, unmodified: EDK2 boots its shim and GRUB (docs/plans/uefi.md, docs/images.md "Debian for interaction").
  // No first-boot answers are passed: its first boot asks on the serial console, as on a regular machine.
  debian: {
    label: 'Debian 13',
    prepare: '`npm start` (it downloads Debian and builds the firmware)',
    kernel: images('edk2/QEMU_EFI.fd'),
    firmware: true,
    disk: images('debian/disk.qcow2'),
    overlay: 'webpc-debian',
    cmdline: '',
    // A systemd credential gives networkd a .network file for the card (DHCP from the gateway, v4 and v6: its
    // lease is the tailnet addresses; resolved does MagicDNS). Not `ip=dhcp`: Debian's initramfs reads
    // that too and waits for a lease before it boots, and a machine that isn't connected yet has none.
    network: { credentials: [{ name: 'network.network.card', data: '[Match]\nName=e*\n[Network]\nDHCP=yes\n' }] },
    ramMiB: 1024,
    framebuffer: { width: 1024, height: 768 },
    display: 'gpu',
    ready: /(?:^|\n)\S+ login: /, // agetty's prompt ("localhost login: ")
  },
  // A shell on the serial console. No fbcon in its kernel: the screen stays black. The root is
  // mounted read-only; the overlay is there so a restart exercises its hand-over (the OPFS locks).
  buildroot: {
    label: 'Buildroot (test guest)',
    prepare: '`images/build.sh` (docs/images.md)',
    kernel: images('linux/Image'),
    disk: images('buildroot/rootfs.ext4'),
    overlay: 'webpc-buildroot',
    cmdline: 'console=ttyAMA0 panic=-1 root=/dev/vda ro init=/init -- /bin/sh',
    ramMiB: 256,
    framebuffer: { width: 640, height: 480 },
    ready: /# $/,
  },
} satisfies Record<string, Machine>;

export type MachineName = keyof typeof MACHINES;

/** The default vCPU count: the host's cores minus two (the page and the device worker), at most 4. */
export const defaultCpus = (cores: number) => Math.max(1, Math.min(4, cores - 2));

/**
 * The host memory a machine needs, GiB: its RAM, ~1 GiB for the browser and the first vCPU's
 * worker, ~0.3 GiB per vCPU (bench/boot/REPORT.md "M8 loop 0": 2.3 GiB of RSS on 1 vCPU, 3.1 on
 * 4, with 1 GiB of guest RAM). Chromium has no catchable out-of-memory error (its renderer is
 * killed: PLAN.md §4 "Guest RAM ceiling"), so the page compares this with
 * `navigator.deviceMemory` before it starts a machine.
 */
export const hostMemoryGiB = (ramMiB: number, ncpus: number) => ramMiB / 1024 + 1 + 0.3 * ncpus;

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

/** `cmdline` with `extra` kernel parameters, before a `--` (whatever follows it goes to init). */
export function withParams(cmdline: string, extra: string) {
  if (!extra.trim()) return cmdline;
  const at = cmdline.indexOf(' -- ');
  return at < 0 ? `${cmdline} ${extra.trim()}` : `${cmdline.slice(0, at)} ${extra.trim()}${cmdline.slice(at)}`;
}
