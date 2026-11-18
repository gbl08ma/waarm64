# waarm64: tracks

Every track, with its state and where its outcome is written. This is an index only. What exists and how it works is in
[`docs/`](docs/README.md), the decisions that bind are in [docs/decisions.md](docs/decisions.md), the numbers are in
`bench/*/REPORT.md`, the loose ends are in [docs/backlog.md](docs/backlog.md), and how work runs is in
[CLAUDE.md](CLAUDE.md). An open track's progress goes in its `<TRACK>-HANDOVER.md`. When a track opens or ends, its row
here changes, and that row stays one line: a name, a state with a date, and links (about 200 characters at most).

## Milestones (done)

| | Milestone | Where |
|---|---|---|
| M0 | Foundations and the feasibility spike (2026-09-25) | `bench/spike/REPORT.md` |
| M0.5 | Memory architecture: layout A (2026-09-25) | [architecture.md](docs/architecture.md), `bench/spike/memory/REPORT.md` |
| M1 | The A64 integer interpreter and the golden corpus (2026-09-25) | [cpu.md](docs/cpu.md), [testing.md](docs/testing.md) |
| M2 | FP and AdvSIMD in the interpreter (2026-09-25) | [cpu.md](docs/cpu.md) |
| M3 | System level: Linux boots on the interpreter (2026-09-25) | [platform.md](docs/platform.md), [abi.md](docs/abi.md) |
| M4 | virtio devices and real distributions (2026-09-26) | [devices.md](docs/devices.md) |
| M5 | JIT tier 1 (2026-09-27) | [jit.md](docs/jit.md) |
| M6 | JIT optimization (2026-09-27) | [jit.md](docs/jit.md), [benchmarking.md](docs/benchmarking.md) "Current numbers" |
| M6.5 | The crypto extensions (2026-09-28) | [cpu.md](docs/cpu.md) |
| M7 | SMP (2026-09-28) | [platform.md](docs/platform.md), [jit.md](docs/jit.md) "Sharing" |
| M8 | A usable machine in the browser, as phases A–D that became the tracks below (from 2026-09-28) | [frontend.md](docs/frontend.md) |

## Tracks

| Track | State | Where |
|---|---|---|
| The interactive page (M8 phase A) | Done 2026-09-29 | [frontend.md](docs/frontend.md), `bench/boot/REPORT.md` "M8 loop 0"–"8" |
| Your own disk through UEFI (phase B) | Done 2026-10-01 | [firmware.md](docs/firmware.md) |
| Snapshots and Suspend | Done 2026-10-01 | [platform.md](docs/platform.md) "Snapshots", [machines.md](docs/machines.md) §5 |
| virtio-gpu 2D (G0, G1) | Done 2026-10-02 | [graphics.md](docs/graphics.md) |
| Disk I/O speed | Done 2026-10-08 | `bench/io/REPORT.md` |
| 3D through virgl on WebGL2 (G2–G4) | Done 2026-10-10 | [graphics.md](docs/graphics.md) |
| G5: 3D's breadth | Partly done 2026-10-19, the rest open (no kickoff) | [graphics.md](docs/graphics.md) "Testing", [backlog.md](docs/backlog.md) |
| Audio | Done 2026-10-12 | [audio.md](docs/audio.md) |
| Video decoding | Done 2026-10-15 | [graphics.md](docs/graphics.md) "Video" |
| Networking and the tailnet client | Done 2026-10-16 | [networking/tailnet.md](docs/networking/tailnet.md), [plans/networking.md](docs/plans/networking.md) |
| Machines as the unit (phase D's start) | Done 2026-10-17 | [machines.md](docs/machines.md) |
| USB (WebUSB, WebHID, Gamepad) | Done 2026-10-18 | [usb.md](docs/usb.md) |
| Several network adapters | Done 2026-10-19 | [networking/adapters.md](docs/networking/adapters.md) |
| Guest RAM past memory 0 | Done 2026-10-24 | [spill-memories.md](docs/spill-memories.md) |
| A browser's code in the JIT | Done 2026-10-23 | [jit.md](docs/jit.md) |
| The block interpreter's speed | Done 2026-10-22 | [cpu.md](docs/cpu.md) "The block interpreter", `bench/interp/REPORT.md` |
| Remote disks | Done 2026-10-23 | [remote-disks.md](docs/remote-disks.md) |
| Self-hosted debug | Done 2026-10-23 | [cpu.md](docs/cpu.md) "Self-hosted debug" |
| Vulkan through Venus (VK0–VK3) | Done 2026-10-29 | [graphics.md](docs/graphics.md) "Vulkan through Venus", [vk/README.md](vk/README.md) |
| Vulkan's breadth (VK4) | In progress since 2026-10-29 | [VK4-KICKOFF.md](VK4-KICKOFF.md), `bench/vulkan/REPORT.md` |
| Shared folders | Done 2026-10-31 | [shares.md](docs/shares.md) |
| A local network helper (NET) | L0–L3 done 2026-11-02; open | [NET-HANDOVER.md](NET-HANDOVER.md), [networking/local-helper.md](docs/networking/local-helper.md) |
| The on-screen keyboard (OSK) | Done 2026-11-02 | [frontend.md](docs/frontend.md) |
| The page's words (i18n) | Done 2026-11-02 | [i18n.md](docs/i18n.md), [copy.md](docs/copy.md) |
| Indirect transfers (XF) | Done 2026-11-05 | [jit.md](docs/jit.md) "Calls" |
| Rebinding (RB) | Tried, not kept 2026-11-05 | [jit.md](docs/jit.md) "Tried and not kept" |
| Clipboard sharing (CLIP) | Done 2026-11-07 | [clipboard.md](docs/clipboard.md) |
| The block interpreter on the Mac host | In progress since 2026-11-09 | `bench/interp/REPORT.md` "The block interpreter on the Mac" |
| The performance backlog (PERF) | In progress since 2026-11-10 | [PERF-HANDOVER.md](PERF-HANDOVER.md) |
| Peer-to-peer rooms (P2P) | Done 2026-11-12 | [networking/rooms.md](docs/networking/rooms.md); left open: [plans/networking-p2p.md](docs/plans/networking-p2p.md) |
| The guest agent (AGENT) | Done 2026-11-13 | [devices.md](docs/devices.md) "The guest's agent" |
| More jobs for the guest agent (BETTERAGENT) | Done 2026-11-14 | [devices.md](docs/devices.md) "The guest's agent" |
| The disk surface visualizer (SURFACE) | Done 2026-11-16 | [frontend.md](docs/frontend.md) "A disk's surface", [plans/surface.md](docs/plans/surface.md) |
| Growing a disk (RESIZE) | Done 2026-11-15 | [machines.md](docs/machines.md) §4.5, [devices.md](docs/devices.md) "A disk grown" |
| Faster snapshots (SNAPZ) | Done 2026-11-16 | [platform.md](docs/platform.md) "The snapshot file", [frontend.md](docs/frontend.md) "Snapshots", `bench/boot/REPORT.md` "SNAPZ: the track's end" |
| Registered names in rooms (NAMES) | In progress since 2026-11-16 | [NAMES-KICKOFF.md](NAMES-KICKOFF.md), [NAMES-HANDOVER.md](NAMES-HANDOVER.md), [plans/room-names.md](docs/plans/room-names.md) |
| The user's QA findings (QA) | Done 2026-11-18 | [frontend.md](docs/frontend.md) (Home, the message bar, a machine that stops by itself), [machines.md](docs/machines.md) §4.4, §5.1 "Unrestorable", [i18n.md](docs/i18n.md) "Markers" |

## Proposed, not started

A preloaded image and snapshot loaded with the page (likely the Arch desktop guest); a catalog of hosted images; the
stable embedding API ([machines.md](docs/machines.md)); Firefox and Safari ([backlog.md](docs/backlog.md)).
