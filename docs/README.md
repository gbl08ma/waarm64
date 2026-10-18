# webpc documentation

What exists and how it works, by topic. Plans and decisions are in [`../PLAN.md`](../PLAN.md);
measurement journals in `bench/*/REPORT.md`; third-party code and licenses in
[`../THIRD_PARTY.md`](../THIRD_PARTY.md). These pages describe the current state: when something
changes, edit the page rather than appending a dated note (dates and "how we got here" belong in
commit messages and the reports, unless they record a finding worth not re-discovering).

| Page | Covers |
|---|---|
| [architecture.md](architecture.md) | threads (vCPU workers), the shared memory (layout A), design principles, the code map, the toolchain |
| [cpu.md](cpu.md) | the guest CPU: ISA and features, ID registers, exceptions, system registers, MMU and TLB, atomics, FP, crypto, the decoder |
| [platform.md](platform.md) | memory map, boot and DTB, the run loop (round-robin and parallel SMP), broadcast maintenance, deterministic and realtime time, the GICv3, timer, PL011, PSCI |
| [frontend.md](frontend.md) | the page (`web/app/`): its machines, the worker protocol, the screen, the serial terminal (xterm.js); `npm start`; `npm run dist` and the deployment at vm.tny.im; the disk reader (partitions, ext4) |
| [devices.md](devices.md) | virtio transports and queues, the device worker, blk/qcow2/overlay, net, 9p, input, framebuffer |
| [tailnet.md](tailnet.md) | the network backends: our tailnet client (`net/ts`, Rust wasm on tailscale-rs's crates, sans I/O) for tailcat (online through a computer of yours, the VM as a tailcat server) and Tailscale (control session, the kept node, filter, exit nodes, MagicDNS), its numbers and findings |
| [usb.md](usb.md) | USB devices: the WebUSB passthrough (descriptor filter, speed, standard requests, IN carry-over) and the WebHID device (report descriptors from WebHID's collections) |
| [audio.md](audio.md) | sound: virtio-snd to an AudioWorklet over a shared ring, the microphone, the guests' drivers (Arch's DKMS module), the Linux driver behavior the pacing depends on, measurements |
| [abi.md](abi.md) | the host ABI (version 28): exports, `VmConfig`, exits, counters, device layouts, the JIT host interface, version history |
| [jit.md](jit.md) | the JIT: dispatch, blocks, regions, linking, invalidation, emission, FP fast paths, what's still helpers, what was tried and dropped |
| [v8.md](v8.md) | what V8 makes of our code: costs, bounds checks, the placement effect, spills and branch hints, module reuse |
| [testing.md](testing.md) | the test layers and which runner covers what, step counts, the golden corpus and oracles, JIT tests and stress policy, litmus and atomics stress, the decoder sweep |
| [benchmarking.md](benchmarking.md) | the harness, every benchmark, the rules, current numbers, profiling |
| [images.md](images.md) | guest images: how they're built, what each is for, gotchas |
| [cloud.md](cloud.md) | Claude Code cloud sessions: what differs from the dev VM (x86_64, Node, Chromium, dtc, images) and the setup script |
| [backlog.md](backlog.md) | open loose ends by area (PLAN.md's M9) |
| [plans/networking.md](plans/networking.md) | exploration for M8's networking (not scheduled) |
| [plans/networking-p2p.md](plans/networking-p2p.md) | peer-to-peer rooms over WebRTC: addresses that are keys, WireGuard over data channels, DERP for signalling and fallback, a Nostr directory, names that are keys (proposed, not scheduled) |
| [plans/graphics.md](plans/graphics.md) | the display and 3D: virtio-gpu 2D (G0, G1), virgl's guest side measured (G2), the virgl renderer on WebGL2 (G3), Firefox, GTK4 and dEQP passing (G4): what each loop found, the numbers; G5 proposed |
| [plans/video.md](plans/video.md) | hardware video decoding (done): VA-API over virgl decoded by WebCodecs (why not V4L2), H.264, VP9 and AV1, each loop's record |
| [plans/agent.md](plans/agent.md) | a guest agent (clipboard, time after a resume, a ready signal, X11 resize): the stock agents first, then a tools disk (not scheduled) |
| [plans/usb.md](plans/usb.md) | USB devices from the user's computer through WebUSB and WebHID: an xHCI in the core, a passthrough backend, an emulated HID device built from WebHID, what neither can attach (proposed, not scheduled) |
| [plans/uefi.md](plans/uefi.md) | booting unmodified images through EDK2: loop 0's oracle findings, DT vs ACPI, the design (M8 phase B) |
| [plans/remote-disks.md](plans/remote-disks.md) | disks from a remote server: today's HTTP reader, where to host an image (Cloudflare R2 and Pages), a chunked format, caching, concurrency (proposed) |
| [plans/machines.md](plans/machines.md) | machines as the unit (M8 phase D's start): stored machines, up to 16 disks and their sources (blank, ramdisk, a copy in OPFS that can be merged into or written in place), overlays as named variants per base, snapshots per machine checked by its shape, the Machines page (confirmed; M8 phase D) |
| [plans/snapshots.md](plans/snapshots.md) | saving and resuming a machine as a file, and Suspend (M8 phase C lane, done) |
