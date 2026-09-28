# webpc documentation

What exists and how it works, by topic. Plans and decisions are in [`../PLAN.md`](../PLAN.md);
measurement journals in `bench/*/REPORT.md`; third-party code and licenses in
[`../THIRD_PARTY.md`](../THIRD_PARTY.md). These pages describe the current state: when something
changes, edit the page rather than appending a dated note (dates and "how we got here" belong in
commit messages and the reports, unless they record a finding worth not re-discovering).

| Page | Covers |
|---|---|
| [architecture.md](architecture.md) | threads, the shared memory (layout A), design principles, the code map, the toolchain |
| [cpu.md](cpu.md) | the guest CPU: ISA and features, ID registers, exceptions, system registers, MMU and TLB, atomics, FP, crypto, the decoder |
| [platform.md](platform.md) | memory map, boot and DTB, the run loop, deterministic and realtime time, the GICv3, timer, PL011, PSCI |
| [devices.md](devices.md) | virtio transports and queues, the device worker, blk/qcow2/overlay, net, 9p, input, framebuffer |
| [abi.md](abi.md) | the host ABI (version 19): exports, `VmConfig`, exits, counters, device layouts, the JIT host interface, version history |
| [jit.md](jit.md) | the JIT: dispatch, blocks, regions, linking, invalidation, emission, FP fast paths, what's still helpers, what was tried and dropped |
| [v8.md](v8.md) | what V8 makes of our code: costs, bounds checks, the placement effect, spills and branch hints, module reuse |
| [testing.md](testing.md) | the test layers and which runner covers what, step counts, the golden corpus and oracles, JIT tests and stress policy, the decoder sweep |
| [benchmarking.md](benchmarking.md) | the harness, every benchmark, the rules, current numbers, profiling |
| [images.md](images.md) | guest images: how they're built, what each is for, gotchas |
| [backlog.md](backlog.md) | open loose ends by area (PLAN.md's M9) |
| [plans/networking.md](plans/networking.md) | exploration for M8's networking (not scheduled) |
| [plans/graphics.md](plans/graphics.md) | exploration for a real display and 3D (not scheduled) |
