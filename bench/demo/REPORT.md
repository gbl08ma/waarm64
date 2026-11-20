# A demo as a visitor meets it (docs/benchmarking.md; docs/decisions.md "Demos")

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

## DEMO loop 1: the spike, an Alpine template restored in a fresh profile (2026-11-19)

**What.** The plan's path to the goal (the DEMO track's loop 1): Alpine at a root prompt as a template snapshot, its
disk a chunked image, both hosted under the demos' layout (decision 17: one shared `pieces/`, a manifest per image and
one for the snapshot, the definition beside them), restored in a fresh Chromium profile with no network past this
computer. Target `waarm64-template` (bench/demo/targets.ts): the page as `npm run dist` builds it (Vite's preview on
127.0.0.1) and the site (bench/demo/site.ts, on localhost, CORS, `_headers`' caching), both counting what they send by
kind. The clock: the page loaded and idle (*ready*), then the **click** (the page's `?hooks` hook, what the store's card
will call: web/app/template.ts fetches the definition and the chunked snapshot, imports the machine, keeps the
snapshot, opens the machine, whose first start restores it), *made* (the hook's work done), *prompt* (the machine
`running`), *command* (`echo ok-$((6*7))` answered), *again* (then `apk --version` answered: a program the boot didn't
run, its ~5 MB read from the disk). **The link:** `DEMO_LINK=100/20` puts both servers behind one modelled link (100
Mbit/s shared, 20 ms before each request; bench/demo/site.ts `throttle`), the page's files at their brotli-5 size (as
Cloudflare sends them; the local server sends them raw), no TCP slow start. Dev VM, Chromium 155.0.8059.84 headless,
commit 3c60c7e9 plus this loop's changes (uncommitted at the runs; the page as committed). 3 runs each, medians (IQR).
JSON: `results/demo-1/` (each variant's runs; `template-*.json`: what each snapshot holds; `codecs.json`;
`served-iofdrop-100.json`: one run's responses in time order).

**The guest** (a stand-in until loop 3's image and loop 2's agent): Alpine 3.24.2's UEFI cloud image (tiny, Limine)
with root logged in on the serial console (`/bin/login -f root` in inittab), tiny-cloud, sshd and chronyd off, Limine's
menu without its 10 s wait (bench/demo/spike-image.sh, in Podman: debugfs and mtools on the partitions); 2 vCPUs, 512
MiB, 2D, one adapter with no connection (dhcpcd falls back to IPv4LL). The template: bench/demo/make-template.ts boots
it on the page from the site (23 s to the prompt), waits 5 s, keeps a snapshot, flags it as a template and chunks it.

**What a template is made of** (`template-*.json`, bench/demo/snapinfo.ts; MB = 10^6 bytes):

| Template | Snapshot | RAM (nonzero, raw) | RAM as stored (LZ4) | Overlay blocks (decision 18) | CPU state |
|---|---|---|---|---|---|
| as booted | 39.9 | 91.8 | 39.7 | 13 blocks, **7.5 KB** | 0.14 |
| caches dropped first (`echo 3 > drop_caches`) | 38.5 | 90.9 | 38.3 | 40 blocks, 29 KB | 0.14 |
| dropped and compacted (`compact_memory`) | 42.2 | 95.7 | 42.0 | 40 blocks, 29 KB | 0.14 |
| kernel with `init_on_free=1` | 32.2 | 79.1 | 32.0 | 15 blocks, 8 KB | 0.14 |
| **`init_on_free=1`, caches dropped** | **25.2** | 64.8 | **25.0** | 39 blocks, 29 KB | 0.14 |

- **Decision 18: the overlay's blocks are 0.03–0.1% of the snapshot** (8–29 KB: what OpenRC's boot of an
  already-made image writes, the logs, `/run`'s tmpfs aside), so the snapshot's disk side stays as it is.
- **The RAM is the download.** The guest uses ~50 MB (`free`: 29.5 MB used, 21 MB cache) of 468; the rest of the 92 MB
  was memory freed in small pieces (the initramfs once unpacked, the boot's temporary allocations) that free page
  reporting (whole 4 MiB blocks) never handed back, still holding its old bytes. Dropping the caches alone frees more
  of the same (no gain); compaction made it worse. **`init_on_free=1`** zeroes what the kernel frees, so the snapshot
  holds what's in use (−7.7 MB), and then dropping the caches counts (−7 MB more).

**Restored, click to a command answered** (MiB = 2^20 bytes; *page* is the brotli size, the local server sent 9.9 MiB):

| Template, link | Ready | Click → made | → prompt | → **command** | `apk --version` | Page | Snapshot | Disk by the command | **On the wire** | PSS at the prompt / peak |
|---|---|---|---|---|---|---|---|---|---|---|
| as booted, 100/20 | 0.22 s | 3.56 (0.02) | 4.48 (0.11) | **4.70 (0.13) s** | 1.03 s | 2.48 | 38.0 | 2.0 | **42.5 MiB (44.6 MB)** | 817 / 843 MiB |
| `init_on_free`, 100/20 | 0.34 s | 2.94 (0.07) | 3.84 (0.17) | **4.07 (0.20) s** | 1.10 s | 2.48 | 30.7 | 2.0 | **35.2 MiB (36.9 MB)** | 743 / 798 MiB |
| **`init_on_free`, dropped, 100/20** | 0.34 s | 2.34 (0.05) | 3.25 (0.15) | **3.49 (0.17) s** | 1.13 s | 2.48 | 24.0 | 4.0 | **30.5 MiB (32.0 MB)** | 711 / 760 MiB |
| the same, 50/20 | 0.34 s | 4.32 (0.03) | 5.52 (0.13) | **5.80 (0.15) s** | 1.58 s | 2.48 | 24.0 | 4.0 | 30.5 MiB | 702 / 764 MiB |
| the same, no link (localhost) | 0.17 s | 0.25 (0.01) | 0.56 (0.06) | **0.76 (0.06) s** | 0.52 s | 2.48 | 24.0 | 6.0 | — | 719 / 752 MiB |

- **Against the goal (≤ 5 s, ≤ 30 MB):** at 100 Mbit/s the time is met (3.5 s); at 50 Mbit/s it's missed by 0.8 s.
  **The bytes miss by 2 MB** (32.0 MB). unkernel (loop 0): 1.3 s and 6.7 MiB from its link; its tab peaks at 769 MiB
  PSS, ours at 760 (the browser's floor is 410).
- **Where the time goes** (one run's responses, `served-iofdrop-100.json`, 100/20): the page idle at 0.23 s; the
  click fetches the definition and the snapshot's manifest, then 12 pieces six at a time, done at 2.4 s (24 MiB at
  the link's rate: the time is the bytes); only then does the machine's start fetch **the core** (`waarm64_core.wasm`,
  9.65 MB raw, ~2 MB brotli'd: 2.6 → 2.9 s) and the disk's manifest; the restore reads **two disk pieces one after
  the other** (each a miss: a round trip and 2 MiB, ~0.3 s), running at 3.8 s; the shell answers 0.25 s later. The
  JIT's cold start after the resume is small at a shell: the first `echo` takes 0.2 s to answer (typing included),
  and `apk --version` 0.5 s on localhost (its pieces' reads are the rest at 100/20: ~1.1 s).
- **The JIT's code isn't in a snapshot** (platform.md), so every visitor compiles the shell's paths again; at these
  numbers that's not where the time is.

**What would close the gap, ranked** (by the bytes and seconds each removes at 100/20):
1. **The template's RAM frames packed with deflate instead of LZ4** (`codecs.json`, each 1 MiB frame packed alone, as
   the file does): the RAM 25.0 → **16.0 MB** (zstd-19 13.6, brotli-9 14.3, zstd-3 16.1). Deflate is what the browser
   unpacks natively (`DecompressionStream('deflate-raw')`; Chromium 155 has no brotli or zstd there) and the core
   inflates already (qcow2), so no dependency: a frame codec the reader takes beside LZ4, written by the publish step
   for templates only (the page's own snapshots stay LZ4: fast to write). **≈ −9 MB and −0.75 s: the whole download
   ~23 MB.** A host compressing the LZ4 pieces (brotli-5 per piece) would give 25.2 → 17.1 MB, but `.bin` isn't a type
   Cloudflare compresses, and that's a deploy-side unknown.
2. **The core fetched with the page or at the click,** not at the machine's start: its ~2 MB are on the wire anyway,
   but now serially after the snapshot (~0.3 s on the critical path, plus its compile).
3. **The resume's disk reads prefetched with the snapshot** (a trace from the resume, as remote-disk's boot traces:
   loop 3's "traced from the resume"): two dependent misses before the prompt (~0.6 s) and five by `apk --version`.
4. `init_on_free=1` in loop 3's image and dropped caches in loop 5's builder: measured above (−15 MB), to do there.
5. Smaller: the guest's RAM (512 → 256 MiB saves ~4 MB of `struct page`s raw, ~1 MB stored); the CPU state (0.14 MB).

**Settled in code this loop** (docs/machines.md §3.1, §5.2, §6.1; docs/remote-disks.md "Publishing an image"):
a chunked image's identity is its content (`{kind: 'url', chunked, bytes}`), so the template's pins and the
definition's disk match wherever the site is hosted (the template here was made against one port and restored from
another); a machine from a template restores it at its first start, with no question, its pins by slot forking onto
the machine's fresh overlays (tests/template.test.ts, tests/page-template-first.test.ts in a fresh profile); and the
site's one `pieces/` directory (`tools/chunk-image.ts --pieces`, `deploy/disks/_headers`).

## DEMO loop 3: the alpine-demo image, its template deflated (2026-11-19)

**What.** The demo's own guest (`images/build.sh alpine-demo`, docs/images.md): alpine-uefi's Limine image cut to
Alpine's base (alpine-base, e2fsprogs, linux-virt, Limine: 45 packages, ~75 MB used), root logged in on the serial
console, udhcpc, apk with `main` (community on demand), the command-not-found hook, the agent's OpenRC service, the
motd, `init_on_free=1`, Limine without its wait; a 1 GiB disk, `alpine-demo.qcow2` 73.0 MB (35 pieces of 2 MiB, 21
distinct). Its template by `bench/demo/make-template.ts` (now the demo builder's seed: boots on the page with
`?ready=guest`, waits for the agent's HELLO, which comes ~17–20 s after the start, clears the console to the motd, keeps
a snapshot with the agent dropping the guest's caches first, flags it as a template and **deflates its frames**:
`tools/snapshot-template.ts --deflate`). 2 vCPUs, 512 MiB, an adapter with no connection. Harness as loop 1's (target
`waarm64-template`, `DEMO_TEMPLATE=alpine-demo`, `DEMO_LINK=100/20`: 100 Mbit/s shared, 20 ms a request; the page's
files at their brotli size). Dev VM, Chromium 155.0.8059.84 headless, commit df7e54eb plus this loop's changes, the page
from `npm run dist`, a quiet machine. JSON: `results/demo-3/` (`template-alpine-demo.json`: what the template holds,
deflated and as LZ4).

**The template** (MB = 10^6 bytes): RAM 64.0 raw (nonzero pages), the overlay 76 blocks (0.3 MB raw, 19 KB stored: what
the boot wrote), the CPU state 1.2 raw.

| Frames | Snapshot | RAM as stored | CORE | DISK |
|---|---|---|---|---|
| LZ4 (the page's codec) | 24.6 | 24.3 | 0.14 | 0.03 |
| **deflate (codec 3, level 9)** | **15.7** | 15.5 | 0.13 | 0.02 |

A first build's ext4 left its inode tables to the kernel's lazy init, which wrote 3,653 blocks (15 MB of zeros) into the
template's overlay at the first boot: cheap in the file (34 KB) but 15 MB written into a visitor's OPFS at the restore.
mke2fs now writes them (`lazy_itable_init=0`, zeros: free in the qcow2 and the pieces).

**Restored, click to a command answered**, the same template as LZ4 (B) and deflated (A), alternated, two rounds of 3
runs each (medians, IQR; *on the wire*: the page brotli'd 2.5 MiB, the snapshot, the disk's pieces read by the command):

| Arm, link | Click → made | → prompt | → **command** | `apk --version` after | Snapshot | Disk | **On the wire** | PSS prompt / peak |
|---|---|---|---|---|---|---|---|---|
| A deflate, 100/20, round 1 | 1.55 (0.08) | 2.56 (0.18) | **3.04 (0.21) s** | 0.72 s | 15.0 MiB | 6.0 | **23.5 MiB (24.7 MB)** | 729 / 783 MiB |
| B LZ4, 100/20, round 1 | 2.25 (0.06) | 3.16 (0.11) | **3.69 (0.17) s** | 0.70 s | 23.4 | 9.6 | 32.1 MiB (33.6 MB) | 699 / 762 |
| A deflate, 100/20, round 2 | 1.52 (0.03) | 2.43 (0.08) | **2.91 (0.09) s** | 0.70 s | 15.0 | 6.0 | **23.5 MiB (24.7 MB)** | 711 / 784 |
| B LZ4, 100/20, round 2 | 2.22 (0.05) | 3.12 (0.10) | **3.59 (0.10) s** | 0.68 s | 23.4 | 6.0 | 32.0 MiB (33.5 MB) | 713 / 757 |
| A deflate, localhost | 0.19 (0.01) | 0.50 (0.01) | **0.70 (0.01) s** | 0.49 s | 15.0 | 9.6 | — | 728 / 767 |
| B LZ4, localhost | 0.23 (0.02) | 0.52 (0.04) | **0.73 (0.04) s** | 0.49 s | 23.4 | 9.6 | — | 724 / 755 |

- **Deflate: −0.65 s and −8.5 MiB at 100/20** (the arms' rounds don't overlap: 2.91–3.04 against 3.59–3.69), and no
  cost seen on localhost (0.70 against 0.73 s: inflating 64 MB at ~200 MB/s a thread, over the load pool's workers, is
  under the noise). Built (codec 3, docs/platform.md "The snapshot file"); the page's own saves stay LZ4.
- **Against the goal (≤ 5 s, ≤ 30 MB): met** — 2.9–3.0 s and 24.7 MB from the click (loop 1's spike: 3.49 s, 32.0 MB).
  unkernel (loop 0): 1.3 s, 6.7 MiB. The disk's pieces read by the command vary between 2 and 3 (4–6 MiB; 9.6 MiB
  with `apk --version` after): the restore's reads, which a prefetch from a trace would take with the snapshot.
- PSS: deflate's peak ~20 MiB over LZ4's (not looked into; the browser's floor is ~410).

**The command-not-found flow, checked by hand** (`bench/results/local/try-cnf.ts`, not committed: the template
restored in a fresh profile, its card on the local helper, so the real dl-cdn through this machine's network): the
motd and the prompt on the restored console; an address 10.5 s after `running` (busybox's udhcpc, its retries now every
~3 s: with its default 20 s pause it was 25–30 s, its LEASE renewal having come during the restore's link flap);
`python3 -c 'print(6*7)'` typed at the prompt installs python3 (16 packages, from main, the index fetched at first use)
and prints 42 in 4.3–10.3 s; `fastfetch --version` enables `community` and runs (4.8 s); a name no package provides
says so (127); `apk add lua5.4` 3.5 s. Not in CI: a test would need the network or a local signed repository (the
virt ISO's `apks/` would serve, with packages this image doesn't have: openssh, chrony, dhcpcd), left in backlog.md.

## DEMO loop 12: the desktop and 3D demos, resumed counting down to their app (2026-11-19)

**What.** Two demos of the Arch desktop image (`target/arch/desktop.qcow2`, the deployed Desktop Demo's: 944 pieces,
content id c25b9287…), 4 vCPUs, 2 GiB, 3D (virgl on WebGL2), sway at 1280×800, by `tools/build-demos.ts` from the
page's copy (`npm run dist` at 7687cf40 plus this loop's changes; its core routed into the build): **`arch-desktop`**
and **`arch-3d`**, each resumed with foot open and a script in it counting 10 s down to the demo's app (Firefox; the
shader demo, `gtk4-demo --run=shadertoy` with `GDK_DISABLE=offload`), so the app starts in the visitor's machine and
isn't in the snapshot (docs/remote-disks.md "A desktop"). Harness: targets `waarm64-desktop-template` and
`waarm64-3d-template` (the restored machine running and its screen like the snapshot's, `resume.webp`:
bench/demo/screen-like.ts; then a command on the serial console, root logged in there), `DEMO_LINK=100/20`, 3 runs
each, a fresh profile per run. Dev VM, Chromium 155.0.8059.84 headless, a quiet machine. JSON: `results/demo-12/`
(`template-*.json`: what each template holds).

**What the snapshot holds, by what the guest ran** (the template's file, deflated; MB = 10^6 bytes; the same image and
machine, built one after another):

| `arch-desktop` built with | Snapshot | RAM stored |
|---|---|---|
| Firefox and foot open | 287.8 | 273 |
| Firefox and foot open, kernel `init_on_free=1` | 250.9 | 236 |
| **foot open, counting down to Firefox** | **134.3** (131.6 on the checkout's core) | 131 |
| `arch-3d`: foot, counting down to the shader demo | **139.8** | 132 |

`init_on_free=1` (what loop 1 used on Alpine: the kernel zeroes what it frees, so the snapshot holds only what's in
use) took 13% off; not opening the app took 53%, without the kernel parameter, whose clearing of every freed page the
visitor's machine would pay for as long as it runs. Dropped.

**Restored, click to the desktop** (100 Mbit/s, 20 ms; medians of 3, IQR in brackets; MiB = 2^20 bytes):

| Demo | Click → desktop shown | → command | Snapshot | Page | Disk by the command | **On the wire by the desktop** | By the run's end | PSS at the desktop / peak |
|---|---|---|---|---|---|---|---|---|
| `arch-desktop` | **12.7 (0.2) s** | 13.0 (0.2) s | 128.1 | 10.0 | 6.0 | **140.2 MiB** | 268.5 MiB | 1341 / 1748 MiB |
| `arch-3d` | **13.2 (0.3) s** | 13.4 (0.3) s | 133.3 | 10.0 | 6.0 | **145.4 MiB** | 271.4 MiB | 1333 / 1767 MiB |

- **The snapshot is the wait:** 128 MiB at 100 Mbit/s is ~10.7 s of the 12.7. The rest is the page (~1 s) and the
  restore.
- **Then the app's files:** by the run's end (~25 s after the click) another ~125 MiB came from the disk, the
  countdown's app starting (Firefox's libxul, GTK and Mesa for the shader demo). A second command meanwhile
  (`pacman --version`, its pages read from the disk) took 11.6–11.8 s, queued behind those reads. On the local link
  (tests/page-demos-guest.test.ts) Firefox's window came 28.7 s after the click and the shader demo's 19.3 s, the count
  included. A boot trace of the app's start, prefetched behind the snapshot, would shorten that (backlog).
- **Is the screen the snapshot's** (bench/demo/screen-like.ts, the mean grey difference at 32×20, 0–255): a resumed
  desktop scored 0.1–0.2 against its `resume.webp`; another screen 22.8 (a text console) to 36.8 (black) and 99–136
  (the old Firefox thumbnail, a white page). The threshold, 12, sits in that gap. The two demos' resumed screens
  differ by 0.2 from each other (both foot and a countdown), which is why the cards' thumbnails are taken later, the
  app open.

## DEMO's end: the deployed demos, single runs (2026-11-19)

**What.** The demos as deployed (vm.tny.im and vmdisks.tny.im), checked from headless Chromium in the dev VM
(SwiftShader), a fresh profile per demo: the store's card → Start → running → a command on the serial console;
Alpine then `apk add python3` through the demo network; a desktop then its countdown's app's window in sway's tree.
**Single runs, not the bench's medians:** bench/demo has no target for the deployed store (backlog "A bench target for
the deployed demos"). The check: `bench/results/local/deployed-check.ts` (git-ignored, ad hoc). Times from the click.

| | 4e81858b (the second deploy) | 4eb078eb (the track's last deploy: fresh images, Alpine 3.24.4) |
|---|---|---|
| alpine-term: a command answered | 4.1 s | 4.3 s (running at 3.7 s) |
| alpine-term: `apk add python3` done | 13.7 s | 14.0 s |
| alpine-term: the terminal fitted, the guest's tty the same | 159×55 | 164×58 |
| arch-desktop: a command on the serial console | — | 12.6 s (the first visit after the deploy, the CDN cold); 3.5 s after |
| arch-desktop: Firefox's window | 56.3 s | 60.5, 43.2, 41.6 s; one run of four never showed it (the first, the CDN cold: only sway's bar on the screen after 189 s, foot's window not there either; not reproduced) |
| arch-3d: a command on the serial console | — | 6.3 s |
| arch-3d: the shader demo's window | 39.4 s | 39.6 s |
| virtio-gpu errors in the guest (both desktops) | 0 | 0 |

At 4e81858b also on the Mac (Chrome for Testing, Apple M4 through ANGLE's Metal): arch-desktop's Firefox at 42.4 s,
arch-3d's shader demo at 30.3 s, 3D on, no virtio-gpu error. The user ran all three by hand on their desktop's Nvidia
GPU (2026-11-19). Compared with the local numbers above ("DEMO loop 3", "DEMO loop 12": a modelled 100 Mbit/s and
20 ms link), the deployed Alpine answers ~1.3 s later: the real CDN and the demo network's connection.
