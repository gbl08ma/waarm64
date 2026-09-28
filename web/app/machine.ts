// The page's machines (docs/frontend.md), in one place: image URLs, the
// command line, RAM, the screen and the devices. `debian` is the page's VM (M8
// decision 1); `buildroot` is the small test guest, for the page's smoke test
// (tests/browser.test.ts) and quick looks. URLs are relative to this module, so
// nothing here depends on the dev server's layout beyond where target/ is.

export type Machine = {
  kernel: string;
  initrd?: string;
  /** The root disk (virtio-blk over HTTP ranges). */
  disk: string;
  /** The OPFS overlay that makes `disk` writable (web/overlay.ts); read-only without one. */
  overlay?: string;
  cmdline: string;
  ramMiB: number;
  framebuffer: { width: number; height: number };
  /** Serial output that means the machine is up (a login prompt, a shell's prompt). */
  ready: RegExp;
};

const images = (path: string) => new URL(`../../target/images/${path}`, import.meta.url).href;

export const MACHINES = {
  // The measured configuration (bench/boot/REPORT.md "M8 loop 0", docs/images.md "Debian for interaction").
  debian: {
    kernel: images('debian/Image'),
    initrd: images('debian/initrd.img'),
    disk: images('debian/disk.qcow2'),
    overlay: 'webpc-debian',
    cmdline: 'console=ttyAMA0 console=tty0 root=/dev/vda1 ro systemd.firstboot=off systemd.set_credential=login.noauth:yes apparmor=0 ' +
      ['systemd-networkd.service', 'systemd-networkd.socket', 'systemd-resolved.service', 'systemd-timesyncd.service', 'systemd-network-generator.service'].map((u) => `systemd.mask=${u}`).join(' '),
    ramMiB: 1024,
    framebuffer: { width: 1024, height: 768 },
    ready: /login: $/,
  },
  // A shell on the serial console. No fbcon in its kernel: the screen stays black. The root is
  // mounted read-only; the overlay is there so a restart exercises its hand-over (the OPFS locks).
  buildroot: {
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
