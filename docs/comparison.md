# waarm64 and the other in-browser machines

A comparison for the project's public pages: what each system is, what it can do, and how fast it is. **§1–§4 are the
facts** (dated, with sources). **§5 is draft copy** built only from them. Claims about other projects come from their
public docs and source as of 2026-11-18. Each has a link in §6, and anything we couldn't confirm is marked
*unverified*. Re-check them before publishing, because these projects move fast. Performance cells marked **TBD** are
still to measure. No number goes in without a run behind it
([benchmarking.md](benchmarking.md) "Rules").

## 1. The field in one line each

- **waarm64:** a whole AArch64 machine (GICv3, PL011, virtio, xHCI, UEFI) with a JIT to wasm. It boots unmodified
  arm64 distributions (Debian, Arch, Alpine) with their stock kernels and the drivers that ship upstream.
- **unkernel** (pithings, announced 2026-11): Linux 7.x compiled to wasm (it grew from linux-wasm) runs natively in
  the tab. Only user programs are emulated: **unmodified aarch64 binaries since 2026-11-19** (riscv64 before: its
  README at `83c65c3`, "the riscv64 user space the project started with"), by an interpreter and a JIT for hot user
  code (FP and AdvSIMD floating point interpreted even inside compiled code). The page boots several CPUs where it
  can ("half the device's threads, up to 4 on desktops"; `?cpus=`), which can't be suspended. Its demo, read
  2026-11-20, is Debian 13 (a 69 MiB image, streamed) on 4 CPUs in 512 MiB, booted in under a second, with Wisp
  networking; Alpine in 48 MiB is the other distribution it ships.
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
| Guest | **AArch64 (arm64), whole machine** | aarch64 user space on a wasm kernel (riscv64 until 2026-11-19) | i386 user space, syscalls emulated | i686 PC | x86_64 / i686 / riscv64 |
| Kernel | **The distribution's own, unmodified**, through UEFI (EDK2) or direct | unkernel's own wasm build | none (CheerpX is the "kernel") | the guest's own | the guest's own |
| Drivers | Upstream: virtio, xHCI, PL011, GICv3 (no custom guest drivers) | custom paravirtual (kwblk, kwnet, kwfb…) | n/a | legacy PC + virtio | virtio |
| Unmodified binaries of the ecosystem | **arm64**: the platform of phones, Macs, Raspberry Pis and cloud servers; proprietary arm64 builds (Steam's official aarch64 client starts; its CEF UI has glitches: backlog) | arm64 user programs, as packaged by Alpine and Debian (no kernel modules, no other kernel) | i386 only | i386 only | yes, per ISA |
| CPU | JIT to wasm (blocks, regions), interpreter and block interpreter tiers; crypto extensions | interpreter + block JIT, user code only; atomics and system instructions interpreted | interpreter + JIT | JIT | interpreter (*unverified*) |
| SMP | **up to 8 vCPUs, a worker each, real atomics** | up to 4 CPUs on the page by default (`?cpus=`), a worker each; one in the SDK and CLI | *unverified* | no | not stated |
| RAM | up to 16 GiB (past 3 GiB as NUMA nodes) | 48 MiB default | — | — | — |
| Display | virtio-gpu, live resize, HiDPI | framebuffer | KMS to a canvas (Xorg) | VGA / SVGA | framebuffer X |
| **3D** | **OpenGL ES 3.0 + GL 2.1 through virgl on WebGL2: 0 failures on dEQP's GLES2 and GLES3 mustpass lists** (17,027 and 44,398 pass); **Vulkan through Venus on WebGPU** (vkcube, vkmark, vkQuake) | no | no | no | no |
| Video | **Hardware video decode for the guest**: VA-API → the browser's `VideoDecoder` (H.264, VP9, AV1); YouTube in a guest Chromium | no | no | no | no |
| A browser inside | Firefox and Chromium with WebGL (WebGL inside WebGL2), accelerated | — | — | — | — |
| Sound | virtio-snd, playback **and microphone** | playback (its own ALSA card and OSS `/dev/dsp`), no capture | not stated (nothing in its README, source or CheerpX's docs) | playback (SoundBlaster 16; its input is "fake silent input"), no microphone | none (no sound device in its list of emulated devices) |
| Input | keyboard (layouts), tablet, raw mouse lock, touchscreen, on-screen keyboard, gamepads | keyboard, mouse, touch | — | PS/2 | — |
| USB | **Real devices through WebUSB and WebHID** passed to the guest; virtual devices | no | no | no | no |
| Network | **Up to 4 adapters**; Tailscale and tailcat (our own client, Rust/wasm); a local helper (full LAN and internet through your computer); **peer-to-peer rooms between browsers** (WireGuard in WebRTC) with **registered names**; IPv6. the **demo network**: a hosted server with an allowlist, no setup ([networking/demo-network.md](networking/demo-network.md); not Wisp) | **Wisp, on by default** (TCP only, IPv4, outbound only) | Tailscale only | relay, Wisp, fetch, between tabs | WS VPN, 40 kB/s |
| Disk images | **qcow2 (compressed too), raw and ISO** (an installer's or a live system's, read-only), stock cloud images as published; up to 16 disks; ramdisks; chunked images over HTTP with boot-trace prefetch | ext4 | ext2 | raw, ISO | own format |
| Storage | disks and overlays in the browser (OPFS), files read in place, URLs, blank disks; merge, resize | IndexedDB ext4 overlay | IndexedDB overlay | — | VFsync |
| Import / export | export a disk or just its changes as qcow2 or raw; import changes; machine definitions in and out; snapshot files | export and reset of the data disk | — | state files | VFsync |
| Snapshots | **Snapshots and Suspend with 3D in use**, compressed; template snapshots that renew the guest's identity | yes, uncompressed; not with SMP | — | yes (zstd) | — |
| Files from your computer | **a folder of yours shared live** (File System Access) or one in the browser, over 9p | the page: its disk kept in the browser, exported or imported whole; a live mount only from the Node CLI and SDK (`--mount`, "Node only") | none in the page ("Direct access to local files is restricted"); its disk kept in IndexedDB; an embedder can pass single files | files copied into an in-memory 9p filesystem (several at once), one fetched out by its absolute path; disk images from local files; no folder picker | files uploaded with a button, one exported with `export_file`; no folder picker |
| Clipboard | two-way with the guest (our agent) | — | — | — | — |
| Debugging | the guest's own debug (ptrace, perf breakpoints, watchpoints) | no ptrace (no strace, gdb) | — | — | — |
| Browsers | **Chromium first** (Chrome, Edge…: what it is built and tested for); Firefox runs smaller guests, more slowly and without WebUSB (the introduction's guest boots there in 0.59 s against 0.48: bench/demo/REPORT.md "INTRO loop 1") | Chrome/Edge 137+, Firefox 153+, Safari 27+, iOS 27 (needs JSPI) | modern browsers | all | all |
| License | MIT | GPL-2.0+ (SDK MIT) | UI Apache-2.0, engine proprietary | BSD-2 | MIT (TinyEMU: its page says "released under the MIT license", and JSLinux's technical notes that "the current version is based on TinyEMU"; JSLinux's own page states no license; read 2026-11-20) |

## 3. Performance (to measure)

The first measured row is Perl ([bench/compare/REPORT.md](../bench/compare/REPORT.md), 2026-11-20): 1.78× as fast as
unkernel on the very same Debian binary and 3.89× as fast as v86 on the Mac host (the page's figures), 1.85× and
4.04× on the dev VM. The user's informal test of 2026-11-18 had put our CPU at a little over twice
unkernel's (riscv64 then). The rows still TBD aren't claimed. Each row is measured in headless
Chromium on the same host, in one session, with medians and IQR ([benchmarking.md](benchmarking.md) "Rules"). The
peers run as shipped: their own demo or a local build at its documented settings. Rows marked * are a cross-ISA
comparison (the same source compiled for each guest), and the table must say that.

| Workload | waarm64 | unkernel | v86 | WebVM | JSLinux |
|---|---|---|---|---|---|
| Click to a shell prompt (cold cache): a typed command answered | 31.7 s (the Desktop Demo's first boot, logged in; login prompt 27.8 s); 2.9–3.0 s (the Alpine demo, a resume: a local build at a modelled 100 Mbit/s and 20 ms); 4.1–4.3 s deployed (single runs) | 1.7 s (2026-11-20: Debian 13, aarch64 user space, 4 CPUs; 1.3 s on 2026-11-19, when the demo was Alpine on riscv64) | 1.8 s (Arch, a saved state); 3.9 s (Buildroot, a boot) | TBD | TBD |
| Bytes downloaded to the prompt | 420 MiB (6.1 the page, 414 the disk); 24.7 MB (the Alpine demo: the page, a 15.7 MB template, the disk's first reads) | 6.9 MiB (2026-11-20; 6.7 the day before) | 15.3 MiB (Arch); 5.5 MiB (Buildroot) | TBD | TBD |
| Perl, six kernels (`bench/compare/work.pl`, size 8; seconds, median of 9, 2026-11-20; the Mac host, Chrome 158, then the dev VM, Chromium 155) | **10.1 s**; 11.3 s (Debian 13 arm64, perl 5.40.1) | 18.0 s; 21.0 s (the same Debian binary: **we are 1.78× as fast** on the Mac, 1.85× in the VM) | 39.3 s; 45.8 s (Arch Linux 32, i686 perl 5.36.0 *: **3.89×**, 4.04×) | not measured (closed, no fixed workload: the user) | not measured |
| CoreMark, 1 core * | TBD | TBD | TBD | TBD | TBD |
| CoreMark, all cores * | TBD | TBD (`?smp`) | — | TBD | — |
| `xz -9` / `gzip` of a fixed file * | TBD | TBD | TBD | TBD | TBD |
| Python: `python3 -c` a fixed loop / pyperformance subset * | TBD | TBD | TBD | TBD | TBD |
| `apk add python3` (network + disk) | 13.7–14.0 s (the Alpine demo deployed, through the demo network: single runs) | 7.7 s, 17.8 MiB | — | — | — |
| fork + exec churn * | TBD | TBD | TBD | TBD | TBD |
| Tab memory at the prompt (PSS over the browser's own 410 MiB) | 2.2 GiB (the Desktop Demo) | 256 MiB (2026-11-20: 512 MiB of guest memory, 4 CPUs; 181 the day before) | 28 MiB (Arch; 845 peak in the restore); 355 MiB (Buildroot) | TBD | TBD |

The measured rows (the prompt, the bytes, `apk`, the memory): [bench/demo/REPORT.md](../bench/demo/REPORT.md) "DEMO loop 0" (2026-11-19, the dev VM, Chromium
155 headless, a fresh profile per run, medians of 3; `node bench/demo/run.ts`). They are the demos as shipped: ours
is the deployed Desktop Demo (Arch with sway, a first boot from a remote disk). The Alpine demo's numbers are
"DEMO loop 3" (a local build served offline through a modelled link) and "DEMO's end" (the deployed demos, single runs
of an ad-hoc check, not the bench's medians: so the rows aren't like for like with the peers' yet; backlog "A bench
target for the deployed demos").

The demos' goal (the DEMO track's, 2026-11-18): a `#` prompt within ~5 s of the click, at most ~30 MB with the page's
code; a target, not a gate (Alpine shipped either way). Buildroot was ruled out as the networked demo: it has no
package manager.

Our own numbers for context (Chromium 153, M4, [benchmarking.md](benchmarking.md) "Current numbers"): CoreMark 10,080
it/s in user mode (QEMU TCG natively: 12,500); 5,175 integer MIPS; Alpine boot to power-off 9.9 s; Buildroot 0.8 s;
AES-128-GCM 232 MB/s with the crypto extensions.

## 4. Where they lead

- **The first minute.** unkernel's demo answers a command at its prompt 1.7 s after the link, after 6.9 MiB (§3; Debian since 2026-11-20, Alpine at 1.3 s and 6.7 MiB the day before); our Desktop Demo, 31.7 s and 420 MiB. It installs the package for a missing
  command as you type it, keeps your changes across reloads, and has a network with nothing configured. v86's demos
  work in a similar way. Ours did open on an empty machine that asks for a disk; the demo store (frontend.md "The demo
  store") now starts the Alpine demo from a template snapshot, with the same install-as-you-type and the demo network
  (its numbers in §3).
- **Browsers:** unkernel runs on Firefox, Safari and iOS; we are Chromium first (decisions.md): Firefox runs smaller
  guests, more slowly and without some features (WebUSB), and making it steadier is in the backlog ("Firefox").
- **Memory:** a 48 MiB guest on a native-wasm kernel is smaller than any whole machine. Not a goal for us.
- **Syscall-heavy work:** unkernel's kernel is native wasm, so a syscall is a call, not an exception; WebVM's
  CheerpX has no guest kernel and answers Linux syscalls in its engine, likely cheaper than ours too (not measured). They claim fork
  and exit faster than native. Our process churn is the weak spot to measure (§3, fork + exec).

## 5. Draft copy

The introduction (frontend.md "The introduction") is where this copy went, 2026-11-20: its comparison's table and
[Where other projects beat waarm64](ui:intro:IntroCompare.leads) are §2's and §4's facts in the catalog's `intro` area, dated by `web/app/intro/compare.ts`
`CHECKED`. A change to §2 to §4 changes those words and that date in the same commit; the one speed figure the page
keeps (`web/app/intro/speed.ts`) are §3's Perl rows (bench/compare/REPORT.md, 2026-11-20). What follows is the draft
they were written from.


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

Comparison lines for a table on the site: "a whole arm64 machine, not i386 or user programs alone"; "a real kernel, not a wasm port";
"8 cores, not 1"; "OpenGL ES 3 and Vulkan, not a framebuffer"; "USB, mic, clipboard, shared folders"; "qcow2 in and
out". Always with a date and a link to this page's sources.

## 6. Sources

- unkernel: https://github.com/pithings/unkernel (README; `js/core/net.ts`, `net-wisp.ts`, `jit.ts`, `snapshot.ts`),
  https://unkernel.dev, https://registry.npmjs.org/unkernel/latest
- WebVM / CheerpX: https://github.com/leaningtech/webvm, https://cheerpx.io/docs/overview,
  https://cheerpx.io/docs/guides/Networking, https://labs.leaningtech.com/blog/cx-10 (32-bit, licensing, "5–10×
  slower than native"); BrowserPod: https://labs.leaningtech.com/blog/browserpod-40
- v86: https://github.com/copy/v86, its `docs/networking.md` and `src/browser/fake_network.js`; `docs/filesystem.md`, `src/sb16.js`, `src/browser/main.js` and the demo's page for sound and files (read at `315b2b0`, 2026-11-20)
- JSLinux: https://bellard.org/jslinux/, https://bellard.org/jslinux/tech.html, https://bellard.org/jslinux/faq.html (file upload, `export_file`); TinyEMU (its base, and its license): https://bellard.org/tinyemu/
- container2wasm: https://github.com/container2wasm/container2wasm; qemu-wasm: https://github.com/ktock/qemu-wasm
- Wisp: https://github.com/MercuryWorkshop/wisp-protocol (CC-BY-4.0)
- Ours: [graphics.md](graphics.md) "Testing" (dEQP), [benchmarking.md](benchmarking.md), [networking/](networking/adapters.md),
  [usb.md](usb.md), [machines.md](machines.md), backlog.md (Steam)
