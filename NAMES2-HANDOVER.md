# NAMES2: room names' loose ends worth closing — handover

The brief, the loops, the decisions and what needs the user's OK: [NAMES2-KICKOFF.md](NAMES2-KICKOFF.md). What exists:
[docs/networking/names.md](docs/networking/names.md); what is left: [docs/backlog.md](docs/backlog.md) "Room names'
loose ends".

## How it runs

Opened 2026-11-23 in a Claude Code cloud session (docs/cloud.md: x86_64, no dev VM, no systemd scope). One subagent per
loop, one at a time; the supervisor reviews each loop's diff before the next and runs `scripts/ci.sh` before each push
to the session's branch. `scripts/ci-net.sh` and the end's whole CI set are owed in the dev VM.

## State

Loops 1-5 done; loop 6 next. Loop 2's (b) is closed by the user's decision (2026-11-23): a calendar that loses a
stamp is a hypothetical (never seen) that stamping at three calendars already mitigates, so it is a known limitation
in names.md "What it doesn't give", not a backlog item, and its ignored test was taken out.

## Loops

| Loop | Commit | Tier passed | Report |
|---|---|---|---|
| 1 | `66e4fba` | `ci-fast.sh` | A pending proof asked at an hour, every 10 minutes to 3 hours, then 20, 40, hourly (`collectWait`): N0b's stamps collected by 2 hours 67 of 80 (every one served by then; doubling: 4), 13 asks a calendar in 3 hours (was 6). ~90% isn't reachable on N0b's batch: 13 of 80 proofs came after 2 hours. |
| 2 | `2b2ffcc` | `ci-fast.sh` | (a) A claim no calendar served a day after its stamp is made again (`CLAIM_AGAIN_MS`), the one before kept and asked for, two waiting at most, one never anchored dropped a week on once another was made or anchored. (b) Closed by the user's decision: a known limitation (names.md "What it doesn't give"), no work planned. |
| 3 | `1acf00d` | `ci-fast.sh` | (a) `judge`'s `none` takes the title key's entries in, so a copy that renewed, shown another copy's release, says Let go and renews no more. (b) Found: a claim let go before it was public was put alone once anchored (its release pending), so it resolved until servers finished the release; now nothing is put until the release is anchored. (c) New name on a connection that holds domains asks: Point at the new name (points at the old key move) or Let them go. |
| 4 | `d98156d` | `ci-fast.sh` | (a) Delete sweeps a room connection's registry records in its room (`forgetRoomRecords`) once its client has stopped, unless another connection in that room has its `identityKey` or another tab's ephemeral one uses the entry; found: an ephemeral connection's own key kept records under its id (left at page close), now none. Records left by connections deleted before: backlog. (b) The resolver logs a count (`resolver: names asked: <n> (in <s> s)`, at most once a minute) and no name; the words only in the `test-params` build, which tests/page-room.test.ts reads. |
| 5 | this loop's | `ci-fast.sh` | (a) A first lookup's first silence from a room never heard is SERVFAIL at once (`Answer::ServFail`; lookups in flight then too), "nobody serves" only at a lookup started after it: N6a's 500 joiners on this host 438 found, 62 NXDOMAIN before; 480 and 20 after (71 SERVFAILs, 51 found asked again; the 20 met a second silence under the same load: backlog). (b) A kept name in its grace is confirmed after 60 s (`KEPT_GRACE_REFRESH`, new row in names.md's table), not 300: a renewal the servers came to hold found 57 s on, was 297. `ci-net.sh` owes page-room's no-server case (now SERVFAIL, then NXDOMAIN). |
