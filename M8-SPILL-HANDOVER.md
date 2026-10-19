# M8 guest RAM past memory 0: the dev VM's checks, handover (2026-10-19)

Asked for by the user (2026-10-18): guest RAM past what memory 0 holds, as **spill memories the guest sees as
CPU-less NUMA nodes** (not swap: NUMA runs no guest code to reach the memory). The plan and what each step built are
in [docs/plans/spill-memories.md](docs/plans/spill-memories.md); S0 to S3 were built in a cloud session, which can't
build guest images or firmware, time anything, or run ci-debian.sh whole. This is S4: what only the dev VM can do.

**What exists.** Memory 0 holds at most `MAX_MEMORY0_RAM` (3 GiB less 1 MiB, web/ram.ts; fixed so a machine's layout
never moves), the rest goes to up to 8 spill memories of up to 4 GiB each, each starting at the next 1 GiB boundary
of the guest's physical map. The DT describes them as nodes 1.., distance 20; an SMBIOS type 11 credential turns
NUMA balancing off (core/src/smbios.rs `NUMA_CREDENTIAL`). Spill pages miss every inline TLB compare and go through
`Mmu::miss`, which serves them from its near-match (`tag ^ (m << 3)`). The page offers one RAM value (to 16 GiB) with a
note past memory 0; a stored machine's Settings has an advanced split (`ramSplit`), a transient one takes `?split=`.
Snapshots carry the spill memories (S3). ABI 40.

## To do, in order

1. **CI on the dev VM:** `scripts/ci.sh`, `scripts/ci-debian.sh` (with `tests/page-spill.test.ts`: the 3-node Debian,
   disk I/O through nodes 1 and 2, a save and load in a fresh profile) and `scripts/ci-machines.sh` (stored machines
   carry `ramSplit` in their shape). The cloud saw two failures that weren't the change's: ci.sh's "the firmware:
   built when missing or stale" (the cloud's fetched EDK2 inputs are stale) and `tests/page-usb-keyboard.test.ts`
   (fails on the base commit there too). Check both pass here.
2. **The nodes in a real session:** Debian with `?ram=6144` (memory 0 plus a 3 GiB node): `numactl -H` (two nodes,
   distance 20), `cat /proc/sys/kernel/numa_balancing` (0), `systemd-creds --system list` (`sysctl.extra`). Then where
   the kernel puts hot pages: `numastat -m` and `numastat -p <firefox>` while the desktop guest
   (`images/arch/desktop.sh`) plays a video with 6 GiB, before and after memory 0 fills. The plan's §4 open item:
   early memblock allocations go top-down, so some boot-time kernel data may sit in the top node; `numastat -m` right
   after boot says how much.
3. **What a spill access costs** against memory 0, in Chromium (`bench/run.ts`, medians and IQR, A/B alternating): a
   workload bound to node 1 against the same bound to node 0 (`numactl --membind=1` / `=0` around e.g. a `sha256sum`
   loop over a tmpfs file and a `memcpy`-heavy program). Ad-hoc probes in the cloud session: Debian booted and ran
   with 1.5 GiB on nodes; nothing was timed.
4. **Decide the JIT's inline second path** (plan §1, S4): only if step 2 shows hot pages on the nodes and step 3 shows
   the miss path costs enough there. Otherwise record the numbers in the plan and close it.
5. **The heap floor** (docs/backlog.md "The core's heap in a fixed memory", stage 1): measure the core heap's peak
   under a heavy 4-vCPU load on today's code cache (a Go build loop, Firefox in the guest) and pick `HEAP_FLOOR`
   (web/ram.ts) with margin. Lowering it raises `MAX_MEMORY0_RAM`, which moves the automatic split: snapshots of a
   machine whose memory 0 was at the old ceiling then load only onto a machine set by hand to the old split
   (`ramSplit`), and the page's notes say the new numbers. Update the backlog item, docs/frontend.md and the plan.

When done: the plan's S4 note, docs/testing.md if a test moves, CLAUDE.md's status line, and delete this file.
