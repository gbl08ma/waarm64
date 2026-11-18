# waarm64 and the other in-browser machines

A comparison for the project's public pages: what each system is, what it can do, and how fast it is. **§1–§4 are the
facts** (dated, with sources). **§5 is draft copy** built only from them. Claims about other projects come from their
public docs and source as of 2026-11-18. Each has a link in §6, and anything we couldn't confirm is marked
*unverified*. Re-check them before publishing, because these projects move fast. Performance cells marked **TBD** are
for the measurements of [plans/first-demo.md](plans/first-demo.md) loop 0. No number goes in without a run behind it
([benchmarking.md](benchmarking.md) "Rules").

## 1. The field in one line each

- **waarm64:** a whole AArch64 machine (GICv3, PL011, virtio, xHCI, UEFI) with a JIT to wasm. It boots unmodified
  arm64 distributions (Debian, Arch, Alpine) with their stock kernels and the drivers that ship upstream.
- **unkernel** (pithings, announced 2026-11): Linux 7.x compiled to wasm (it grew from linux-wasm) runs natively in
  the tab. Only **riscv64** user programs are emulated, by an interpreter and a block JIT. One CPU in the release;
  `?smp=N` is experimental and can't be snapshotted. The demo is Alpine in 48 MiB, about 10 MB to download, with Wisp
  networking on by default.
- **WebVM / CheerpX** (Leaning Technologies): a proprietary **32-bit x86** user-mode JIT that implements Linux syscalls
  itself, with no guest kernel. 64-bit is "not an immediate priority". Its network is Tailscale only. It's free only
  for exploration and individual use.
- **v86:** a whole-PC **32-bit x86** JIT to wasm: no x86-64, one core, VGA/SVGA, no 3D, no USB. Networking through a
  frame relay, Wisp, or `fetch`. BSD-2.
- **JSLinux** (Bellard): x86_64, i686 and riscv64 machines in Emscripten-compiled C, with no JIT documented. Its
  network is a WebSocket VPN capped at 40 kB/s and 2 connections per IP.
- **container2wasm / qemu-wasm** (NTT): container images as wasm through Bochs, TinyEMU or QEMU's wasm port.
  qemu-wasm is the only other arm64 system emulator in a browser. We measured it once: it booted Buildroot 4.7×
  slower than waarm64 and computed CoreMark wrong ([benchmarking.md](benchmarking.md)).
- Not VMs, so not compared row by row: WebContainers (Node), BrowserPod (Leaning's wasm-native kernel, programs
  rebuilt for wasm), WASIX, linux-wasm and tombl/linux (wasm-only programs), WebCM (riscv64 Cartesi machine,
  CORS-bound network).

## 2. Features

| | **waarm64** | unkernel | WebVM / CheerpX | v86 | JSLinux |
|---|---|---|---|---|---|
| Guest | **AArch64 (arm64), whole machine** | riscv64 user space on a wasm kernel | i386 user space, syscalls emulated | i686 PC | x86_64 / i686 / riscv64 |
| Kernel | **The distribution's own, unmodified**, through UEFI (EDK2) or direct | unkernel's own wasm build | none (CheerpX is the "kernel") | the guest's own | the guest's own |
| Drivers | Upstream: virtio, xHCI, PL011, GICv3 (no custom guest drivers) | custom paravirtual (kwblk, kwnet, kwfb…) | n/a | legacy PC + virtio | virtio |
| Unmodified binaries of the ecosystem | **arm64**: the platform of phones, Macs, Raspberry Pis and cloud servers; proprietary arm64 builds (Steam's official aarch64 client starts; its CEF UI has glitches: backlog) | riscv64, still a smaller binary ecosystem | i386 only | i386 only | yes, per ISA |
| CPU | JIT to wasm (blocks, regions), interpreter and block interpreter tiers; crypto extensions | interpreter + block JIT, user code only; atomics and system instructions interpreted | interpreter + JIT | JIT | interpreter (*unverified*) |
| SMP | **up to 8 vCPUs, a worker each, real atomics** | 1 (experimental SMP, not released) | *unverified* | no | not stated |
| RAM | up to 16 GiB (past 3 GiB as NUMA nodes) | 48 MiB default | — | — | — |
| Display | virtio-gpu, live resize, HiDPI | framebuffer | KMS to a canvas (Xorg) | VGA / SVGA | framebuffer X |
| **3D** | **OpenGL ES 3.0 + GL 2.1 through virgl on WebGL2: 0 failures on dEQP's GLES2 and GLES3 mustpass lists** (17,027 and 44,398 pass); **Vulkan through Venus on WebGPU** (vkcube, vkmark, vkQuake) | no | no | no | no |
| Video | **Hardware video decode for the guest**: VA-API → the browser's `VideoDecoder` (H.264, VP9, AV1); YouTube in a guest Chromium | no | no | no | no |
| A browser inside | Firefox and Chromium with WebGL (WebGL inside WebGL2), accelerated | — | — | — | — |
| Sound | virtio-snd, playback **and microphone** | ALSA / OSS | *unverified* | SoundBlaster 16 | — |
| Input | keyboard (layouts), tablet, raw mouse lock, touchscreen, on-screen keyboard, gamepads | keyboard, mouse, touch | — | PS/2 | — |
| USB | **Real devices through WebUSB and WebHID** passed to the guest; virtual devices | no | no | no | no |
| Network | **Up to 4 adapters**; Tailscale and tailcat (our own client, Rust/wasm); a local helper (full LAN and internet through your computer); **peer-to-peer rooms between browsers** (WireGuard in WebRTC) with **registered names**; IPv6. Wisp: proposed ([plans/first-demo.md](plans/first-demo.md) §3) | **Wisp, on by default** (TCP only, IPv4, outbound only) | Tailscale only | relay, Wisp, fetch, between tabs | WS VPN, 40 kB/s |
| Disk images | **qcow2 (compressed too) and raw**, stock cloud images as published; up to 16 disks; ramdisks; chunked images over HTTP with boot-trace prefetch | ext4 | ext2 | raw, ISO | own format |
| Storage | disks and overlays in the browser (OPFS), files read in place, URLs, blank disks; merge, resize | IndexedDB ext4 overlay | IndexedDB overlay | — | VFsync |
| Import / export | export a disk or just its changes as qcow2 or raw; import changes; machine definitions in and out; snapshot files | export and reset of the data disk | — | state files | VFsync |
| Snapshots | **Snapshots and Suspend with 3D in use**, compressed; template snapshots that renew the guest's identity | yes, uncompressed; not with SMP | — | yes (zstd) | — |
| Shared folders | folders on your computer (File System Access) or in the browser, over 9p | 9p over vsock (CLI) | — | 9p | 9p |
| Clipboard | two-way with the guest (our agent) | — | — | — | — |
| Debugging | the guest's own debug (ptrace, perf breakpoints, watchpoints) | no ptrace (no strace, gdb) | — | — | — |
| Browsers | **Chromium only** (Chrome, Edge…) | Chrome/Edge 137+, Firefox 153+, Safari 27+, iOS 27 (needs JSPI) | modern browsers | all | all |
| License | MIT | GPL-2.0+ (SDK MIT) | UI Apache-2.0, engine proprietary | BSD-2 | MIT (TinyEMU); current build *unverified* |

## 3. Performance (to measure)

The user's informal test of 2026-11-18 put our CPU at a little over twice unkernel's, and further ahead with
unkernel's experimental SMP on. That's not a published number until it's measured. Each row is measured in headless
Chromium on the same host, in one session, with medians and IQR ([benchmarking.md](benchmarking.md) "Rules"). The
peers run as shipped: their own demo or a local build at its documented settings. Rows marked * are a cross-ISA
comparison (the same source compiled for each guest), and the table must say that.

| Workload | waarm64 | unkernel | v86 | WebVM | JSLinux |
|---|---|---|---|---|---|
| Click to a shell prompt (cold cache) | TBD | TBD | TBD | TBD | TBD |
| Bytes downloaded to the prompt | TBD | ~10 MB (their README) | TBD | TBD | TBD |
| CoreMark, 1 core * | TBD | TBD | TBD | TBD | TBD |
| CoreMark, all cores * | TBD | TBD (`?smp`) | — | TBD | — |
| `xz -9` / `gzip` of a fixed file * | TBD | TBD | TBD | TBD | TBD |
| Python: `python3 -c` a fixed loop / pyperformance subset * | TBD | TBD | TBD | TBD | TBD |
| `apk add python3` (network + disk) | TBD (with Wisp) | TBD | — | — | — |
| fork + exec churn * | TBD | TBD | TBD | TBD | TBD |
| Peak tab memory at the prompt | TBD | TBD | TBD | TBD | TBD |

Our own numbers for context (Chromium 153, M4, [benchmarking.md](benchmarking.md) "Current numbers"): CoreMark 10,080
it/s in user mode (QEMU TCG natively: 12,500); 5,175 integer MIPS; Alpine boot to power-off 9.9 s; Buildroot 0.8 s;
AES-128-GCM 232 MB/s with the crypto extensions.

## 4. Where they lead

- **The first minute.** unkernel's demo is an Alpine prompt after ~10 MB. It installs the package for a missing
  command as you type it, keeps your changes across reloads, and has a network with nothing configured. v86's demos
  work in a similar way. Ours opens on an empty machine that asks for a disk. Closing that gap is
  [plans/first-demo.md](plans/first-demo.md).
- **Browsers:** unkernel runs on Firefox, Safari and iOS; we are Chromium only (decisions.md).
- **Memory:** a 48 MiB guest on a native-wasm kernel is smaller than any whole machine. Not a goal for us.
- **Syscall-heavy work:** unkernel's kernel is native wasm, so a syscall is a call, not an exception. They claim fork
  and exit faster than native. Our process churn is the weak spot to measure (§3, fork + exec).

## 5. Draft copy

> **A real arm64 computer in a browser tab.** waarm64 runs the same Linux you'd run on a Raspberry Pi, a Mac's VM or
> an arm64 cloud server: stock distributions, stock kernels, unmodified binaries, proprietary ones included. It isn't
> a wasm port of Linux or a syscall emulator. It's a whole machine, with up to 8 cores, up to 16 GiB of RAM and UEFI,
> and a JIT that is several times faster than [TBD: the measured peers].
>
> **Graphics that pass the conformance tests.** OpenGL ES 3.0 with zero failures on dEQP's mustpass lists, Vulkan
> through WebGPU, and hardware video decoding: run Firefox or Chromium *inside* the tab, WebGL and YouTube included.
>
> **Your devices and your files.** Plug in a USB device and the guest sees it. Share a folder from your computer.
> Copy and paste both ways. Open any qcow2 or raw image (a published cloud image as it is), keep it in your browser,
> snapshot it, suspend it, and export the disk, or just your changes, back out.
>
> **Networks of your choice.** Join your Tailscale tailnet, go online through your own computer, or connect browsers
> directly to each other in peer-to-peer rooms with names of their own. [With the demo network: online from the
> first prompt.]
>
> **Open source, MIT.**

Comparison lines for a table on the site: "arm64, not i386 or riscv64"; "a real kernel, not a wasm port";
"8 cores, not 1"; "OpenGL ES 3 and Vulkan, not a framebuffer"; "USB, mic, clipboard, shared folders"; "qcow2 in and
out". Always with a date and a link to this page's sources.

## 6. Sources

- unkernel: https://github.com/pithings/unkernel (README; `js/core/net.ts`, `net-wisp.ts`, `jit.ts`, `snapshot.ts`),
  https://unkernel.dev, https://registry.npmjs.org/unkernel/latest
- WebVM / CheerpX: https://github.com/leaningtech/webvm, https://cheerpx.io/docs/overview,
  https://cheerpx.io/docs/guides/Networking, https://labs.leaningtech.com/blog/cx-10 (32-bit, licensing, "5–10×
  slower than native"); BrowserPod: https://labs.leaningtech.com/blog/browserpod-40
- v86: https://github.com/copy/v86, its `docs/networking.md` and `src/browser/fake_network.js`
- JSLinux: https://bellard.org/jslinux/, https://bellard.org/jslinux/tech.html
- container2wasm: https://github.com/container2wasm/container2wasm; qemu-wasm: https://github.com/ktock/qemu-wasm
- Wisp: https://github.com/MercuryWorkshop/wisp-protocol (CC-BY-4.0)
- Ours: [graphics.md](graphics.md) "Testing" (dEQP), [benchmarking.md](benchmarking.md), [networking/](networking/adapters.md),
  [usb.md](usb.md), [machines.md](machines.md), backlog.md (Steam)
