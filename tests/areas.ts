// The areas map (docs/testing.md "Tiers"): what each part of the tree is, which slow tests guard it, and what the
// tiers add for a change to it. scripts/ci-fast.sh (the fast lane, through tools/ci-select.ts) runs, for a change:
// the smoke set (every test file that is neither heavy nor topic-only: the quick ones, all of them, every change), the
// heavy files of the areas the change touches, the changed test files themselves and those importing a changed test
// helper, and the areas' crates. Before a push, scripts/ci.sh and the areas' `push` scripts; at a track's end, `end`
// too. `node tools/ci-select.ts --check` (T0, in scripts/ci.sh and the fast lane) fails when a tracked file is in no
// area, a glob matches nothing, or a topic-only file has no script; and warns when the last scripts/ci.sh's timings
// (target/ci/timings.json) show a smoke file past HEAVY_SECONDS.
//
// Globs are node:path's matchesGlob. A file in several areas takes them all. A test file is heavy when it took more
// than HEAVY_SECONDS in scripts/ci.sh: it goes in the `heavy` list of the area it is about (a file can be heavy in
// several). The fast lane runs every heavy file reduced: no WAARM64_DISTROS (no Alpine), no WAARM64_LONG_TESTS,
// WAARM64_PARALLEL_RUNS=1, WAARM64_JIT_DIFF=512.

export interface Area {
  /** The tracked files it owns (globs). */
  src: string[];
  /** Test files over HEAVY_SECONDS that guard it (globs): the fast lane runs them only for a change here. */
  heavy?: string[];
  /** Crates whose cargo tests the fast lane runs: `core` (lib, bare-metal, corpus), `ts` (net/ts), `agent`, `testfloat`. */
  cargo?: ('core' | 'ts' | 'agent' | 'testfloat')[];
  /** Topic scripts (scripts/) that a push needs beside scripts/ci.sh, with their options. */
  push?: string[];
  /** What a track's end adds. */
  end?: string[];
  /** Selects every heavy file and says scripts/ci.sh is the tier (dependencies, toolchain, build config). */
  all?: boolean;
}

/**
 * A test file slower than this in scripts/ci.sh (its wall under ci.sh's load, start-up included) is heavy, not in the
 * smoke set. Files near it move by a few seconds from run to run: 2026-11-18's run had 151 files under 15 s (306 s
 * together) and 9 more between 15 and 20.
 */
export const HEAVY_SECONDS = 20;

/**
 * Test files only a topic script runs (they skip under npm test without its environment: a Debian boot, the rigs,
 * dEQP): the fast lane leaves them out, scripts/ci.sh runs them as skips. Each must be named by a scripts/ci-*.sh.
 */
export const TOPIC = [
  // scripts/ci-debian.sh (and --platform). Not here: files with tests that run without Debian too (page-debian, start,
  // page-folders, page-machine, page-deqp): they are in the smoke set, their Debian tests skipping there.
  'tests/page-disk.test.ts', 'tests/page-spill.test.ts',
  'tests/page-agent.test.ts', 'tests/page-power.test.ts', 'tests/page-ram.test.ts', 'tests/page-usb-keyboard.test.ts',
  'tests/page-usb-gamepad.test.ts', 'tests/page-clock.test.ts', 'tests/page-clipboard.test.ts',
  'tests/page-clipboard-x11.test.ts', 'tests/page-template.test.ts',
  // scripts/ci-machines.sh
  'tests/page-machines.test.ts', 'tests/page-stored.test.ts', 'tests/page-snapshots.test.ts', 'tests/page-quota.test.ts',
  'tests/page-incognito.test.ts', 'tests/page-usb-guest.test.ts', 'tests/page-surface-debian.test.ts',
  'tests/page-demos-guest.test.ts',
  // scripts/ci-graphics.sh
  'tests/page-venus.test.ts',
  // scripts/ci-net.sh
  'tests/net-guest.test.ts', 'tests/page-network.test.ts', 'tests/net-tailnet.test.ts', 'tests/tailcat-browser.test.ts',
  'tests/room-browser.test.ts', 'tests/page-room.test.ts', 'tests/net-tailcat.test.ts', 'tests/net-local.test.ts',
  'tests/ts-tailnet.test.ts', 'tests/tailscale-browser.test.ts', 'tests/ts-tailcat.test.ts', 'tests/page-alpine-agent.test.ts',
  'tests/page-demonet.test.ts', 'tests/page-demo-room.test.ts',
  // scripts/ci-audio.sh, ci-fp.sh, ci-usb.sh, ci-deqp.sh, ci-deqp-vk.sh
  'tests/audio-browser.test.ts', 'tests/fptest.test.ts', 'tests/usb-e2e-webusb.test.ts', 'tests/usb-e2e-hid.test.ts',
  'tests/usb-guest.test.ts', 'tests/page-deqp-vk.test.ts',
];

const FP = ['core/src/fp.rs', 'core/src/fp/**', 'core/src/interp/float.rs', 'core/src/interp/simd_fp.rs', 'core/src/interp/ldst_fp.rs', 'core/src/jit/emit/float.rs', 'core/src/jit/emit/half.rs', 'core/src/jit/emit/bf16.rs', 'web/fma.ts'];

export const AREAS: Record<string, Area> = {
  // ---- the core (Rust, natively and as the wasm core)
  jit: {
    src: ['core/src/jit/**', 'web/jit-compile-worker.ts', 'web/jit-host.ts', 'tests/jit-diff-suite.ts', 'tests/jit-variants.ts'],
    heavy: ['tests/jit-diff-[1-4].test.ts', 'tests/corpus-wasm.test.ts', 'tests/boot-node.test.ts', 'tests/boot-node-linux.test.ts'],
    cargo: ['core'],
    push: ['ci-jit.sh'],
    end: ['ci-debian.sh'],
  },
  fp: {
    src: FP,
    heavy: ['tests/jit-diff-[1-4].test.ts'],
    cargo: ['core', 'testfloat'],
    push: ['ci-fp.sh', 'ci-jit.sh'],
  },
  core: {
    // The interpreter, the MMU, the GIC, the platform and the rest of the core.
    src: ['core/**', 'tests/corpus/**', 'tests/baremetal/**', 'tests/dtb/**', 'tests/steps.txt', 'tests/steps.ts', 'tools/corpus/**', 'web/cpu-features.ts', 'web/vm.ts', 'web/core.ts', 'web/jit-host.ts', 'web/counters.ts', 'web/coordinator.ts', 'web/device-host.ts', 'web/warm-workers.ts', 'web/test-guests.ts', 'web/vcpu-worker.ts', 'web/ram.ts', 'web/clock.ts', 'web/liveness.ts', 'web/profiler.ts', 'web/sampler-worker.ts', 'web/timeline-worker.ts', 'web/iostats.ts'],
    heavy: ['tests/corpus-wasm.test.ts', 'tests/boot-node.test.ts'],
    cargo: ['core'],
    end: ['ci-jit.sh', 'ci-debian.sh'],
  },
  smp: {
    // Parallel SMP: the runner, its workers, the stop word, the guests that stress it.
    src: ['core/src/vm/parallel.rs', 'web/vcpu-worker.ts', 'web/coordinator.ts', 'tests/litmus/**', 'images/litmus/**', 'images/stress/**', 'tests/threads-*.ts', 'tests/hoststall/**'],
    heavy: ['tests/boot-node-parallel.test.ts', 'tests/boot-node-litmus.test.ts', 'tests/browser.test.ts', 'tests/hoststall.test.ts', 'tests/pause.test.ts'],
    cargo: ['core'],
    push: ['ci-jit.sh'],
  },
  firmware: {
    // The boot path: the firmware and UEFI, the page's run.
    src: ['core/src/boot.rs', 'core/src/fw_cfg.rs', 'core/src/smbios.rs', 'core/src/flash.rs', 'core/src/fdt.rs', 'images/edk2/**', 'web/app/run/**', 'web/app/firmware-files.ts', 'tools/uefi-oracle.ts'],
    heavy: ['tests/uefi.test.ts', 'tests/page-run.test.ts'],
    push: ['ci-debian.sh'],
    end: ['ci-debian.sh --platform'],
  },
  devices: {
    src: ['core/src/virtio.rs', 'core/src/virtio/**', 'core/src/pl011.rs', 'core/src/pl031.rs', 'core/src/rng.rs', 'web/devices.ts', 'web/device-worker.ts', 'web/device-host.ts', 'web/virtio.ts', 'web/blk-device.ts', 'web/net-device.ts', 'web/input-device.ts', 'web/disk-sources.ts', 'web/balloon.ts', 'web/vsock-device.ts', 'web/9p*.ts', 'web/fat.ts', 'tests/p9/**'],
    push: ['ci-debian.sh'],
  },
  // ---- disks, snapshots, machines
  disks: {
    src: ['web/qcow2*.ts', 'web/overlay.ts', 'web/blk-device.ts', 'web/disk-sources.ts', 'web/stored.ts', 'web/blockcache.ts', 'web/diskcache.ts', 'web/ramdisk.ts', 'web/chunked.ts', 'web/sha256.ts', 'web/spill.ts', 'web/deflate.ts', 'web/inflate-*.ts', 'web/lz.ts', 'web/app/disk*', 'web/app/Disk*', 'web/app/AddDisk*', 'web/app/add-disk.ts', 'web/app/AttachDisk.svelte', 'web/app/ResizeDisk.svelte', 'web/app/resize.ts', 'web/app/merge.ts', 'web/app/import*', 'web/app/export*', 'web/app/Export*', 'web/app/deflate-*.ts', 'web/app/areas/disk-*.ts', 'web/app/areas/trim-actions.ts', 'web/app/areas/grow-actions.ts', 'web/app/run/page-disks.ts', 'tests/qcow2/**', 'tests/qcow2-make.ts', 'tools/chunk-image.ts', 'tools/disk-trace.ts', 'deploy/**'],
    heavy: ['tests/blockcache.test.ts', 'tests/qcow2-write.test.ts', 'tests/overlay.test.ts', 'tests/page-save.test.ts'],
    push: ['ci-machines.sh'],
    end: ['ci-debian.sh'],
  },
  snapshots: {
    src: ['core/src/snapshot.rs', 'core/src/vm/state.rs', 'web/snapshot*.ts', 'web/app/snapshot*.ts', 'web/app/Snapshots.svelte', 'web/app/LoadSnapshotMenu.svelte', 'web/app/worker-snapshot.ts', 'web/app/areas/snapshot-*.ts', 'tests/snapshot-*.ts', 'tools/snapshot-template.ts'],
    heavy: ['tests/snapshot.test.ts', 'tests/page-snapshot.test.ts'],
    push: ['ci-machines.sh', 'ci-debian.sh'],
  },
  machines: {
    // Stored machines, the store, the Machines and Home pages.
    heavy: ['tests/storage-full.test.ts'],
    src: ['web/app/store*.ts', 'web/app/machine*.ts', 'web/app/machines*.ts', 'web/app/Machine*.svelte', 'web/app/MachinesPage.svelte', 'web/app/storage-report.ts', 'web/app/Storage*.svelte', 'web/app/locks.ts', 'web/app/areas/machines-nav.svelte.ts', 'web/app/areas/records.svelte.ts', 'web/app/definitions.ts', 'web/app/template.ts', 'web/app/demo-store.ts', 'web/app/demo-check.ts', 'web/app/demo-open.ts', 'web/app/demos-route.ts', 'web/app/intro-route.ts', 'tests/intro-route.test.ts', 'web/app/demo-leave.ts', 'web/app/Demo*.svelte', 'web/app/NewMachine.svelte', 'tests/page-home.ts', 'web/app/areas/demos.svelte.ts', 'tests/demos-route.test.ts', 'tests/demo-fixture.ts', 'tests/page-demos*.test.ts', 'tools/demo-site.ts', 'tools/publish-demos.ts', 'tools/build-demos.ts', 'bench/demo/make-template.ts', 'bench/demo/screen-like.ts', 'tests/demo-store.test.ts', 'tests/demo-site.test.ts', 'tests/build-demos.test.ts', 'tests/template.test.ts'],
    push: ['ci-machines.sh'],
  },
  // ---- graphics
  display: {
    src: ['web/gpu.ts', 'web/gpu-backend.ts', 'web/gpu-present.ts', 'web/display.ts', 'web/edid.ts', 'web/surface.ts', 'web/input.ts', 'web/app/Screen*.svelte', 'web/app/areas/screen*.ts', 'web/app/areas/mouse.svelte.ts', 'web/app/areas/cursor-fit.ts', 'web/app/Mouse*.svelte', 'web/app/Size*.svelte', 'web/app/areas/page-window.ts', 'web/app/ViewDivider.svelte', 'tests/gpu/**'],
    heavy: ['tests/page-pointers.test.ts', 'tests/page-surface.test.ts', 'tests/page-layout.test.ts'],
    push: ['ci-debian.sh', 'ci-graphics.sh'],
  },
  virgl: {
    src: ['web/virgl*.ts', 'web/gpu-worker.ts', 'web/gpu-messages.ts', 'web/gpu-knobs.ts', 'web/gl-enums.ts', 'web/video-*.ts', 'tests/virgl/**', 'tests/virgl-*.ts', 'tools/virgl-*', 'tools/virgl-oracle/**', 'tools/nosme*', 'tools/nosme/**', 'images/gpu/**', 'images/deqp/**', 'tests/deqp/**', 'tests/deqp-lists.ts'],
    heavy: ['tests/virgl-browser.test.ts'],
    push: ['ci-graphics.sh', 'ci-deqp.sh'],
    end: ['ci-deqp.sh --full'],
  },
  vulkan: {
    src: ['vk/**', 'web/venus*.ts', 'tests/venus/**', 'tools/venus-oracle/**', 'tools/vulkan-tools/**', 'images/vulkan/**', 'images/debian-vulkan/**', 'images/vkframes/**'],
    heavy: ['tests/venus-driver.test.ts', 'tests/wgsl.test.ts'],
    push: ['ci-graphics.sh', 'ci-deqp-vk.sh'],
    end: ['ci-deqp-vk.sh --full'],
  },
  // ---- the network
  network: {
    src: ['web/gateway.ts', 'web/net.ts', 'web/net-device.ts', 'web/bytes.ts', 'web/local-net*.ts', 'web/demo-net*.ts', 'web/app/demo-view.ts', 'web/local-release.ts', 'web/ip6.ts', 'web/reach6.ts', 'web/tailscale*.ts', 'web/tailnet-worker.ts', 'web/tailcat*.ts', 'web/ts-*.ts', 'web/offload.ts', 'net/**', 'web/app/Net*.svelte', 'web/app/net-*.ts', 'web/app/network*.ts', 'web/app/Network*.svelte', 'web/app/guest-net.ts', 'web/app/Connection*.svelte', 'web/app/connection*.ts', 'web/app/areas/network*.ts', 'web/app/areas/lease-actions.ts', 'tests/net/**', 'tests/waarm64-net.ts', 'tests/waarm64-demonet.ts', 'tests/go-pinned.ts', 'tools/tailscale.ts'],
    heavy: ['tests/page-local.test.ts', 'tests/page-connections.test.ts', 'tests/net-path.test.ts'],
    cargo: ['ts'],
    push: ['ci-net.sh'],
  },
  rooms: {
    // Rooms and names: net/ts's room, the page's names.
    src: ['net/ts/src/room.rs', 'net/ts/src/room/**', 'net/ts/src/nostr.rs', 'web/room*.ts', 'web/names*.ts', 'web/app/names-view.ts', 'web/app/room-*.ts', 'web/app/NetNames.svelte', 'web/app/NetRoom*.svelte', 'web/app/Name*.svelte', 'web/app/areas/names.svelte.ts'],
    cargo: ['ts'],
    push: ['ci-net.sh'],
  },
  // ---- the rest of the devices the page drives
  sound: {
    src: ['web/snd*.ts', 'web/audio*.ts', 'web/app/Sound.svelte', 'web/app/areas/sound.svelte.ts', 'images/snd/**', 'tests/snd/**', 'tests/snd-disk.ts', 'tests/audio-tap.ts'],
    push: ['ci-audio.sh'],
  },
  usb: {
    src: ['core/src/xhci.rs', 'core/src/xhci/**', 'web/usb*.ts', 'web/webusb.ts', 'web/webhid.ts', 'web/hid-descriptor.ts', 'web/app/Usb*.svelte', 'web/app/AddUsb.svelte', 'web/app/usb-*.ts', 'web/app/gamepads.ts', 'web/app/areas/usb*.ts', 'tests/usb/**', 'images/usb/**', 'images/usbhost/**'],
    push: ['ci-usb.sh'],
    end: ['ci-machines.sh'],
  },
  agent: {
    // The guest agent and what the page does through it: clipboard sharing, the soft power-off, the guest's facts.
    src: ['agent/**', 'web/agent-frame.ts', 'web/app/agent-link.ts', 'web/app/guest-*.ts', 'web/app/clipboard*.ts', 'web/app/Clipboard*.svelte', 'web/app/areas/agent-*.ts', 'web/app/areas/clipboard*.ts', 'web/app/areas/power.svelte.ts', 'images/debian-sway/**', 'tests/debian-unattended.ts'],
    heavy: ['tests/page-clipboard-ui.test.ts', 'tests/page-console.test.ts'],
    cargo: ['agent'],
    push: ['ci-debian.sh', 'ci-net.sh'], // ci-net.sh: the agent on Alpine (tests/page-alpine-agent.test.ts)
    end: ['ci-debian.sh --platform'],
  },
  folders: {
    // Shared folders (9p over virtio): docs/shares.md.
    src: ['web/9p*.ts', 'web/app/folder*.ts', 'web/app/Folder*.svelte', 'web/app/shares-mount.ts', 'web/app/areas/folder-actions.ts', 'web/app/areas/shares.svelte.ts'],
    push: ['ci-machines.sh'],
  },
  // ---- the page
  osk: {
    src: ['web/app/osk*.ts', 'web/app/Osk*.svelte', 'web/app/keymaps.ts', 'web/app/keyboard.ts', 'web/app/Keyboard*.svelte', 'web/app/Keys*.svelte', 'web/app/areas/key*.ts', 'tools/osk-keymaps.ts'],
    heavy: ['tests/page-osk.test.ts'],
  },
  page: {
    // The page's UI: components, the catalog, the theme, the workers' plumbing. Its quick tests are in the smoke set.
    src: ['web/app/**', 'web/intro-captures/**', 'web/messages/**', 'web/i18n.ts', 'web/msg.ts', 'web/window.ts', 'web/changes.ts', 'web/ram-scan.ts', 'tests/browser/**', 'tests/harness/**', 'tests/page-*.ts', 'tests/serial-console.ts', 'tests/words.ts', 'tests/until.ts', 'tests/debian-lock.ts', 'tests/debian-fixture.ts', 'tools/i18n-check.ts', 'tools/screens.ts', 'tools/screens-demos.ts', 'tools/copy-apply.ts', 'tools/start.*', 'tools/dist.ts'],
    heavy: ['tests/page-run.test.ts', 'tests/page-modal.test.ts', 'tests/page-statusbar.test.ts'],
    end: ['ci-debian.sh'],
  },
  // ---- what the rest of the tree is
  images: {
    // The guest images (built in Podman: images/build.sh). A push also runs the scripts that use the image.
    src: ['images/**'],
  },
  'build-rust': {
    // The Rust dependencies, toolchain and build configuration: every crate and every heavy file; scripts/ci.sh is the
    // tier (a toolchain bump: the benchmarks too, CLAUDE.md).
    src: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/**', '.config/nextest.toml', 'scripts/build-wasm.sh'],
    cargo: ['core', 'ts', 'agent'],
    all: true,
  },
  'build-js': {
    // The npm dependencies, the build's and the dev server's configuration: every heavy file; scripts/ci.sh is the tier.
    src: ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig*.json', 'prettier.config.ts', 'tools/serve.ts', 'tools/stamp.ts', 'tools/lint/**'],
    all: true,
  },
  ci: {
    // The CI scripts and their tools: the fast lane runs its static checks; a push, scripts/ci.sh.
    src: ['scripts/**', 'tests/areas.ts', 'tools/ci-select.ts', 'tools/test-timings.ts', 'tools/harness-imports.ts', 'tools/third-party.ts', 'THIRD_PARTY.json', '.claude/**'],
  },
  other: {
    // Benchmarks, the tools no test runs and test helpers no area claims (tsc checks them in T0).
    src: ['bench/**', 'tools/**', 'tests/**'],
  },
  repo: {
    src: ['.gitattributes', '.gitignore', '.git-blame-ignore-revs', 'LICENSE', 'wrangler.jsonc'],
  },
};
