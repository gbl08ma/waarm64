# HOST: handover

The brief and the user's answers: [HOST-KICKOFF.md](HOST-KICKOFF.md). This file is the current state and the plan.

## State (2026-11-20, night)

- **Review**: three out-of-context static reviews on the branch `review/host` (`review/host-gpu.md`,
  `review/host-vm.md`, `review/host-io.md`; line numbers from before the reformat).
- **Linters** (5ff933ca): Prettier formats `web/*.ts` (869d55e2, blame-ignored); ESLint's host block
  (docs/host-code.md §3), what remained grandfathered in the suppressions (they shrink as the lanes fix things).
- **Fix lanes, committed**: graphics b8f4744b, network/USB/sound 9592a39f, VM/storage 5fc65fe3 (their messages list
  each defect and its test). **Split**: graphics 3debeab1 (moves; the three big classes stay whole: their seams are
  methods over private state).
- **In flight** (uncommitted in the main checkout, each lane on its own files): the network/sound/input split
  (Q1 IP-port host, Q2 worker handle, Q3 frame socket, snd.ts/names.ts/input.ts splits) and the vm.ts/devices.ts split.
- **CI**: the merge's lanes all passed (ci.sh at 2b1b26fb; ci-debian --platform, ci-machines, ci-net, ci-usb,
  ci-graphics, ci-audio after three test fixes: page-debian ×2, room-browser). At 5908a9ec, ci.sh and the topic lanes
  running; nothing past origin/main 3c6a5e38 is pushed yet.

## Next

1. Commit the two split lanes; prune suppressions (`--prune-suppressions` on their files).
2. The whole CI set at the result, plus `ci-jit.sh` (exit view caching in vcpu-worker), `ci-deqp.sh` (P3 index
   uploads, the renderer split) and `ci-deqp-vk.sh` (the Venus split, vsubmit transfers). Push.
3. One Chromium A/B (bench/run.ts, ≥3 alternated rounds) of the hot-path changes against 3c6a5e38's wasm-identical
   page: Alpine userspace and a graphics scene; numbers in a `bench/host/REPORT.md`.
4. Backlog: the lanes' leftovers (below). Docs: docs/host-code.md grows what the lanes learned.
5. The end: PLAN.md's row done, this file and the kickoff deleted.

## Leftovers for the backlog (from the lanes)

- gpu: D5 (a Venus import not detached at an unref while attached: Linux detaches first); the floor never comes down
  in a session; P2 (program key per draw), P4 (video frame pools), P6 (Venus import wrappers); P9's Venus fence keys,
  pollQueries, Screen.damage; the `Resource` union in gpu.ts; VenusShare/VenusImport `warned` Sets unbounded; C
  comments in vk/ still name web/venus-gpu.ts for what moved to venus-caps/venus-formats/venus-wgsl.
- io: P1(b) (14 bytes of headroom in IP-port packets), P7 (frame ports take batches), P8 (snd allocations), P10
  (pointer events: cached rect, flat Int32Array); input.ts's double blur, usb-keyboard's `actual`, room-worker's
  namesFetch capture; D10 and tailcat's identity have no browser test.
- vm: `onerror` after ready isn't routed into `failed`; the synchronous XHR paths (deterministic) have no stall bound;
  9p's Rread scatter split; P10 (one inflate pool per device worker); Q7/Q8.
