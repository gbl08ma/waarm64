# NAMES2: room names' loose ends worth closing — handover

The brief, the loops, the decisions and what needs the user's OK: [NAMES2-KICKOFF.md](NAMES2-KICKOFF.md). What exists:
[docs/networking/names.md](docs/networking/names.md); what is left: [docs/backlog.md](docs/backlog.md) "Room names'
loose ends".

## How it runs

Opened 2026-11-23 in a Claude Code cloud session (docs/cloud.md: x86_64, no dev VM, no systemd scope). One subagent per
loop, one at a time; the supervisor reviews each loop's diff before the next and runs `scripts/ci.sh` before each push
to the session's branch. `scripts/ci-net.sh` and the end's whole CI set are owed in the dev VM.

## State

Loop 3 done; loop 2's (b) awaits the user's call (names.md "Findings": servers finish only the lowest pending
anchor), then loop 4.

## Loops

| Loop | Commit | Tier passed | Report |
|---|---|---|---|
| 1 | `66e4fba` | `ci-fast.sh` | A pending proof asked at an hour, every 10 minutes to 3 hours, then 20, 40, hourly (`collectWait`): N0b's stamps collected by 2 hours 67 of 80 (every one served by then; doubling: 4), 13 asks a calendar in 3 hours (was 6). ~90% isn't reachable on N0b's batch: 13 of 80 proofs came after 2 hours. |
| 2 | `2b2ffcc` | `ci-fast.sh` | (a) A claim no calendar served a day after its stamp is made again (`CLAIM_AGAIN_MS`), the one before kept and asked for, two waiting at most, one never anchored dropped a week on once another was made or anchored. (b) Not fixed, needs the user's call: an item carries one pending anchor an entry (the lowest, `alice`'s) and servers keep the lower, so with `alice` losing stamps the 60-day promise is NXDOMAIN days 25 to 28 (`visits_keep_a_name_with_the_lowest_calendar_losing_its_stamps`, `#[ignore]`d); keeping more needs a change to how a pending anchor travels in a put and is stored. |
| 3 | this loop's | `ci-fast.sh` | (a) `judge`'s `none` takes the title key's entries in, so a copy that renewed, shown another copy's release, says Let go and renews no more. (b) Found: a claim let go before it was public was put alone once anchored (its release pending), so it resolved until servers finished the release; now nothing is put until the release is anchored. (c) New name on a connection that holds domains asks: Point at the new name (points at the old key move) or Let them go. |
