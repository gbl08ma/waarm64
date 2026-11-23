# NAMES2: room names' loose ends worth closing — handover

The brief, the loops, the decisions and what needs the user's OK: [NAMES2-KICKOFF.md](NAMES2-KICKOFF.md). What exists:
[docs/networking/names.md](docs/networking/names.md); what is left: [docs/backlog.md](docs/backlog.md) "Room names'
loose ends".

## How it runs

Opened 2026-11-23 in a Claude Code cloud session (docs/cloud.md: x86_64, no dev VM, no systemd scope). One subagent per
loop, one at a time; the supervisor reviews each loop's diff before the next and runs `scripts/ci.sh` before each push
to the session's branch. `scripts/ci-net.sh` and the end's whole CI set are owed in the dev VM.

## State

Loop 1 done; loop 2 next.

## Loops

| Loop | Commit | Tier passed | Report |
|---|---|---|---|
| 1 | this loop's | `ci-fast.sh` | A pending proof asked at an hour, every 10 minutes to 3 hours, then 20, 40, hourly (`collectWait`): N0b's stamps collected by 2 hours 67 of 80 (every one served by then; doubling: 4), 13 asks a calendar in 3 hours (was 6). ~90% isn't reachable on N0b's batch: 13 of 80 proofs came after 2 hours. |
