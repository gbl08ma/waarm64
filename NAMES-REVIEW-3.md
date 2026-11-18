# NAMES review 3: out-of-context review of the redesign (R1 to R3a)

The scope was a static review of `net/ts/src/room/names/` (outside.rs, member.rs, server.rs, wire.rs, entry.rs,
anchor.rs, header.rs, chain.rs, store.rs, agent.rs), the names code in `room.rs`, and `web/names.ts` and
`web/room-worker.ts`, read against `docs/plans/room-names.md`. Findings 1 to 3 were confirmed with throwaway tests on
`member_tests.rs`'s bus (`cargo test -p waarm64_ts`, capped). The tests were removed again and are described under each
finding so a fix loop can rebuild them as its failing tests. The other findings are static.

Ranked most severe first.

## 1. A kept name goes to an impostor whose claim predates only the owner's last renewal (high, confirmed)

`member.rs:1947` `decide_one`, `member.rs:1325` (`decide`'s `contested`), `chain.rs:342` `Kept::offer`.

**The defect.** A first lookup that sees one owner key decides "with no history". `take` then keeps
`Kept::new(chain)`, where the chain is built from the one last entry, so `earliest` is the time of the owner's latest
renewal and not of its claim. `Kept::offer` replaces what is kept when it is shown a chain with
`c.seniority < self.earliest`. So any live chain claimed after the owner's claim but before its last renewal counts as
"older". This is a back-order, which the rules let own the name only once the holder lapses. In owner mode a server
sends only its last entry. For an impostor whose chain is a single claim, that entry's time is its seniority.
`decide` asks for `history` only when the answers disagree or `contested` holds, and `contested` is false here because
`offer` would accept the chain. So nothing is asked and the impostor is taken.

**Attack.** The attacker claims `alpha` while the owner holds it, which is allowed as a back-order, and keeps that one
entry alive. Every honest member that resolved `alpha` through an uncontested first lookup now keeps
`earliest = last renewal`, at most about 15 days back. The attacker then needs to be both servers of a member's
refresh. That draw is "registrations buy places" (the spec: 128 junk registrations are both servers of most
questions). It answers `get` with its claim, and the member switches `alpha` to the attacker's zone. The same happens
without junk registrations after a room reset in which only the impostor's chain survives. The spec says a member
"refuses an impersonator after a reset" and that a refresh's servers can "never [show] another owner".

**Confirming test (it failed the spec's claim).** Use `a_kept_name_isnt_replaced_by_a_younger_chain` with the fake
claimed 10 days ago instead of 2 (the owner claimed 20 days ago and renewed 4 days ago). After the refresh,
`resolve("alpha")` gives `Node([0x66; 32])`, with 0 histories. Kept `earliest` was the renewal's time.

**Fix (options).** (a) Have `Kept` record whether `earliest` was verified from a whole run. While it wasn't, a chain of
another owner key never replaces a covering kept chain on seniority alone: it is "contested". The member then asks
for `history` and refuses the other chain unless the kept owner's own run is shown and loses. If the kept owner's run
can't be had from the drawn servers, fall back to a first lookup's ask; that is a privacy cost, and it needs the
user's call. (b) After `decide_one`, fetch the one key's run (one `fetch`, through a session) so that `earliest` is the
claim's. That costs about one session for every first lookup.

## 2. Forged `TooBig` (or `None`) replies stall every first lookup; no registration needed (high, confirmed)

`member.rs:1639-1640` (`check_replies`), `member.rs:1847` (`counted` pushes late repliers into a running contest),
`member.rs:1988` `contest_step`, `wire.rs` `Reply` (`since` is unchecked, and `ReplyItem::TooBig` carries no proof).

**The defect.** A reply needs only the room's key: it is MAC'd and sealed with the room's lookup key, and its tag is
derived from the asker's names key, which the ask carries. `ReplyItem::TooBig` and `ReplyItem::None` cost no check
(`Ok(Some(None))` and `Ok(None)`, 0 units) and count as replies. A `TooBig` reply with a made-up `server` key and
`since = 0` adds a `Replier { key: None }`. That forces a contest (`decide_first`: `too_big` makes a contest). The
contest can't end until every replier with a `since` no later than the best run's seniority has been fetched. With
`since = 0` that is every forged replier. Each forged replier costs the member one `fetch` ask (4 a second, from the
same `asks_out` queue as every other first lookup's rounds and dissents) and a 5 s `FETCH_WAIT`, 8 at once.
`counted` keeps appending to `c.left` while the contest runs. `asks_out` and `f.queue` have no bound, and the room
admits 128 events a second a relay (`LOOKUP_EVENTS_PER_SECOND`).

**Attack.** Anyone who knows the room's ID can mount this: any member, anyone in a public room like `global`, or a relay
operator who knows the ID. They read the ask under the names tag and publish N `TooBig` replies under the asker's
reply tag. The member resolves nothing for about N/8 × 5 s (and N/4 s of the ask budget). While the attacker keeps
sending, the first lookup never ends. Every guest query gets SERVFAIL, the queued fetch asks push other names' rounds
past their 2.5 s give-up, and those lookups end in `silence`, which is SERVFAIL too because `heard` was just set. All
64 `MAX_LOOKUPS` places fill with stuck contests. The forged replies also inflate `share_count`, which narrows
`self.spread` to 15 for later lookups. The spec's table says junk replies cost "a failed check each; no place taken
from anyone". That holds only for `Item` replies, and `junk_replies_take_no_place` covers only those.

**Confirming test.** On the bus, one honest server and 40 junk `Reply { since: 0, item: TooBig, server: <distinct> }`
injected at each `share` ask (the existing `bus.junk` hook). `resolve("alpha")` gives `Wait` after 4 s, 8 fetches. It
resolves only after about 20 s more, after 41 fetches.

**Fix.** Give unverifiable replies no weight. (a) A `TooBig` must carry something checkable, such as the owning
chain's last entry without the zone (it fits under `REPLY_MAX`), so it counts only once that holds. (b) Or count
`TooBig` and `None` only toward "someone answered", and never fetch a `TooBig` replier ahead of a checked one: order
the contest by checked repliers first, and bound the unverified repliers fetched to a few. (c) Cap `f.queue`, the
repliers a lookup, `c.left` and `asks_out`. (d) Give a contest a deadline: past it, decide on the runs checked.
`since` stays a hint; a forged `since = 0` mustn't be able to hold the decision open.

## 3. Two contests at once misroute a fetched run: the honest run is dropped and the impostor wins (high, confirmed)

`member.rs:2055` `on_fetched`.

**The defect.** A fetched run (`Items` with transfer 0) is routed to the first first-lookup, in id order, whose
contest has `from` in `flying`. It does not use the item's id. If the same server was fetched by two contests (it
replied for two names), the run for name A can land in name B's contest. There, `items.find(|i| i.id == id)` finds
nothing, the server is marked `fetched` with no run, and `Cmd::Forget(from)` closes the session. The server's second
`Items` transfer (B's run, or A's) then fails. `Gone` reaches `fetch_gone`, which removes the server from the other
contest too. Both contests lose that server's run.

**Attack.** An attacker holds younger chains on two names (`alpha` and `beta`) on its own servers, and the room's
honest server holds both owners. A guest resolves both at once (a page that looks up several hosts does). The honest
run is lost to the wrong contest, and the attacker's run is the only one that holds. The member keeps the impostor,
whose seniority 10 days back is then what `Kept` defends. Without an attacker, the same happens to honest contested
names: "a contest without a run that held", no answer.

**Confirming test.** On the bus: `alpha` and `beta` claimed 20 days ago and renewed 4 days ago, both on one honest
server. Fakes claimed 10 days ago, each on its own server. Query both, advance 15 s. `alpha` resolves to the fake's
`[0x66; 32]`, `beta` to the owner. With one fake server holding both fakes, `alpha` gets no answer.

**Fix.** Route by item: for each item in the message, give it to the contest of `item.id` that has `from` flying. Send
`Forget(from)` only when no other contest still waits on `from`. Better still, have the server answer the `fetch`
under a transfer the member can match, or key `flying` by (server, id) and fetch one name at a time per server.

## 4. A server queues unbounded sync and `have` answers, with items for any name (high, static)

`server.rs:1613-1622` `on_answer` (`(Req::Get(_), Msg::Items(items))`), `server.rs:1572` (`Have`), `server.rs` (the
`jobs` queue, which has no bound).

**The defect.** An `Items` answer to a `get` is pushed whole into `self.jobs`, one `Job` per item. Nothing checks that
the items are for the id or prefix asked, how many there are, or how large `jobs` already is. Items for other names,
including names the bound dropped, which sync is meant not to fetch for a day, are verified and kept. A `get` answer is
up to 1 MiB. A peer that proved one live name (one registration's proof in its first `sync`, which needs no draw) can
send `have` repeatedly, 32 ids each, and the server keeps 64 `get`s outstanding to it. Each answer brings 1 MiB of
items. One item per junk entry, signed with the attacker's own key with a bad nonce, costs the server a BIP-340 check
plus a whole Argon2id (about 0.66 ms) each, because `forged` ends only that item's job. The refused cache holds 4,096
ids, so distinct junk always costs a check.

**Scenario.** At the DERP rates measured (0.6 to 3 Mbit/s), one peer delivers tens of MB a minute of jobs, faster than
24 units a turn verifies them. `jobs` grows without limit (memory until the room worker dies). The CPU stays saturated.
`synced` (which waits for `jobs` to empty) never becomes true on a new server, so it never answers questions or asks.
Puts, including the server's own finished renewals, wait behind `jobs`.

**Fix.** In `on_answer`, keep only items whose id matches the `get`'s prefix (one item for a 32-byte id), and drop the
rest. Cap `jobs` by count and bytes, refusing new `get`s or `have`s past it. Count a peer's bytes in `jobs` against the
peer, and end its run or drop its `have`s past a share.

## 5. The agent stops renewing on one server's "better" chain, even when the other server took the title (medium, static)

`web/names.ts:844` and `:877` (`publish`), `agent.rs` `judge`.

**The defect.** `publish` puts the title to the two drawn servers. If any answer is judged `lost`, `now.lost` is set,
even when the other server answered `taken` (`shown = true`): `if (lost) { … now.lost = … } else if (now.lost &&
(shown || …))`. A lost title is never renewed (`renew` returns early on `t.lost`). `lost` clears only on a pass where
neither server says lost. `judge` checks the shown entries' headers against the floor only. The agent never asks an
explorer about them, though it already talks to explorers and servers refuse such blocks (R2).

**Attack.** The forger's header from the spec's "Forge a Bitcoin header" row costs 1/16 of a block, once, and is reusable
in every room. With it, the attacker makes a chain older than the owner's. The attacker's servers, registrations that
buy places in the publisher's draw, answer `better` with that chain. Honest servers refuse the block and answer
`taken`, but the owner's agent marks the title lost and stops renewing. In most passes the attacker is one of the two
drawn, so the title stays lost past its last renewal's `t + TERM + GRACE`. The name then lapses at the honest servers
too. This is the real owner losing a name that every honest server held for it.

**Fix.** A `taken` (or an `ours` or `branch` verdict) from any server in the same pass should win over a `lost`. At
least it shouldn't set `lost` when another server took the title. Before acting on `lost`, check the winning chain's
first entry's block at an explorer (`block/<hash>/header`), as servers do. Keep renewing while lost is unconfirmed: it
costs one entry a fortnight.

## 6. An anchor in a block refused mid-verification is kept for a day (medium-low, static)

`server.rs:1950` (`check_entry` checks `self.out.refused` when the anchor is offered), `server.rs:1973` `keep`
(inserts `job.checked` without checking again), `outside.rs` `drop_anchors_in` (runs once, at the verdict).

**The defect.** An entry's anchor is checked against the refused blocks when the entry is checked. `keep` merges
`job.checked` later. A job longer than a turn's 24 units is one with more than about 6 entries, and puts take turns a
slice at a time. Such a job checked before a block's refusal is kept after it, with anchors in the refused block.
`drop_anchors_in` has already run, and `note` finds the block `Refused`, so the anchors stay. They go only after
`REFUSED_FOR` (a day), when `outside_scan` forgets the verdict, notes the block again as unchecked, and refuses it
again.

**Scenario.** A forger puts one small item anchored in its forged block, then a long one (many entries, same block). The
small one is kept and the block is checked within seconds and refused. The long one, still in the puts queue, keeps its
forged anchors at that server for a day. During that day the server serves the forged chain to members' refreshes,
replies and fetches, and in sync.

**Fix.** In `keep`, drop the anchor of any checked entry whose block `self.out.refused(...)`, before inserting. Or
mark the pending jobs when `block_verdict` refuses a block.

## 7. A block's check never backs off: unreachable explorers are asked every 5 minutes a block, for good (low, static)

`outside.rs:423`.

**The defect.** When neither explorer settles a block, the retry reads `tries` from `b.state`. That state is
`Checking` (set in `outside_tick`), so `tries` is always 0 and the wait is always `CHECK_AGAIN` (5 minutes). The spec
says "asked again after 5 minutes, doubling to 6 hours". `stop()` also resets `tries` to 0.

**Scenario.** An explorer that is down, rate-limits with a 429, or answers without CORS headers (status 0 at the page,
which N0c has yet to measure) makes every server re-ask each of its registry's blocks every 5 minutes. With hundreds of
blocks, that is the pace's maximum, two GETs every 3 s a server, indefinitely. Multiplied by every server in every
room, this is the load the spec meant the doubling to prevent.

**Fix.** Carry `tries` in `Fetch::Block`, or keep it in `Block` apart from `state`, and use it when setting
`Unchecked { next, tries: tries + 1 }`.

## Checked and found sound

- **Wire decoding** (`wire.rs`): item, message, question, ask and reply lengths and counts are bounded; `get` id lengths
  are pinned per mode (`ids` one byte, `owner` and `history` 32); listings are capped. Transfers: parts are bounded by
  `MAX_MESSAGE`, there are 16 incomplete inbound transfers and 2 MiB buffered at most, idle inbound transfers are
  dropped, the buffered byte count is consistent, and the 8 MiB queued cap holds.
- **Anchors** (`anchor.rs`): only the three operations and the Bitcoin attestation are taken; there is a 4 KiB message
  limit, varuint overflow is refused, fork copying is bounded (`MAX_COPIED`), and `Pending` is limited to the compiled
  calendars. Server finish URLs come only from `Calendar::url` and `EXPLORERS`. The explorer's block hash is validated
  as 64 hex digits before use, and `serviceFetch` and `get` refuse other origins.
- **Headers**: Bitcoin's compact-target rules (negative, zero and overflow refused), proof of work against the header's
  own target, the floor, and the 2 h future bound.
- **Entries**: the signature is checked before Argon2id, the room prefix and the prev/kind consistency are checked, and
  the id covers the signature.
- **Chain order and `Held::settle`**: a total order; tombstones and pending renewals are bounded; the zone is dropped
  when the owner changes.
- **`ids`**: one first byte only, cover ends rounded up to a week.
- **The refused-block check at load** (`take_trusted`, and `load_block` in either record order).
- **Reply budgets** (2 a second, 16 a minute a tag, once a nonce), the per-key call-back limit, the accept window's
  eviction, and members never fetching outside the room.
