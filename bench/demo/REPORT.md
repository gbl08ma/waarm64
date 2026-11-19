# A demo as a visitor meets it (docs/benchmarking.md; plans/first-demo.md)

How long a visitor waits for a shell, how much the page downloads first, and how much memory the tab takes, for the
others' demos and ours, measured the same way. The harness is `bench/demo/run.ts` (its header says what each number
is); the targets are `bench/demo/targets.ts`.

## DEMO loop 0: the gap (2026-11-19)

**Setup.** The dev VM (Lima vz on the M4 Mac mini, 8 vCPUs, arm64, openSUSE Tumbleweed), Chromium 155.0.8059.84
headless through Playwright (SwiftShader's WebGL2), through the Mac's home connection; no IPv6. Each run: a fresh
profile (empty HTTP cache and storage), the target's URL opened (the clock starts at the navigation: none of these
demos needs a click past its link), three runs per target in a row, one target after another. Commit 24185401 (no
emulator change). JSON: `results/demo-0/<target>.json` (each run's marks, bytes by host, memory; `summary` holds
the medians and IQRs).

**What each number is.**
- *Prompt*: ms from the navigation to the target's prompt on its console: a logged-in shell (unkernel, v86's
  Buildroot), a login prompt (ours: the machine's `running`, its ready marker), or, for v86's Arch, whose console is a
  canvas, nothing readable (see *command*).
- *Command*: ms to the answer of `echo ok-$((6*7))` typed at the prompt (after logging in as root on our Desktop Demo's
  serial terminal; on v86's Arch, typed on its screen and redirected to its serial port, read from the page's serial
  terminal). The first moment the visitor's typing does something: the comparable column.
- *Bytes*: received on every socket from the navigation to that mark (Chromium's net log: TCP's bytes with TLS and
  HTTP framing, short of TCP/IP headers; QUIC's packets; DNS), the page's hosts only. Chromium's own traffic (Google's
  autofill, update and sign-in hosts: ~45 KB a run) is apart in the JSON (`background`).
- *Memory*: PSS summed over the browser's processes (/proc's `smaps_rollup`), at the prompt and at its peak over the
  run (sampled every 500 ms). `blank` (about:blank) is the browser's own floor, **410 MiB PSS**; "tab" takes it off.
  RSS (which counts shared pages in each process) is in the JSON. `measureUserAgentSpecificMemory` is in the JSON too
  but not comparable: for ours it counts the reservations of the shared wasm memories (~24 GiB), not what's resident.

Medians of 3 runs (IQR in brackets):

| Target | Prompt (s) | Command (s) | MiB to the command | PSS MiB at the prompt (tab) | PSS MiB peak (tab) |
|---|---|---|---|---|---|
| **unkernel** (`unkernel.dev`: Alpine 3.24 riscv64, logged in) | **1.04** (0.18) | **1.30** (0.22) | **6.7** | 591 (181) | 769 (359) |
| v86 Buildroot (`?profile=buildroot`, i686, booted) | 3.51 (0.18) | 3.92 (0.17) | 5.5 | 765 (355) | 869 (459) |
| v86 Arch (`?profile=archlinux`, resumed from a saved state) | — (canvas) | 1.77 (0.03) | 15.3 | 438 (28) | 1,255 (845) |
| **waarm64 Desktop Demo** (vm.tny.im, a first boot of Arch from vmdisks.tny.im) | **27.8** (0.5), login prompt | **31.7** (0.4), logged in | **420.2** (6.1 the page, 414.1 the disk) | 2,593 (2,183) | 2,716 (2,306) |
| waarm64, Alpine's UEFI cloud image (`npm run dist` on localhost) | 48.4 (0.1), login prompt | — (root locked) | 78.7 (page and disk, uncompressed, to the prompt) | 1,250 (840) | 1,250 (840) |
| `blank` (about:blank) | | | 0 | 410 | 422 |

**`apk add python3` on unkernel** (the only guest that can out of the box): **7.7 s** (IQR 0.7) from typing it to
its marker, `python3` then printing; **17.8 MiB** through its Wisp server (`wss://wisp.pi0.io:6680`, counted under
its address in the JSON). The whole run, page to Python, was 24.4 MiB. Ours: no network out of the box (the demo
network is loops 7–10).

**Where our time goes.**
- *The Desktop Demo* (Arch, sway, a 1.95 GB image, remote-disk/REPORT.md R6's paced prefetch): 6.1 MiB of page (the
  core and the firmware, compressed by Cloudflare), then the firmware, GRUB, the kernel and systemd, to the serial
  login at 27.8 s with **414 MiB of the disk fetched** (the boot trace's prefetch runs far ahead of the guest by
  then). Logging in as root and the command take 4 s more. The tab: ~2.2 GiB over the browser's floor (the guest's
  RAM as touched, the JIT, the disk cache).
- *Alpine's cloud image* on the local build: the firmware on the console at 0.75 s, Limine at 4.3 s, the kernel's
  first line at 15.6 s (Limine's menu timeout, the kernel's and initramfs' reads), then **33 s from the kernel to the
  login prompt**: the cloud image's OpenRC boot, with tiny-cloud and DHCP waiting on an adapter that has no
  connection (a `?disk=` machine has none). The bytes are the local preview server's, uncompressed (the page's files
  hold the core, 9.6 MB, and EDK2, 3 MB, which Cloudflare sends compressed): not a deployment's number. Root is locked
  in the published image (tests/uefi.test.ts unlocks it with a seed disk), so no command.
- **There is no Alpine at a prompt on our page today, and no network.** The gap to unkernel, on what a visitor can
  open today (the Desktop Demo): **24× the time to a usable shell (31.7 s against 1.3 s), 63× the bytes (420 MiB
  against 6.7)**, ~12× the tab's memory. The plan's goal (≤ 5 s, ≤ 30 MB) is a snapshot restored onto a remote disk
  (loop 1's spike), which skips the firmware, the loader and the boot that are almost all of these seconds.

**What the others do (seen in these runs).** unkernel downloads one 10.9 MiB wasm (6.65 MiB on the wire) holding the
kernel and a 3.8 MiB root file system, makes a data disk in IndexedDB, starts Linux in ~0.25 s and a shell in under
a second; Wisp is connected from the start, and `apk` installs from `dl-cdn` through it. v86's Buildroot boots a
4.9 MB bzImage in ~3.5 s, with no network until `udhcpc` (over a relay); its Arch resumes a 14.8 MiB state (zstd)
at a root shell in 1.8 s, the root file system fetched file by file over 9p as used, network off until
`./networking.sh`. Their memory over the browser's floor: unkernel ~180 MiB at the prompt (a 512 MiB guest, touched
sparsely), v86 ~30–360 MiB, peaking at ~850 MiB during Arch's state restore; ours 0.8–2.2 GiB.

**Not measured here:** WebVM and JSLinux (comparison.md §3's other columns), the CPU workloads (CoreMark, xz, Python,
fork churn), and other hosts or connections: a visitor elsewhere gets other times, but the same bytes.
