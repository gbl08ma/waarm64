# Room names: how much Bitcoin, and who a member believes (a design review)

A review of two parts of [room-names.md](room-names.md) that grew as gaps were found: the Bitcoin chain data around an
OpenTimestamps proof, and the choice of servers by their chain's age (N5a's fix of review 2's finding 2). It changes no
code. Its recommendations touch decisions 4 and 12 of [NAMES-KICKOFF.md](../../NAMES-KICKOFF.md), so they are the
user's to take; "Decisions for the user" at the end lists them.

## Summary

**Not a deep redesign: a cut and one addition.** The rule (the oldest unbroken chain of stamped claims), the records'
shape, the registry, sync, the agent and the page all stay. What goes is most of what was added around the proof.

1. **Bitcoin.** An anchor is an OpenTimestamps proof and **the one header of its block**: nothing less can give a time
   to a member that asks no explorer. Everything past that goes: the six following headers, the floor's schedule
   (one compiled number instead), `ref` with its header and `REF_WINDOW`. **Servers ask an explorer once per block**
   whether that header is Bitcoin's block at that height, in the background, and refuse a block the explorers deny.
   Members check the header's own proof of work against the compiled floor, as N1 built it. This follows from the
   user's choice for finding 3: once servers ask an explorer at all, an explorer's word ties a header to the chain,
   and the run of seven and the schedule have no job left. Proof of work on entries stays; it has nothing to do with
   Bitcoin once `ref` is gone.
2. **Finding 2.** Ranking servers by age delays an attacker by three months and no more, and its three costs are
   permanent. No way of *choosing* servers resists cheap registrations. What does is to stop depending on the choice:
   **a member that is shown an answer for a name it doesn't keep asks the room whether anyone holds a different
   owner for it** (one more ephemeral message, naming the name's id), and any server that does answers. A liar then
   has to silence every honest holder of the name, not win a draw. The tiers go: a `serve` is one entry again, rounds
   and load are as they were before N5a. The price is that the id asked for is seen by every server and by a relay
   that knows the room's ID, where today two servers see it. If the user doesn't accept that, keep N5a as built.
3. **Else.** With `ref` gone a renewal can be made ahead of the visit that stamps it, so a short visit is enough once
   servers finish renewals. N6 should measure the design after these changes, so the loops below come before it.

## 1. Bitcoin beyond the proof

### What a proof needs

An OpenTimestamps proof is a path of hashes from an entry's id to the Merkle root of a Bitcoin block, and a height.
The time is in that block's header. So a verifier needs the header (80 bytes) and a reason to believe it is Bitcoin's.
There are three reasons to be had, and the design has used each in turn:

| Reason | Who can use it | Cost | What an attacker needs |
|---|---|---|---|
| **An explorer's word**: the block at that height has this hash | whoever may ask an explorer | one small GET a distinct block, once | the explorer (two, if both must agree) |
| **The header's own work** against a compiled floor | anyone, offline | nothing; a number in the release | the floor's work once, reusable for any number of claims |
| **A chain of headers** from a compiled checkpoint | whoever holds the chain | 4.2 MB a year, the retarget rules, a sync of its own | a fork as heavy as the real chain |

The spec today is the second, stretched: seven linked headers at half of the difficulty, a schedule that decays
between releases, and nobody but the registering page asking an explorer. It grew from one premise, "members and
servers ask no explorer", which made a header's own work the only reason available to anyone but the owner. The user
dropped that premise for servers on 2026-11-17 (finding 3). That changes the answer.

### The options

**A. As built** (seven headers, the schedule, `ref`).
- Users: 640 bytes of headers an entry on every `get` and `serve`; registration needs two explorers that agree on
  `ref`, and an entry whose anchor misses 48 hours is made again.
- Code: `header::Run`, `floor`'s schedule, the window, the agent's `ref()` and its made-again path, and a chore with no
  owner: someone adds a point to the schedule at each release, or the floor decays to 1/64 (seven headers for 0.11 of
  a block) after 15 weeks.
- Attacker: about 3.5 blocks' work at best, once, reusable; less the older the release.
- Finding 3's fix costs each server about 9 GETs a finished renewal (the block and six more).

**B. One header, a constant floor, nobody checks further** (N1's design; review 1's finding 6 accepted).
- Users: 80 bytes an entry. Explorers only for the header of an anchor being collected (2 GETs).
- Code: the least. `Run`, the schedule and `run_span` go.
- Attacker: one header at the floor (1/16 of a block: about 0.2 BTC of mining revenue forgone, or hash power rented
  for that), timed weeks back, anchors claims on any number of names in every room, for good.
- At this scale that is far above what any name here is worth, and far above the attacks the design accepts (a
  withheld claim costs a minute of a core). What makes it uncomfortable is its reach: every room at once, for ever.

**C. B, and servers ask an explorer about each block** (recommended).
- A server, having checked an anchor as a member does, asks one of the two explorers `block-height/<h>` (the height is
  in the proof) and compares the answer with the hash of the header it holds. One GET a distinct block, once a server,
  kept with the registry; at a slow steady pace, newest arrivals first; never in the way of a lookup. The same hash:
  checked. Another hash from both explorers: the block is refused, with every anchor in it, and remembered for a day.
  No answer: later. Until a block is checked its anchors count on the header's work, so names work with the explorers
  down.
- Users: nothing on either hot path. A server's page shows an explorer its IP address and block heights. The heights
  are those of the calendars' transactions, the same for every room, so the explorer learns that the address serves
  names somewhere and nothing of where or which. A server is a page that registered, so that explorer has already seen
  it.
- Code: a queue of unchecked blocks and a set of checked ones in the server, a fetch in the room's worker, the refusal
  path. It shares its plumbing with finding 3's fix (below).
- Attacker: a forged header at the floor now lasts at a server until that server's check, seconds for a new arrival.
  It still works on a member both of whose servers are the attacker's (question 2), for that member only. An explorer
  that lies can pass a forged header only together with the floor's work; two that lie together can have a real block
  refused.
- Load: a server's first sync brings as many checks as its registry has distinct blocks: under 1,200 for 100 names
  held six months, some thousands at 2,000 names (the calendars make a few dozen transactions a day). N6 measures
  what pace the explorers tolerate from a page; the pace is the only thing it can change.
- *Stricter variant*: an anchor doesn't count at a server until its block is checked. Nothing forged is ever served,
  but a new server can't serve until the explorers have answered for its whole registry, and renewals wait when
  explorers are down. I wouldn't: it puts explorers in the way of the registry working.

**D. A compiled checkpoint and the chain of headers from it.**
- The strongest and the opposite of what is wanted: 144 headers a day (11.5 KB) for ever, Bitcoin's retarget rule in
  the module, a store and a sync for the chain, a fork choice, and Esplora serves headers one request each (ten
  blocks a request as JSON at best), so somebody still asks an explorer some 200 times a fortnight. A member can't
  carry it on a first lookup, so members would be left with B's check anyway.

**E. Every verifier asks an explorer, no header carried** (plain OpenTimestamps).
- Members would ask an explorer on a first lookup: against decisions 3 and 4, a second service on a hot path, and
  the first draft's reason for leaving it.

### `ref` and `REF_WINDOW`: remove

`ref` says an entry was made after a block; the window says its anchor came within 48 hours of that. Neither does
what it was added for:
- **"Proof of work can't be stockpiled."** It can't be made early, but making it early saves nothing: a name held for
  a term costs the same two entries' work whenever that work is done. A dictionary of a million names costs the same
  GPU-hours a term with or without `ref`.
- **"It can't be reused for the next term."** A renewal names the entry before it, so its work is its own anyway.
- **Ordering** uses only the anchor's time. Nothing in "Who owns a name" reads `ref`.
- **Against a forged header** `ref` is no help: any old real block serves (review 1 said so).

What it costs: the registering page asks two explorers that must agree before it can make an entry; 32 bytes and an
80-byte header on every entry; a check of that header; the rule that an anchor past the window is void, and with it
the agent's made-again path, the pending slack and review 2's finding 4. Without it, making an entry needs the
calendars alone, and a slow calendar costs nothing but the wait.

One consequence to know: without `ref` an owner can make and sign renewals ahead of time. That is a gain for the
honest owner (question 3). It lets nobody hold a name more cheaply: each renewal still costs its work and must still
be stamped within the term of the one before.

### Proof of work on entries: keep

It is the only price on a name, and a price is what stops a dictionary being claimed every term for a minute of
signatures. No other price is to be had without a coin: stamps are free and one covers any number of claims; age is
free to anyone who starts early; limiting how many claims a stamp may cover would move the attacker's load onto the
calendars. Argon2id stays as chosen, salted with the name id instead of `ref`.

### What I would do

C, with `ref` removed.
- **An anchor**: the proof and its block's header. **A header counts** when its work meets its own target, that
  target meets one compiled floor (1/16 of the difficulty at the release, N1's value; it guards members, and keeps
  junk headers from costing servers explorer requests), and its time isn't more than `drift` past now.
- **A server** also asks an explorer about each block, as in C.
- **Finding 3** (decided): a server holding a signed pending renewal asks the calendar; with the finished proof it
  asks an explorer for the block at the proof's height and its header (2 GETs where the run needs 9), checks the
  Merkle root, and has an anchor the room can check, already known to be Bitcoin's.
- **The agent** collects its own anchors the same way and asks explorers for nothing else.
- **A member** asks no explorer (decision 4 stands for members).

Outside services after this: three calendars (pages that register or renew; servers finishing a renewal), two
explorers (pages that hold a name: to fetch the header of an anchor collected or finished, and to check blocks).
Chain data in the protocol: 80 bytes a distinct block.

## 2. An attacker as a member's servers

### What the problem is

A member takes two servers from those that answer "who serves?" and believes what both say, having checked that each
answer is valid. A server can't forge; it can leave out a better chain (say "none", or show its own younger claim on
a name the member never resolved). Answering takes a live registration, a registration costs a minute of a core, so
128 junk registrations are both servers of 93% of questions in a room with five honest ones.

### Why choosing better doesn't end it

Any rule that picks k of the answers is a draw the attacker enters as often as it likes, unless entering costs
something it can't buy. Asking more servers doesn't help: with 128 junk registrations against five honest servers
all of eight chosen are the attacker's 73% of the time, and with 1,280, 97%. Work can be bought (a GPU is ~280 times
a tab). Age can't be bought but can be waited for: N5a's tiers make the attacker hold its junk for three months,
renewed (some 900 entries' work, eight hours of a core), and after that the draw is as it was. In a young room there
is nothing to wait for. So N5a's protection is a delay, paid for with costs that don't end: old names' servers take
more of the questions, young rooms reach the round where everyone answers, and a `serve` proves its age with up to
eight entries.

### The options

**A. As built (N5a).** Holds off an attacker without patience, in rooms whose servers are old. The costs above.

**B. The plain draw, and accept.** `serve` back to one entry, rounds by the hash alone. An hour of a core a term makes
an attacker most members' servers: names it wants gone don't resolve for members that don't keep them, and a
guessable name a member never resolved can be shown as the attacker's. Too cheap to accept as it stands.

**C. Ask the room for dissent** (recommended). Keep the plain draw, and add one step where a lie matters:
- When a member's servers have answered for a name it doesn't keep (a chain, or none), the member publishes one more
  ephemeral message under the room's names tag, sealed as the question is: its names client's key and region, the
  name id, and the first 8 bytes of the id of the last entry it was shown (zeros for none).
- A server that holds an owner for that id whose chain ends at **another** entry calls the member back and sends that
  chain's run. A server that holds the same, or nothing, stays silent.
- The member waits about a second. Silence: it takes what it was shown. A dissent: it checks the run and decides by
  "Who owns a name" over all it was shown, as it does today when its two servers disagree. A dissent whose first
  entry is later than the shown chain's last can't be older and is dropped unread.
- So the attacker's count of registrations stops mattering for lookups. The asker's choice isn't trusted; any one
  honest server in the room that holds the name and hears the message corrects it. Ranking is by the answer's own
  content, checked, which no number of identities improves.

  What it costs:
  - **What a member reveals.** The id asked for is seen by every server in the room (today: by the two drawn, which
    may be anyone's), and by a relay that knows the room's ID (today it sees that an address asks for names, not
    which). For a guessable name in a room with a guessable ID, a relay learns which name an IP address looked up,
    once, the first time. Never the member's key. This is past decision 12.
  - **A first lookup takes about a second longer** (the wait for dissent), inside the resolver's 4 s. Names a member
    keeps answer at once as now; refreshes send nothing new (a kept chain yields only to an older run already).
  - **Servers**: one lookup in their store per message; an answer only when they differ, from the budget they answer
    questions from.
  - **Code**: one message, a handler in server.rs, one state in member.rs's lookup; the tiers come out.

  What an attacker can still do:
  - Make every holder of a name answer by sending the message with a made-up entry id: the same lever, and the same
    limits, as a question asking everyone today.
  - Keep honest servers too busy to dissent by flooding questions, or keep the member's window of incoming handshakes
    full for the second it waits. Both are loud and both exist today against "who serves?" itself; a budget for
    dissent apart from the questions' would narrow the first.
  - Serve an old zone to a member that keeps the name, until a later draw includes an honest server.
  - Swallow a publisher's `put`s. The same message serves the publisher: after `taken`, it asks for dissent on its
    own last entry, and a server still holding the chain's earlier state answers and is put to. A claim nobody holds
    yet still has to reach one honest server by the draw or by the owner's own node syncing.
  - Be a new server's only sync partners for some rounds. Each round draws afresh, so this slows a server's first
    registry and doesn't keep it out.

**D. Prefer servers the member already knows** (the owners of names it keeps). Free and unbuyable, but it does
nothing for a member with no names kept, which is the member the attack is aimed at.

### What I would do

C, and take the tiers out. If the user won't have the id of a first lookup shown to the room and its relays, keep A:
it is built and tested, and B's risk is too cheap to take on.

## 3. What else is wrong, in this light

- **A renewal can be ready before the visit.** Today a visit that finds a renewal due makes it then: half a minute of
  proof of work on average, two and a half at worst, before anything is stamped; a visit shorter than that renews
  nothing, and with visits two weeks apart the next chance is past the grace. Without `ref`, the agent can make the
  next renewal right after the one before it (its `prev` is known), and a later visit only stamps it (a second or
  two) and puts it with its pending anchor for servers to finish. "Open this web app at least every 2 weeks" then
  holds for a visit of a few seconds.
- **The schedule's upkeep** ("who adds points, and how often", open in the backlog) disappears with the schedule.
- **Sizes.** An entry with its anchor and headers falls from 1.15–2.1 KB to 0.55–1.5 KB (the entry 175 bytes, the
  anchor 300–1,250, one 80-byte header a distinct block). The size table and "where it stops" move by about a
  third; a `serve` is 1 to 2 KB.
- **"Explorers all down"** in the spec's table stops being "no new claims": claims and renewals can be made and
  stamped; only collecting an anchor waits.
- **N6 hasn't run.** Its numbers (a cold lookup, a server's first sync, the public services' tolerance) should be
  taken on the design as it will ship, so these changes come first.
- **Not changed, and right as they are**: the rule and its accepted holes (decision 1), hashed names and sealed
  zones, one owner key a name, the names client's fresh key, servers holding the whole registry, the calendars.

## What changes in the code, if this is taken

**Kept**: `id.rs`, `zone.rs`, `chain.rs`, `store.rs`, `anchor.rs`'s verifier and pending anchors, range sync, `get`,
`put`, `have`, the bound, `Kept`, the resolver, the agent's titles, locks, export and import, the page.

**Removed**:
- `header.rs`: `Run`, `FOLLOWERS`, `next_hashes`, the schedule in `floor`; `Params`' `floor` list, `floor_step`,
  `floor_steps`, `run_span`, `ref_window` and the pending slack tied to it.
- `entry.rs`: `refb`, `Stamped::ref_header`, `window`, `Invalid::RefHeader` and `AnchorWindow`.
- `wire.rs`: an anchor's six header indices; a `serve`'s run (`SERVE_RUN`).
- `server.rs`, `member.rs`: `TIERS`, `tier`, the tier in `rank` and `choice`, the tail a `serve` builds.
- `web/names.ts`: `ref()`, the walk over `next_best`, the made-again path for an anchor past its window.
- Their tests and planted bugs (N4b's 350 lines in tests.rs, N5a's tier tests), the kickoff's "an anchor past
  `REF_WINDOW` taken" among them.

**Changed**:
- An entry is 175 bytes (version 2); Argon2id salted with the name id; items' version moves. Pre-release, so older
  ones are refused (decision 11). The real vector (block 976,177) stays; pretend titles are made again.
- `header::check` against one compiled target.
- A pending anchor is dropped when its entry can no longer link (past the entry before it's `t + TERM + GRACE`).
- The agent collects with 2 GETs from one explorer (the other if it fails) and makes the next renewal ahead.

**Added**:
- Servers finishing renewals and checking blocks: the module asks the room's worker for a calendar's proof or a
  block's hash by height (an action and an input, as persistence has), paced; a set of checked blocks kept with the
  registry; a refused block's anchors removed and its names settled again. The pretend explorer already answers
  `block-height`.
- The dissent message: `wire.rs`, a handler in `server.rs`, a lookup state in `member.rs`, the publisher's use of it.

**Loops** (each as the kickoff's loops run: tests failing first, planted bugs, the spec brought in line):

| Loop | What | Needs |
|---|---|---|
| R1 | Records: `ref` and the window out, one header an anchor, the constant floor; the agent without `ref()`; tests' titles and vectors | the user's go on question 1 |
| R2 | Servers finish renewals at the calendars (finding 3) and check blocks at the explorers; the agent makes the next renewal ahead; the visit notice's promise tested with visits 14 days apart and seconds long | decision 4 |
| R3 | The tiers out, the dissent message in; review 2's finding 2 test rewritten: 128 and 1,280 junk registrations, one honest holder, the member gets the owner | decision 12 |
| then | N0b, N0c, N6, the end, as queued. N6 adds: explorer requests a server's first sync makes and the pace they tolerate; a first lookup's time with the wait for dissent | |

R1 and R2 are the "rely less on Bitcoin" loop the user planned for the end, brought forward so that N6 measures what
ships. R1 stands alone if R2's or R3's decision is no.

## Decisions for the user

1. **Decision 4: servers ask an explorer about every block their registry is anchored in** (one GET each, in the
   background), beyond fetching the headers of renewals they finish, which was decided on 2026-11-17. Without it:
   option B, a forged header for 1/16 of a block's work stays a way to backdate claims everywhere, accepted.
2. **Remove `ref` and `REF_WINDOW`**, and with them the six headers and the floor's schedule decided for review 1's
   finding 6 on 2026-11-17. Not a kickoff decision, but it undoes one of the user's, and changes every record.
3. **Decision 12: a first lookup's name id is shown to every server in the room and to a relay that knows the room's
   ID**, in exchange for the tiers going. Without it: N5a stays as built.
4. Whether the three loops run before N6 (recommended) or as the planned loop at the end.
