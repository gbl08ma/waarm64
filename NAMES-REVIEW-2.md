# Room names: out-of-context review 2

Scope: registered names from the records to the page. That is `net/ts/src/room/names.rs` and `names/*`, the names
code in `net/ts/src/room.rs` and `wasm.rs`, `web/names.ts`, `web/names-ops.ts`, `web/names-worker.ts`, the names parts
of `web/room.ts`, `web/room-worker.ts` and `web/ts-client.ts`, and the page's names parts in `web/app/`. Each was read
against `docs/plans/room-names.md`, `docs/networking/rooms.md`, `CLAUDE.md` and `docs/frontend-code.md`.

The review was static. Two findings were confirmed with throwaway tests, which have been removed (`git status` is
clean). Line numbers are at `b54bc77`. Findings are ranked by severity.

| # | Severity | Finding |
|---|---|---|
| 1 | High | The dialog's check tells a server the name being typed: one checker key asks for the first byte of every prefix |
| 2 | High (spec) | Server choice is a lottery with one ticket per live claim, and claims on junk ids are cheap: a Sybil is both of most askers' servers |
| 3 | High | "Every 2 weeks" doesn't keep a name resolving: a renewal reaches the room only at the visit after the one that made it (**waiting for the user**) |
| 4 | Medium-High | The agent drops a valid entry for good on one failed or odd collection |
| 5 | Medium | A released name keeps resolving for members that kept it, and they refuse its next owner (test) |
| 6 | Medium | Let it go, while a renewal waits for its anchor, releases nothing |
| 7 | Medium | Valid entries replayed in `put`s are verified again every time: any asker can keep servers' CPUs busy for free (test) |
| 8 | Medium | `lost` is decided while the title's own chain is merely uncollected, and it never clears |
| 9 | Medium-Low | Stale owner-mode answers fill a `history` lookup, so a contested name is decided on last entries |
| 10 | Medium-Low | A zone a server refuses is answered `taken`: the page says Saved, and a forked copy's zone never takes effect |
| 11 | Medium-Low | An export pasted into a connection that already has an owners' secret keeps the old secret: the imported names lapse |
| 12 | Low-Medium | "Who serves?" makes every server call back whatever key the question names |
| 13 | Low-Medium | `ids` lists every id and its cover end to anyone, for free, and one visit's renewals share a cover end |
| 14 | Low | A sync partner can keep a new server unsynced for hours |
| 15 | Low | Titles taken in from a pasted export are trusted unverified by the node's server |
| 16 | Low | A title publishes through the link it was registered with, and is shown only on a connection with that exact link |
| 17 | Low | The page's words: "public in about 1 hour" for days; Add a label past 3 fails with a bare `Zone` |


## Status (N5a and N5b, 2026-11-17)

Each fix started with its test, failing first; each new rule has a planted bug the tests caught (NAMES-HANDOVER.md's
N5a row). What a fix leaves: docs/backlog.md "Review 2's fixes".

| # | Status | Test (net/ts/src/room/names/…, tests/…) |
|---|---|---|
| 1 | Fixed (N5b, the user's decision 2026-11-17; N5a's every-id form, fa6c561, replaced and gone from the wire): the check runs when Register is pressed, not as typed: one first byte a press, through a checker made for that press; as typed, only the page's own checks (the rules, this connection's own). Free registers; taken keeps the dialog open with the date; nobody can say says so, and Register pressed again registers | names-agent.test.ts "the dialog's check: as typed … asking no server; at Register, one first byte …"; names-page.test.ts "the dialog: typing asks no server …", "… taken keeps it open …", "… nobody can say …"; member_tests.rs `ids_by_first_byte` (an `ids` get of 0, 2 or 32 bytes refused); page-room.test.ts's dialog steps |
| 2 | Fixed (df84c2f) within the decisions: a `serve` shows its chain's run (8 entries at most), answers rank by the chain's age in half terms (6 tiers, 90 days) then the hash, rounds sample a young chain as rarely; the accept window keeps the best two | member_tests.rs `cheap_fresh_registrations_dont_buy_both_of_an_askers_servers` (both servers junk in 22 of 30 before, ≤ 1 of 40 after); server_tests.rs `served_keys_ranked_worst_make_room_but_the_best_two_stay`, `serve_is_a_live_names_…` |
| 3 | **Waiting for the user** (the renewal rule, the visit notice and servers finishing renewals are theirs to decide) | — |
| 4 | Fixed (f6466a2): only `AnchorWindow` drops an entry; a stale one is kept and asked for a week past its window; each calendar's answer and each explorer's run tried | names-agent.test.ts "a renewal collected late revives its chain …", "a calendar answering junk, or an explorer an inconsistent run …" |
| 5 | Fixed (0c67cb6): a server shows a tombstone's release to a member whose last entry is on it; the member ends what it keeps and asks again. Also found: transfer ids restarted per peer after a forget, so a server met again dropped a member's new requests as done | member_tests.rs `a_release_ends_a_kept_name_and_its_next_owner_is_taken`; server_tests.rs `a_peer_forgotten_and_met_again_gets_new_transfers` |
| 6 | Fixed (87b9af9): Let it go drops waiting renewals; a release not stamped is made again | names-agent.test.ts "Let it go while a renewal waits …" |
| 7 | Fixed (2342371): 16,384 entries verified lately are remembered | server_tests.rs `valid_entries_put_again_are_checked_once` |
| 8 | Fixed (f6466a2): not lost while a lapsed chain's own entry waits for its anchor; a lost title is put and judged again; the key from the claim | names-agent.test.ts "a renewal collected late revives its chain …", "a better chain of another key's makes a title lost …" |
| 9 | Fixed (daa620e): a lookup being checked isn't asked again; answers only into a lookup of their own mode | member_tests.rs `a_lookup_being_checked_isnt_asked_again` |
| 10 | Fixed (652c99e): a zone not taken is answered `better`; the agent counts past the room's `seq` and puts again after 11 minutes | server_tests.rs `a_zone_the_server_doesnt_take_isnt_answered_taken`; names-agent.test.ts "a zone the room's servers didn't take …" |
| 11 | Fixed (5e5ca8a): a title taken in keeps its bundle's secret where the connection has another; renewals only with the title's key | names-agent.test.ts "an export pasted into a connection that has an owners' secret already …" |
| 12 | Fixed in part (ed9616c): a server answers questions naming one key 4 times a minute; a proof of the key filed (docs/backlog.md "Review 2's fixes") | server_tests.rs `questions_naming_one_key_get_few_call_backs` |
| 13 | Fixed in part (6add82e): `ids` cover ends rounded up to a week, the spec's cost corrected; spreading renewals filed (it waits with finding 3) | server_tests.rs `ids_answers_round_cover_ends_to_a_week` |
| 14 | Fixed (9d53f6f): a run lasts 4 minutes at most and ends the round | server_tests.rs `a_slow_partner_doesnt_keep_a_server_unsynced` |
| 15 | Fixed (726a2a5): `set_titles` verifies a title's entries and zone; one that fails is refused whole | server_tests.rs `titles_are_verified_before_the_registry_holds_them` |
| 16 | Fixed (567e8c0): the views by room ID; `relink` publishes through the connection's link as it is now | names-page.test.ts "a connection's names: by its key and room …"; names-agent.test.ts "a title publishes through its connection's link …" |
| 17 | Fixed (7f22d89): late reserved words, the wait from the claim's own stamp; past four points a wide zone, 15 labels at most | names-page.test.ts (the reserved state); names-agent.test.ts "… REF_WINDOW …", "a zone of more than four points is sealed wide" |

---

## 1. High: the dialog's check tells a server the name being typed

- **Where:**
  - `web/app/NameDialog.svelte:25` and `:55-73` (a check 300 ms after each pause in typing);
  - `web/names.ts:368-383` (`check`: the first byte of the typed name's id);
  - `web/names-ops.ts:126-139` (`Checker`: one publisher, one names-client key, for every check of the dialog and a
    minute after).
- **What's wrong:** each pause while typing asks the same two servers, from the same key, for the ids under the first
  byte of `id(prefix)`. Typing `alice` with pauses asks for `id("a")[0]`, `id("al")[0]`, …, `id("alice")[0]`. The name
  id is a keyed BLAKE2s with a key every member derives from the room's ID, so a server can compute ids for anything.
  Each observed byte filters candidates by 1/256. The server can rebuild the name one character at a time: of the 37
  next characters, about one passes each byte. It needs no dictionary, and it costs nothing.
  - The spec's rule ("The dialog's check … must not tell a server which id someone is about to claim") holds for one
    check. It doesn't hold for a linked sequence of checks.
- **Failure scenario:**
  1. An attacker holds one registration and is one of the dialog's two servers (finding 2 makes that likely).
  2. It reads the name from the checks while the user is still typing.
  3. It starts mining its own claim. The user's proof of work only starts at Register, about 30 s or more of work.
  4. It stamps first, or into the same calendar batch, and grinds the tie-break. The spec's own row: "Tie a claim it
     somehow knew of … wins most ties".
  - The user's claim is then lost when it goes public.
  - The spec's row "Race a new registration | none | nothing … the dialog's check doesn't name the id" is wrong in
    practice.
- **Confirmed:** static reasoning. `changed()` runs on every input, debounced 300 ms. `Checker.ids` reuses
  `this.client` for each byte, and `Member::ids` sends each new byte to the servers it holds.
- **Fix:** check only on an explicit action, or at most once a dialog. Use a fresh, unlinkable checker for each check.
  Send several random decoy first bytes with the real one, so a server sees at most 8 unlinkable bits.

## 2. High (spec): server choice is a lottery with one ticket per live claim, and tickets are cheap

- **Where:**
  - `net/ts/src/room/names/server.rs:290-321` (`check_live`: any anchored entry whose one-entry chain covers now);
  - `server.rs:352-384` (`Ask::offer`, `choose`: lowest `BLAKE2s(nonce, owner key)`, one answer per owner key or name
    id);
  - `member.rs:606-618` (more than one answer by the choice: no widening).
- **What's wrong:** a `serve` counts as a server if it carries any live entry, including a claim on an id nobody's
  resolver would ask. A name id costs one claim:
  - proof of work, a mean of about 32 s of a tab's core, at most about 280x less on a GPU;
  - a stamp, which can cover any number of claims through the attacker's own Merkle tree.

  An attacker with N junk claims holds N tickets against the room's H honest servers.
  - At spread 6, N = 128 puts about 2 attacker answers in the first round on average. Honest servers rarely answer
    that round, and a member that has two answers then stops.
  - When only one answer came, the member asks everyone. The two lowest of 128 + H are then the attacker's with
    probability about 128·127 / ((128+H)(127+H)), which is ~93% for H = 5.
  - The cost is about 128 claims a term: an hour or two of one core, or seconds of a GPU.

  The spec's table assumes "both servers the attacker's" needs two registrations that happen to rank below every
  honest one. With cheap tickets that is the usual case.
- **Failure scenario:** the attacker becomes both servers for most questions in the room.
  - Members get "none" for names they don't keep (suppression).
  - Members get the attacker's own younger chain for a guessable name they never resolved (impersonation, with no reset
    needed).
  - Publishers' `put`s go to the attacker, which answers `taken` and keeps nothing, so honest servers never get new
    titles.
  - New servers sync only with the attacker (an eclipse).
- **Confirmed:** static reasoning and the arithmetic above.
- **Fix (a spec change, the user's call):** make a ticket cost time, not only work. Rank answers by their chain's
  seniority (an older registration first), require a minimum age of the serving chain, or have the `serve` carry the
  whole run. A Sybil then needs registrations held for months, renewed every term.

## 3. High: "every 2 weeks" doesn't keep a name resolving

- **Status: waiting for the user** (N5a left the renewal rule, the visit notice and how servers finish renewals as they
  are; NAMES-HANDOVER.md "Open questions").

- **Where:**
  - `web/names.ts:540-548` (renew when the last anchored entry is `TERM / 2` old);
  - `names.ts:500-518` (an anchor is collected only by an open page);
  - the words `NameDialog.notice.visit` and `names-view.active` (web/messages/en/network.json:1150, 1202);
  - the spec's "Who talks to a calendar" (N4d: servers don't finish renewals).
- **What's wrong:** a renewal is made at the first visit at least 15 days after the last anchored entry. Its anchor
  reaches the room only when a page collects it, either an hour or two later with the page still open, or at the next
  visit. The name resolves only until 30 days after the last anchored entry.

  Model it with visits every V days, each short. The renewal is made at an age in [15, 15+V) and collected at an age in
  [15+V, 15+2V). It must arrive before 30, so V ≤ 7.5 days, not 14.
- **Failure scenario:** visits every 14 days, at days 0, 14, 28, 42, …
  - Day 0: the claim is made.
  - Day 14: the claim's anchor is collected; it is 14 days old, so no renewal.
  - Day 28: renewal R1 is made, and the page closes.
  - Days 30 to 42: the name resolves for nobody.
  - Days 37 to 42: servers hold nothing of it and the dialog's check says free, so anyone can register it. (The owner
    wins it back at day 42 only if finding 4 doesn't strike.)
  - Day 42: R1 is collected.
  - The cycle repeats: down about 12 of every 28 days.

  The page says "Open this web app at least every 2 weeks to keep the name" and "Active, kept until about … unless you
  visit". The spec's "renewal at half a term leaves two weeks for it" assumes a visit lands exactly at day 15.
- **Confirmed:** static reasoning over `work()` and `collect()`.
- **Fix:** renew earlier, at the first visit past `TERM − 2 × the promised interval` (for 14 days, about day 2), or
  keep the page collecting before it says Active. Otherwise build N4d (servers finishing renewals), or change the words
  to the interval that holds.

## 4. Medium-High: the agent drops a valid entry for good on one failed or odd collection

- **Where:** `web/names.ts:500-529` (`work`), `names.ts:651-676` (`collect`).
- **What's wrong:** there are three paths.
  - **Stale entries get one try.** An entry past `ref` + 48 h + 4 h is stale. At a later visit it is collected once,
    whatever the backoff. If that one try finds nothing (a calendar or explorer briefly unreachable, the network not up
    yet at page load, a run not yet six deep at the explorer), the next statement drops it. Its finished proof stays
    at the calendar for years.
  - **Any `NamesError` drops the entry.** `collect` doesn't catch the `finish` op's errors (`names.ts:663`). So one
    calendar answering 200 with a body that isn't a timestamp throws `AnchorFormat`, which propagates to `work`'s
    `catch`: "refused for good … made again", even when another calendar's proof would have done. Examples of such a
    body: a CDN error page, a proxy page, an unknown operation tag.
  - **Any refusal of the `anchor` op does too.**
    - `HeaderFuture`: the user's clock more than 2 h behind.
    - `HeaderRun`: one explorer's inconsistent `next_best`, where the other explorer isn't tried once the module
      refused).
    - Only `AnchorWindow` is the "can never count" case the comment describes.
- **Failure scenario:** with the cadence of finding 3, every renewal is stale at the visit that collects it. One failed
  fetch round at that page load drops R1. Its replacement is made at day 42, past the claim's day 0 + 37, so it can't
  link. The chain is dead and the title shows "Lapsed: anyone can register it now". The agent makes no new claim,
  because `st.best` exists. One bad calendar can do this to every agent.
- **Confirmed:** static reasoning.
- **Fix:** drop an entry only on `AnchorWindow`, or a proof that verifiably reaches a block outside the window. Keep a
  stale entry's stamps and retry with backoff, since a stale renewal can still link. Catch `finish` errors per calendar
  like `anchor`'s, and try the other explorer when the module refuses a run.

## 5. Medium: a released name keeps resolving for members that kept it, and they refuse its next owner

- **Where:**
  - `net/ts/src/room/names/store.rs:236-243` (`owner_answer`: `None` when no chain owns the name now, and a release
    leaves none);
  - `member.rs:1061-1069` (both servers saying none: "a kept chain still alive answers throughout").
- **What's wrong:** servers hold the release as a tombstone but answer a member's `get` with "none". The member's kept
  chain, which ends at the renewal before the release, still covers by its own reckoning, so it keeps answering. When
  someone registers the name, the servers show the new owner's chain. The member asks for `history`, and `Kept::offer`
  refuses the younger chain.
- **Failure scenario:**
  1. The owner lets `alpha` go. The dialog says "Members won't reach this machine by it any more, and anyone can
     register it once the release is public".
  2. Every member that resolved `alpha` keeps resolving it to the old machine until the kept renewal's term ends, up to
     30 days.
  3. A newcomer registers `alpha`. Those members still resolve the old machine and refuse the newcomer.
- **Confirmed:** throwaway test in member_tests.rs. A member resolves `alpha` (renewed 4 days ago), then both servers
  load a release anchored just after.
  - Five minutes later, and again after a new key's claim two days on that both servers hold, the member answers
    `Node(a1…)`, the released target.
  - The servers' `owner` is `None`.
- **Fix:** `owner_answer` (and `history`) should show a tombstone's release when it ends a chain the member may keep,
  for example when the release continues the asker's held last entry. Members then end what they keep at the release's
  time.

## 6. Medium: Let it go, while a renewal waits for its anchor, releases nothing

- **Where:** `web/names.ts:348-361` (`release`), `names.ts:500-518` (`work` still collects), `names.ts:709-760`
  (`publish` still publishes), `chain.rs:75-88` (`order`).
- **What's wrong:**
  - The release is made with `prev` set to the owning chain's last **anchored** entry.
  - A renewal R made at an earlier visit is a sibling on the same `prev`, and it waits for its anchor for days with
    infrequent visits.
  - `work()` keeps collecting R's anchor, because `t.released` doesn't stop the collect loop, and `publish` puts it.
  - The chains [… last, R] and [… last, release] share their first entry. The one whose cover ends later wins, and that
    is R's (tR + 37 days > the release's time). `tests.rs:592-595` pins exactly that ("A release on the other branch
    doesn't end the title").
  - Also, a release that no calendar stamped (`names.ts:617-620`) or that went stale is never made again, because
    `work` returns once `t.released`.
- **Failure scenario:** the user lets a name go two days after a visit that renewed it. The page says "Let go". At the
  next visit R is collected and published: the name resolves for another month and is kept from others for 37 days.
- **Confirmed:** static reasoning, with the order's semantics pinned by the existing test.
- **Fix:**
  - At release, drop the title's unanchored renewals and their stamps; servers can't anchor them.
  - Or make the release on the newest leaf.
  - Remake a release that wasn't stamped or went stale.

## 7. Medium: valid entries replayed in `put`s are verified again every time

- **Where:** `net/ts/src/room/names/server.rs:1500-1525` (`check_entry`: skips only entries held or `refused`),
  `server.rs:1180-1187` (`put` from any session).
- **What's wrong:** the junk defence remembers only entries that failed on their own bytes. A valid but dead entry
  (an old chain's, or the attacker's own entries mined once, years ago) is dropped by `settle` after its check, so it
  is never "held". Every `put` of it pays a whole check again (Argon2id, BIP-340, headers).
- **Failure scenario:** any asker opens sessions, which takes only the room's ID. It then puts the same items of up to
  1,024 valid entries in a loop, 4 at a time per session. Each costs every server about 0.7 s of a core. The servers'
  room workers spin, since "while any wait, the module asks to be ticked again at once". The attacker pays bandwidth
  only. The spec's "a junk one costing one check" covers forged entries only.
- **Confirmed:** throwaway test in server_tests.rs. A dead 150-entry title put three times by one peer gave
  `stats.checked` 150, 300, 450.
- **Fix:** remember lately verified entry ids, with their verified `Stamped`, as `refused` remembers failures. Or bound
  checks per peer per time, not only puts in flight.

## 8. Medium: `lost` is decided while the title's own chain is merely uncollected, and it never clears

- **Where:** `net/ts/src/room/names/agent.rs:486-498` (`judge`: lost whenever another key's chain owns now),
  `web/names.ts:729`, `:741`, `:710` (`publish` returns at once for a lost title), `names.ts:853` (`roomTitles`
  doesn't serve a lost title).
- **What's wrong:** `judge` compares only anchored entries.
  - If the title's chain doesn't cover now but a renewal in the title would revive it once collected, another key's
    younger claim made in the gap makes the verdict `lost`. The renewal could have failed to collect this pass
    (finding 4), or the chain could be in finding 3's days 37 to 42.
  - `lost` is never re-judged. Collected anchors are kept but never published, and the node stops serving the name.
  - The words "an older claim of another owner's holds it" are wrong in that case: it is a younger claim.
  - Separately, `judge` takes the title's key from `title.entries.first()`, the lowest id, not the claim's
    (`agent.rs:447`).
- **Failure scenario:** finding 3's day-42 visit with one failed calendar fetch. The publish shows the interloper's
  chain, so the title is lost for good, though its pending R1, collected at the next visit, would have beaten it by
  seniority.
- **Confirmed:** static reasoning.
- **Fix:**
  - Judge after collecting.
  - Don't mark lost while the title holds an unanchored entry that could link.
  - Re-judge a lost title at each pass rather than never publishing it again.
  - Take the owner key from the claim.

## 9. Medium-Low: stale owner-mode answers fill a `history` lookup

- **Where:**
  - `net/ts/src/room/names/member.rs:447-457` (`dispatch` sends a `get` for every lookup whose `asked` is empty);
  - `member.rs:897` (`settle` empties `asked` when checking starts);
  - `member.rs:786-795` (an answer goes into the lookup of its id, whatever the request's mode).
- **What's wrong:** a lookup being checked over several turns has an empty `asked`. That happens when another lookup's
  long history used the turn's 24 units first. Any `dispatch` meanwhile (another query, a put, an `ids`) sends owner
  `get`s for it again. If it then decides "the servers disagree", it starts a `history` lookup. The stray owner
  answers, sent earlier, arrive first and fill both of its slots. The lookup is then decided as a history on last
  entries only, and the real history answers are dropped.
- **Failure scenario:** a member that never resolved `alpha` asks for it while it checks another long history. The
  attacker is one of its two servers, and it shows an impostor claim from 10 days ago. The honest server shows the
  owner's renewal from 4 days ago. "Last entries alone can't be compared": the member keeps the impostor, the case
  `servers_that_disagree_are_asked_for_history` exists to prevent.
- **Confirmed:** static reasoning.
- **Fix:** skip lookups with `checking.is_some()` in `dispatch`, and drop an answer whose `Req` mode isn't the
  lookup's.

## 10. Medium-Low: a zone a server refuses is answered `taken`

- **Where:** `net/ts/src/room/names/server.rs:1578-1585` (`taken` by the owning chain's last entry alone),
  `store.rs:188-198` (`offer_zone`: refused within 10 minutes, or when it doesn't beat the held zone),
  `web/names.ts:631-635` (`nextSeq` counts from the title's own zone only), `names.ts:752-755`.
- **What's wrong:** the put answer says nothing of the zone, and the agent marks the item published. There are two
  consequences:
  1. A second Save within 10 minutes of a zone change reaches the room only at the next hourly re-put or page load.
  2. With a title forked between two browsers, which the spec supports, the copy whose `n` is lower makes zones that
     every server refuses. That goes on until its `n` passes the other's, which may be never. `judge`'s `ours` verdict
     doesn't carry the room's newer zone back either.
- **Failure scenario:** browser B (an imported copy, n = 2) saves new points, while browser A's zone is at n = 5. The
  page says Saved, and members keep resolving A's points.
- **Confirmed:** static reasoning.
- **Fix:** answer `better` (or carry the held zone's tag) when the put's zone wasn't taken. The agent then raises `n`
  past the room's `seq` and re-puts after the 10-minute limit.

## 11. Medium-Low: an export pasted into a connection that already has an owners' secret

- **Where:** `web/names.ts:827-836` (`importNames`: `addSecret` keeps the secret already there),
  `web/app/connections.ts:279-289` (a pasted key that another connection has shares its `identityKey`),
  `web/names.ts:542-546` (`ownKey` is always `o.owner`, so the guard is a tautology).
- **What's wrong:** the bundle's titles are kept, but the bundle's secret is dropped when the connection has one.
  Renewals are then signed with keys derived from the old secret. They don't link to the imported chains, and their
  zones are sealed by a key the servers drop. `work()`'s owner check can't notice, because `ownKey` is the owning
  chain's own first entry's key.
- **Failure scenario:**
  1. The user moved a key to browser B earlier, before it had names, and registered a name in B.
  2. Later they paste A's export, now with names, into B. It lands on the same `identityKey`.
  3. A's names, now "in B", lapse within 37 days, while the page shows them as active.
- **Confirmed:** static reasoning.
- **Fix:** refuse, or keep per title, a bundle whose secret differs from the one kept. Check renewals against the
  title's claim key.

## 12. Low-Medium: "who serves?" makes every server call back whatever key the question names

- **Where:** `net/ts/src/room/names/server.rs:960-1009` (`on_question` → `CallBack { key: q.key }` and `serve`),
  `room.rs:1638-1671`.
- **What's wrong:** the asker's key in a question is unauthenticated. Anyone with the room's ID can publish questions
  at spread 0 naming a victim member's node key. Every server whose budget allows, 4 a second each, then:
  - starts a WireGuard handshake to the victim through DERP;
  - sends it a `serve` on UDP port 2, which the victim's node passes to its guest.
- **Failure scenario:** with 20 servers, a question a second spends the victim's `TRIALS_PER_SECOND` (16) of incoming
  trials. Members calling it are refused for as long as the questions go on, and its guest sees stray port-2 datagrams.
  The spec's "Flood who serves?" row counts only the servers' cost.
- **Confirmed:** static reasoning.
- **Fix:**
  - Have the question prove its key: a MAC under the X25519 shared secret with a per-hour room key, or a
    call-back-first handshake where the asker initiates.
  - At least, keep a victim's node from treating port-2 datagrams from names clients as the guest's.

## 13. Low-Medium: `ids` lists every id and its cover end to anyone, for free

- **Where:** `net/ts/src/room/names/server.rs:1063-1080` (`ids` isn't among the server-only requests),
  `server.rs:1109-1126`; `web/names.ts:408-424` (`pass` renews every due title in one visit).
- **What's wrong:**
  - **Free listing.** 256 `ids` requests from any fresh key list every id in the registry with its cover end. The spec
    prices "Hash a dictionary against a server's ids" at "one registration".
  - **One owner's names link up.** A cover end is the last anchor's block time + 37 days. An owner's names renewed in
    one visit are stamped together and land in one block, so they share a cover end. Anyone can group ids by owner,
    which undoes "an owner key per name". The spec says "the agent spreads them when it can", but the agent doesn't.
- **Failure scenario:** an outsider in a public room groups the room's ids into owners and dictionary-checks them
  offline, with no registration.
- **Confirmed:** static reasoning.
- **Fix:**
  - Spread renewals across visits or hours, as the spec says.
  - Round or drop cover ends in `ids` answers: "taken" with a coarse date is enough.
  - Correct the spec's cost.

## 14. Low: a sync partner can keep a new server unsynced for hours

- **Where:** `net/ts/src/room/names/server.rs:1338-1360` (a run bounded by 8,192 `sync`s and its gets),
  `server.rs:96` (15 s a request), `server.rs:736-743`, `:986-988`, `:605-609`.
- **What's wrong:** a partner that answers each request just before the 15 s timeout, with differing children,
  stretches a run to about 8,192 / 4 × 15 s ≈ 8.5 h. The partner is easily chosen with finding 2.
  - `round_over` waits for every run, so `synced` stays false.
  - The new server answers no question.
  - Its resolver says `Wait` (SERVFAIL) for every name it doesn't hold.
  - A new question each round can draw the same partner again.
- **Failure scenario:** each time a page starts serving, its first sync is held up for hours.
- **Confirmed:** static reasoning.
- **Fix:** bound a run by time as well as by requests, and count a run that ended by its bound as the round's end.

## 15. Low: titles taken in from a pasted export are trusted unverified

- **Where:** `web/names.ts:827-836` (`importNames` checks only the secret's form), `room-worker.ts` (`roomTitles` gives
  them to the module), `net/ts/src/room/names/server.rs:559-576` and `:635-654` (`set_titles` → `take_trusted`, no
  checks).
- **What's wrong:** a crafted export, which the spec lists as an attack vector, can carry items with forged entries,
  anchors and headers.
  - The node's server takes them as verified.
  - `settle` keeps one chain a name, so a forged senior chain displaces the real owner's in that server's registry.
  - The guest resolves the name to the attacker.
  - Other members that ask this server get forged answers, which they refuse, so it never serves the real chain.
- **Failure scenario:** a user pastes a "key with names" sent by someone else. Their own machine then resolves `bank`
  where the sender chose.
- **Confirmed:** static reasoning.
- **Fix:** verify imported items once at import, through the `add` and `anchor` ops, or have `set_titles` verify what
  it hasn't seen.

## 16. Low: a title is bound to the link it was registered with

- **Where:** `web/names.ts:718` (`this.b.publish(t.link, …)`), `web/app/areas/names.svelte.ts:50-65` (`of` filters on
  `t.link === c.link`).
- **What's wrong:** two cases follow.
  - A second connection to the same room ID, with the same key but another link (other relays), serves the names,
    because `roomTitles` matches by room ID. Its adapter and details show none of them.
  - If the original link's relays go away, the agent keeps publishing through them for good: "not published; next
    pass".
- **Failure scenario:** the user rejoins the room with a link naming working relays. Their names vanish from the menu
  and are never published again.
- **Confirmed:** static reasoning.
- **Fix:** key the view by room ID, and publish through the connection's current link (or every link of the room the
  connections hold).

## 17. Low: the page's words

- **Where:**
  - `web/names.ts:775` (`publicAbout` from `stampedAt`), `names.ts:625` (`stampedAt ??=` survives a remake);
  - `web/app/NameEntry.svelte:91-96` (Add a label without a limit);
  - `web/names.ts:637-642` (`sealed` never passes `wide`).
- **What's wrong:**
  - "Reserved, public in about N hours" counts down to "about 1 hour" and stays there for days when the page closed
    before the claim's anchor came, since only an open page collects it. It also counts from the first stamp after a
    remake.
  - Add a label offers any number of rows, but zones are always 4 slots. A fourth label fails Save with the module's
    bare `Zone`.
- **Fix:**
  - Say "public once this web app has been open about 2 hours", and reset `stampedAt` at a remake.
  - Seal `wide` past four points, or stop Add a label at three.
