# webpc documentation

What exists and how it works, by topic. Decisions, and every track with its state, are in [`../PLAN.md`](../PLAN.md);
measurement journals in `bench/*/REPORT.md`; third-party code and licenses in
[`../THIRD_PARTY.json`](../THIRD_PARTY.json) ([third-party.md](third-party.md)). These pages describe the current state: when something
changes, edit the page rather than appending a dated note (dates and "how we got here" belong in
commit messages and the reports, unless they record a finding worth not re-discovering).

| Page | Covers |
|---|---|
| [architecture.md](architecture.md) | threads (vCPU workers), the shared memory (layout A), design principles, the code map, the toolchain |
| [cpu.md](cpu.md) | the guest CPU: ISA and features, ID registers, exceptions, system registers, MMU and TLB, atomics, FP, crypto, the decoder |
| [platform.md](platform.md) | memory map, boot and DTB, the run loop (round-robin and parallel SMP), broadcast maintenance, deterministic and realtime time, the GICv3, timer, PL011, PSCI |
| [frontend.md](frontend.md) | the page (`web/app/`): its machines, the worker protocol, the screen, the serial terminal (xterm.js); `npm start`; `npm run dist` and the deployment at vm.tny.im; the disk reader (partitions, ext4) |
| [i18n.md](i18n.md) | the page's words: the catalog in `web/messages/` (i18next), notes, keys by source, parameters, plurals and markers, errors as messages (headline and details), workers that send data, the checks (`tools/i18n-check.ts`), the docs' UI quotes |
| [copy.md](copy.md) | how the page's words are written: the voice, the level of detail, the words (disk, image, overlay, start, boot, this web app, this emulator), buttons, confirmations, errors, setup screens |
| [machines.md](machines.md) | machines as the unit: the rules, what is stored where (IndexedDB records, OPFS bytes), a disk's identity, the overlay's generation, up to 16 disks and their sources (URL, file, stored in the browser and merged into or written in place, blank, ramdisk and the tab's 8 GiB buffer pool), snapshots checked by the shape and restored by keeping or forking, Suspend on pins, definitions in and out |
| [shares.md](shares.md) | shared folders: folders on the user's computer or in the browser, kept by the browser and attached to machines as connections are, served through one virtio-9p device the page mounts in the guest; what a directory handle can't say and what the server answers, the write sessions, snapshots |
| [devices.md](devices.md) | virtio transports and queues, the device worker, blk/qcow2/overlay, net, 9p, input, virtio-gpu and virgl's device side, snd, framebuffer |
| [remote-disks.md](remote-disks.md) | disk images on a server: what a remote boot costs, what a server must give, publishing an image (chunked, a boot trace, a name), where ours are hosted (vmdisks.tny.im, static.gbl08ma.com), why Cloudflare static assets and never R2 |
| [tailnet.md](tailnet.md) | the network backends: our tailnet client (`net/ts`, Rust wasm on tailscale-rs's crates, sans I/O) for tailcat (online through a computer of yours, the VM as a tailcat server) and Tailscale (control session, the kept node, filter, exit nodes, MagicDNS), its numbers and findings |
| [spill-memories.md](spill-memories.md) | guest RAM past memory 0: spill memories as CPU-less NUMA nodes (why NUMA, the TLB tag, the accessor, devices, the page, snapshots), where the guest puts its pages, what a spill access costs, the inline path not built, the heap floor |
| [local-helper.md](local-helper.md) | the local network helper, webpc-net (its own repository): what it serves, the page's side (the kind, the pairing link, the install lines, the client in a worker, no gateway), Local Network Access, its releases and the commit the tests pin |
| [network-adapters.md](network-adapters.md) | several network adapters per machine and the browser's connections (tailnets, tailcat, ephemeral ones): the model, the migration, the locks between tabs, the guest's routes over several adapters (the primary, the routes-only leases, the takeover's time) |
| [usb.md](usb.md) | USB devices from the user's computer: what WebUSB and WebHID allow, the xHCI and its backend protocol, the WebUSB passthrough, the WebHID device, virtual devices (Gadget Zero, the firmware's keyboard), the page's USB tab, what the measurements and real devices showed |
| [graphics.md](graphics.md) | the display and 3D: how the pieces fit (the device, the 2D presenter, the GPU worker), what the guests do with virtio-gpu (fbcon, the flush pacing, llvmpipe's stale frames), Mesa's virgl in the guest, the caps, fences and the call queue, the virgl renderer on WebGL2 (formats, WebGL's refusals, multisampling, stream output, queries), the TGSI translator, video, snapshots with 3D in use, what isn't backed, applications; Vulkan through Venus (its shape, what maps, what's emulated and what isn't offered, the render-pass rule, its known limits, what WebGPU permanently stops, what VK0 to VK3 found, what wasn't taken); measurements, findings, dEQP and the tools |
| [clipboard.md](clipboard.md) | clipboard sharing with the guest: the channel, the page's ways (sync on focus with the permission, the paste chord, the toolbar's menu), the rules (pending copies, placeholders, echoes, caps, images and HTML), the guest's agent over fw_cfg and what it costs, what each browser does, findings, the tests, what isn't measured |
| [audio.md](audio.md) | sound: virtio-snd to an AudioWorklet over a shared ring, the microphone, the guests' drivers (Arch's DKMS module), the Linux driver behavior the pacing depends on, measurements |
| [abi.md](abi.md) | the host ABI (version 28): exports, `VmConfig`, exits, counters, device layouts, the JIT host interface, version history |
| [jit.md](jit.md) | the JIT: dispatch, blocks, regions, linking, invalidation, emission, FP fast paths, what's still helpers, what was tried and dropped |
| [v8.md](v8.md) | what V8 makes of our code: costs, bounds checks, the placement effect, spills and branch hints, module reuse |
| [testing.md](testing.md) | the test layers and which runner covers what, step counts, the golden corpus and oracles, JIT tests and stress policy, litmus and atomics stress, the decoder sweep |
| [benchmarking.md](benchmarking.md) | the harness, every benchmark, the rules, current numbers, profiling |
| [images.md](images.md) | guest images: how they're built, what each is for, gotchas |
| [firmware.md](firmware.md) | booting unmodified images through UEFI: which EDK2 and what it needs of the machine, our patches, Linux under it, DT vs ACPI, the guests (credentials, seed disks), gotchas |
| [devenv.md](devenv.md) | the dev VM, what's installed and why, the USB rigs, deploying, dev-only tools, every command |
| [cloud.md](cloud.md) | Claude Code cloud sessions: what differs from the dev VM (x86_64, Node, Chromium, dtc, images) and the setup script |
| [third-party.md](third-party.md) | `THIRD_PARTY.json`, the authoritative list of third-party code and references: its sections and fields, which rows the About pane shows and why, pinned license links, the checks |
| [backlog.md](backlog.md) | open loose ends by area |
| [plans/networking.md](plans/networking.md) | exploration for M8's networking (not scheduled) |
| [plans/networking-p2p.md](plans/networking-p2p.md) | peer-to-peer rooms over WebRTC: addresses that are keys, WireGuard over data channels, DERP for signalling and fallback, a Nostr directory, names that are keys (proposed, not scheduled) |
| [plans/networking-local.md](plans/networking-local.md) | a local network helper: a Go program of ours on the user's computer, over gvisor-tap-vsock, that the page reaches by a WebSocket on loopback; Ethernet frames, no gateway in the page, IPv6 from an unmerged gvisor-tap-vsock pull request and only as far as the host has it, reproducible binaries; its own repository, `github.com/gbl08ma/webpc-net` (v0.2.0; L0 to L3 done) |
| [plans/graphics.md](plans/graphics.md) | Vulkan's plan: the bar it must meet (no program slower than on virgl), the decisions that bind it, and VK4 (its tasks in VK4-KICKOFF.md); how Vulkan works now, its map and its limits are graphics.md "Vulkan through Venus" |
| [plans/video.md](plans/video.md) | hardware video decoding (done): VA-API over virgl decoded by WebCodecs (why not V4L2), H.264, VP9 and AV1, each loop's record |
| [plans/agent.md](plans/agent.md) | a guest agent (time after a resume, a ready signal, X11 resize; the clipboard is built with our own agent: [clipboard.md](clipboard.md)): the stock agents first, then a tools disk (not scheduled) |
| [plans/clipboard.md](plans/clipboard.md) | sharing the clipboard with the guest: virtio-console's multiport, an agent of ours delivered over fw_cfg and a credential (no disk writes), the browser's prompts and placeholder reads, a toolbar switch to pause it, the user's choices (built: the CLIP track, 2026-11-07; how it works now is [clipboard.md](clipboard.md)) |
