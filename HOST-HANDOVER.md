# HOST: handover

The brief and the user's answers: [HOST-KICKOFF.md](HOST-KICKOFF.md). This file is the current state and the plan.

## State (2026-11-20)

- **Review**: three out-of-context static reviews on the branch `review/host` (`review/host-gpu.md`,
  `review/host-vm.md`, `review/host-io.md`; line numbers from before the reformat). Triage below.
- **Linters**: Prettier formats `web/*.ts` (`npm run format`, `npm run lint:format`).

## Plan (loops, in order)

1. ESLint over `web/*.ts` (its own config block: no size rules, the type-checked correctness sets), suppressions
   grandfathered; docs/host-code.md.
2. Fixes: the confirmed defects (triage below), each with its confirming test.
3. Performance: the per-packet, per-TD, per-submit and per-request allocations and copies; hot paths A/B'd together.
4. Splits along the seams the reviews name (pure moves).
5. The end: the whole CI set, docs, backlog, PLAN.md.

## Triage

(filled in as loops take the findings)
