# Testing

Layered, cheapest first, in scripts by what a change touches (not needed for a change that
only edits docs: `.md` files or code comments):

- **`scripts/ci.sh`** (~6 min) must pass before any piece of work is done: every layer but the
  Debian boots. It includes the heaviest multi-vCPU runs (`WEBPC_LONG_TESTS=1`: the parallel
  litmus and atomics stress under JIT-check, the JIT's at `-r 50`, Node's Alpine on 4 parallel
  vCPUs; a plain `npm test` leaves them out or runs `-r 10`), and the graphics and network tests
  that boot no Debian (the gpu guest natively, in Node and in Chromium, `gpu`, `gpu-present`,
  `display`; `network`, `gateway`, `net`, `devices`), and the sound device's (`snd`, the snd guest likewise).
- **`scripts/ci-debian.sh`** boots Debian on the page: `page-debian`, `page-disk`, `page-machine`'s graphics test,
  `start`'s run, `page-venus` (vkcube through Venus on images/debian-vulkan/build.sh's Debian, reaching steady frames, its frames
  presented through a GLES sway into virgl and seen by grim, and with
  images/vkframes/build.sh's disk vkcube's frames compared with lavapipe's, vk/README.md "Checking frames"; skipped
  without that image or vk/build.sh's renderer), ~3.5 min in the dev VM ("Debian boots" below). Two run at a time
  (`WEBPC_DEBIAN_SLOTS=2` in `tests/debian-lock.ts`: nothing else runs beside them there), so
  `page-debian`'s ~3.5 min is about its wall time (`WEBPC_DEBIAN_TIMES=1` prints each test's hold of a slot). It must pass too when a change touches the
  page, the firmware or UEFI, the devices, disks or overlays, snapshots or the display (virtio-gpu
  and its presenter, the page's screen: its size, the keys and the pointer on it, the guest's
  cursor; EDID); for guest-visible changes; and at the end of a milestone or a track.
  The page's machines are 3D by default (the GPU worker draws the screen); `WEBPC_PAGE_QUERY=gpu=2d
  scripts/ci-debian.sh` runs it on the 2D path (every page test adds `clocksync=0`, the clock catch-up off, and `WEBPC_PAGE_QUERY` to the page's
  query, `tests/page-query.ts`): for changes to the 2D presenter (`web/gpu-present.ts`) or the
  device's 2D display, and at the end of a milestone or a track. That is the canvas 2D screen here (SwiftShader's
  WebGL2 is software, which the presenter leaves to canvas 2D); `gpu=2d,gl2d` runs them on the WebGL2 one.
- **`scripts/ci-machines.sh`** boots Debian on the page for machines as the unit: `page-machines` (four disks: blank,
  ramdisk, read-only, serials, a reboot), `page-stored` (a disk stored in the browser in two steps: import, variants,
  merge, in place) and `page-snapshots` (kept snapshots, forks, the ramdisk, Suspend on pins, orphaned ones), three at a
  time (`WEBPC_DEBIAN_SLOTS=3`), ~3.5 min. It must pass too when a change touches stored machines, their disks (stored,
  blank, ramdisk, overlays, serials), snapshots of them or the Machines page, and at the end of a milestone or a track.
  Split from `ci-debian.sh` on 2026-10-17: together they took 455 s on two slots (790 s of slot time, the machines
  tests ~415 of it), 361 s on three.
- **`scripts/ci-net.sh`** (~4 min) runs the network tests on Debian (`net-guest`, `page-network`,
  `net-tailnet` (with two adapters: the tailnet beside tailcat), `net-tailcat`); it must pass too when a change touches the network (the gateway, virtio-net, the
  Tailscale client, the Network menu, Debian's network command line).
- **`scripts/ci-audio.sh`** (~1 min) runs the realtime sound tests on the page (`audio-browser`: the snd guest's
  tone heard, the microphone, snapshots while it plays); it must pass too when a change touches sound (virtio-snd,
  the sound ring, the Sound menu, the microphone). They time the sound against the clock, so they run alone:
  beside `npm test`'s other files a starved guest failed their timing now and then (backlog).
- **`scripts/ci-deqp.sh`** (~6 min) runs dEQP on the page (`page-deqp`: GLES2's and GLES3's pass lists in
  `tests/deqp/`, every case expected to pass, a guest boot each); it must pass too when a change touches 3D (the
  virgl renderer, the TGSI translator, the caps, the GPU worker, virtio-gpu's 3D commands), and at the end of a
  graphics track. It needs `images/deqp/build.sh`'s disk and guest (on demand, ~15 min once). The lists are
  dEQP's every 50th case plus groups that caught regressions the subset didn't (graphics.md "Testing"). CI's Chromium is
  SwiftShader; a real GPU differs (graphics.md "Testing": on the Mac's, ANGLE on Metal, 85 GLES2 and 129 GLES3 cases fail,
  all the GPU's, after four fixes of ours that SwiftShader hid). The whole lists, or a pass list, run on the Mac host's
  GPU through `bench/gpu/sway-mac.sh` (`SCRIPT=deqp-run.ts`, mode `gles2` or `gles3`, `STRIDE`/`OFFSET`/`CASES`
  passed on; a GLES3 slice ~7 min there); `bench/gpu/results/g5-deqp-metal/` has the Metal results to compare with.
- **`scripts/ci-deqp-vk.sh`** (~12 min) runs dEQP-VK on the page (`page-deqp-vk`: the pass list `tests/deqp/vk.txt`,
  every case expected to pass, one guest boot), then `page-venus` (the programs' captures against lavapipe's frames,
  also ci-debian.sh's: VK3 L5b broke vkQuake's first frame, and the three loops after it ran only dEQP-VK); it must pass too when a change touches Vulkan (the renderer's driver
  and translator in `vk/`, `web/venus-gpu.ts`, Venus's device), and at the end of a Vulkan track. It needs
  `images/deqp/build.sh vk`'s disk and guest (VK-GL-CTS vulkan-cts-1.4.7.0's deqp-vk and Arch Linux with Venus's
  guest driver; on demand, ~25 min once), `page-venus`'s Debian and frames disk and the renderer (`vk/build.sh`); it skips where the page has no WebGPU
  adapter. The list is the cases that passed of samples of the direct set's groups (`PREFIX`/`STRIDE` runs of
  `bench/gpu/deqp-run.ts vk`, `PASSED=1`); what fails is in docs/backlog.md "The Vulkan driver's gaps", by cause. A case
  that crashes deqp-vk is recorded as `Crash` and the run goes on from the next one.
- **`scripts/ci-usb.sh`** runs the USB tests that need the dev VM's host rigs ([below](#usb-the-dev-vms-host-rigs)):
  WebUSB against dummy_hcd gadgets and WebHID against uhid devices in the pinned Chromium, and the guest through
  them. It must pass too when a change touches USB (the xHCI, its glue, the WebUSB and WebHID backends, the USB tab).
  These tests never go in `ci.sh` or `ci-debian.sh`, so cloud sessions and machines without the rigs aren't blocked.
  Without a rig it exits 0 with `CI-USB skipped: <why>`, and each test file skips by itself without
  `WEBPC_USB_TESTS=1` or its rig. Tests are added to its `TESTS` list.

Until 2026-10-08 `ci.sh` held the Debian boots and the long multi-vCPU runs had a script of
their own: `ci.sh` took 765 s, of which the Debian queue was ~460. Without the Debian boots it
takes 302 s, and 365 s with the long runs. JIT and core changes are covered in `ci.sh` by Buildroot, Alpine, Alpine
userspace, Alpine through EDK2, the corpus, the differential test, lockstep and litmus; Debian
comes with the end of their track.

**New behavior comes with tests at the cheapest layer that catches it.** Instruction
semantics need golden-corpus coverage; JIT changes must pass the differential test, lockstep
and the exact-step boots.

## Where each thing runs

| Layer | Runner | What it covers |
|---|---|---|
| Unit tests | `cargo test` (native) | decoder, ALU/flags, bitfields, FP core, crypto KATs, MMU walker, GIC, virtio rings, run loop, DTB, the JIT's structure (block formation, liveness, encoder bytes) |
| TestFloat | `scripts/testfloat.sh` | `fp.rs` against TestFloat 3e, every op and FZ/DN combination (51.2M cases) |
| FP suite ([below](#the-fp-suite-imagesbuildsh-fptest)) | `scripts/ci-fp.sh` (`tests/fptest.test.ts`, `WEBPC_FPTEST=1`; not in `scripts/ci.sh`) | TestFloat 3e's level-1 cases through all 482 scalar, vector, by-element, pairwise and general-register FP forms in a Linux guest under the JIT (4 parallel vCPUs), every FPCR rounding mode × FZ × DN, FPSR.IXC clear and set, against SoftFloat with ARM's rules; ~300M checks, ~1.5 min |
| Golden corpus | `core/tests/corpus.rs` (native interpreter); `tests/corpus-wasm.test.ts` (wasm: interpreter, JIT forced, JIT stress, block interpreter) | ~50,000 instruction tests with results from the M4 |
| Block interpreter ([cpu.md](cpu.md) "The block interpreter") | `interp::block::tests` (`cargo test`); `core/tests/boot.rs` `linux_boots_through_the_block_interpreter`, `core/tests/distros.rs` `alpine_boots_through_the_block_interpreter` (native: there the dispatcher runs everything in it); `WEBPC_NATIVE_JIT=1` runs every native guest test through it; every JIT run's cold code | random blocks of the classes it has handlers for (and some it runs generically) from random states against `interp::steps`: steps, exit, registers, RAM; Buildroot on 1 and 4 vCPUs and Alpine with `tests/steps.txt`'s counts, Buildroot on 4 parallel vCPUs |
| JIT differential | `tests/jit-diff.test.ts` | JIT vs interpreter on random words per inlined class, from 8 random states each, plus multi-instruction sequences and region shapes (branches, loops) |
| Lockstep | `tests/jit-lockstep.test.ts` | the integer and FP guests (user mode) and the integer guest at EL1 (MMU off and on), JIT and JIT-stress vs interpreter, `Cpu` + RAM checksum every chunk; 20M steps per JIT case in CI |
| JIT compile worker | `tests/jit-compile-worker.test.ts` (its ready word); `tests/boot-node-suite.ts` "parallel: Buildroot on n vCPUs" (every module through the worker, none overdue); `core/src/jit/mod.rs` unit tests (redirects wait for their region) | the vCPUs install a module only once the worker has compiled it, interpreting its blocks until then (docs/jit.md "Sharing") |
| Core instances on one memory | `tests/threads.test.ts` (Node workers); `tests/browser.test.ts` (Chromium workers) | three concurrent instances (interpreter, JIT, JIT) with their own stack, TLS and table run the integer guest to the reference's exact state (M7) |
| JIT plumbing | `tests/jit.test.ts` | install, IC IVAU invalidation (also across chains), the stale-code checker, call/return chaining, tier-up, direct branches to another page under the MMU (pages that aren't contiguous physically, a decoy at the PA that would follow, a remap), a batch's blocks compiled as one forward region (two calls of one function with a predicted and a mispredicted return; a region across two pages: remapped, and rewritten with an `IC IVAU`) |
| Bare-metal EL1 tests | `core/tests/baremetal.rs`; `tests/boot-node*.test.ts` (interpreter, JIT, JIT-stress) | exceptions, MMU, GICv3, timer, UART, SMP (4 vCPUs: CPU_ON, SGI ping-pong, per-CPU timers, CPU_OFF), broadcast maintenance (`maint`, 4 vCPUs: every TLBI …IS flavor, TLBI by ASID while the others run another ASID and against a global mapping, IC IVAU and IALLUIS on code the others run; its IC planted out, JIT-check's stale-code checker must trap), 128-bit atomics (`pairs`, 4 vCPUs: CASP and LDXP/STXP against each other and against plain stores to the same bytes), self-hosted debug (`debug`: software step from EL0 through a load-exclusive, an SVC, an UNDEFINED instruction and an IRQ taken first; breakpoints by address, linked and unlinked context ID, PMC, KDE and `PSTATE.D`, the OS lock; watchpoints by byte, LSC, MASK and a store exclusive; planted: the dispatcher's test, `set_pstate` not following the EL, ERET dropping `SPSR.SS`, an arming MSR not ending the chunk, a restore dropping a comparator each fail it or kvm-unit-tests' `debug-*`), console input (`rx`, 2 vCPUs: a line through the PL011's RX interrupt while it waits in WFI with no timer; parallel mode needs `SIGNAL_RX` to wake it), the firmware configuration's CFI flash bank (`flash`: erase, word and buffered program, status, identifier and CFI query, as EDK2 drives it) |
| kvm-unit-tests | `core/tests/kvm_unit_tests.rs`; `tests/boot-node*.test.ts` | selftest (incl. smp), psci, gicv3-ipi, gicv3-active, timer, cache, debug (breakpoints, watchpoints, single step, and through snapshots) |
| Litmus and atomics stress (4 vCPUs) | `core/tests/litmus.rs` (interpreter: round-robin with exact steps, parallel); `tests/boot-node*.test.ts` (round-robin JIT with exact steps; parallel JIT and JIT-check); `tests/browser.test.ts` (parallel JIT); `scripts/tsan.sh` (parallel, small) | the memory model (no state herd7 forbids), LSE and LL/SC atomics, 128-bit CAS, futex wake-ups, spin-wait latency (M7) |
| Buildroot boot and device test | `core/tests/boot.rs`; `tests/boot-node*.test.ts`; `tests/browser.test.ts` | Linux boots, virtio console/rng/blk/net/9p/input, framebuffer, realtime mode, writable overlay, console input (`-- /bin/sh` reads 5.5 KB from the host at a fixed step: more than the RX ring; in parallel through a `MessagePort`) |
| LTP subset + arm64 kselftests | `core/tests/ltp.rs` (interpreter, each result against its table); `tests/boot-node*.test.ts` (JIT) | 93 syscall tests; `syscall-abi`, `ptrace`, `hwcap`, `tpidr2`, `tags_test`, signal tests |
| Crypto test kernel | `tests/boot-node*.test.ts` (JIT; interpreter with `WEBPC_INTERP=1`) | the arm64 CE drivers' full self-tests (sha3-ce among them), lib/crypto's SHA-1/224/256/384/512 KUnit suites, `/proc/cpuinfo` listing `sha3` and `sha512` |
| The firmware configuration (M8 phase B, [firmware.md](firmware.md)) | `core/tests/firmware.rs` (interpreter); `tests/boot-node*.test.ts` (interpreter, JIT); `tests/uefi.test.ts` (parallel JIT, realtime) | EDK2 (`images/build.sh edk2`) boots the UEFI Shell from `shell.img`, whose `startup.nsh` prints an EFI variable, sets it in the flash bank and powers off through `ResetSystem`; a second boot with the bank's bytes prints it (`edk2-shell`, `edk2-shell-again` in `tests/steps.txt`). Alpine's UEFI cloud images through EDK2 to a root login and a power-off, as the UEFI oracle does (Limine, GRUB; a NoCloud seed disk from `web/fat.ts`) with `WEBPC_DISTROS=alpine-uefi` (`images/build.sh alpine-uefi`): `rtc-efi`, the framebuffer above `/memory`, both vCPUs, and a virtio-net card on the echo gateway that Alpine brings up by itself (DHCP and DHCPv6/RA: both addresses, default routes, a ping each; N7) (the two boots side by side, ~55 s; Debian's platform checks are in `tests/page-debian.test.ts`). Planted: a flash program that doesn't stick (the flash unit test, `flash` check 11, EDK2's boot), fw_cfg's directory off by one (its unit test; the page test's timezone credential) |
| Distros | `core/tests/distros.rs` (interpreter: Alpine); `tests/boot-node*.test.ts` (Alpine, Alpine userspace, JIT); `tests/browser.test.ts` (Alpine, JIT); `tests/page-debian.test.ts` (Debian through UEFI on the page, parallel; Debian is never booted natively, interpreted or directly) | real distro boots from virtio-blk |
| Parallel SMP (a thread per vCPU, realtime: not reproducible, so repeated, every run must pass; `WEBPC_PARALLEL_RUNS`) | `core/tests/baremetal.rs` `baremetal_parallel` (every test, 5×), `core/tests/boot.rs` (Buildroot on 1, 2, 4 vCPUs), `core/tests/distros.rs` `alpine_smp` with `WEBPC_PARALLEL=1`; `tests/boot-node*.test.ts` (bare-metal under the JIT and JIT-check, kvm-unit-tests' SMP set, litmus and stress on 4, Buildroot on 2 and 4, Alpine on 4); `tests/browser.test.ts` (Buildroot on 4; litmus and stress on 4; Alpine on 4; the page's Debian on 2) | the vCPU workers, wake-ups, the platform lock, broadcast maintenance and the DSB wait (M7). In Node a run that doesn't power off within its bound (`runToPowerOff`'s `maxMs`: 5 min, the usb guest's 1 min) fails with the console's end and its VM closed, instead of holding its test file until CI's timeout |
| virtio-gpu, 2D ([devices.md](devices.md) "virtio-gpu", [graphics.md](graphics.md) "The 2D display") | `tests/gpu.test.ts` (Node; `edid-decode` where installed); `core/tests/gpu.rs` (the native twin); the gpu guest: `core/tests/gpu_guest.rs`, `tests/boot-node-suite.ts`, `tests/browser.test.ts` (`images/build.sh linux-gpu`) | unit: every command on hand-built buffers (the errors the spec and QEMU have, all eight formats, a rectangle narrower than the resource, the scanout showing part of a resource, damage clipped to it, the resource budget across unref and reset, the cursor, events and write-one-to-clear, save and restore, a console restored into a bigger page keeping its buffer's mode in the EDID, a flush alone drawing and a page flip drawn once, one flush reply per frame with the queue behind it in order, a transfer copied on arrival while its reply is held), a seeded run of 20000 random and mutated commands (never throws, answers in the spec, guest RAM unchanged), the EDID checked against `edid-decode --check` for eight sizes and against the twin's bytes (`tests/gpu/edid.json`), and a conformance script whose hashes the twin must give too. Planted: a transfer off by a row, a backing entry outside RAM accepted, the stride ignored (needed a rectangle narrower than the resource), a display event never raised, damage outside the scanout drawn, a cursor hotspot ignored. **The gpu guest** (`gpu` in `tests/steps.txt`): Linux with `virtio_gpu` and a static init (`images/gpu/init.c`, raw KMS ioctls) on a 640×480 display: connector and EDID (mode and physical size), a mode set, DIRTYFB damage with a write outside the clip nobody was told about, a cursor with a hotspot, then the display event the host raises after the second flush (the guest sees a preferred 800×600 and sets it). The scanout's hash after each of the three flushes and the cursor's are `tests/gpu/guest.json`, and `tests/gpu.test.ts` computes them from first principles (init.c's drawing reimplemented), so they aren't merely what the twin says; natively, in Node (interpreter, JIT, JIT-stress) and in Chromium (the device worker) the steps, console and hashes are the same. Planted: the stride ignored and the event never raised (the guest fails each) |
| virtio-snd ([devices.md](devices.md) "snd", [audio.md](audio.md)) | `tests/snd.test.ts` (Node); `core/tests/common/snd.rs` (the native twin); the snd guest: `core/tests/snd_guest.rs`, `tests/boot-node-suite.ts`, `tests/browser.test.ts` (`images/build.sh linux-snd`), its expectations in `tests/snd/`; the sound ring: `tests/audio.test.ts` (Node), `tests/audio-browser.test.ts` (Chromium, the page's `snd` machine; ci-audio); Debian's card in `tests/page-debian.test.ts` (ci-debian) | unit: the device entry and config (two streams); `PCM_INFO`'s bytes, a larger item size padded, and every info query's error (out of range, wrapping, too small, no room, short; jacks and channel maps, of which there are none; `JACK_REMAP`); unknown codes; `SET_PARAMS` with every offered format and the rates' ends, `NOT_SUPP` for the rest, `BAD_MSG` for sizes of no whole frame or period; the state machine's every transition, in order and out of it; transmit messages held until START, completed at the end of their exit in order with their status in the last 8 writable bytes (split over buffers too), the sink's hash and bytes; at most a buffer less a period per exit; STOP holding, START resuming, RELEASE returning without playing (after its own reply); malformed and misplaced messages, rxq, event buffers held; a reset; save and restore (a held message posted again plays once; bad states refused); `toF32` for each format, unaligned; the input stream: its own lifecycle and log name, receive messages held until its START, filled with the pattern at the end of their exit with the frames then the status (split over buffers too), a buffer less a period per exit, malformed ones, STOP and RELEASE (returned with only a status), save and restore (the pattern going on), an old one-stream state still loading, the pattern in each format and mono; with no microphone, silence at the stream's rate, its bound and the untaken wait, paused while stopped, counted afresh at START; the microphone's ring: frames in order in the stream's format, mono as the mean and FLOAT clamped, at most a buffer behind after a stall, stale frames from before it went live skipped, silence by the clock once its worklet stops. Planted: no burst limit (the unit test and the guest fail: the guest's writes time out), a byte lost from the hash, RELEASE not returning (each caught); no burst limit in the twin (the native guest fails); the pattern's channels swapped (the guest test fails on the frequencies and the pinned hash), no burst limit on the source in JS (the guest and two unit tests fail) and in the twin (the native guest's reads stall). **The snd guest** (`snd` in `tests/steps.txt`): Linux with `virtio_snd` built in and a static init (`images/snd/init.c`, raw ALSA ioctls): the card and the PCM, what the device offers, hw params S16 48 kHz stereo with 4 periods of 1024 frames, sw params that never stop on an underrun, 48 periods of a 440/660 Hz sine, then a drain of what's still queued (a drop when nothing is: ALSA's drain on an empty stream waits out its timeout, [audio.md](audio.md) "Linux driver behavior"); then (audio S4) 16 periods recorded from the capture PCM with the same parameters: the deterministic source's pattern from frame 4096 (the first buffer overwritten before it's read, [audio.md](audio.md) "Linux driver behavior"; FNV-1a `2b1e136b`, pinned in both runners' checks), 999 and 1500 Hz by its zero crossings, the source having filled 24 messages. The sink must have played exactly the 49,152 frames whose FNV-1a the guest printed, which `tests/snd/guest.ts` also makes from the waveform, after the control requests of `tests/snd/log.txt`; natively, in Node (interpreter, JIT) and in Chromium (the device worker, interpreter and JIT) the steps, console, hash and log are the same. QEMU's virtio-sound-device is the oracle ([audio.md](audio.md) "Linux driver behavior": the same requests, the same samples; §16: the same capture requests, and with its `none` backend 16 periods of silence in 342 ms of the guest's time, which the page's clock source matches). **The sound ring** (audio S2): the realtime sink on a fake clock (frames into the ring as f32 stereo in order and across its wrap; messages completed when the worklet's read index passes them, with the page's latency, or by the sink's own clock at the stream's rate, waiting for the guest when the ring ran dry (an underrun with its silent frames when sound comes again; none if frames come before the clock reaches the ring's end), taking over from the worklet's last quantum when its heartbeat stops; at most a buffer less a period since the guest's last message, counted across pumps, the rest after its next message or half a buffer's time and 30 ms after the core took the batch's first completion (not while it hasn't: no vCPU runs); after a restore, a whole buffer counted as in flight (two of three re-posted periods complete); messages waiting for room; STOP and START, RELEASE dropping the ring; mono to both channels) and the worklet's `process` under stubs of its scope (only while started at its rate; a gap counted as an underrun when the sound comes back, not at a stream's end; a lost compare-and-exchange plays silence). In Chromium (`scripts/ci-audio.sh`, alone) the page's `snd` machine plays 4 s (`snd_seconds=4`): the stream's time on the device (START to its stop, the sink's `stop` message) is the sound's length plus the gaps the ring counted, within 40 ms, and the gaps under 10% of it (a loaded host starves the guest's 85 ms buffer for real, but no time may go missing uncounted; the guest's own time, which also has its computing before START in it, is printed; the exit's numbers are measured alone: [audio.md](audio.md) "Measurements"), an analyser after the volume hears 440 and 660 Hz, the guest then records 16 periods in real time (341 ms, up to 60 more: the microphone opens while it records and its switch starts a period again), mute silences it and is remembered over a reload; a suspended context shows "Sound: click to hear", the sink's clock keeps the guest playing, a click resumes the worklet. **The microphone** (audio S4; the browser for `tests/audio-browser.test.ts` has Chromium's fake capture device, playing a 500 Hz WAV the test writes): with Raw microphone, the guest records 3 s of it at 500 ± 10 Hz on both channels in its length of its own time (± 150 ms), the summary says "· mic", the track's echo cancellation, noise suppression and gain control are off, and the microphone closes when recording stops; with the browser's processing (the default) they're on and the tone is heard; Microphone off: `getUserMedia` is never called and the guest records silence (16 periods, 341 ms ± 40); refused (`getUserMedia` rejects): silence, and the menu's hint says the browser refused it. **Snapshots while it plays** (audio S4): a 12 s tone saved 2 s in plays on in time through the pause; the file loaded in a fresh profile (over that page's own snd guest) plays on: 440 and 660 Hz heard, the new ring holds what the guest hadn't had completed (whole periods, within a buffer of what the old ring played around the save), the stream's time is that plus its counted gaps within 40 ms, the guest drains normally; and in Node the snd guest through 6 files, 4 mid-tone and 2 mid-recording, in the unbroken run's steps and console (`tests/snapshot.test.ts`). Planted: no burst limit, the bound per pump instead of since the guest's last message, the wait's 10 ms counted while completions are untaken, the take-over from the time it's noticed, the sink's dry spells not counted (each fails a unit test), mute ignored (the page test fails); raw ignored, Microphone off ignored (the microphone tests fail); a restored clock that runs before the vCPUs do, and a saved one not held (the core's `a_realtime_clock_continues…` test). Debian (ci-debian): `/proc/asound/cards` lists the VirtIO SoundCard, and Debian's own driver plays a file (audio S3): `snd-play` (`images/snd/play.c`, a static WAV player on raw ALSA ioctls with aplay's buffer, 500 ms in 4 periods, built by `images/build.sh linux-snd`) and a 3 s 440/660 Hz WAV at 44.1 kHz come in a tar on the page's second disk (`?disk2=`, `tests/snd-disk.ts`; `tar -xf /dev/vdb`); its own clock says the sound's length within a period (3,110 ms for 3,125), no underrun, the page (whose context follows the stream's rate) hears 440 and 660 Hz, and ALSA's delay half-way is the buffer plus the browser's output latency. The same disk and player under QEMU's `virtio-sound-device` give its WAV the file's samples exactly. And it records (audio S4): `snd-rec` (`images/snd/rec.c`, on the same disk) takes 3 s at 48 kHz stereo from the page's microphone (the test's browser has Chromium's fake capture device playing 500 Hz) through Debian's driver: its length in its own time (± 150 ms), no overrun, 500 ± 15 Hz on both channels (the browser's processing on) |
| virgl's device side (M8 graphics G2, [devices.md](devices.md) "virgl") | `tests/gpu.test.ts` (Node) | off by default (the 3D commands are `ERR_UNSPEC`); the capsets' info and blobs (VIRGL v1 308 bytes, VIRGL2 1408, `virglCaps`; GLSL 130, renderer `webpc`, nothing WebGL2 lacks: no dual-source blending, fbfetch or independent blending), the caps' encoding round trip; contexts (0 and a reused id refused), 3D resources (bad target, reused id), attach and detach, 3D transfers counted in bytes, a 2D transfer of a 3D resource refused, `SUBMIT_3D` walked and counted per command (a length past the end and a size past the payload refused, an unknown context), a 3D scanout black and opaque, a buffer never shown, the snapshot marker, unref, destroy and reset; a seeded run of 20000 random 3D commands and streams (never throws, answers in the spec, guest RAM unchanged). Planted: a stream length past the end accepted, the capset's size misreported (both caught). Guests: none in the test suites (the null renderer is measured, `gl_virgl_jit*` and graphics.md "Measurements"' sway runs, not pinned) |
| virgl's renderer on WebGL2 (M8 graphics G3, [graphics.md](graphics.md) "The renderer") | `tests/virgl.test.ts` (Node, a recording WebGL2: `tests/virgl-mock-gl.ts`); `tests/virgl-browser.test.ts` (Chromium); fixtures in `tests/virgl/` (`tools/virgl-capture.ts`, `bench/gpu/sway-load.ts` with `CAPTURE=`) | Node: every shader of the TGSI corpus (the oracle's glmark2 and the guests') parses and every fragment shader makes a program; the generated GLSL's registers, immediates (bits where a float literal would be denormal), sampler and render-target swizzles (BGRX both ways), integer bits, the fragment coordinate's origin, the alpha test; what GLES 3.0 lacks refused; the trace format round-trips; glcomp's and sway's traces through the device into the renderer with no errors (draws, read-backs, every submit OK); a fenced reply held for the host with the replies behind it in order; the caps from a browser's parameters (formats only with their extensions, limits) and a snapshot's caps checked against today's; half floats. Chromium: the corpus's programs compile and link; glcomp's render target against llvmpipe's last frame (within 8 a byte, mean under 1.5: blending and filtering round differently); sway's last frame against a reference this renderer made (`sway-640.scanout.gz`, a regression check); stream output from a stream made in the test (interleaved and separate, an append, a rebind, a draw cut at a full buffer, PRIMITIVES_EMITTED, nothing bound to draw on; the generated varyings in Node). A 2D machine's WebGL2 screen (`web/gpu-present.ts` through the device): the eight formats' bytes kept as the guest wrote them and drawn through their swizzle, the canvas 2D screen's RGBA too, and a lost context drawn again when it is restored, with nothing flushed (planted: the restore not redrawing, the scanout's swizzle left out; both caught). A 3D machine's snapshot: Node (contexts remade, a context in use saved from the host's state and loaded on restore, a host's refusal kept, caps that can't be backed turn 3D off, the restored scanout told to the host; the null renderer's tables); Chromium (graphics.md "Snapshots with 3D in use": glcomp's and sway's traces saved at several submits and loaded into fresh renderers on new contexts draw the same bytes, each save saved again the same; every format as 2D with levels, cube, array, 3D and 4 samples loads and saves back exactly; a save across the GPU worker's port loaded into a second worker; planted: texture uploads skipped at a load, the bound blend dropped, a stencil bit not read, each caught); the page's Debian tests (3D by default; `WEBPC_PAGE_QUERY=gpu=2d` for the 2D path, above). Planted: `B8G8R8X8` sampled as RGBA (the sway check fails); an append started over, the captured bytes not read back into the CPU copy, the restore's scanout not sent, a 3D cursor ignored (each caught). A 3D cursor read back from the renderer and converted from its format, a later update winning over a read in flight (Node). Queries (graphics.md "Queries"): a fence held for the occlusion queries before it, a query destroyed while pending holding none, one with no draw done at once and a `null` span counted as passed, spans paused when another sub-context draws or a blit runs (Node); two contexts and two sub-contexts with queries open at once, each counting its own draws, the fence answered (Chromium); spans folded once one passed. Feedback loops (graphics.md "Feedback loops"): a level drawn while sampled through a swizzle gives its old texels, an array's layer drawn while another is sampled (Chromium). A shader object destroyed deletes its programs; a sampler with no view leaves nothing bound on its unit (Node). The call queue gives up a picture pending 3 s while later ones come out (`tests/virgl-video.test.ts`). What ANGLE on Metal found (graphics.md "The translator"): one program with stream output captured or not, an invariant position kept invariant, NaN-pattern integer immediates no constant expression, `x != x` as `isnan` (Node); each planted back fails its test |
| Video over virgl ([plans/video.md](plans/video.md)) | `tests/virgl-video.test.ts`, `tests/video-h264.test.ts`, `tests/video-av1.test.ts` (Node); `tests/virgl-browser.test.ts` (Chromium; fixtures `tests/virgl/video-*` from `bench/video/fixture.ts`) | The caps' `video_caps` words as Mesa reads them (at their dwords in the v2 caps), a restore needing every decoder the guest was told of, the codec and buffer tables and a picture's desc and data read from staging buffers; H.264: Exp-Golomb and emulation prevention round trips, the rebuilt SPS and PPS read back field by field by a parser written to §7.3.2 (POC type 1's cycle, Constrained Baseline's flags, the effective scaling lists), a picture's chunk (parameter sets at an IDR and when they change), a software decoder's SPS saying the stream's reorder depth learned from the POCs (the reference count before, raised at an IDR, carried to a drained decoder's successor). `VideoContext` on a fake decoder: VP9 pictures into their planes, a hidden VP9 frame waited for by nothing, a decoder error and the new decoder at the next key picture, software H.264 drained when it holds pictures and decoded again from the IDR by a new decoder (the drained one's output still counting, nothing lost; hardware never drained), a picture a software decoder passed over (a lesser POC pending when a later one comes out) given up at once (in hardware not), pending pictures given up after the bound, a destroyed buffer's pending picture still written into its planes and a destroyed codec's decoder flushed (what it held written, the rest dropped when the flush ends), a picture never written over a later one in the same planes; the renderer (mock GL) writing a picture into planes the decoding context detached after END_FRAME (Firefox's decoder process at a seek); `CallQueue`: a call waits only if its context has a pending plane attached (decode-only submits excepted) or it names one, what must follow a waiting call waits too (its context, its resources; a fence and a read after every waiting call), the rest runs ahead (Venus's calls that make things too, those that end things in order); drained at 200 ms, given up at 1 s. Planted: the compositor's draw not held, a fence or a read passing a waiting call, a transfer of a plane not held, the passed-over rule off or applied to hardware, the drained decoder's output ignored, no decoding again after a drain, the write needing the decoding context's attachment, a destroyed codec closed at once, a destroyed buffer's picture dropped, the older-picture guard off (each fails). In Chromium, 40 pictures a codec of the Sintel trailer as the guest's FFmpeg sent them through VA-API, replayed through the device, decoded by WebCodecs, the planes read back: VP9 each FFmpeg's frame exactly; H.264 each a frame of the browser's own decode of the original stream (the dev VM's Chromium decodes H.264 with OpenH264, not bit-exact with FFmpeg; on a hardware decoder FFmpeg's exactly); AV1 (fixtures `video-av1-aom`, `-svt`, `-tools`: 40 frames each of libaom, SVT-AV1 and libaom with segmentation, tiles, 128x128 superblocks, quantizer matrices, global motion, delta q and lf, loop restoration and film grain) each written picture one of FFmpeg's frames (planted: a live reference's slot taken, no decoding again, hidden frames left hidden, `qm_v` left out, tile sizes off by one; each fails); `tests/video-av1.test.ts` (Node): `ns` and the sub-exponential code read back by readers written to the spec, the slots (a frame into a slot the guest's map doesn't hold, waiting for the next map when none is free, flushed stored nowhere and decoded again when referenced, hidden frames written shown or put in the next unit) and global motion coded against the primary reference's parameters (planted: against the defaults); a waiting AV1 frame sent by the queue's nudge and before a destroyed codec's flush (`tests/virgl-video.test.ts`); a damaged chunk (its bytes garbled, `ChunkFault`) is a WebCodecs decoding error in both codecs (none conceals it), the pictures before it written, the codec's later ones dropped and no call waiting on them (planted: the error not closing the codec). **Reading a decoded frame in the dev VM's Chromium needs `tools/nosme.ts`** (`chromiumEnv()` for Playwright's `launch({ env })`: an `LD_PRELOAD` that hides SME from `getauxval`, built on demand into `target/nosme/`, only where the CPU has SME and no SVE; plans/video.md §4); every launcher that decodes video passes it. The guest's end to end checks are tools: `bench/video/v1.ts` (`SNAPSHOT=1`: Save snapshot refused while a player decodes, saved once it exits) and `bench/video/seek.ts` (seeking, plans/video.md §9) |
| Pause and resume (`pause()`, [platform.md](platform.md) "Pausing a VM") | `tests/pause.test.ts` (Node; `WEBPC_PARALLEL_RUNS` repeats the parallel ones, taken at 10); `tests/browser.test.ts` (Chromium) | Buildroot on 4 parallel vCPUs (JIT) paused 25 times through its boot (every 30 ms and at console markers): the summed step counter stands still for 20 ms, the doorbell's served word equals its rung word, STOP is clear, the guest still ends as an unpaused boot does; a pause with the backends' service slowed by 10 ms (`Devices.prototype.poll` wrapped) never resolves while one is still serving; a pause with every vCPU idle at a shell prompt then input after `resume()` (a lost wake-up hangs it); a pause requested as the guest powers off (never hangs); `close()` while paused and while a pause is pending frees the VM (no worker left); round-robin pauses between runs leave `buildroot` and `buildroot-4cpu` at their exact steps; in Chromium (device worker) ~10 pauses through the 4-vCPU boot. Planted: `resume` not notifying the pause word, STOP left set at the resume, devices not settled before the pause resolves (the slowed-backends test: "resolved with a backend still serving"); the doorbell's server (`Devices.serve`) ends on a `close` that lands while it yields to the event loop (`tests/devices.test.ts`; [below](#a-test-file-that-never-ends)) |
| ThreadSanitizer | `scripts/tsan.sh` (in `ci.sh`, ~20 s warm) | the native parallel runner under `-Zsanitizer=thread` (std rebuilt, `target/tsan`): the bare-metal tests 3×, Buildroot on 1, 2, 4 vCPUs, the litmus image on 4 (~1 min); any report fails, nothing is suppressed (guest RAM is accessed with relaxed atomics: [cpu.md](cpu.md) "Memory accesses and atomics"); a planted plain load is reported |
| Browser-only | `tests/browser.test.ts` | cross-origin isolation, the device worker, sync XHR ranges, OPFS, the canvas, DOM input, the spike page |
| The page ([frontend.md](frontend.md)) | `tests/browser.test.ts` (smoke test on the Buildroot guest, 2 parallel vCPUs, ~7 s; and the screen's dirty rows on a canvas) | the machine worker and its protocol, pixels written to `/dev/fb0` on the worker-drawn canvas, serial output to xterm.js and keys typed there to the shell, a key on the screen to `/dev/input/event0`, a held key released when the screen loses the focus, a Keys-menu chord (Ctrl+Alt+F12: order and release), the tablet through a scaled-down canvas (`/dev/input/event1`), a paste over 4 KiB (its md5), full screen, power off, Start, Restart while running (the disk overlay handed over); the page's messages (~4 s: served without COOP/COEP, xterm.js, the core or an image missing then Retry, a device reporting 1 GB then Start anyway, an overlay over another image then Reset disk); a guest panic (`?params=init=/nonexistent`) kept on show with the serial log copied and saved, the remembered view, a second tab refused the disk then Retry, a file kept over a restart and gone after Reset disk (~15 s); the overlay's hand-over (`tests/browser/overlay-worker.ts`, ~1 s: a second opener waits for the first's close, 20 holders terminated and the overlay opened at once, one held past the wait is in use) and six restarts in a row while the guest rewrites its disk, during the next machine's loading and booting, one a double click (~9 s; M8 loop 8) |
| The serial terminal's keys into EDK2 and GRUB | `tests/page-disk.test.ts` (`scripts/ci-debian.sh`: the chosen disk's first boot goes through them) | arrows, Enter, Esc, F2, Ctrl-N/E/X, typing through xterm.js: GRUB's menu → "UEFI Firmware Settings" (the guest resets; the variable that asks for the setup survives the page's restart in the flash bank) → EDK2's boot menu and setup forms → Continue → GRUB's editor and command line → Ctrl-X boots the edited entry, whose `/proc/cmdline` has what was typed |
| Disk out ([frontend.md](frontend.md) "Your own disk") | `tests/qcow2-write.test.ts` (needs `qemu-img`), `tests/page-save.test.ts` (Chromium, Buildroot) | the base's hash (SHA-256 of the slices' digests) against node:crypto; the changes qcow2 (backing file, base hash) and the whole-disk qcow2 against `qemu-img check` and `compare` with the merged bytes, small and over several L2 tables and refcount blocks, and read back by our reader (planted: a block left out fails it); a packer that answers several batches at once, late and out of order, writes the same bytes as compressing in place; `tests/qcow2.test.ts`: a read over many clusters is a few host reads (planted: no merging fails it) and survives a merged read that fails; on the page, saving from a running machine downloads raw (the image's bytes), qcow2 (identical) and changes (valid, over the image) and the machine starts again |
| Discard ([devices.md](devices.md) "blk") | `tests/overlay.test.ts`, `tests/devices.test.ts`, `tests/trim.test.ts` (Buildroot, JIT, 2 vCPUs), `tests/qcow2-write.test.ts`, `tests/changes.test.ts` | the overlay against a byte-array model through writes, discards and zeroes, reopened (planted: a discard that zeroes the base's blocks, slots never freed, a partial write over a zeroed block that reads the base, a compaction that maps the wrong slot: each fails); the requests and their refusals without a guest; Linux's `fstrim` shrinks the overlay's data file and can't without the offer; zero blocks as zero clusters under `qemu-img check` and `compare`, and back through Load changes without slots; on Debian, `fstrim` in `tests/page-disk.test.ts` |
| Changes in ([frontend.md](frontend.md) "Your own disk") | `tests/changes.test.ts` (Node, in-memory overlay; qemu-img/qemu-io for one case), the end of `tests/page-save.test.ts` and `tests/page-disk.test.ts` | the saved disk comes back through the overlay and replaces what it held; a changed base, size, a disk and a qcow2 from another tool are refused with the overlay untouched; qemu-img's own changes file (64 KiB clusters, zero cluster) reads; on the page, Buildroot loads its changes back and refuses a raw file, and a fresh profile's Debian plus the changes file saved from another-named copy boots with the file (the last phase of page-disk) |
| Your own disk on the page ([frontend.md](frontend.md) "Your own disk") | `tests/page-disk.test.ts` (with `WEBPC_DISTROS=debian`: two Debian boots and the changes-in boot, ~200 s alone; takes the Debian lock) | a qcow2 chosen with the picker boots through UEFI under its own overlay (`webpc-disk-<hash>`, flash beside it); its changes are saved (download and picker handle: same bytes, `qemu-img check`, backing file, base hash); after a reload the same file chosen again has the file written before (planted: an overlay name that changes per choice fails it) |
| The page on Debian, end to end ([frontend.md](frontend.md) "The end-to-end test") | `tests/page-debian.test.ts` (`scripts/ci-debian.sh`: three Debian boots shared with GRUB's screen key, the page's size and the snapshot ("Debian boots" below); `WEBPC_PAGE_RUNS=N` repeats it; the ready marker's unit test always) | what a user does on the page's own VM (through UEFI, `tests/debian-unattended.ts`'s credentials over `?credential=`; the flash bank is saved beside the overlay): Debian on 2 parallel vCPUs from a fresh profile reaches `running`; root logs in on the serial terminal (xterm.js to the PL011), waits there for tty1's `login: ` in `/dev/vcs1`, then logs in on the **screen** (keys on the canvas through virtio-input) and runs a command that writes a marker to `/dev/ttyAMA0`, read back on the serial side; tty1's text (`/dev/vcs1`) shows the prompt and the command, and the canvas isn't black; the platform the firmware gave Linux (`rtc-efi`, the virtio-gpu framebuffer `virtio_gpudrmfb`, `/sys/firmware/efi`, both vCPUs, a credential read back from fw_cfg and the timezone systemd-firstboot set from it); a file written and synced is there after a reload (no shutdown). Reset disk is the Buildroot page test's (`tests/browser.test.ts`). The screen is a virtio-gpu here (device worker draws; `bench/gpu/draw-latency.ts` measures flush-to-draw); `tests/page-disk.test.ts` uses `?display=simple` to keep GRUB's serial menu. The transport's "QueueNum 0 is the maximum" has a unit test (EDK2's gpu driver hung the firmware without it) |
| The guest's clock across snapshots ([frontend.md](frontend.md) "The guest's clock", [platform.md](platform.md) "System suspend") | `core/src/vm/tests.rs` (`system_suspend_*`, `a_parallel_vcpu_resumes_from_system_suspend_when_woken`); `core/src/virtio/tests.rs` (`a_queue_turned_off_drops_its_chains_in_flight`); `tests/clock.test.ts` (virtio-rtc); `tests/page-clock.test.ts` (ci-debian) | the core: SYSTEM_SUSPEND in FEATURES, DENIED while another vCPU is on (both modes), the vCPU off until `wake_suspended` and then at its entry with its context (32-bit arguments for SMC32), a suspended state saved and restored, the clock skip only while suspended (and not in deterministic time, which has no SYSTEM_SUSPEND) with the RTC on the host's time, a format 2 state restoring awake and a format 2 one with the field refused; a queue turned off drops its chains in flight (planted: kept, the test fails); virtio-rtc's messages and sizes as Linux's driver checks them. On Debian with `?clocksync=1`: the clock device listed, the guest within 3 s of the host after its booting, after Save snapshot (the guest slept for it: the message, the file's `slept`, one `suspend entry (deep)`), after `systemctl suspend` and a key, after Suspend and a resume 20 s on, after the file loaded minutes later in a fresh profile, with no failed unit, RCU stall or watchdog line |
| The guest's keyboard layout ([frontend.md](frontend.md) "The keyboard layout") | `tests/keyboard.test.ts`; `core/src/smbios.rs`; `tests/store.test.ts`, `tests/page-modal.test.ts`; `tests/page-debian.test.ts` (`?keyboard=gb`) | the layouts and "Match this browser"'s detection, the credentials as base64 SMBIOS strings, the guest's script under dash on files of its own (Debian's `/etc/default/keyboard` with other lines kept, `/etc/environment`, a second run changing nothing); the host's strings in type 11 and out of fw_cfg; the setting in the record and the definition, not the shape; the Settings field and its note; on Debian the unit's result, localed's X11 layout and `XKB_DEFAULT_*` in a login |
| The page's size to the guest (M8 graphics G1 loop 5) | `tests/page-debian.test.ts` (`scripts/ci-debian.sh`; on its first boot, before any message's bar takes from the screen box); the rules' unit test in `tests/gpu.test.ts` | Debian on virtio-gpu: the console is born at the screen box's size (the connector's preferred mode and the canvas); a bigger window leaves the console enabled (the EDID's extra mode) and a fresh probe lists the new preferred mode; a smaller one never crops the canvas. Planted: the floor removed (the console cropped: caught); no extra modes (the console went blank: seen before the fix) |
| The guest's cursor on the page (M8 graphics G1 loop 6) | `tests/gpu-present.test.ts`; `tests/page-cursor.test.ts` (`scripts/ci.sh` when the Debian images exist: the page's machine is stopped within a second, ~10 s) | The presenter sends a cursor when its image or hotspot changes, its moves as positions (not a hidden one's); the page turns a message into the canvas's CSS cursor at the canvas's scale (hotspot scaled, blob's size and alpha), `none` hidden, the default when never set. Planted: the hotspot ignored (caught) |
| The screen's pointing devices: side buttons, chords, touch, the mouse lock, the leave warning | `tests/devices.test.ts` (the config answers); `tests/page-pointers.test.ts` (`scripts/ci.sh` when the Debian images exist: the start message's input ports are kept on the page and the worker stopped, ~15 s); `tests/page-debian.test.ts` (the guest's devices and a touch reaching its touchscreen) | Back and forward are BTN_SIDE/EXTRA and don't navigate; a second button held with the first is pressed; two touches take two slots, BTN_TOUCH from first down to last up; with the lock a click takes the mouse (not the guest's); in Pointer mode the motion moves the tablet as unlocked (a quarter of the screen's width is a quarter of its range) and stops at the edge; in Raw, motion and buttons go to the mouse, the page draws the guest's cursor at its position, clipped at the screen's corner (no page overflow), and letting go returns to the tablet; a running machine's page asks before a reload, not with Preferences' switch off. Planted: the back button's cancel removed (caught: the page navigated); the cursor's clip removed (caught: the page overflowed) |
| Snapshots on the page ([frontend.md](frontend.md) "Snapshots") | `tests/page-snapshot.test.ts` (Buildroot, ~20 s); Debian's in `tests/page-debian.test.ts` (`scripts/ci-debian.sh`: saved on its first boot, loaded in a second profile). The Debian snapshot is loaded into another window size: the console is drawn at its own size and still shown after the display event, and the connector's preferred mode is the new window's. **Suspend:** Buildroot suspended and the page reloaded resumes with its shell's variable and no suspended copy left, a second reload boots; Start resumes, Boot instead and Reset disk drop it (planted: the copy kept after a resume); Debian, on the same boots as the snapshot test: suspended logged in, resumed after a reload, a file written, then a normal boot finds every file; `tests/snapshot.test.ts` has the file's rules (no disk blocks, the overlay kept, refused as a snapshot), and the rule benchmarks start from (docs/benchmarking.md "Starting from a snapshot"): a file loads into another build of the core (other bytes, another ABI in its header) and Buildroot runs on to the unbroken run's steps and console, while another state version, a changed core state word and another machine are refused (planted: the ABI checked, the version not checked; each fails it) | Save snapshot (download and picker handle; the machine runs on), Load snapshot in a fresh profile (a shell variable, a devtmpfs file, the terminal's tail, the snapshot's vCPUs; Debian: logged in, the disk's file read past the page cache, the flash copy beside the new overlay, a write and a reload after), a snapshot dropped like a disk, the refusals with the disk untouched (not a snapshot, another machine, another disk, devices the page can't make, truncated; Start recovers). Planted: no resume after a save, no flash rewrite, no overlay replacement, a terminal reply to the replayed tail each fail it |
| Machines as the unit ([plans/machines.md](plans/machines.md), [frontend.md](frontend.md) "Machines in the browser") | `tests/store.test.ts` (Node and Chromium), `tests/ramdisk.test.ts`, `tests/stored.test.ts`, `tests/overlay.test.ts`, `tests/devices.test.ts`, `tests/snapshot-plan.test.ts` (Node, a bare-metal guest); `tests/page-disks.test.ts`, `tests/page-modal.test.ts`, `tests/page-definitions.test.ts`, `tests/dist.test.ts` (Chromium, no guest); `tests/page-machines.test.ts`, `tests/page-stored.test.ts`, `tests/page-snapshots.test.ts` (Debian, `scripts/ci-machines.sh`), `tests/page-disk.test.ts` (Debian, `scripts/ci-debian.sh`) | the records written after their bytes and the sweep of what a crash left (only id-named files; it waits for writers), deletions in order, two tabs hearing each other; the shape's hash pinned, moved by what the guest sees and nothing else; the ramdisk against a byte array (chunks given back); a stored disk's import read back (raw, qcow2 with compressed clusters), exported under `qemu-img compare`, merged, an interrupted merge finished at the next opening; the generation bumped once per opening before the first change, and again after a snapshot's pin; a restore's plan (keep, fork, reuse, replace, in place); the Machines page making a machine and its disks (the Add a disk wizard), the URL check's refusals; definitions across two fresh profiles. On Debian: four disks (a URL, blank formatted and kept, a ramdisk empty after a reboot, read-only refusing writes); Debian stored in the browser (~1 GB, an on-disk profile: an off-the-record context's OPFS holds ~0.8 GB), variants, Import changes into a new overlay, a merge, in place; three kept snapshots (an on-disk profile too: with the URL disk's block cache they outgrow an off-the-record one; the toolbar's Snapshot, renamed on the Snapshots tab), an older one restored forking the newer state, the ramdisk back, Suspend on pins, a RAM change orphaning them. Planted: the bump left out, the epoch left out, an interrupted merge not resumed, a fork skipped when the generation differs (each caught) |
| Network adapters and connections ([network-adapters.md](network-adapters.md)) | `tests/connections.test.ts` (Node and Chromium), `tests/store.test.ts` (adapters), `tests/net-live.test.ts` (the adapters live, fake clients), `tests/page-connections.test.ts` (Chromium, two stored machines on the firmware alone, ~40 s), `tests/net-guest.test.ts`, `tests/page-network.test.ts` and `tests/net-tailnet.test.ts` (Debian, `scripts/ci-net.sh`; the last with headscale and tailcat's rig) | adapters in the shape (one at the default MAC hashes as the card did; more, another MAC or another order move it), added up to four and removed, copies and definitions carrying the MACs and no connections; on Debian, three cards each with its own lease, router and gateway MAC, and two whose default route goes through the primary only (the other's network through it: 100.64.0.0/10, the /48 from a Route Information option), moving when the primary does (IPv6 at once, IPv4 within 10 s, bounded at 45 s); a tailnet without an exit node beside tailcat through a server, the primary though second, the guest reaching the tailnet's peer (by address and by MagicDNS name; its /48 at high preference over tailcat's medium, the adapters' ranks) and tailcat's internet at once; `tests/gateway.test.ts` and `tests/network.test.ts` for the routes-only lease and `primaryOf`. Planted: a MAC left out of the hash, every adapter's gateway at one address, a default route from every gateway (each caught). Stored and ephemeral connections, their names and state keys (two to one tailnet are two nodes), deleted with their state; the Attach wizard's preselection; the single connection kept before migrated (its kept nodes under their profiles, the served identity), idempotent; the locks between tabs; the store's upgrade to version 2 over a database made before, keeping its records. Planted: a kept node's profile rewritten (caught). The page (L3): what a connection starts its client with (an ephemeral one's node not kept), connect at start, a restart keeping the clients and another machine stopping them, an attachment whose connection is gone detached with a note, the default way out moving to the adapter that reaches the internet; in Chromium a new machine connected in one wizard, another tab's machine named as the holder and taking the connection after asking, Detach, an ephemeral connection gone after a reload, Connections' rename and delete. Planted: a connect without its lock, every node kept, Keep ignored (each caught) |
| USB on the page ([usb.md](usb.md) "The page") | `tests/usb-page.test.ts` (Node), `tests/page-usb.test.ts` (Chromium, WebUSB and WebHID faked, no guest), `tests/page-usb-guest.test.ts` (Debian, `scripts/ci-machines.sh`) | the controller left out of an off machine's shape (its hash pinned in `tests/store.test.ts`); entries matched to the browser's devices (serial-less twins by order), the messages' remedies, the ports against a fake device worker, the locks between tabs (who holds one, Detach there); the USB tab, the wizard, a definition on another profile (Allow, Forget revoking); Gadget Zero attached from the menu, seen by the guest, unplugged around a snapshot and back |
| The Machine menu ([frontend.md](frontend.md) "Views, settings and the disk") | `tests/page-machine.test.ts` (Buildroot, ~6 s; its graphics test on Debian in `scripts/ci-debian.sh`) | vCPUs and RAM chosen in the menu show in the status line after the restart, are remembered over a reload, and `?ncpus=`/`?ram=` win; Graphics: 3D by default, 2D from the menu after its restart and over a reload (the page's `data-graphics`), `?gpu=virgl` over it with the choice greyed out; the RAM above 1 GiB with the gpu is Debian's (`scripts/ci-debian.sh`, once a default) |
| The network on Debian ([frontend.md](frontend.md) "Network") | `tests/network.test.ts` (the page's controller and parsers, a fake client; always), `tests/net-guest.test.ts` (with `WEBPC_DISTROS=debian`: the page's Debian with a card on the echo gateway configures itself from its command line and pings any address over IPv4 and IPv6, and takes a late lease in both families, ~3 min), `tests/page-network.test.ts` (the Network menu against an unreachable control server: form errors, the card, the connection kept but not the key, Disconnect, an ephemeral connection gone after a reload; ~4 min), `tests/net-tailnet.test.ts` (Debian on a headscale tailnet: DHCP lease = the client's address, ping (v4 and v6) and MagicDNS to a peer, the peer reaches a server in the guest over both; then, **opt-in with `WEBPC_TAILNET_INTERNET=1`** (it needs the real internet; skipped loudly otherwise; passed 2026-10-01, ~100 s whole test), the peer as the exit node: the internet (1.1.1.1, example.com) and DNS through it, and the guest's IPv6 default
there only as the peer has an IPv6 route out (the probe, web/reach6.ts: rootless Podman gives it none, so it goes),
back once the exit node is cleared. Its targets must be public: Tailscale's exit nodes never forward RFC 1918, CGNAT or link-local destinations, their own LAN included. The dev VM's LAN address failed as a stand-in for the internet (curl exit 28). Needs Podman and `target/net/ts.wasm` (the page's client); it also pings the peer by its short name (the guest must take the lease's search domain: `UseDomains=yes`, [frontend.md](frontend.md) "Network"; `HEADSCALE_DOMAIN=` runs the rig with another MagicDNS domain, e.g. a `.local` one); `scripts/ci-net.sh` sets `WEBPC_TAILNET=1` when Podman is there, ~2 min; the tailcat backend (docs/tailnet.md): `tests/ts-client.test.ts` (the Rust client's module with a stub WebSocket; always, once `net/ts/build.sh` ran), `tests/tailcat-browser.test.ts` (Chromium, no guest: the page's tailcat client against `tests/net/tailcat.sh`'s exit node comes up and carries UDP; ~10 s) and `tests/net-tailcat.test.ts` (Debian through the exit node: both leases, HTTP, 2 MB down and 2 MB up (virtio-net's TSO: under 1,000 packets leave the guest's interface) to this machine's LAN address over IPv4 and IPv6; the IPv6 probe (web/reach6.ts): without an IPv6 address on this machine it is lost, so the guest has no IPv6 default,
keeps the tunnel's /48 (the tailcat clients come in over it) and gets curl's "couldn't connect" at once over IPv6;
with one, a stand-in resolver on it (`tests/net/resolver.ts`) answers, and the default is there, goes within 14 s when
the stand-in stops (the /48 back within 2 s: the gateway's second advertisement) and comes back; the internet opt-in
with `WEBPC_TAILCAT_INTERNET=1`, plain `curl` (IPv6 out, it uses IPv4). No stand-in works without a real IPv6
address: the exit node drops `::1` and `::ffff:127.0.0.1`, and answers from `64:ff9b::/96` reach the guest as IPv4.
The real targets answering was checked by hand: `tailcat serve exit-node` on the Mac (built here with `GOOS=darwin`,
kept in `~/webpc-tailcat`), the page's Debian through it. **The IPv6 part needs a non-link-local IPv6 address on a non-loopback interface**, which Lima's VM lacks: `sudo ip -6 addr add fd00:7e57::1/128 dev eth0 nodad` before the run, or it says SKIPPED; the exit node doesn't answer its own `[::1]`), both with `WEBPC_TAILCAT=1`, which `scripts/ci-net.sh` sets when Go is there (it builds tailcat and derper)); the Rust Tailscale client (docs/tailnet.md "Tailscale"): `cargo test -p webpc_ts` (Noise, HTTP/2, the netmap, the store, the session against a fake control server, the filter, the exit node, MagicDNS; always), `tests/ts-tailnet.test.ts` (in Node against the test tailnet: the kept node handed over with the Go client (`net/tailscale`, now only this test's fixture), run in a Node worker, both ways; the netmap against the peer's; interactive login; a stand-in guest's pings, DNS, UDP and TCP, the peer's disco ping and connection in; ~1 min), `tests/tailscale-browser.test.ts` (the client in Chromium, no guest: Running, the lease, 2,000 echoes; a kept node through reloads; logout), both with `WEBPC_TAILNET=1`, and `tests/ts-tailcat.test.ts` (`WEBPC_TAILCAT=1`: the module in Node against the tailcat rig, its relay's WebSocket cut off while it stays open (`tests/net/tailcat-blackhole.ts`): the guest's echoes come back within ~8 s on a new connection; ~15 s), run one at a time by `scripts/ci-net.sh`'s last step (each brings the test tailnet up on the same ports). Without Podman (a cloud session) `WEBPC_TAILNET_SCRIPT=tests/net/tailnet-native.sh` runs the same tailnet natively) | the gateway's bytes are `tests/gateway.test.ts` and `tests/devices.test.ts`, virtio-net's offloads' `tests/offload.test.ts`; these test what the guest and the page do with them. The Debian ones take turns through `tests/debian-lock.ts` |
| `npm start` ([frontend.md](frontend.md) "`npm start`") | `tests/start.test.ts` (the checks: ms; the run: ~5 s, with `WEBPC_DISTROS=debian`) | the Node-version and rustup messages (an old Node faked with `--import`; a `PATH` with Node alone), the npm staleness rule, the core's input hash; then a copy of the repository as a clone has it (tracked and untracked files, no `node_modules` or `target/`) runs `npm start` (PORT=0): `npm ci`, no disk image prepared (no "Debian" in its output), the URL printed, the page waits for a disk ("Open a disk image"), then, given this checkout's Debian linked into the copy (`?disk=`), boots it in Chromium until the firmware writes to the serial console, and a second start with nothing to do takes < 5 s (~0.1). The copy gets this checkout's core and a matching stamp; **`WEBPC_START_COLD=1`** makes it build its own (the whole path a user takes; run it when `start.ts` or the build changes) |
| Host code | `tests/{devices,overlay,qcow2,ext4,fat,serve,wasm-encoder,core-wasm,memory-kernels}.test.ts` | 9p server, loopback adapter, input config, overlay, qcow2 fixtures (compressed clusters also under a DecompressionStream that loses a write's output to the junk after the stream, as Firefox's does; planted: no byte-by-byte retry; a request's clusters inflated in one batch, and through the inflate pool's workers in Chromium; planted: a worker that drops its clusters' bytes), the FAT12 writer (its layout; `fsck.fat` and mtools read it back, where installed), the ext4 reader and partition tables (`tests/ext4/make.sh`'s fixtures against their manifest), the dev server (ranges, the page, the `node_modules` allow-list), the encoder |
| Snapshots: the core's state ([platform.md](platform.md) "Snapshots") | `cargo test` (unit: `vm/tests.rs`, `virtio/tests.rs`, `cpu.rs`); `core/tests/boot.rs`, `core/tests/distros.rs` (`Boot::snapshots`: the VM saved, dropped and restored into a new one on a copy of RAM at given steps) | unit: a machine with a timer, console output and a device (one chain answered, one held) saved at each of 300 consecutive steps and restored runs on to the unsaved machine's registers, steps, console and RAM, and saves the same bytes; WFI and idle; refusals (another version, each configuration word); every prefix refused and every byte changed in turn refused or run without a panic; the pinned bytes of a fixed machine (a layout change needs `snapshot::VERSION` bumped); the realtime clock continuing and the RTC showing the new host's time; a transport's in-flight chains posted again in order, and states that can't be. Natively, with the steps of `tests/steps.txt` and an unbroken run's console: Buildroot through 28 saves on 1 vCPU and 12 each on 2 and 4, the device test through 40 (net's 256 receive buffers held, 9p and the disk mid-conversation), console input with bytes waiting in the RX ring, Alpine through 8. Planted: a register not restored, a queue's used index not restored, an in-flight chain not posted again (each fails the unit tests and the boots). **Parallel mode** (the VM saved between runs of its vCPU threads, every thread out of the core, and a new one restored): unit (a CPU_ON request not yet taken, WFI, an off vCPU, and the same realtime state restored under the other run mode; a fired timer's line and a device interrupt raised by the save itself reach the restored vCPU); `core/tests/baremetal.rs` (every test through snapshots at growing intervals, round-robin and parallel), `core/tests/boot.rs` (Buildroot on 1, 2, 4 threads, ~27 saves a boot), `core/tests/litmus.rs` (litmus and the stress through 12 saves round-robin with exact steps, and in parallel), all under ThreadSanitizer too. Planted: the realtime counter not rebased, a restored vCPU's timer lines not taken from the GIC, the IRQ lines not published after a restore (each fails its unit test; a Buildroot boot notices none of them: Linux rides out a counter that steps back) |
| The host-visible window and its write-watch (VK1, [devices.md](devices.md) "The host-visible window") | `core/src/virtio/tests.rs` (SHM region 1), `core/src/vm/tests.rs` (`the_window_follows_ram_in_memory_0`), `tests/core-wasm.test.ts` (a window of part of 2 MiB refused); `tests/baremetal/watch.c` through `core/tests/baremetal.rs` `window_watch` (round-robin and parallel; interpreter and block interpreter) and `tests/window-watch.test.ts` (wasm: interpreter, block interpreter, JIT, its JIT steps checked) | each look reports exactly the pages a phase stored to (hot loops, a page-crossing store, LSE and exclusive atomics), a page written again after a look comes back, one only read doesn't. Planted: no mark when a record is dropped (phase 1 fails), records never dropping their entries (phase 3, natively and in wasm under all three) |
| USB: the xHCI and its devices ([usb.md](usb.md)) | `core/src/xhci/tests.rs` (the controller on hand-built rings); `tests/usb.test.ts`, `tests/usb-glue.test.ts` (Node: the virtual device base, Gadget Zero, the glue on the core's ring layout); `core/tests/common/usb.rs` (the native twin); the usb guest: `core/tests/usb_guest.rs`, `tests/boot-node-suite.ts`, `tests/browser.test.ts` (`images/build.sh linux-usb`), its options and checks in `tests/usb/` | unit: bring-up and the protocol capabilities; attach, reset (the first one the core's), suspend and resume, detach; enumeration with BSR and a short control read; bulk TDs across a Link TRB, immediate data, a short bulk IN; a stall through Reset Endpoint and Set TR Dequeue; Stop Endpoint with TDs in flight (a completion before it taken first, late ones dropped, the rest posted again); in realtime mode its completion held until the backend read the cancel; an unplug in flight; TRB errors; a full event ring; Deconfigure; HCRST; the completion latency; a halted TD's dequeue after a Link TRB; snapshots. **The usb guest** (`usb-hubs`, `usb` in `tests/steps.txt`): Linux with `xhci-plat-hcd` and `usbtest`, a static init and the kernel's `testusb`: the two empty root hubs; then `testusb -a` against a high-speed and a super-speed Gadget Zero (`pattern=1`): a clean pass, passes until connector 0 is unplugged at step 95M (mid-pass 2), a clean pass after it is plugged in again at 150M; natively, in Node (interpreter, JIT) and in Chromium (the device worker, interpreter and JIT) the same steps and console. Parallel SMP (2 vCPUs, no hot-plug: one clean pass, three runs), natively and in Node. Planted: the Short Packet event reported as Success (two unit tests and testusb's first pass fail); the realtime Stop Endpoint completing before the backend read its cancel (its unit test). **The built-in keyboard** (docs/usb.md "The keyboard"): `tests/usb-keyboard.test.ts` (Node: descriptors, reports, rollover, LEDs, idle, protocol, `usb-key` through the glue); `tests/page-usb-keyboard.test.ts` (Chromium, Debian, ci-debian: GRUB stopped and driven from the screen through EDK2's USB keyboard, a held Shift seen by `keystatus`, the keyboard gone from the guest once its virtio keyboard is live) |
| Guest RAM past memory 0: spill memories as NUMA nodes ([spill-memories.md](spill-memories.md)) | `core/src/mem.rs`, `core/src/mmu/tests.rs`, `core/src/vm.rs` (`spill_memory_end_to_end`), `core/src/boot.rs` (`tests/dtb/webpc-numa.dts`), `core/src/smbios.rs`; `tests/core-wasm.test.ts`, `tests/jit-diff.test.ts` (Node); `tests/page-spill.test.ts` (Chromium, Debian, ci-debian) | unit: the host address and `Mem` across memories, a spill TLB entry missing every inline compare and served by the miss path, the DT's nodes and distance map against `dtc`, the SMBIOS credential and ranges, the page's split; natively and in Node (interpreter, block interpreter, JIT-stress) loads, stores, exclusives, LSE, DC ZVA and code in a spill memory. `tests/jit-diff.test.ts`: the JIT's spill arm, the load and store classes with the MMU on and data in spill memories 1 (inline) and 2 (the helper), an interpreter VM against a JIT-check VM, and a warm load on memory 1 making no helper call (planted: the arm naming memory 0; LD1's lane load and STXP's W pair left on memory 0); `jit::emit::tests::loads_and_stores`: its bytes, and none without spill memory. the page: the split in shapes and definitions, its note (`tests/store.test.ts`), the advanced section of Settings checked, saved and kept (`tests/page-modal.test.ts`). **Debian with `?split=2560,1024,512`**: the Machine menu's note, three nodes, both CPUs on node 0, distance 20, `numa_balancing` 0 with the credential listed, a tmpfs bound to node 1 read back intact, and direct disk reads into and writes out of a process bound to node 1 and out of one bound to node 2 (systemd's `NUMAPolicy`) intact; then a snapshot saved and loaded in a fresh profile (a shell variable and node 1's tmpfs as they were). `tests/snapshot-plan.test.ts`: the spill memories' RAM round trips and restores only onto the same split; `tests/snapshot-file.test.ts`: pages past 2 GiB. Planted: the backends' views ignoring the segment's memory (the disk check fails) |
| USB through real devices ([usb.md](usb.md) "The usbhost guest") | `tests/usb-guest.test.ts` (Chromium, realtime, JIT; `scripts/ci-usb.sh`, the dev VM's dummy_hcd and uhid rigs, `images/build.sh linux-usbhost`); the backends alone in Node: `tests/usb-webusb.test.ts`, `tests/usb-webhid.test.ts`, `tests/usb-hid-descriptor.test.ts` | the guest's `testusb -a` against the dummy_hcd Gadget Zero through the WebUSB passthrough; the guest's `cdc_acm` on the ACM gadget, echoed, closed and opened again (the IN carry-over); a uhid device through WebHID: the rebuilt report descriptor, input, output and feature reports. In Node: the descriptor filter and speed heuristic on transcribed descriptors of real device types, the standard requests, halts, carry-over and code mapping against a fake USBDevice; the report-descriptor encoder against Chromium's recorded parses; the HID device's requests and reports against a fake HIDDevice. Planted: the carry-over's accounting, the protected-interface filter, the HID ID framing and a flag bit |
| A VM through snapshot files (the host: `web/vm.ts` `snapshot()`/`restore`, `web/snapshot.ts`, `web/lz.ts`) | `tests/snapshot.test.ts` (Node, JIT; Alpine's userspace benchmark with `WEBPC_DISTROS=alpine-user`); `tests/browser.test.ts` (Chromium: the device worker's backends) | the VM saved to a file, closed and a new one started from the file, several times in a run. Round-robin, with the steps of `tests/steps.txt` and an unbroken run's console: Buildroot through 9 files; on 4 vCPUs through 6 with the tier changing at each (interpreter, JIT, JIT-check); the snd guest through 6 while it plays and records; console input with 4 KiB in the RX ring and the rest queued in the host; input and net devices' held buffers; Alpine's userspace benchmark (1 GiB) through 3 (`alpine-user-snapshots`: a restore empties the TLBs, [platform.md](platform.md) "Snapshots"; `core/tests/distros.rs` `userspace_through_snapshots_is_the_run_with_tlb_flushes` shows natively that this is all the difference, on demand, ~2 min); a VM started from a file saves the same core bytes and backend state. Parallel (paused, saved, closed, new workers): Buildroot and litmus with the stress on 4 vCPUs in Node, Buildroot on 4 in Chromium. Refusals: another machine (vCPUs, RAM, devices, features), another state version, a truncated file, a cut state; a 9p device. **The disk in the file:** a boot that writes a file to its root filesystem is saved after the write; from the file, over the overlay as later writes left it and over none at all (a fresh profile), the machine finishes in the unbroken boot's steps and the next boot finds the file (Node, in-memory overlays; Chromium, OPFS, through four files in one boot); another disk, a file cut or damaged in its disk blocks, and a machine without the disk are refused with the overlay untouched; the base's hash is asked for only when the cheap identity differs. Planted: the rng's position not restored, pending serial input not restored, the config spaces overwritten after a restore, the overlay's blocks left out of the file |
| Snapshot file | `tests/snapshot-file.test.ts` | the snapshot container (`web/snapshot-file.ts`, [plans/snapshots.md](plans/snapshots.md)): CRC-32 against zlib's, round trips of every frame kind (RAM from a shared-memory view at an odd offset), 1-byte, random and Blob input, writer back-pressure and order, every refusal with its `problem`, truncation at every prefix and a flipped bit at every byte of a small file, the stored and a pluggable codec. Node only, ~3 s; buffers are compared with `sameBytes`, never `assert.deepEqual` (a diff of two RAM-sized arrays exhausts memory) |
| Decoder sweep | `core/fuzz` (not in CI) | every 2³² word vs Capstone |
| virtqueue fuzzing | `cargo fuzz run virtqueue` (not in CI) | the transport and split-queue parser |

Rules behind that matrix:
- **Interpreter runs of long guests happen natively** (Rust release builds are fast and need no
  engine): Buildroot, the device test, LTP and Alpine; natively a JIT mode runs everything in the
  block interpreter, so Buildroot and Alpine boot through it there too. Node runs the **JIT** on every guest and
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
- **Debian boots in `ci-debian.sh`** (the Debian tests take turns through `tests/debian-lock.ts`,
  two at a time there and one in `ci.sh` and `ci-net.sh`, so each boot adds to the wall time; **put
  a new Debian check on a boot that exists** unless it
  needs what that boot can't give: another profile, URL, disk or window): `page-debian` 3 (1: a
  Buildroot snapshot refused, `c` on the screen stops GRUB, login on both consoles, the platform,
  the page's size, a snapshot saved; 2: a reload, the file kept; 3: the snapshot in a fresh profile
  at another window size, Suspend and resume, a reload that boots its disk), `page-disk` 3 (1: the
  chosen file, through the serial keys' flow in EDK2 and GRUB with `?display=simple` (two firmware
  starts first; Debian's GRUB passes `quiet`, so the kernel's own echo of its command line can't be
  waited for), its overlay, fstrim, the changes saved; 2: the same file chosen again; 3: a fresh
  profile with the changes file), `start.test.ts` 1 partial (until the firmware writes to the
  console; only the page holds the lock, not the install before it). Until 2026-10-08 they were nine
  boots and five partial starts in eight files: 581 s, then 416 s merged and 229 s with two slots
  (`page-debian` alone 221 s, beside another boot 232). The rest is not repeated on Debian: Reset
  disk, a file kept over a restart and the overlay hand-over are Buildroot's
  (`tests/browser.test.ts`), the deterministic and one-vCPU JIT are Buildroot's and Alpine's. The
  network tests' Debian boots are `ci-net.sh`'s. **CI's wall time:** Node runs test files in parallel and a file's tests in
  sequence, so the long files set it. The Node boots are one suite (`tests/boot-node-suite.ts`)
  in four files that pick their tests by name (`tests/boot-node*.test.ts`: ~280 s in one file
  before). `ci.sh` runs the native guest-image tests (~130 s) beside `npm test`, not after it.
- Guest-image tests skip loudly when `target/images/<name>` is missing or stale
  (`images/build.sh --check`).

**The page's questions in tests:** the page asks with its own dialogs (`<dialog id="ask">`, docs/frontend.md "Dialogs
and the message bar"), not the browser's, so `page.on('dialog')` hears nothing: a test calls
`answerAsks(page, (q) => …)` (`tests/page-ask.ts`) before `goto`, which clicks OK on each question (Cancel when the
callback returns false; a prompt gets the string it returns) and hands the test each question's kind and text.

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
    bf16 afp dit`, `lrcpc ilrcpc dcpop dcpodp flagm uscat asimddp asimdrdm fphp
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

- **The UEFI oracle** (`tools/uefi-oracle.ts`, M8 phase B; [firmware.md](firmware.md)): our
  EDK2 build (`images/build.sh edk2`) on `qemu-system-aarch64` set up like our machine
  (ArmVirtQemuKernel via `-kernel` with QEMU's DT minus PCIe, the platform bus, the PMU, the PL061
  and its `gpio-keys`, the ITS and the seeds; the variable store in flash bank 1; virtio-mmio disks;
  Cortex-A57), booting `debian`, `alpine` (Limine) and `alpine-grub` unmodified to a root login
  and a power-off, with each stage's time. Dev-only (needs `qemu-system-aarch64`, `dtc`,
  `mkfs.vfat`, `mcopy`), not in CI. `node tools/uefi-oracle.ts debian alpine alpine-grub`: ~30 s
  for all three at once under TCG. **Finding:** QEMU's `kaslr-seed` in `/chosen` made Debian's
  boot 1.8× slower under TCG (KASLR forces KPTI on a CPU without E0PD, as the A57 is: docs/cpu.md,
  "FEAT_RNG and FEAT_E0PD"), which first looked like DT vs ACPI; without it they're equal.

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

**The core's heap (`tests/heap.test.ts`, `core/tests/alloc_hook.rs`):** a guest of millions of `b .+4` (every word a
block run once) in a test-only small heap reserve (`BootOptions.heapReserve`): 8M blocks in 320 MiB through the
block map's prunes, and 4M in 64 MiB through the safety net's rescues ([jit.md](jit.md) "The core's heap"; the core
before the bound trapped in both). The allocation error hook's message is checked natively, in a child process that
aborts.

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

**A turn for the contender (`tlbi_spin.c`):** CPU 0 holds the lock through each TLBI IS + DSB,
asleep in the DSB wait until CPUs 1–3 end their chunks, then frees it for ~50 loop iterations
before taking it again, so CPU 2's LDAXR/STXR loop wins a round only when the host has its
thread on a core in that window of ~1 µs. In one `scripts/ci.sh` run (2026-10-19) it won none of
the 100 and exited 42. An instrumented copy of the guest (CPU 2's attempts, those that found the
lock taken, failed STXRs, rounds won, gaps in its loop) showed why: on an otherwise idle VM it won
99–100 rounds, but with 4 VMs at once pinned to 3 cores (`taskset -c 0-2`) it won 0–2 in 9 runs of
60, and on one core none. The window before round 0 saved it then, but it misses that too in
about 1 run in 8 even when idle: the first compile of its loop stalls it ~150 µs right after its
`ack`. No STXR ever failed with the lock free (each failure was CPU 0 taking the lock between
CPU 2's LDAXR and STXR), and the monitor is cleared only by exclusive stores, CLREX, exceptions and
ERET, never by a drain or TLBI. So the emulator was right: the architecture promises CPU 2 no
turn, and a host may deschedule a vCPU. With CPU 2 held back until round 0 had begun (a planted
delay standing in for that stall), the old binary failed 23 of 300 runs on 3 cores and 9 of 12 on
one. Now CPU 0 notes CPU 2's wins (`won`, written under the lock) in round 0 and, after the last
round, waits until CPU 2 has won once more (exit 50 if it never does): the same variant passed 200
of 200 runs on 3 cores and 30 of 30 on one, and an idle run takes as long as before (~110 ms).
To stress it by hand, crowd its parallel runs onto a few cores:
`WEBPC_PARALLEL_RUNS=30 taskset -c 0-1 node --test --test-name-pattern='tlbi_spin' tests/boot-node-parallel.test.ts`.

## kvm-unit-tests

Commit `5a221342a025`, booted with one CPU and 256 MiB; `EXIT: STATUS=` from the UART. Every
`unittests.cfg` entry is run or skipped with a reason, and the runner fails if a new one appears.
Pass: `selftest-setup`, `selftest-smp`, `selftest-vectors-kernel`, `selftest-vectors-user`,
`psci` (with the concurrent cpu-on check enabled), `gicv3-ipi` and `gicv3-active` (4 vCPUs),
`timer`, `cache`, `debug-bp`, `debug-wp`, `debug-sstep` and their `-migration` variants (the key
`migrate_once()` waits for queued from the start, the VM saved and restored at 15 points over the
run and 21 more packed toward its end, where the tests arm; in Node the three without migration,
under the JIT and JIT-stress too). Skipped: `gicv2-*` (no GICv2), `its-*`, `pmu-*`, `pci-test`,
`micro-bench`, `fpu-context` (KVM only), `mte-*`; `sieve` (not in `unittests.cfg`; too slow
interpreted).

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
  It caught all three rustc/LLVM `simd128` miscompiles. The V registers live in locals: only
  sequences (and regions) see a dirty one not written back before a helper or one not dropped
  after it, so "NEON, FP and V helpers" mixes inline NEON, FP and V loads and stores with
  helper-only words on the same V registers (FRECPS on doubles, URECPE, FSQRT, scalar and vector
  FRINTA, USQADD on a D register), from whole registers of FP lanes. The integer NEON classes
  get registers of integer lanes of one size with edge values (the saturating, rounding and
  doubling limits) a third of the time. `WEBPC_JIT_DIFF_HELPERS=1` prints each class's helper
  calls by instruction, from allocated words only (unallocated ones go to the helper too and hide
  the rest): what's still missing from the JIT. On the flat bus a load's slow path never
  returns normally (outside RAM is an abort), so a load that keeps its V destination's stale
  local after the helper shows only under the MMU: the Alpine userspace boot caught it, lockstep
  and Buildroot didn't.
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
- **Paths the page doesn't take:** round-robin SMP, Node's deterministic runs and user-mode vCPUs have no compile
  worker (every module's `seq` 0). A "parked on seq" check that didn't exclude 0 parked them for good: Firefox and
  the gates couldn't see it, lockstep and the bare-metal tests did. Run `tests/jit-lockstep.test.ts` and
  `tests/jit.test.ts` on any change to installs before measuring. In round-robin one cache serves every vCPU, each
  with its own TLB: state derived from the cache but kept per vCPU must notice the cache's changes per vCPU
  (`Cache::drops` against `Tlb::xdrops`; a one-shot flag was consumed by whichever vCPU ran next). On parallel vCPUs
  code read twice can differ: read guest code once per decision; a repeated boot loop (500 boots in ~5 min) finds
  such races, CI only sometimes.
- **A bad table index** (a "function signature mismatch" in a worker): dump every index the vCPU's JIT state can
  call (the jump cache, hot-word redirects, the transfer cache) at the trap and test each against the worker's table.
- In parallel mode input timed by steps is wrong (the vCPUs' summed steps say nothing about how far the boot is):
  wait for the prompt; and a test that waits for a shell must never match the console's end (count prompt lines:
  `trim.test.ts` failed 1 in 40 under load until it did). `scripts/ci.sh` runs the native tests from the working
  tree: don't edit `core/` while it runs, and read its result before committing.
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
  | `tests/boot-node*.test.ts` | parallel, JIT / JIT-check | `-s 1000 -r 10` (`-r 50` with `WEBPC_LONG_TESTS=1`, as `ci.sh` runs it), `-n 100000` / `-s 100 -r 2`, `-n 10000` | 18 s / 43 s (JIT-check's boot is 30 s) |
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
  JIT run uses `-r 50` in `scripts/ci.sh`, where the unfixed build failed 5 of 5 runs
  (`-r 10`, a plain `npm test`, caught it in 1 run of 3). To look for such a
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

## The FP suite (`images/build.sh fptest`)

Hand-written FP tests have been wrong where the code was (ed20c9f: a double FMA whose Dekker
product overflowed, which random inputs never made), and the golden corpus sets FPSR.IXC in only a
fifth of its FP tests, so the inline fast paths that need it (anything that rounds) saw a few
hundred cases a form. The suite takes its cases and its answers from Berkeley TestFloat and
SoftFloat instead, and real hardware checks its rules.

- **`images/fptest/fptest.c`** (static, with SoftFloat 3e's ARM-VFPv2 build linked in): reads
  `testfloat_gen`'s cases per operand type (f16/f32/f64 with one to three operands, the four integer
  types) and runs each through every form that takes it (`images/fptest/forms.py` lists them: FADD …
  FNMUL, FMADD … FNMSUB, FMLA/FMLS vector and by element, FSQRT, FMAX/FMIN/FMAXNM/FMINNM, FCMP/FCMPE
  (with zero), FCCMP/FCCMPE, FCSEL, FCMEQ … FACGT and the compares with zero (scalar and vector),
  FRINTN/A/P/M/Z/X/I, FCVT between half, single and double, FCVTL/FCVTN/FCVTXN(2), FCVT{N,A,P,M,Z}{S,U}
  to W, X and V registers, SCVTF/UCVTF from W, X and V registers; scalar, 2S, 4S and 2D), under
  each FPCR rounding mode × FZ × DN and with FPSR clear or with IXC already set. A vector's lanes
  are consecutive cases, so a plain lane sits beside an odd one. What each must give is SoftFloat's
  result with tininess before rounding and ARM's rules on top: FZ flushes denormal single/double
  inputs (IDC) and tiny results (UFC, no IXC); DN; NaN propagation in operand order (the addend first
  for the FMAs, and a quiet-NaN addend with ∞ × 0 is Invalid); FPNeg on NaNs (FNMUL, the negated FMA
  operands); saturating integer conversions; FMAXNM's quiet NaNs. Options: `-level 1|2`, `-every k`
  (a sample of a level; 3-operand types default to every 64th of level 1's 6.1M), `-n`, `-part k/n`,
  form-name prefixes. A type small enough for one chunk (the one-operand floats and the integer
  types: 372–768 cases at level 1) runs again until each form has run ~64k times: on 4 parallel
  vCPUs the JIT installs a compiled block only once the compile worker is done, and a form's
  12k checks finished interpreted (planted bugs in the fixed-point conversions went unseen).
- **Real hardware first:** `fptest.tar` (the programs and `run.sh`) passes on the oracle VM, and
  natively in the dev VM (also the M4): ~300M checks, 0 failures, in ~20 s. A rule wrong in the
  harness fails there.
- **In the guest:** `initramfs.cpio` (BusyBox, `images/fptest/init`: a part of the forms on each
  CPU) boots on `linux/Image`; `tests/fptest.test.ts` runs it on 4 parallel vCPUs under the JIT
  (~90 s; `WEBPC_FPTEST_INTERP=1` adds the interpreter, `WEBPC_FPTEST_ARGS` passes options,
  `WEBPC_FPTEST_CPUS` the vCPUs). The harness's loops get compiled, so its instructions run the
  inline code; each one follows `MSR FPCR/FPSR`, which ends a block, so it starts a block (the FP
  guard reads the FPSR it just set).
- **Planted** (2026-10-18): the single FMA's midpoint branch skipped, scalar FRINTA's tie test
  made strict, FCMP's lt and gt swapped: each failed its forms (44–1.3M failures), nothing else.
- Also FABD, FMULX (∞ × 0 is ±2), FRECPS/FRSQRTS (FPNeg on the first operand, fused; FRSQRTS's
  (3 − ab)/2 as 1.5 + (a/2)·b, so it can't overflow where the halved result doesn't), FRECPX,
  FRECPE/FRSQRTE (the ARM ARM's RecipEstimate and RecipSqrtEstimate, without FEAT_RPRES), the
  pairwise ops (FADDP, FMAXP … on Vm:Vn, and the scalar pairs) and across-lanes ones (FMAXV …,
  reduced pairwise as ARM does), and the fixed-point conversions (fbits 1, 16, 32 and 64): 482
  forms. Models planted wrong (the estimate's rounding, FRSQRTS's 1.5, the reduction's order) fail
  on the M4. Not covered: FP16 arithmetic (not advertised).

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
Go or C churn binary put on the guest), `--no-load` (no built-in load; the `--guest-cmd` ones still start), `--query` (added to the page's query, e.g. `jit=nocw`), `--disk2 <repo path>` (a read-only second disk: `images/stress/build-goroot.sh`'s Go toolchain, whose `go build` loop the JIT's cache was measured with: [jit.md](jit.md) "Sharing"), `--stall-ms` (2000), `--freeze-ms` (10000),
`--warmup` (150 s from the tool's start, left out of the memory and speed trends). Exit code 0 clean, 1 findings, 2 the
harness failed (no login).

Debian boots with the page tests' unattended credentials (`tests/debian-unattended.ts`), so no
first-boot questions stop it. What a sample holds (`type: "sample"`): the page's state and message, the status the page shows
(`data-status`: uptime, steps, JIT blocks, compile time, flushes, JIT steps and bytes compiled, IRQs, the run loop's cadence, per-vCPU
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

## USB: the dev VM's host rigs

Lima's `vz` passes no host USB devices through, so the test devices come from the VM's own kernel
([usb.md](usb.md) "Findings"). All of this is dev-VM-only: a cloud container can't load modules.

- **Setup, once per machine** (and after a kernel update): `tests/usb/gadget.sh install` (passwordless sudo). It
  builds `dummy_hcd` for the running kernel and installs it with a udev rule, a modprobe blocklist (`usbtest` and
  `cdc_acm` stay off the host's side of the gadgets) and Chromium's managed policy ([devenv.md](devenv.md) "The USB rigs"). `tests/usb/gadget.sh check` says what's missing.
- **The gadgets** (`tests/usb/gadget.sh up|down|status [name...]`): configfs gadgets on `dummy_hcd`'s four UDCs,
  at high speed. `zero` is Gadget Zero (`0525:a4a0`, serial `webpc-zero`), with configuration 1 source/sink
  (pattern 1: `i % 63`) and configuration 2 loopback. `zero-a` and `zero-b` are two without a serial, which differ
  only in bcdDevice (1.01 and 1.02). `acm` is a CDC ACM port (`0525:a4a7`, serial `webpc-acm`). `ci-usb.sh`
  brings up `zero` and `acm` and takes them down after.
- **The uhid rig** (`tests/usb/uhid.ts`) needs no command: a test makes its devices with
  `new UhidDevice(descriptor)`, and they go away with the process. The descriptors are in
  `tests/usb/hid-descriptors.ts`. `node tests/usb/uhid.ts [id...]` keeps some up by hand and prints what the host
  sends them. Its `keyboard` device is also a keyboard and mouse to the VM's own input: send it only empty reports.
- **Permission** comes from the policy alone. It grants the 0525 gadgets (WebUSB) and every HID device (WebHID) to
  `http://127.0.0.1:8190`–`8197`, exact origins only, so a test serves its page on one of those ports
  (`tests/usb/rig.ts` `PORTS`). On Chromium 153 the DevTools protocol's `DeviceAccess` prompt events never fire for
  WebUSB or WebHID: `requestDevice` in headless Chromium waits forever, and no test can answer a chooser.
- **Tests:** `tests/usb-e2e-webusb.test.ts` (Gadget Zero's control, bulk and loopback transfers and the ACM
  gadget's interfaces, from a worker) and `tests/usb-e2e-hid.test.ts` (Chromium's parse against
  `tests/usb/hid-fixtures/`, and reports both ways, protected collections included), both in `scripts/ci-usb.sh`.
- **The fixtures** `tests/usb/hid-fixtures/<id>.json` hold Chromium's parse (`HIDDevice.collections` as JSON) of
  each uhid device, with the raw descriptor as `descriptor` (hex) and in `<id>.rdesc`. The WebHID device's encoder
  round-trips against them. `node tests/usb/hid-record.ts` records them again when the pinned Chromium moves, and
  `usb-e2e-hid` fails until then.
- **The QEMU oracle** (`tests/usb/oracle.sh`): the linux-usb guest on `qemu-system-aarch64 -M virt` (TCG) with
  `qemu-xhci`, and Gadget Zero passed in with `usb-host`. It runs each of testusb's tests in a boot of its own
  (~1 s each), with the usb guest's arguments on ours, and prints ok, the errno, or hung. `--trace` adds QEMU's
  `usb_xhci_*` trace events beside each console log, with the doorbells, transfers and queued events and their
  completion codes, to compare our controller's behavior with. **Finding (2026-10-18, QEMU 11.1.2):** 0–23 and
  25–29 pass or are skipped by usbtest for this device (15, 16, 22 and 23 need isochronous endpoints, 25–28
  interrupt ones). Test 24 (unlink from queues of writes) hangs every time on QEMU. In the run with `-c 10` alone
  (32-deep queues), the guest's xhci-hcd logged events for TRBs that weren't part of any TD. That is a QEMU
  `qemu-xhci`/`usb-host` behavior, not ours, so compare 24 against the native runs instead.
- **Sizing:** `node bench/usb/run.ts` (WebUSB's cost per transfer and bulk throughput from a worker, with a native
  usbfs baseline; usb.md "Findings", `bench/usb/REPORT.md`).

## USB: real devices on the Mac

The dev VM sees no real USB devices, but the Mac mini that hosts it does. A by-hand check (not a test in any
`ci-*.sh`; usb.md "Findings") runs the page in a headless Chrome on the Mac, driven from the VM:

- **The browser:** Playwright's Chrome for Testing, already on the Mac (`~/Library/Caches/ms-playwright/chromium-*`),
  started over SSH with `--headless=new --remote-debugging-port=9223 --user-data-dir=/tmp/webpc-cft`. It listens on
  the Mac's `127.0.0.1:9223` (with `--remote-debugging-address=127.0.0.1` it took `[::1]`). Start each session
  with a fresh profile (`rm -rf /tmp/webpc-cft` first): a reused one listed none of the policy's devices.
- **The tunnels:** from the VM, `ssh -N -R 8193:127.0.0.1:8193 -L 9300:127.0.0.1:9223 macmini.lan`, with
  `PORT=8193 node tools/serve.ts` in the VM. The page is then the Mac's `http://127.0.0.1:8193`, and the VM drives
  the browser with `chromium.connectOverCDP('http://127.0.0.1:9300')`. Lima forwards the VM's own listening ports to
  the Mac's loopback too, so don't forward a port to the Mac that the VM also listens on.
- **Permission** is a managed policy again, which needs the user's `sudo` on the Mac: a plist with
  `WebUsbAllowDevicesForUrls` (the devices' vendor and product IDs, for `http://127.0.0.1:8193`) in
  `/Library/Managed Preferences/com.google.ChromeForTesting.plist`, then `sudo killall cfprefsd`. Chrome for
  Testing reads that domain, not its bundle identifier's (`com.google.chrome.for.testing`); `chrome://policy`
  renders blank to `innerText` in headless Chrome, so check with Playwright's `getByText`, or just with
  `navigator.usb.getDevices()`. Remove the plist afterwards.
- **The guest:** a stored Debian machine written into the store from the page (as `tests/page-usb-guest.test.ts`
  does), with the devices in `usbDevices` and *attach at start*, since the chooser can't be answered. Commands go
  through the page's terminal; it holds only what is on screen, so long output is better written to a file in the
  guest and read back in short pieces. Interactive bash drops the rest of a command line when a child dies of
  SIGINT, so stop a timed run with `timeout` (SIGTERM) or a count, not `timeout -s INT`.

## A test file that never ends

`node --test`'s spec reporter prints a file's results only when the file's process ends (only the first file's stream as they come),
so a file cancelled with "Promise resolution is still pending but the event loop has already resolved" and
nothing printed may well have passed every test: its process stayed up for a ref'd handle left behind. In a report
(`node --report-signal=SIGUSR2 --report-on-signal`, `kill -USR2`), a listening `MessagePort` is an `async` handle with
`is_referenced: true` (not a pipe or a worker); `Atomics.waitAsync`'s timeouts are unref'd `timer` handles; the JS stack
is always empty from a signal; and `ps`'s `%CPU` is the average over the process's life, not its current use.
`tests/pause.test.ts` hung like that four times under `scripts/ci.sh` (2026-10-18 to 10-27): `Devices.serve`, which
yields through a `MessageChannel` every 2 ms of work and keeps listening on it, missed a `close` that landed during the
yield and waited on the doorbell for good, its port keeping the process up. It re-checks the close after the yield and
closes the port on every way out; `tests/devices.test.ts` closes in that window.

## Out-of-context reviews

Loops review their own work with a context full of their own theory; a fresh reader finds what they miss (VK3,
2026-10-27: one static review of the path of a VA-API picture under Venus found 14 real defects: VK3-HANDOVER.md
"The green"). So, besides the tests:
- **When:** at each track's end, over the code the track changed (before its final CI); mid-track every ~3 loops,
  or after a loop that adds a subsystem (a new path through the driver, the worker, the core), over that area.
- **Who:** a fresh agent (a subagent, or a cloud session: [cloud.md](cloud.md)) with only the repo. Read-only on
  main.
- **The brief:** short and neutral: the area and its entry points (docs and files), "a careful static review for real
  defects: races, missing ordering or synchronization, lifetimes and reuse, silent failures, spec gaps, state that
  differs between a first and a later run". A symptom may be named when there is one, never a theory, the
  handover's findings or what has been ruled out: they steer the reader away from what they didn't think of.
- **The output:** one Markdown file on a `review/<area>` branch, findings ranked, each with file:line, the defect,
  the condition or interleaving that triggers it, and a test that would confirm it; plus what was checked and found
  fine.
- **After:** the supervisor (or the session) triages each finding into a fix loop or the backlog. A fix starts with
  its confirming test, failing first (as a planted bug for a JIT rule). The findings move into docs/backlog as they
  are fixed or filed; the branch is deleted.

## Planned layers

- **In-guest suites** not yet run: more LTP areas (need `mkfs` tools and a scratch disk), the
  kselftests `fp` and the generic suites, language test suites (Python), guest JITs (Node/V8,
  LuaJIT) for code invalidation.
