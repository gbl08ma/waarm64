# Room names: out-of-context review 1

Scope: `net/ts/src/room/names.rs`, `net/ts/src/room/names/*`, and the names code in `net/ts/src/room.rs`,
`net/ts/src/wasm.rs`, `web/room.ts`, `web/room-worker.ts`, `web/ts-client.ts`, read against
`docs/plans/room-names.md` and `docs/networking/rooms.md`. Static review. Throwaway tests (since removed) confirmed
the findings marked "test". Ranked by severity.

| # | Severity | Finding |
|---|---|---|
| 1 | High | A sync partner can crash any server: `Range::child` panics at depth 64 |
| 2 | High | Anyone can pick a member's or a server's two servers: answers aren't held to the share, one registration signs for unlimited keys, and any member can fill the accept window |
| 3 | Medium | Any member can hold all 32 asker slots of every server: nobody finds a server |
| 4 | Medium | Any peer with a session can make a server do unbounded work and queue unbounded memory (`put`, `sync`, `have`, listings) |
| 5 | Medium | A peer can make a server or member buffer 16 MiB of incomplete transfers, not the spec's 2 MiB |
| 6 | Medium (spec) | One header forged at the floor backdates any number of entries in every room, for good |
| 7 | Medium-Low | Pending anchors aren't authenticated and "the lower wins": anyone can replace an owner's pending with junk |
| 8 | Low-Medium | A member checks a `history` answer synchronously and without deduplication: about 0.7 s of stall per answer |
| 9 | Low | A server's lapsed records are "taken" at load, so the page never deletes them |
| 10 | Low | A chain whose first anchor is ahead of the server's clock is dropped, though the comment says it is kept |
| 11 | Low | Zone slot keys don't take the owner: two owners of one name at the same `seq` reuse ChaCha20-Poly1305 keys and nonces |
| 12 | Low | Registry records are keyed by room only, and the last batch can be lost when the worker stops |
| 13 | Low (latent) | `anchor::leaves` turns 8 KB of input into about 200 MB of allocations |

---

## 1. High: a sync partner can crash any server (panic at depth 64)

- **Where:** `net/ts/src/room/names/wire.rs:322-335` (`Range::child`, `p[b]` with `b = depth / 2`), reached from
  `net/ts/src/room/names/server.rs:929-942` (`on_sync_answer`, `SyncAnswer::Children`).
- **What's wrong:** the side that answers sends a listing once `range.depth >= 64` (server.rs:805). The side that asks
  never checks depth. It takes `Children` for any range it asked about, and calls `range.child(k)` on each child that
  differs. For a range at depth 64, `b = 32` indexes past the 32-byte prefix and panics. The module is built with
  `panic = "abort"` (Cargo.toml:10), so the wasm instance traps and the room client dies, guest networking included.
- **Failure scenario:** the attacker holds one live registration and is chosen as a server's sync partner (finding 2
  makes that easy). To each `sync` it answers `Children`, with one child at count 1 and a junk hash and the other 15 at
  `Fp::default()`, so the victim's empty sub-ranges compare equal. The victim walks one path down. After 65 small
  messages it panics. Every server in the room can be crashed each time it starts.
  - The same partner can instead answer `Children` with all 16 children differing, down to depth 63. The run then
    never ends, `round_over` is never set, and the victim never becomes `synced`, so it never answers questions.
- **Confirmed:** test. A fake partner fed `Children` to a `Server` until it panicked with
  `index out of bounds: the len is 32 but the index is 32` at wire.rs:326.
- **Fix:** treat a `Children` answer for a range at depth ≥ 63 (or ≥ 64) as a protocol error that ends the run, and
  bound a run's total requests.

## 2. High: anyone can choose a member's (and a server's) two servers

- **Where:**
  - `net/ts/src/room/names/member.rs:582-626` and `server.rs:634-680` (`on_serve`, `choose`);
  - `server.rs:170-212` (`check_serve`);
  - `net/ts/src/room.rs:1856-1880` and `3244-3247` (the accept window).
- **What's wrong:** the spec's defence against a lying server is that the asker keeps "the two servers with the lowest
  `BLAKE2s(nonce, server's key)`: not the two fastest, which an attacker could always be". Three things defeat it:
  1. **Answers aren't held to the share.** `on_serve` accepts any valid `serve`, whatever the round's `spread`. Only
     honest servers apply `in_share`. In round 1 (spread 6) an honest server answers with probability 1/64. An
     attacker answers at once from two keys. That makes two answers, so `choose` runs 0.3 s later. The member's
     "ask everyone if only one answered" never triggers.
  2. **One registration signs for unlimited keys.** `serve` binds the owner key to the nonce and the names client's
     key. It doesn't bind one key per name, and the asker doesn't deduplicate answers by the serve's entry or owner.
     The attacker can make names-client keys after it sees the nonce. X25519 keys are cheap, so it can grind for a
     low `share_hash` within the 0.3 s window and beat even in-share honest answers.
  3. **The accept window is first come, first served.** `names_accept` lets in `ACCEPT_MAX` = 32 handshakes from any
     key while a question is open. The asker's key is inside the question, which anyone with the room's ID can open
     (public rooms). An attacker that starts 32 handshakes as soon as the event appears shuts out every honest server.
- **Failure scenario:**
  - Name `alice` is held by its owner. A member that never resolved it asks. The attacker:
    - had claimed `alice` itself (proof of work and one stamp: its chain is alive but younger);
    - fills the member's accept window;
    - answers from two keys with one registration.
  - Both of the member's servers then show the attacker's chain. Its last entry is valid and alive, the two servers
    agree, and nothing contests it. The member takes and keeps it, so the guest's `alice` resolves to the attacker's
    machine.
  - The same control lets the attacker answer "none" (suppression), serve stale zones, and become a server's sync
    partner (and so finding 1's crash).
  - The spec's table lists "both servers the attacker's" as the worst case. These three properties make that the
    usual case, not a rare draw.
- **Confirmed:** static reasoning. There is no `in_share` call on the asking side (`grep in_share`: only
  server.rs:690). The accept counter is spent by any completed handshake.
- **Fix:**
  - Refuse answers whose `share_hash` isn't in the share of a round already sent.
  - Count answers per name (owner key, or the serve entry's chain), not per session key.
  - Admit handshakes to the accept window only for keys whose hash is in the share. An off-share key gets no slot.

## 3. Medium: any member can hold every server's 32 asker slots

- **Where:** `server.rs:696-698` (`MAX_ASKERS`), `server.rs:759-761` (any datagram refreshes an asker),
  `server.rs:558-569` (idle after 60 s).
- **What's wrong:** a server answers only while it holds fewer than 32 askers. Any datagram from an asker resets that
  asker's idle timer, even one that fails to parse as a transfer part.
- **Failure scenario:** in a public room, the attacker sends 32 questions (spread 0) under fresh keys, a few a second.
  Each server calls every one back (32 sessions). The attacker then sends one junk UDP datagram per session every
  59 s. Every server stays at "no room" for good, so no member and no new server ever finds a server. Names that
  aren't kept get NXDOMAIN or SERVFAIL room-wide, and new servers never sync. The cost is about 32 datagrams a minute.
  The spec's "Flood who serves?" row considers only the answer budget, not slots held.
- **Confirmed:** static reasoning.
- **Fix:**
  - Refresh an asker only on a well-formed request it makes.
  - Bound each asker's lifetime (or its requests) whatever it sends.
  - Under pressure, evict the oldest asker rather than refusing new ones.

## 4. Medium: unbounded work and memory from any peer with a session

Any key a server called back (any asker: finding 3) can send any registry message. Nothing restricts `put`,
`sync`, `have` or `get all` to sync partners, or rate-limits them per peer.

- **`put` and the verification queue** (`server.rs:864-870`, `1058-1131`):
  - `jobs` is unbounded.
  - A failed entry isn't remembered. `check_entry` looks for it in the registry and in `job.checked`, but failures go
    in neither.
  - The attacker signs one entry with its own key and gives it any real header as `ref`, with no valid work. The
    checks run in order: signature, `ref` header, then Argon2id, so each copy costs the full Argon2id.
  - One `put` of 1,024 copies is about 218 KB and costs about 0.68 s of a core (production parameters). With several
    sessions, arrival outpaces the 6 entries a turn.
  - `synced` waits for `jobs` to empty (server.rs:513-519), so a new server under such a flood never answers questions.
- **`sync`** (`server.rs:797-811`): each 55-byte `sync` makes the server settle and fingerprint the range. For
  `Range::ALL` that is one BLAKE2s per item for `fp`, and another pass for `children`: about 40,000 hashes at 20,000
  names, for one small datagram. The sender is also added to `synced_with` and gets `have` pushes.
- **`have`** (`server.rs:855-863`): one `get` request for each id listed, up to about 32,000 per 1 MiB message. Each
  is a queued `Out` in `Transfers`. `pump` lets only 8 parts fly, and unsent parts never expire
  (`wire.rs:689-724`, `797-831`), so the queue lives for hours. `deadline()` and `tick()` walk it every turn.
- **Listings** (`server.rs:945-973`): every id in a partner's listing gets a `get` at once. `SYNC_PARALLEL` isn't
  applied, and a listing may hold 65,536 entries (`wire.rs:591`).
- **Confirmed:** static reasoning.
- **Fix:**
  - Accept `sync`, `have` and `get all` only from the round's partners and servers that proved a live name (and
    rate-limit them).
  - Bound `jobs` per peer and in total, and cache refused entry ids.
  - Bound a run's queued requests to `SYNC_PARALLEL` from a work list.

## 5. Medium: the inbound transfer budget is checked only on a transfer's first part

- **Where:** `net/ts/src/room/names/wire.rs:763-779`.
- **What's wrong:** `MAX_BUFFERED` (2 MiB) is compared only when a transfer is new. Later parts of an admitted
  transfer are buffered without a check. A peer can open 16 transfers with one small part each, then fill each one to
  about 1 MiB. That makes 16 MiB per peer, against the spec's "16 incomplete, 2 MiB". Incomplete transfers never
  expire either.
- **Failure scenario:** the attacker holds 32 asker sessions (finding 3) and fills each to 16 MiB: about 512 MiB of
  wasm memory in the room worker. Wasm memory never shrinks, so the tab may fail.
- **Confirmed:** test. After the first part of each of 16 transfers and then the rest, 14,064 parts (about 15 MiB)
  were acknowledged and buffered for one peer.
- **Fix:** check `buffered + data.len()` for every new part, not just a transfer's first, and expire incomplete
  transfers after a timeout.

## 6. Medium (the spec): one forged header is a reusable backdating oracle

- **Where:**
  - `net/ts/src/room/names/header.rs:81-96`;
  - `entry.rs:320-350` (the window is relative to `ref`, and `ref` can be any old real block);
  - room-names.md "What an attacker can do" ("Forge a Bitcoin header … one false time").
- **What's wrong:** a header proves only its own work, at a floor of 1/16 of today's difficulty. It may have any time
  up to now + 2 h, any time in the past, and a Merkle root of the attacker's choosing. Its root can commit a Merkle
  tree of any number of entries, since anchors are arbitrary append, prepend and SHA-256 paths. `ref` can be any
  historic real block whose time lies within 2 h after, or 48 h before, the forged time. Nothing ties either header
  to Bitcoin's chain, and nothing ever expires a forged header.
- **Failure scenario:**
  - The attacker mines one header at the floor, about 1/16 of a block's work (about 0.2 BTC of mining revenue
    forgone), timed now − 36 days. Its root commits claims on every name it wants, in every room (proof of work each).
  - It renews each with a real stamp today: the link is valid because 36 days ≤ TERM + GRACE.
  - It then beats every chain claimed in the last five weeks, in every room, and keeps them by renewing.
  - One more forged header per 37 days of history takes any name at all.
  - The spec's row ("a real block's work … one false time") understates this. The header serves unlimited entries,
    names and rooms, for good. The spec elsewhere says the cost is a sixteenth of a block, not a block.
- **Confirmed:** static reasoning, from the code and the spec's own parameters.
- **Fix (a spec decision):** don't let a lone header give an entry's time. Options:
  - require the anchor's header to be connected by a header chain to a compiled checkpoint (80 bytes a block);
  - or have servers refuse a first entry whose anchor is much older than when the room first saw it;
  - and at least correct the table.

## 7. Medium-Low: pending anchors are unauthenticated, and "the lower wins"

- **Where:** `net/ts/src/room/names/entry.rs:363-372` (`offer_pending`), `server.rs:1125-1127`, `store.rs:109-124`.
- **What's wrong:** a pending anchor (a calendar index and ops) can't be checked until it finishes, and nothing signs
  it. Among two, the lower is kept, so anyone who `put`s the owner's unanchored renewal with
  `Pending { calendar: Alice, ops: [] }` replaces the owner's real receipt everywhere. The spec relies on servers
  finishing pending renewals ("one short visit is enough"). A server that tries will ask the calendar for a commitment
  that doesn't exist. The renewal then waits for the owner's own agent, and an owner who visited once may lose the
  name at TERM + GRACE.
- **Confirmed:** test. The forged lower pending replaced an honest `Bob` pending. This is latent until servers fetch
  from calendars (not built yet).
- **Fix:** have the owner sign the pending (a second BIP-340 signature over the entry id and the pending bytes), or
  keep one pending per calendar from the owner's own `put`.

## 8. Low-Medium: `history` answers are verified synchronously and without deduplication

- **Where:** `net/ts/src/room/names/member.rs:697-726` (`view`), called from `settle` inside `on_msg`.
- **What's wrong:** a `history` item may carry 1,024 entries (`wire.rs:40`). The member runs `Stamped::check` (BIP-340
  and Argon2id) on each entry inline, in one turn, with no `job.checked`-style deduplication.
- **Failure scenario:** a lying server answers owner-mode `get` with a different valid chain (its own claim), so
  `lasts.len() > 1` and the member asks both servers for `history`. The attacker sends 1,024 copies of one valid entry.
  That is about 0.68 s of blocking work in the room worker, where the node's networking also runs, each time the name
  is looked up or refreshed.
- **Confirmed:** static reasoning.
- **Fix:** deduplicate entries by id before checking, and verify `history` in slices as servers do.

## 9. Low: lapsed server records are reported as taken, so never deleted

- **Where:** `net/ts/src/room/names/server.rs:432-439` (`load` returns true unconditionally),
  `server.rs:453-472` (`take_trusted` drops an item that settles empty), `web/room-worker.ts:98`.
- **What's wrong:** the page deletes records the module doesn't take. That covers "a lapsed name's" (web/ts-client.ts
  `namesLoad`, room-names.md "Persist"). A server's `load` says it took a record even when the name lapsed and nothing
  was kept. The module emits no `Store { record: None }` for an id it doesn't hold, so the record stays in IndexedDB
  for good and is re-read and re-settled at every start.
- **Confirmed:** test. `load` of a 200-day-old claim returned `true` with the registry left empty.
- **Fix:** return whether the item is held after `take_trusted` (or emit a delete for it).

## 10. Low: a chain whose first time is ahead of the clock is dropped, not kept for later

- **Where:** `net/ts/src/room/names/store.rs:141-147`, and `chain.rs:53-55` (`covers` needs seniority ≤ now).
- **What's wrong:** `settle` notes that "a chain whose first entry's time is still ahead … may own later" and
  schedules `next_change`. It then retains only the owner, pending and tombstone ids, so the chain's entries are
  deleted at once. Headers may run 2 h ahead of now (`drift`), and a server's clock can lag.
- **Failure scenario:** a claim anchored in a block whose time is 30 minutes ahead of the server's clock is `put`. The
  server drops it and answers `Better` with an empty item, and doesn't hold it until the owner puts it again.
  `check_serve` and the member refuse it the same way.
- **Confirmed:** test. A claim at `T + 1800` settled at `T` left 0 entries.
- **Fix:** keep chains whose seniority is within `drift` of now in the kept set, or let `covers` allow `seniority ≤ now + drift`.

## 11. Low: zone slot keys don't take the owner, so keys and nonces repeat across owners

- **Where:** `net/ts/src/room/names/zone.rs:41-46` (`slot_keys` over the seal key, `seq` and the full name only),
  with a zero nonce (zone.rs:92-99).
- **What's wrong:** the spec says a key "is never reused but by a zone of the same name and `seq`". It doesn't say
  that every owner of a name (after a lapse, or a back-order) starts at the same small `seq`. Two owners' zones at one
  `seq` then share the ChaCha20 keystream and the slot tags.
  - The XOR of two ciphertexts is the XOR of the two node keys. A server holding both can test pairs of known member
    keys and learn where an unguessable name points.
  - Equal tags show which slots are used. The spec says neither can be learned.
- **Confirmed:** static reasoning.
- **Fix:** take the owner key (and the name id) into `slot_keys`.

## 12. Low: registry records are keyed by room only; the last batch can be lost

- **Where:** `web/room.ts:358-388` (keys `[room, id]`), `web/room-worker.ts:75-98`; `room-worker.ts:55-57` and
  `web/room.ts:253-266` (`flush` isn't awaited before `detached`, and `close` terminates the worker).
- **What's wrong:**
  - Records aren't keyed by the connection, so two stored connections in one room (two machines on one page, one a
    server) share keys. At start, each deletes the other's records as "another role's", and the two overwrite each
    other's records for the same id. The member loses its kept `earliest`, its defence against impersonation after a
    reset.
  - Writes wait up to 1 s (`NAMES_WRITE_MS`), and detach or close don't wait for them. A name resolved just before
    the page closes keeps nothing.
- **Confirmed:** static reasoning.
- **Fix:** key records by `[room, identityKey, id]`, and await `flush()` before posting `detached` or terminating.

## 13. Low (latent): `anchor::leaves` amplifies 8 KB into about 200 MB

- **Where:** `net/ts/src/room/names/anchor.rs:233-266`.
- **What's wrong:** each `0xff` fork pushes a clone of the whole operation list so far. An input of `ff 08` repeated
  (8 KB, 4,096 levels) keeps 4,096 siblings with up to 4,096 ops each, about 8.4 M `Op`s, before failing at the end of
  the input.
- **Confirmed:** test. A debug build's peak RSS rose by about 200 MB (from 112 to 319 MB), and the call took 0.33 s.
  Today only the tests call it. The agent (N4) will feed it calendars' answers (`Pending::from_receipt` and `finish`).
- **Fix:** share prefixes (keep, per stack item, the index of the op list so far, or a persistent list) and bound the
  total ops visited.
