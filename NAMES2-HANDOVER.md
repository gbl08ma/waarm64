# NAMES2: room names' loose ends worth closing — handover

The brief, the loops, the decisions and what needs the user's OK: [NAMES2-KICKOFF.md](NAMES2-KICKOFF.md). What exists:
[docs/networking/names.md](docs/networking/names.md); what is left: [docs/backlog.md](docs/backlog.md) "Room names'
loose ends".

## How it runs

Opened 2026-11-23 in a Claude Code cloud session (docs/cloud.md: x86_64, no dev VM, no systemd scope). One subagent per
loop, one at a time; the supervisor reviews each loop's diff before the next and runs `scripts/ci.sh` before each push
to the session's branch. `scripts/ci-net.sh` and the end's whole CI set are owed in the dev VM.

## State

Loops 1-7 done (7: review fixes A and B); the supervisor's triage next. Loop 2's (b) is closed by the user's decision (2026-11-23): a calendar that loses a
stamp is a hypothetical (never seen) that stamping at three calendars already mitigates, so it is a known limitation
in names.md "What it doesn't give", not a backlog item, and its ignored test was taken out.

## Loops

| Loop | Commit | Tier passed | Report |
|---|---|---|---|
| 1 | `66e4fba` | `ci-fast.sh` | A pending proof asked at an hour, every 10 minutes to 3 hours, then 20, 40, hourly (`collectWait`): N0b's stamps collected by 2 hours 67 of 80 (every one served by then; doubling: 4), 13 asks a calendar in 3 hours (was 6). ~90% isn't reachable on N0b's batch: 13 of 80 proofs came after 2 hours. |
| 2 | `2b2ffcc` | `ci-fast.sh` | (a) A claim no calendar served a day after its stamp is made again (`CLAIM_AGAIN_MS`), the one before kept and asked for, two waiting at most, one never anchored dropped a week on once another was made or anchored. (b) Closed by the user's decision: a known limitation (names.md "What it doesn't give"), no work planned. |
| 3 | `1acf00d` | `ci-fast.sh` | (a) `judge`'s `none` takes the title key's entries in, so a copy that renewed, shown another copy's release, says Let go and renews no more. (b) Found: a claim let go before it was public was put alone once anchored (its release pending), so it resolved until servers finished the release; now nothing is put until the release is anchored. (c) New name on a connection that holds domains asks: Point at the new name (points at the old key move) or Let them go. |
| 4 | `d98156d` | `ci-fast.sh` | (a) Delete sweeps a room connection's registry records in its room (`forgetRoomRecords`) once its client has stopped, unless another connection in that room has its `identityKey` or another tab's ephemeral one uses the entry; found: an ephemeral connection's own key kept records under its id (left at page close), now none. Records left by connections deleted before: backlog. (b) The resolver logs a count (`resolver: names asked: <n> (in <s> s)`, at most once a minute) and no name; the words only in the `test-params` build, which tests/page-room.test.ts reads. |
| 5 | `ef78aaf` | `ci-fast.sh` | (a) A first lookup's first silence from a room never heard is SERVFAIL at once (`Answer::ServFail`; lookups in flight then too), "nobody serves" only at a lookup started after it: N6a's 500 joiners on this host 438 found, 62 NXDOMAIN before; 480 and 20 after (71 SERVFAILs, 51 found asked again; the 20 met a second silence under the same load: backlog). (b) A kept name in its grace is confirmed after 60 s (`KEPT_GRACE_REFRESH`, new row in names.md's table), not 300: a renewal the servers came to hold found 57 s on, was 297. `ci-net.sh` owes page-room's no-server case (now SERVFAIL, then NXDOMAIN). |
| 6 | `5c383ba` | `ci-fast.sh` | A lost Nostr relay is opened again after 2 s doubling to 10 minutes (`NOSTR_BACKOFF_MAX`, was 60 s), reset only by a connection that carried something: an event for our subscription, an accepted `OK`, or a renewal's EOSE (a healthy quiet relay answers that a minute on); a connection's first EOSE alone resets nothing (relay.degmods.com's case). On the bus a relay that never answers: 48 connections in the third hour, now at most 6 (the test's bound); one that answers only a connection's first REQ: 47, now at most 6. Same for the names client (its own `Client`; a member's made anew starts at 2 s). |
| 7 (review A) | `7150557` | `ci-fast.sh` | Review findings 1, 2, 6 on loop 6: the backoff grows to 10 minutes only for a relay our client dropped for an unanswered REQ (N6b's), to a minute (`NOSTR_CLOSED_MAX`) for a connection that closed (a failed open: an outage costs a minute at most after the network's return; a relay-side close); an answer resets it only on a connection open 30 s (`NOSTR_HELD`), and so does a relay-side close of one that answered and held that long (an idle timeout: again after 2 s). Bus tests failed first: 10 minutes offline, closed for 512 s then; a relay closing after 57 s idle, again in 4 s at the second drop (growing); two REQs answered seconds apart then a stall, 42 connections in the third hour. The page's `online` isn't passed to the client (not needed now). |
| 7 (review B) | this loop's | `ci-fast.sh` | Review findings 3, 4, 5 on loops 3-4: New name's choice is kept with each title before the key changes (`NamesAgent.newKey`: let go at once, or the old key in a new optional `repoint` field) and the agent's passes do it (the points once `member`'s key is another, a release as Let it go's), the page's pass in the background so Settings shows the new key at once; Let it go keeps `released` before its proof of work (a pass makes a release cut short). The question lists, and New name acts on, the room's domains only (`held(identityKey, room)`). New name off a shared entry sweeps that entry's records in the room once the old client stopped (`Connections.sweepRoom`, `sweepRoomRecords` now counts the connections as they are). Failed first: names-agent's Let it go cut short (stayed `active`) and New name's (`held` listed another room's); connections' sweep (none); page-domains' question (listed `far`); a planted awaited pass failed its new key shown. |
