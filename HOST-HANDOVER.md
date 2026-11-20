# HOST: handover

The brief and the user's answers: [HOST-KICKOFF.md](HOST-KICKOFF.md). This file is the current state and the plan.

## State (2026-11-20, night)

- **Review**: three out-of-context static reviews on the branch `review/host` (`review/host-gpu.md`,
  `review/host-vm.md`, `review/host-io.md`; line numbers from before the reformat).
- **Linters** (5ff933ca): Prettier formats `web/*.ts` (869d55e2, blame-ignored); ESLint's host block
  (docs/host-code.md §4), what remained grandfathered in the suppressions.
- **Fix lanes**: graphics b8f4744b, network/USB/sound 9592a39f, VM/storage 5fc65fe3 (their messages list each defect
  and its test). **Splits**: graphics 3debeab1; vm.ts, devices.ts, snd.ts, names.ts, input.ts and the network's shared
  shapes e72013e8 (VirglRenderer, VenusGpu and Gpu stay whole: their seams are methods over private state).
- **CI**: the whole set green at f49abdab (ci.sh, ci-debian --platform, ci-machines, ci-net, ci-graphics, ci-usb,
  ci-audio, ci-jit, ci-deqp, ci-deqp-vk); pushed. Load flakes fixed on the way: page-debian ×2, room-browser,
  page-layout's countdown, page-open's timing.
- **Docs**: docs/host-code.md (hot paths, correctness, modules, the linters); the lanes' leftovers in docs/backlog.md
  "The host's code".

## Next

1. One Chromium A/B of the hot paths, arms alternated, 3 rounds: A = ../waarm64-base at 3c6a5e38, B = main (one core:
   no core change). `bench/results/local/host-ab/ab.sh` (smp_user_jit_4, boot_alpine_mips_jit, gl_virgl_jit, fio and
   net under the JIT); the numbers and JSON into `bench/host/REPORT.md` and `bench/host/results/`.
2. The track's end: an out-of-context review of the new modules, PLAN.md's row done, this file and the kickoff
   deleted.
