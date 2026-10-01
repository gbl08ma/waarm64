# Testing

Layered, cheapest first; `scripts/ci.sh` runs every layer and must pass before any piece of work
is done (not needed for a change that only edits docs: `.md` files or code comments). **`scripts/ci-net.sh`** runs the network tests on Debian (`net-guest`, `page-network`,
`net-tailnet`, ~4 min); it must pass too when a change touches the network (the gateway,
virtio-net, the Tailscale client, the Network menu, Debian's network command line). The rest of
the network's tests (`network`, `gateway`, `net`, `devices`) are in `ci.sh`. **`scripts/ci-long.sh`**
(~70 s alone) runs the heaviest multi-vCPU runs, which `ci.sh` leaves out or shortens for its time: the
parallel litmus and atomics stress under JIT-check, the JIT's at `-r 50` (`ci.sh` runs `-r 10`), and Node's Alpine on 4 parallel vCPUs
(Chromium's parallel Alpine boot stays in `ci.sh`). It must pass too for changes to the JIT,
parallel SMP, broadcast maintenance or the memory model, and at a milestone's end. **New behavior comes with tests at the cheapest layer that catches it.** Instruction
semantics need golden-corpus coverage; JIT changes must pass the differential test, lockstep
and the exact-step boots.

## Where each thing runs

| Layer | Runner | What it covers |
|---|---|---|
| Unit tests | `cargo test` (native) | decoder, ALU/flags, bitfields, FP core, crypto KATs, MMU walker, GIC, virtio rings, run loop, DTB, the JIT's structure (block formation, liveness, encoder bytes) |
| TestFloat | `scripts/testfloat.sh` | `fp.rs` against TestFloat 3e, every op and FZ/DN combination (51.2M cases) |
| Golden corpus | `core/tests/corpus.rs` (native interpreter); `tests/corpus-wasm.test.ts` (wasm: interpreter, JIT forced, JIT stress) | ~50,000 instruction tests with results from the M4 |
| JIT differential | `tests/jit-diff.test.ts` | JIT vs interpreter on random words per inlined class, from 8 random states each, plus multi-instruction sequences and region shapes (branches, loops) |
| Lockstep | `tests/jit-lockstep.test.ts` | the integer and FP guests (user mode) and the integer guest at EL1 (MMU off and on), JIT and JIT-stress vs interpreter, `Cpu` + RAM checksum every chunk; 20M steps per JIT case in CI |
| Core instances on one memory | `tests/threads.test.ts` (Node workers); `tests/browser.test.ts` (Chromium workers) | three concurrent instances (interpreter, JIT, JIT) with their own stack, TLS and table run the integer guest to the reference's exact state (M7) |
| JIT plumbing | `tests/jit.test.ts` | install, IC IVAU invalidation (also across chains), the stale-code checker, call/return chaining, tier-up |
| Bare-metal EL1 tests | `core/tests/baremetal.rs`; `tests/boot-node*.test.ts` (interpreter, JIT, JIT-stress) | exceptions, MMU, GICv3, timer, UART, SMP (4 vCPUs: CPU_ON, SGI ping-pong, per-CPU timers, CPU_OFF), broadcast maintenance (`maint`, 4 vCPUs: every TLBI …IS flavor, TLBI by ASID while the others run another ASID and against a global mapping, IC IVAU and IALLUIS on code the others run; its IC planted out, JIT-check's stale-code checker must trap), 128-bit atomics (`pairs`, 4 vCPUs: CASP and LDXP/STXP against each other and against plain stores to the same bytes), console input (`rx`, 2 vCPUs: a line through the PL011's RX interrupt while it waits in WFI with no timer; parallel mode needs `SIGNAL_RX` to wake it), the firmware configuration's CFI flash bank (`flash`: erase, word and buffered program, status, identifier and CFI query, as EDK2 drives it) |
| kvm-unit-tests | `core/tests/kvm_unit_tests.rs`; `tests/boot-node*.test.ts` | selftest (incl. smp), psci, gicv3-ipi, gicv3-active, timer, cache |
| Litmus and atomics stress (4 vCPUs) | `core/tests/litmus.rs` (interpreter: round-robin with exact steps, parallel); `tests/boot-node*.test.ts` (round-robin JIT with exact steps; parallel JIT and JIT-check); `tests/browser.test.ts` (parallel JIT); `scripts/tsan.sh` (parallel, small) | the memory model (no state herd7 forbids), LSE and LL/SC atomics, 128-bit CAS, futex wake-ups, spin-wait latency (M7) |
| Buildroot boot and device test | `core/tests/boot.rs`; `tests/boot-node*.test.ts`; `tests/browser.test.ts` | Linux boots, virtio console/rng/blk/net/9p/input, framebuffer, realtime mode, writable overlay, console input (`-- /bin/sh` reads 5.5 KB from the host at a fixed step: more than the RX ring; in parallel through a `MessagePort`) |
| LTP subset + arm64 kselftests | `core/tests/ltp.rs` (interpreter, each result against its table); `tests/boot-node*.test.ts` (JIT) | 93 syscall tests; `syscall-abi`, `ptrace`, `hwcap`, `tpidr2`, `tags_test`, signal tests |
| Crypto test kernel | `tests/boot-node*.test.ts` (JIT; interpreter with `WEBPC_INTERP=1`) | the arm64 CE drivers' full self-tests, lib/crypto's SHA KUnit suites |
| The firmware configuration (M8 phase B, [plans/uefi.md](plans/uefi.md)) | `core/tests/firmware.rs` (interpreter); `tests/boot-node*.test.ts` (interpreter, JIT); `tests/uefi.test.ts` (parallel JIT, realtime) | EDK2 (`images/build.sh edk2`) boots the UEFI Shell from `shell.img`, whose `startup.nsh` prints an EFI variable, sets it in the flash bank and powers off through `ResetSystem`; a second boot with the bank's bytes prints it (`edk2-shell`, `edk2-shell-again` in `tests/steps.txt`). Alpine's UEFI cloud images through EDK2 to a root login and a power-off, as the UEFI oracle does (Limine, GRUB; a NoCloud seed disk from `web/fat.ts`) with `WEBPC_DISTROS=alpine-uefi` (`images/build.sh alpine-uefi`): `rtc-efi`, the framebuffer above `/memory`, both vCPUs, and a virtio-net card on the echo gateway that Alpine brings up by itself (DHCP and DHCPv6/RA: both addresses, default routes, a ping each; N7) (the two boots side by side, ~55 s; Debian's platform checks are in `tests/page-debian.test.ts`). Planted: a flash program that doesn't stick (the flash unit test, `flash` check 11, EDK2's boot), fw_cfg's directory off by one (its unit test; the page test's timezone credential) |
| Distros | `core/tests/distros.rs` (interpreter: Alpine); `tests/boot-node*.test.ts` (Alpine, Alpine userspace, JIT); `tests/browser.test.ts` (Alpine, JIT); `tests/page-debian.test.ts` (Debian through UEFI on the page, parallel; Debian is never booted natively, interpreted or directly) | real distro boots from virtio-blk |
| Parallel SMP (a thread per vCPU, realtime: not reproducible, so repeated, every run must pass; `WEBPC_PARALLEL_RUNS`) | `core/tests/baremetal.rs` `baremetal_parallel` (every test, 5×), `core/tests/boot.rs` (Buildroot on 1, 2, 4 vCPUs), `core/tests/distros.rs` `alpine_smp` with `WEBPC_PARALLEL=1`; `tests/boot-node*.test.ts` (bare-metal under the JIT and JIT-check, kvm-unit-tests' SMP set, litmus and stress on 4, Buildroot on 2 and 4, Alpine on 4); `tests/browser.test.ts` (Buildroot on 4; litmus and stress on 4; Alpine on 4; the page's Debian on 2) | the vCPU workers, wake-ups, the platform lock, broadcast maintenance and the DSB wait (M7) |
| Pause and resume (`pause()`, [platform.md](platform.md) "Pausing a VM") | `tests/pause.test.ts` (Node; `WEBPC_PARALLEL_RUNS` repeats the parallel ones, taken at 10); `tests/browser.test.ts` (Chromium) | Buildroot on 4 parallel vCPUs (JIT) paused 25 times through its boot (every 30 ms and at console markers): the summed step counter stands still for 20 ms, the doorbell's served word equals its rung word, STOP is clear, the guest still ends as an unpaused boot does; a pause with the backends' service slowed by 10 ms (`Devices.prototype.poll` wrapped) never resolves while one is still serving; a pause with every vCPU idle at a shell prompt then input after `resume()` (a lost wake-up hangs it); a pause requested as the guest powers off (never hangs); `close()` while paused and while a pause is pending frees the VM (no worker left); round-robin pauses between runs leave `buildroot` and `buildroot-4cpu` at their exact steps; in Chromium (device worker) ~10 pauses through the 4-vCPU boot. Planted: `resume` not notifying the pause word, STOP left set at the resume, devices not settled before the pause resolves (the slowed-backends test: "resolved with a backend still serving") |
| ThreadSanitizer | `scripts/tsan.sh` (in `ci.sh`, ~20 s warm) | the native parallel runner under `-Zsanitizer=thread` (std rebuilt, `target/tsan`): the bare-metal tests 3×, Buildroot on 1, 2, 4 vCPUs, the litmus image on 4 (~1 min); any report fails, nothing is suppressed (guest RAM is accessed with relaxed atomics: [cpu.md](cpu.md) "Memory accesses and atomics"); a planted plain load is reported |
| Browser-only | `tests/browser.test.ts` | cross-origin isolation, the device worker, sync XHR ranges, OPFS, the canvas, DOM input, the spike page |
| The page ([frontend.md](frontend.md)) | `tests/browser.test.ts` (smoke test on the Buildroot guest, 2 parallel vCPUs, ~7 s; and the screen's dirty rows on a canvas) | the machine worker and its protocol, pixels written to `/dev/fb0` on the worker-drawn canvas, serial output to xterm.js and keys typed there to the shell, a key on the screen to `/dev/input/event0`, a held key released when the screen loses the focus, a Keys-menu chord (Ctrl+Alt+F12: order and release), the tablet through a scaled-down canvas (`/dev/input/event1`), a paste over 4 KiB (its md5), full screen, power off, Start, Restart while running (the disk overlay handed over); the page's messages (~4 s: served without COOP/COEP, xterm.js, the core or an image missing then Retry, a device reporting 1 GB then Start anyway, an overlay over another image then Reset disk); a guest panic (`?params=init=/nonexistent`) kept on show with the serial log copied and saved, the remembered view, a second tab refused the disk then Retry, a file kept over a restart and gone after Reset disk (~15 s); the overlay's hand-over (`tests/browser/overlay-worker.ts`, ~1 s: a second opener waits for the first's close, 20 holders terminated and the overlay opened at once, one held past the wait is in use) and six restarts in a row while the guest rewrites its disk, during the next machine's loading and booting, one a double click (~9 s; M8 loop 8) |
| The serial terminal's keys into EDK2 and GRUB | `tests/page-uefi-keys.test.ts` (`WEBPC_DISTROS=debian`, ~1.5 min) | arrows, Enter, Esc, F2, Ctrl-N/E/X, typing through xterm.js: GRUB's menu → "UEFI Firmware Settings" (the guest resets; the variable that asks for the setup survives the page's restart in the flash bank) → EDK2's boot menu and setup forms → Continue → GRUB's editor and command line → Ctrl-X boots the edited entry, whose `/proc/cmdline` has what was typed |
| Disk out ([frontend.md](frontend.md) "Your own disk") | `tests/qcow2-write.test.ts` (needs `qemu-img`), `tests/page-save.test.ts` (Chromium, Buildroot) | SHA-256 against node:crypto; the changes qcow2 (backing file, base hash) and the whole-disk qcow2 against `qemu-img check` and `compare` with the merged bytes, small and over several L2 tables and refcount blocks, and read back by our reader (planted: a block left out fails it); on the page, saving from a running machine downloads raw (the image's bytes), qcow2 (identical) and changes (valid, over the image) and the machine starts again |
| Changes in ([frontend.md](frontend.md) "Your own disk") | `tests/changes.test.ts` (Node, in-memory overlay; qemu-img/qemu-io for one case), the end of `tests/page-save.test.ts` and `tests/page-disk.test.ts` | the saved disk comes back through the overlay and replaces what it held; a changed base, size, a disk and a qcow2 from another tool are refused with the overlay untouched; qemu-img's own changes file (64 KiB clusters, zero cluster) reads; on the page, Buildroot loads its changes back and refuses a raw file, and a fresh profile's Debian plus the changes file saved from another-named copy boots with the file (the last phase of page-disk) |
| Your own disk on the page ([frontend.md](frontend.md) "Your own disk") | `tests/page-disk.test.ts` (with `WEBPC_DISTROS=debian`: two Debian boots and the changes-in boot, ~200 s alone; takes the Debian lock) | a qcow2 chosen with the picker boots through UEFI under its own overlay (`webpc-disk-<hash>`, flash beside it); its changes are saved (download and picker handle: same bytes, `qemu-img check`, backing file, base hash); after a reload the same file chosen again has the file written before (planted: an overlay name that changes per choice fails it) |
| The page on Debian, end to end ([frontend.md](frontend.md) "The end-to-end test") | `tests/page-debian.test.ts` (with `WEBPC_DISTROS=debian`: two Debian boots, ~1.5 min alone; `WEBPC_PAGE_RUNS=N` repeats it; it and the `npm start` run take turns through `tests/debian-lock.ts`; the ready marker's unit test always) | what a user does on the page's own VM (through UEFI, `tests/debian-unattended.ts`'s credentials over `?credential=`; the flash bank is saved beside the overlay): Debian on 2 parallel vCPUs from a fresh profile reaches `running`; root logs in on the serial terminal (xterm.js to the PL011), waits there for tty1's `login: ` in `/dev/vcs1`, then logs in on the **screen** (keys on the canvas through virtio-input) and runs a command that writes a marker to `/dev/ttyAMA0`, read back on the serial side; tty1's text (`/dev/vcs1`) shows the prompt and the command, and the canvas isn't black; the platform the firmware gave Linux (`rtc-efi`, the framebuffer, `/sys/firmware/efi`, both vCPUs, a credential read back from fw_cfg and the timezone systemd-firstboot set from it); a file written and synced is there after a reload (no shutdown). Reset disk is the Buildroot page test's (`tests/browser.test.ts`) |
| Snapshots on the page ([frontend.md](frontend.md) "Snapshots") | `tests/page-snapshot.test.ts` (Buildroot always, ~10 s; Debian with `WEBPC_DISTROS=debian`, ~2 min alone, takes the Debian lock) | Save snapshot (download and picker handle; the machine runs on), Load snapshot in a fresh profile (a shell variable, a devtmpfs file, the terminal's tail, the snapshot's vCPUs; Debian: logged in, the disk's file read past the page cache, the flash copy beside the new overlay, a write and a reload after), a snapshot dropped like a disk, the refusals with the disk untouched (not a snapshot, another machine, another disk, devices the page can't make, truncated; Start recovers). Planted: no resume after a save, no flash rewrite, no overlay replacement, a terminal reply to the replayed tail each fail it |
| The network on Debian ([frontend.md](frontend.md) "Network") | `tests/network.test.ts` (the page's controller and parsers, a fake client; always), `tests/net-guest.test.ts` (with `WEBPC_DISTROS=debian`: the page's Debian with a card on the echo gateway configures itself from its command line and pings any address over IPv4 and IPv6, and takes a late lease in both families, ~3 min), `tests/page-network.test.ts` (the Network menu against an unreachable control server: form errors, the card, the key not kept, Disconnect, a reload; ~4 min), `tests/net-tailnet.test.ts` (Debian on a headscale tailnet: DHCP lease = the client's address, ping (v4 and v6) and MagicDNS to a peer, the peer reaches a server in the guest over both; then, **opt-in with `WEBPC_TAILNET_INTERNET=1`** (it needs the real internet; skipped loudly otherwise; passed 2026-10-01, ~100 s whole test), the peer as the exit node: the internet (1.1.1.1, example.com) and DNS through it. Its targets must be public: Tailscale's exit nodes never forward RFC 1918, CGNAT or link-local destinations, their own LAN included. The dev VM's LAN address failed as a stand-in for the internet (curl exit 28). Needs Podman, Go or `target/net/tailscale.wasm`; `scripts/ci-net.sh` sets `WEBPC_TAILNET=1` when Podman is there, ~2 min) | the gateway's bytes are `tests/gateway.test.ts` and `tests/devices.test.ts`; these test what the guest and the page do with them. The Debian ones take turns through `tests/debian-lock.ts` |
| `npm start` ([frontend.md](frontend.md) "`npm start`") | `tests/start.test.ts` (the checks: ms; the run: ~5 s, with `WEBPC_DISTROS=debian`) | the Node-version and rustup messages (an old Node faked with `--import`; a `PATH` with Node alone), the npm staleness rule, the core's input hash; then a copy of the repository as a clone has it (tracked and untracked files, no `node_modules` or `target/`) runs `npm start` (PORT=0, Debian from this checkout's download cache): `npm ci`, Debian prepared (its kernel and initrd identical to this checkout's), the URL printed, the page boots it in Chromium until the guest's console takes the screen, and a second start with nothing to do takes < 5 s (~0.1). The copy gets this checkout's core and a matching stamp; **`WEBPC_START_COLD=1`** makes it build its own (the whole path a user takes; run it when `start.ts` or the build changes) |
| Host code | `tests/{devices,overlay,qcow2,ext4,fat,serve,wasm-encoder,core-wasm,memory-kernels}.test.ts` | 9p server, loopback adapter, input config, overlay, qcow2 fixtures, the FAT12 writer (its layout; `fsck.fat` and mtools read it back, where installed), the ext4 reader and partition tables (`tests/ext4/make.sh`'s fixtures against their manifest), the dev server (ranges, the page, the `node_modules` allow-list), the encoder |
| Snapshots: the core's state ([platform.md](platform.md) "Snapshots") | `cargo test` (unit: `vm/tests.rs`, `virtio/tests.rs`, `cpu.rs`); `core/tests/boot.rs`, `core/tests/distros.rs` (`Boot::snapshots`: the VM saved, dropped and restored into a new one on a copy of RAM at given steps) | unit: a machine with a timer, console output and a device (one chain answered, one held) saved at each of 300 consecutive steps and restored runs on to the unsaved machine's registers, steps, console and RAM, and saves the same bytes; WFI and idle; refusals (another version, each configuration word); every prefix refused and every byte changed in turn refused or run without a panic; the pinned bytes of a fixed machine (a layout change needs `snapshot::VERSION` bumped); the realtime clock continuing and the RTC showing the new host's time; a transport's in-flight chains posted again in order, and states that can't be. Natively, with the steps of `tests/steps.txt` and an unbroken run's console: Buildroot through 28 saves on 1 vCPU and 12 each on 2 and 4, the device test through 40 (net's 256 receive buffers held, 9p and the disk mid-conversation), console input with bytes waiting in the RX ring, Alpine through 8. Planted: a register not restored, a queue's used index not restored, an in-flight chain not posted again (each fails the unit tests and the boots). **Parallel mode** (the VM saved between runs of its vCPU threads, every thread out of the core, and a new one restored): unit (a CPU_ON request not yet taken, WFI, an off vCPU, and the same realtime state restored under the other run mode; a fired timer's line and a device interrupt raised by the save itself reach the restored vCPU); `core/tests/baremetal.rs` (every test through snapshots at growing intervals, round-robin and parallel), `core/tests/boot.rs` (Buildroot on 1, 2, 4 threads, ~27 saves a boot), `core/tests/litmus.rs` (litmus and the stress through 12 saves round-robin with exact steps, and in parallel), all under ThreadSanitizer too. Planted: the realtime counter not rebased, a restored vCPU's timer lines not taken from the GIC, the IRQ lines not published after a restore (each fails its unit test; a Buildroot boot notices none of them: Linux rides out a counter that steps back) |
| A VM through snapshot files (the host: `web/vm.ts` `snapshot()`/`restore`, `web/snapshot.ts`, `web/lz.ts`) | `tests/snapshot.test.ts` (Node, JIT; Alpine's userspace benchmark with `WEBPC_DISTROS=alpine-user`); `tests/browser.test.ts` (Chromium: the device worker's backends) | the VM saved to a file, closed and a new one started from the file, several times in a run. Round-robin, with the steps of `tests/steps.txt` and an unbroken run's console: Buildroot through 9 files; on 4 vCPUs through 6 with the tier changing at each (interpreter, JIT, JIT-check); console input with 4 KiB in the RX ring and the rest queued in the host; input and net devices' held buffers; Alpine's userspace benchmark (1 GiB) through 3 (`alpine-user-snapshots`: a restore empties the TLBs, [platform.md](platform.md) "Snapshots"; `core/tests/distros.rs` `userspace_through_snapshots_is_the_run_with_tlb_flushes` shows natively that this is all the difference, on demand, ~2 min); a VM started from a file saves the same core bytes and backend state. Parallel (paused, saved, closed, new workers): Buildroot and litmus with the stress on 4 vCPUs in Node, Buildroot on 4 in Chromium. Refusals: another machine (vCPUs, RAM, devices, features), another state version, a truncated file, a cut state; a 9p device. **The disk in the file:** a boot that writes a file to its root filesystem is saved after the write; from the file, over the overlay as later writes left it and over none at all (a fresh profile), the machine finishes in the unbroken boot's steps and the next boot finds the file (Node, in-memory overlays; Chromium, OPFS, through four files in one boot); another disk, a file cut or damaged in its disk blocks, and a machine without the disk are refused with the overlay untouched; the base's hash is asked for only when the cheap identity differs. Planted: the rng's position not restored, pending serial input not restored, the config spaces overwritten after a restore, the overlay's blocks left out of the file |
| Snapshot file | `tests/snapshot-file.test.ts` | the snapshot container (`web/snapshot-file.ts`, [plans/snapshots.md](plans/snapshots.md)): CRC-32 against zlib's, round trips of every frame kind (RAM from a shared-memory view at an odd offset), 1-byte, random and Blob input, writer back-pressure and order, every refusal with its `problem`, truncation at every prefix and a flipped bit at every byte of a small file, the stored and a pluggable codec. Node only, ~3 s; buffers are compared with `sameBytes`, never `assert.deepEqual` (a diff of two RAM-sized arrays exhausts memory) |
| Decoder sweep | `core/fuzz` (not in CI) | every 2³² word vs Capstone |
| virtqueue fuzzing | `cargo fuzz run virtqueue` (not in CI) | the transport and split-queue parser |

Rules behind that matrix:
- **Interpreter runs of long guests happen natively** (Rust release builds are fast and need no
  engine): Buildroot, the device test, LTP and Alpine. Node runs the **JIT** on every guest and
  the interpreter only on the short ones (where the JIT run must print exactly the interpreter's
  console). Chromium tests what only a browser has, plus JIT boots of the distros. **Don't boot
  complex guests under the interpreter in Node or Chromium**: it costs minutes and tests nothing
  the native run doesn't.
- `WEBPC_DISTROS` (comma list: `alpine,alpine-user,debian,alpine-uefi`) picks the distro tests; `ci.sh`
  defaults to the current images of all. **Debian boots only in Chromium, through UEFI under the JIT**
  (~45 s alone: the page tests); it has no direct-kernel, native or Node boot (dropped when UEFI
  became the production path: the direct boot's tests and its `boot_debian_jit`/`smp_debian_jit`
  benchmarks timed only a boot, which the page tests' logs show). **Make each Debian boot count:**
  a boot is the expensive thing, so a Debian test checks what it can on the boot it has.
- **Debian boots in `ci.sh`** (reviewed at the end of M8 phase B; the Debian tests take turns through
  `tests/debian-lock.ts`, so each boot adds to the wall time): `page-debian` 2 (login on both
  consoles and the platform checks; a reload), `page-disk` 3 (a chosen file; the same file chosen
  again; a fresh profile with a changes file), `page-uefi-keys` 1 (two firmware/GRUB starts first;
  Debian's GRUB passes `quiet`, so the kernel's own echo of its command line can't be waited for), `start.test.ts` 1 partial (until the console takes the
  screen, ~3 s after the URL). The rest is not repeated on Debian: Reset disk, a file kept over a
  restart and the overlay hand-over are Buildroot's (`tests/browser.test.ts`), the deterministic
  and one-vCPU JIT are Buildroot's and Alpine's. The network tests' Debian boots are
  `ci-net.sh`'s. **CI's wall time:** Node runs test files in parallel and a file's tests in
  sequence, so the long files set it. The Node boots are one suite (`tests/boot-node-suite.ts`)
  in four files that pick their tests by name (`tests/boot-node*.test.ts`: ~280 s in one file
  before). `ci.sh` runs the native guest-image tests (~130 s) beside `npm test`, not after it.
- Guest-image tests skip loudly when `target/images/<name>` is missing or stale
  (`images/build.sh --check`).

## Step counts

**Every deterministic guest takes the same number of steps (instructions retired plus exceptions
taken) natively, in Node and in Chromium, under the interpreter and the JIT**, on N vCPUs too
(deterministic round-robin: `buildroot-2cpu`, `buildroot-4cpu`). The guest images'
counts are in `tests/steps.txt`, read by every runner (`core/tests/common` `steps()`,
`tests/steps.ts`). A mismatch is a bug unless the change is guest-visible; then the counts move
**once**, in the same commit, with the reason in its message. Guest-visible changes so far: ERET
ending the chunk (M6), the crypto extensions advertised (M6.5), the GICv3 as the default GIC and
its driver in the test kernels (M7).

Realtime runs and the rw-overlay boots aren't step-exact.

## The golden corpus (`tests/corpus/`)

- **Oracles:** QEMU user mode (`qemu-aarch64`, installed in the dev VM) for day-to-day growth, and
  **real hardware, authoritative:** the Lima VM `oracle` on the M4 Mac mini (Debian 13 arm64, 4
  vCPUs, 8 GiB, 60 GiB, 4K pages; created with `limactl create --name=oracle --vm-type=vz --cpus=4
  --memory=8 --disk=60 --plain template:debian-13`), reached with `ssh macmini.lan
  /opt/homebrew/bin/limactl shell oracle <cmd>`. EL0 code runs natively there. The corpus is
  re-validated on it whenever it grows or QEMU and we disagree. The oracles are only needed when
  the corpus grows; CI compares against the committed files.
- **Format (`webpc-corpus 1`):** `tests/corpus/<group>.txt`, line-oriented. Each test has `code`, a
  `seed` (splitmix64 expands to X0–X30, SP, NZCV, the 8 KiB data region, then V0–V31 as low/high
  u64 pairs; FPCR and FPSR start at 0), `in` overrides, then the oracle's `out` (changed registers,
  `v0=0x<32 hex>`, `fpcr=`, `fpsr=`), `mem` (changed bytes) and `exit` (`end`, or
  `sigill`/`sigbus`/`sigsegv`/`sigtrap` with PC offset, `si_code` and fault address). `note qemu: …`
  records a QEMU result that differs from the M4's. New keys are additive; anything else bumps the
  version. Fixed VAs: code at `0x100000` followed by `brk #0`, data at `0x200000`, harness at
  `0x400000`.
- **Tooling:** `tests/harness/harness.c` (static, freestanding; state loaded by an asm trampoline
  including FPCR/FPSR/V0–V31, dumped from the signal `ucontext` and its `fpsimd_context` on an
  alternate stack), `tools/corpus/gen.ts` (deterministic generator), `tools/corpus/run.ts` (runs
  the oracles and writes the golden files: `node tools/corpus/run.ts [--oracle qemu|m4|both]
  [group…]`), `core/tests/corpus.rs` (the comparator). `WEBPC_CORPUS=<groups>` filters the wasm run.
- **Groups:** branch, dp_imm, dp_reg, ldst, excl, lse, sys, fp_scalar, ldst_fp, simd_same,
  simd_diff, simd_fp, simd_misc, simd_move, simd_perm, simd_shift, crypto.
- The generator avoids CONSTRAINED UNPREDICTABLE and IMPLEMENTATION DEFINED cases (e.g. `LDP`
  with `Rt == Rt2`, writeback with `Rn == Rt`), where the oracles legitimately disagree.
- **Known oracle behavior** (the generator avoids it):
  - Both oracles implement **FEAT_LSE2**: misaligned exclusives, LDAR/STLR and LSE atomics only
    fault across a 16-byte granule. We keep the v8.0 rule (wasm atomics need natural alignment
    anyway).
  - QEMU's `max` CPU has MTE (`ADDG`/`SUBG`, `STGP` execute); the M4 raises SIGILL, as we do.
    QEMU's `DC ZVA` block is 512 bytes; the M4's and ours 64.
  - **Apple's hypervisor filters ID registers** but the M4 guest still runs v8.x/v9 features we
    leave out: PAC (`paca pacg`: `PACIASP` really signs, where we NOP), BTI, `sb flagm2 frint i8mm
    bf16 afp dit`, `lrcpc ilrcpc dcpop dcpodp flagm uscat sha3 sha512 asimddp asimdrdm fphp
    jscvt fcma`, FP16 (incl. FP16 FMOV and fixed-point conversions with immh = 001x), BF16 (BFCVT
    is the FCVT encoding with ftype 01, opc 10), FHM, RDM, DotProd, I8MM, FCMA, JSCVT, FRINTTS. The
    generator emits none of them.
  - Corpus depth: some FP flag paths are thin (only 8 `fp_scalar` tests raise Divide-by-Zero).

## System-level oracles

- `qemu-system-aarch64 -M virt,gic-version=2` (TCG) for behavioral comparison, and Homebrew QEMU
  (11.1) on the Mac with `-accel hvf` for real Apple hardware at EL1 (MMU, exceptions; devices are
  QEMU's). The Sail ARM model for disputed corner cases.
- **Findings:** QEMU TCG raises no SP alignment faults (hvf does, as do we); QEMU under hvf makes
  unassigned PAs RAZ/WI (TCG aborts, as do we); HVF can't emulate a GICv2 (moot since we dropped
  ours). **hvf does give a GICv3** (`-M
  virt,gic-version=3`): kvm-unit-tests' `gicv3-ipi`, `gicv3-active`, `selftest-smp`, `psci` and
  `timer` pass there at 4 CPUs. **It's Apple's in-kernel vGIC** (the default, and with
  `kernel-irqchip=on`): its `GICR_TYPER` reads 0 through 32-bit halves, QEMU's own model
  (`kernel-irqchip=off`) doesn't, so the interrupt controller has a hardware oracle.

- **The UEFI oracle** (`tools/uefi-oracle.ts`, M8 phase B; [plans/uefi.md](plans/uefi.md)): our
  EDK2 build (`images/build.sh edk2`) on `qemu-system-aarch64` set up like our machine
  (ArmVirtQemuKernel via `-kernel` with QEMU's DT minus PCIe, the platform bus, the PMU, the PL061
  and its `gpio-keys`, the ITS and the seeds; the variable store in flash bank 1; virtio-mmio disks;
  Cortex-A57), booting `debian`, `alpine` (Limine) and `alpine-grub` unmodified to a root login
  and a power-off, with each stage's time. Dev-only (needs `qemu-system-aarch64`, `dtc`,
  `mkfs.vfat`, `mcopy`), not in CI. `node tools/uefi-oracle.ts debian alpine alpine-grub`: ~30 s
  for all three at once under TCG. **Finding:** QEMU's `kaslr-seed` in `/chosen` made Debian's
  boot 1.8× slower under TCG (backlog "No `rng-seed` in the DT"), which first looked like DT
  vs ACPI; without it they're equal.

## Bare-metal tests (`tests/baremetal/`)

`start.S` (stack, vectors calling `on_exception(frame, vector)`, FP on, `run_el0()` to drop to EL0
and come back through SVC #1) plus one C file per test (all on a GICv3, `lib.h` `gic_init()`; `// smp: N` boots N
vCPUs, on the oracles too; `// qemu-cpu: <model>` replaces TCG's Cortex-A57, e.g. `max` for LSE; `// flash` runs it in the firmware configuration, for its flash bank (the oracles attach an erased bank 1); `// input: <text>` is typed on
the serial console once the test waits: at its first idle in round-robin, once it printed `ready` in parallel, after a
second on the oracles), built with host clang and lld by
`build.sh` into committed flat `.bin`s loaded at `0x4000_0000`. Pass = PSCI SYSTEM_OFF with
x1 = 0; `power_off` also prints `exit <code>`. `oracle.sh` runs the `-DORACLE` builds
(implementation-specific checks left out) on QEMU TCG, `oracle.sh --hvf` the `-DORACLE -DHVF`
builds on the Mac (`gic-version=3`: Apple's in-kernel vGIC); every test runs on both. Left out
of the HVF build: two `gicv3` checks that are ours and QEMU's but not Apple's
(`ID_AA64PFR0_EL1.GIC`, `GICR_ICFGR0`: [platform.md](platform.md) "The GIC"), and `smp`'s second
CPU_ON (QEMU's PSCI races it against the target's start: another answer ~1 in 5 under hvf; TCG failed
its check 4 once in 6 runs on a loaded VM, M8 loop 1). Tests mustn't rely on
UNKNOWN or IMPLEMENTATION DEFINED reset values and must pick addresses unmapped on `virt` too (its
flash covers `0x0`–`0x0800_0000`). **Rebuild all of them together** when one changes (different clangs build different bytes;
they were last rebuilt together on the M4 VM in M8 loop 8, when only `timer.bin` changed and the others came out identical).

**Host stalls (`tests/hoststall/`, `tests/hoststall.test.ts`):** `stall.c` builds four 2-vCPU
guests (`build.sh`: `stall-run|install|idle|waiter.bin`, committed) that cooperate with a test-only
hook in a vCPU worker (`BootOptions.stall`, web/vm.ts `Stall`) through a word in RAM: vCPU 1 arms it,
the hook blocks that worker (`Atomics.wait`), vCPU 0 then runs TLBI IS + DSB. Real workers in Node,
parallel, JIT, the real 10 s DSB limit (no ABI for lowering it). Stalled in the core's clock import
(between chunks) or in `jit_install` (mid-chunk), the vCPU is RUN: the wait ends at 10 s with the
panic report as the error (state 1, applied, retired and PC frozen, the waiter's timing line). Stalled
after `vm_run_cpu` returned IDLE (OUT), the DSB doesn't wait. With the *waiting* vCPU's worker
stalled 11 s inside its wait while vCPU 1 is healthy (frozen 13 s), the wait doesn't panic: it counts
waiting, not its own stalls (`DsbBudget`, unit-tested in `core/src/vm/tests.rs`). ~40 s in all.
These guests aren't in `tests/baremetal/`, so the generic bare-metal runners and the oracles skip them.

**Realtime windows:** in parallel mode the counter follows the host's clock, so a test can't
assume the host keeps its vCPU running for any stretch. `timer.c` retries its "not expired yet"
check (a 1 ms `CNTV_TVAL`, up to 100 times: a host that deschedules the vCPU between the write
and the read made it fail, twice in one M8 loop 6 CI run under two Debian page boots) and bounds
the CVAL written through TVAL by the counter read before and after (it was a fixed 10 ms
window). Under the load that broke it (both Debian page tests at once beside the rest of
`npm test`, `tests/debian-lock.ts` bypassed) the old and new binaries alternated in a loop:
see bench/boot/REPORT.md "M8 loop 8". Bare-metal tests have no entry in `tests/steps.txt` (the
deterministic runners compare the JIT's steps with the interpreter's), so nothing moved there.

## kvm-unit-tests

Commit `5a221342a025`, booted with one CPU and 256 MiB; `EXIT: STATUS=` from the UART. Every
`unittests.cfg` entry is run or skipped with a reason, and the runner fails if a new one appears.
Pass: `selftest-setup`, `selftest-smp`, `selftest-vectors-kernel`, `selftest-vectors-user`,
`psci` (with the concurrent cpu-on check enabled), `gicv3-ipi` and `gicv3-active` (4 vCPUs),
`timer`, `cache`. Skipped: `gicv2-*` (no GICv2), `its-*`, `pmu-*`, `pci-test`, `micro-bench`, `fpu-context` (KVM only), `debug-*`,
`mte-*`; `sieve` (not in `unittests.cfg`; too slow interpreted).

**The SMP set on QEMU TCG** (11.1, `-M virt,gic-version=3 -cpu max -smp S`), the oracle for M7:
`selftest-setup` (smp 2), `selftest-smp` (4 and 8), `gicv3-ipi` (4, 8), `gicv3-active` and `psci`
(4) pass. `psci` skips its concurrent cpu-on check unless the environment (passed as
an initrd, `ERRATA_6c7a5dce22b3=y`) enables it; enabled, QEMU fails it (several CPUs racing to
start one target must get ALREADY_ON or ON_PENDING).

## The JIT's tests

- **Differential** (`tests/jit-diff.test.ts`): `WEBPC_JIT_DIFF=<n>` words per class. Classes seed
  FP with NaNs, denormals, infinities, zeros and FPCR/FPSR states, and crypto with the FIPS
  vectors' states a third of the time. Flat bus only (the MMU path is lockstep's and the boots').
  A new class shifts the shared seed for later classes: a failure elsewhere may be harness state.
  It caught all three rustc/LLVM `simd128` miscompiles.
- **Lockstep:** `WEBPC_LOCKSTEP_STEPS=300000000` for the long run, done at the end of every loop
  that touches semantics (stress runs a tenth).
- **JIT-stress** (threshold 0, batch 1, a 4-region cache, tier-up after one entry, the stale-code
  checker) runs in CI on the bare-metal tests, kvm-unit-tests `cache` and the corpus.
  `WEBPC_JIT_STRESS=1` runs every Node boot under it (hours with LTP and Alpine). **The long
  stress runs aren't routine**: they ran once at M5's end (Alpine 4.25 h, LTP 2.9 h) and found
  nothing the short runs, the differential test and the exact-step boots hadn't. Run them only
  when a change targets eviction or invalidation; for coverage per minute prefer short variants
  (a tiny cache with the default threshold, compile-on-sight with a big cache, tier-up after one
  entry).
- **JIT-check** (`VmConfig.jit` 3: compile on sight into the full-size cache, with the checker)
  finds stale blocks JIT-stress's 4-region cache evicts before they're entered again; the `maint`
  test uses it (code rewritten by another vCPU).
- **Planted bugs:** every new emitter rule gets deliberately broken once (a carry, a condition, a
  write-back, a fusion taken when the registers differ, a swapped swizzle operand, …) and the
  tests must fail. After a planted-bug experiment, restore the source **and rebuild the wasm**,
  and check the build actually compiled before trusting a "caught" result. Every real bug found
  gets a regression test.

## Decoder sweep (`core/fuzz`)

A separate workspace, so Capstone never reaches the core's builds. `cargo run --release --bin
sweep` (from `core/fuzz/`) runs every 2³² word on a scratch vCPU (no panics) and compares "valid
instruction" with Capstone 5.0 (~3 min); `sweep -- sys` covers the system space
(`0xd500_0000..0xd540_0000`) at EL1 in seconds: a register Capstone names must work unless its
feature is one we leave out (`SYS_NOT_OURS`), an unnamed one must be UNDEFINED except the ID space
(reads as zero). `core/fuzz/src/check.rs` lists the expected differences (features we leave out,
CONSTRAINED UNPREDICTABLE encodings Capstone rejects, should-be-one fields the M4 ignores). Both
report 0 mismatch classes. Not in `ci.sh` (it builds Capstone from C): rerun it when the decoder
changes. `cargo fuzz run decode` (from `core/`) is the libFuzzer target.

## Litmus tests (`images/build.sh litmus`, M7)

herdtools7's tools, built and run in the images container ([images.md](images.md)): 42 tests
from our own list of cycles (`images/litmus/tests.txt`), each with herd7's allowed final states
under `aarch64.cat`. `run.sh` runs each program and **`check.awk` fails a test if it observes
any final state herd7 doesn't allow** (the general form of "forbidden outcomes never appear");
each test prints `litmus: <test> ok model=<herd7's verdict on its condition> seen=<litmus7's
observation>`. A test with more threads than the machine has CPUs prints nothing and counts as
skipped (on one vCPU only `CoRW1`, `CoWR`, `CoWW` run).
- **The M4 reference** (`tests/litmus/m4-reference.txt`: the oracle VM, 4 vCPUs, 10⁸ outcomes
  per test): no forbidden outcome; 16 of the 20 allowed relaxations appear (R and SB ~60–70 per
  million, MP ~47, IRIW 1.5, WRC 0.1), never `LB`, `2+2W+dmb.sy+po`, `S+dmb.sy+po`. With
  litmus7's default settings the M4 showed almost nothing (SB never in 2M): the image uses
  herdtools7's Arm settings (stride 1, `userfence` barriers, `incr0` affinity, 5k × 200).
- The checker was checked by removing SB's allowed states (it fails, listing each state).
- **In CI, every mode and tier** (4 vCPUs; `webpc.litmus=` options, then the stress's):

  | Runner | Mode, tier | Litmus, stress | Time |
  |---|---|---|---|
  | `core/tests/litmus.rs` | round-robin, interpreter (steps: `litmus-4cpu`) | `-s 100 -r 1`, `-n 20000` | 9 s |
  | `core/tests/litmus.rs` | parallel, interpreter | `-s 1000 -r 10`, `-n 100000` | 12 s |
  | `tests/boot-node*.test.ts` | round-robin, JIT (the same steps) | as the interpreter's | 3.4 s |
  | `tests/boot-node*.test.ts` | parallel, JIT / JIT-check | `-s 1000 -r 10` (`-r 50` in `ci-long.sh`), `-n 100000` / `-s 100 -r 2`, `-n 10000` | 18 s / 43 s (JIT-check's boot is 30 s) |
  | `tests/browser.test.ts` | parallel, JIT | `-s 1000 -r 10`, `-n 100000` | 9 s |
  | `scripts/tsan.sh` | parallel, interpreter, ThreadSanitizer | `-s 100 -r 1`, `-n 10000` | 60 s |

  Round-robin is sequentially consistent (one thread, whole quanta), so it shows no relaxed
  outcome at all; parallel runs show them as the M4 does (MP 32, SB 918, R 49 of 20K under the
  JIT; SB and R under the native interpreter). JIT-stress round-robin takes over 5 min: only with
  `WEBPC_JIT_STRESS=1`. With DMB emitted as nothing (planted), MP+dmb.sys, MP+dmb.st+dmb.ld,
  MP+dmb.sy+addr, SB+dmb.sys and 2+2W+dmb.sys fail in parallel.
  **An address dependency lost in V8** (M8 loop 7): TurboFan folded the litmus idiom `eor wN, wM,
  wM` to 0, so the dependent load's address no longer depended on the first load (docs/jit.md
  "Atomics"). It showed as MP+dmb.sy+addr's forbidden outcome about once in 10⁴–10⁵ once the
  code tiered up: twice in CI (1 of 20,000, Chromium) and 95 times in 1.2M in Node at `-r 200`
  (none after the fix). Short runs run mostly Liftoff code, which doesn't fold: the Node parallel
  JIT run uses `-r 50` in `scripts/ci-long.sh`, where the unfixed build failed 5 of 5 runs
  (`ci.sh` runs `-r 10`, which caught it in 1 run of 3). To look for such a
  rare outcome, boot the litmus image in parallel JIT with `webpc.litmus=-s,1000,-r,200` (~1 min
  in Node, 400K outcomes a test).

## Atomics stress (`images/litmus/stress.c`, M7)

In the litmus image, built twice: `stress-lse` (`-march=armv8.1-a`: CASAL, CASPAL, LDADD) and
`stress-llsc` (`-march=armv8-a`: LDXR/STXR, LDXP/STLXP), both `-mno-outline-atomics`; the build
fails if a binary lacks its instructions. `webpc.stress=<options>` runs both, a thread per CPU,
each pinned: `count` (32- and 64-bit fetch-add and a CAS loop on one cache line: exact totals),
`stack` (a Treiber stack of 64 nodes under a 128-bit (top, tag) CAS: every node back once, the
pops exact; GCC calls libatomic for a 16-byte `__atomic` CAS, so it uses `__sync`), `pingpong`
(mutex/condvar token passing: futex sleeps and wake-ups), `spin` (plain `STR`/`LDR` round trips
between CPUs 0 and 1: percentiles, not checked). It passes on the oracle VM (4 vCPUs, 10⁶
iterations per thread, 3× each).
- **Planted bugs caught** (native parallel interpreter): LDADD as a load and a store (`count`:
  385K of 400K); CASP/STXP as two plain stores, no lock (`stack` loses nodes, 3 of 3 runs, both
  binaries). A pair op without its lock but with its per-half CASes passes (3 of 3): the ABA it
  then misses needs two whole pair ops inside one; `pairs.c` covers the lock against plain stores.
  STXR succeeding whenever memory still holds what it reads now (not the monitored value): the
  guest never finishes (no pass within 300 s).
- Other planted bugs of M7's list: an SGI delivered to the CPU after its target (bare-metal
  `gicv3` check 21; `smp` hangs, deterministic and parallel); no IC broadcast in parallel mode
  (`maint` checks 401–403 on the first parallel run, JIT and JIT-check).
- **Spin-wait latency** (round trip, 2 × one way; 2026-09-28): the M4 0.08 µs p50, 0.13 p99.9;
  parallel JIT in Node (10⁶ per thread) 0.5 µs p50, 1.2–2.2 p99, 1.5–3.9 p99.9, max 0.3–0.9 ms;
  native parallel interpreter 0.72 p50, 0.95 p99; round-robin ~1 ms (virtual: a quantum each
  way). No chunk-long tail, so TurboFan doesn't keep a polled `LDR` in a register across a
  loop's iterations for long. In Chromium the guest counter moves in `performance.now()`'s
  5 µs steps (coarsened under cross-origin isolation), so sub-5 µs latencies read as 0 or 5.

## The stress test (`bench/stress/`)

A long-running run of the real page in headless Chromium (Debian, `?ncpus=4`, JIT, parallel SMP),
not part of `npm test` or CI (it takes as long as you give it; `tests/stress-analyze.test.ts` and
`tests/liveness.test.ts` are its cheap layers). It logs in on the serial console, starts a mixed
guest load (two busy loops, a fork/exec storm, `sort -R` and a Python thread + fork +
`mmap`/`mprotect`/`munmap` churn, `urandom | sha256sum`, `find /usr`, a `dd`/`cat`/`rm` disk loop,
console output) and samples every few seconds into a JSONL log.

```sh
# a few minutes (the guest is up at ~45 s; nothing else heavy should run: the numbers are host-sensitive)
systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- timeout 400 \
  node bench/stress/stress.ts --seconds 300 --out bench/results/local/stress.jsonl
# hours, detached: a transient unit that survives the shell; the log is the record
systemd-run --user --unit=webpc-stress --collect --working-directory="$PWD" -p MemoryMax=10G -p MemorySwapMax=0 -- \
  timeout 14700 node bench/stress/stress.ts --seconds 14400 --out bench/results/local/stress-4h.jsonl
tail -f bench/results/local/stress-4h.jsonl | cut -c1-200      # or:
node bench/stress/summarize.ts bench/results/local/stress-4h.jsonl   # while it runs, or after; exit 1 on findings
systemctl --user status webpc-stress; journalctl --user -u webpc-stress   # its console lines and final report
```

Flags: `--seconds` (the sampling time; the ~45 s boot and login come before it), `--interval` (sample period, 5), `--probe` (guest console probe period, 15),
`--ncpus`, `--guest-cmd '<cmd>'` (repeatable: started as `( cmd ) &` after the built-in load, for a
Go or C churn binary put on the guest), `--no-load`, `--stall-ms` (2000), `--freeze-ms` (10000),
`--warmup` (150 s from the tool's start, left out of the memory and speed trends). Exit code 0 clean, 1 findings, 2 the
harness failed (no login).

What a sample holds (`type: "sample"`): the page's state and message, the status the page shows
(`data-status`: uptime, steps, JIT blocks, compile time, IRQs, the run loop's cadence, per-vCPU
liveness), how long since a status message reached the page and the longest gap between two, the
main thread's timer lag, the last `performance.measureUserAgentSpecificMemory()` result (MiB), CDP
`Performance.getMetrics` (main-thread JS heap) and every browser process's RSS from `/proc`
(`SystemInfo.getProcessInfo`; the renderer's includes the workers and guest RAM). Other records:
`probe` (a `dmesg | grep` and an arithmetic marker typed on the serial console every `--probe`
seconds; the answer's latency is the guest console's liveness), `dmesg` (new lockup, stall, hung
task, panic lines), `event` (console errors, page errors, injections), `meta`, `end`.

`bench/stress/analyze.ts` turns the records into findings (the same rules run at the end of a run
and in `summarize.ts`): `crash` (page state `crashed`/`failed`, a panic or page error: the page's
message carries the core's panic text), `freeze` (main thread not answering, or no status for
`--freeze-ms` while running; it says whether a console probe was answered meanwhile), `vcpu-stall`
(one `vm_run_cpu` call, or the host handling an exit, longer than `--stall-ms`, or one in progress),
`loop-stall` (the machine worker's run loop), `memory-growth` (renderer RSS slope above 200 MiB/h
and 200 MiB over at least 600 s after the warm-up), `slowdown` (MIPS in the last third of the run
below 70% of the first third's, or three samples under 10% of the median), `guest-lockup`,
`guest-unresponsive` (a probe unanswered for 60 s).

Fault injection checks the detection: `--inject freeze-main@60:25` keeps the page's main thread
busy for 25 s from t=60 s; `--inject drop-status@60:25` swallows the machine worker's status
messages for 25 s (a frozen display with a live guest). Both are reported as `freeze`.

Liveness is host-side (web/liveness.ts, no core ABI): each vCPU worker times its `vm_run_cpu` calls
into a SharedArrayBuffer block (`Vm.liveness()`). The longest chunk is bounded by the step budget
(100M steps, ~0.3 to 1 s at these speeds), so a call over ~2 s is a real stall, in the core or in
a host import inside it. Blind spots: while the page's main thread or the machine worker is
frozen, the guest console can't be read (it goes through them); the vCPU counters are read
through the same status message.

## Planned layers

- **In-guest suites** not yet run: more LTP areas (need `mkfs` tools and a scratch disk), the
  kselftests `fp` and the generic suites, language test suites (Python), guest JITs (Node/V8,
  LuaJIT) for code invalidation.
