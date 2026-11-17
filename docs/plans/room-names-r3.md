# Room names, loop R3: a first lookup asks the room through the relays

This replaces "R3" and option C of question 2 in [room-names-redesign.md](room-names-redesign.md). The user accepted
(2026-11-17) that a first lookup shows its name id to every server in the room and to a relay that knows the room's
ID. Given that, a first lookup no longer finds servers and then asks them: **it asks the room for the name, and the
answers come back through the relays too.** **Built in R3 (2026-11-17)**, with the user's answers to the four points at
the end (records through relays: yes; names that don't exist announced again: yes; `REPLY_MAX` 4 KiB, the relays
measured in a dev VM session; no publisher `ask`): room-names.md "Finding a server", "A member resolving a name" and
"Servers" say what the code does, and "As built" below what this page left open. The numbers marked *estimate* are
from the P2P track's R4 table (bench/net/REPORT.md "Rooms on public servers"), not measurements of this design.

## Summary

- **One new question, `ask`**, an ephemeral event under the room's names tag: the name id, what the asker has been
  shown so far, and how wide a share of servers should answer. **One new answer, `reply`**, an ephemeral event under a
  tag the asker listens on: the owning chain's last entry with its anchor and header, and the zone.
- **Sampling** as "who serves?" does it (1/64, 1/8, everyone), started where the last lookup found the room. **Dissent
  is the same message** sent once more, saying whose chain was shown: every server that holds another owner answers,
  whatever the share.
- **No call back, no DERP and no server's proof on a first lookup.** A reply is believed for what it contains, which
  the member checks; who sent it doesn't matter, so there is no draw to win and no handshake window to fill. A session
  through DERP is opened only when two owners contest a name, or a reply is too big for an event, and then only to
  the servers the member names.
- **"Who serves?" stays** for what must not name an id: the dialog's check, a publisher's `put`s, servers' sync
  partners, and the refresh of names a member keeps. It goes back to the plain draw: N5a's tiers come out.
- **A first lookup** on public relays: about 1 s in a room it has asked before, about 2 s the first time (*estimate*).
- **For the user**: four points at the end. None changes a decision as amended; two widen what answer 3 covered by
  a little, one is about touching public relays before N6.

## The messages

Both are events of the rooms' kind, MAC'd and sealed with the room's lookup key as a question is
(`lookup::seal_bare`), dropped by the same rules (the MAC first, copies through other relays, an hour off the clock).

**`ask`** (~165 bytes; about 650 on the wire), under `Room::names_tag`, which servers already hold a subscription to:

| Field | Bytes | |
|---|---|---|
| a lookup's body | 122 | the names client's key (new each session), its region, the time, a nonce |
| name id | 32 | |
| mode | 1 | `share`, `dissent` or `fetch` |
| spread | 1 | `share`: a server answers when its rank's top `spread` bits are zero, as for "who serves?" |
| shown | 8 | `dissent`: what the asker was shown, zeros for none; since R3a 8 bytes of a hash of the owner key, its last entry's id and the zone ("As built"; it was the owner key's first 8 bytes). `fetch`: the first 8 bytes of the names key of the one server asked |

**`reply`**, under the asker's reply tag, `BLAKE2s(tag salt, "names-reply", the asker's names key, hour)`, which its
names client subscribes to once, when it starts:

| Field | Bytes | |
|---|---|---|
| nonce | 16 | the ask's |
| server | 34 | the replier's names key and region, for a `fetch` |
| since | 4 | the time of the first entry of the owning chain's run, as the server holds it; unchecked, used only to order a contest |
| item | 0, or 0.6 to 2.7 KB | nothing: the server holds no owner for the id. Else the owning chain's last entry (175 bytes), its anchor (300 to 1,250) and header (80), and the zone (366, or 1,038 wide) |

A reply with its item is 1.3 to 4.1 KB on the wire (base64 in an event). An item past `REPLY_MAX` (a parameter, set from what the default
relays forward; 4 KiB to start) is left out and a flag says so: the member fetches it (below).

**A server** (`on_ask`), for an ask whose MAC holds, once it has synced:
- `share`: in the share, it replies, with the item or with none. Out of it, nothing.
- `dissent`: it replies only if it holds an owner for the id and what it holds isn't what `shown` names (any owner,
  when `shown` is zeros; since R3a the owner key, the last entry and the zone, "As built"). Whatever the share.
- `fetch`: if `shown` names it, it calls the asker back and sends `history` for the id, as it does today.
- It publishes a reply through the two relays that brought the ask first. Budget: replies have one of their own (2 a
  second, apart from call backs and from answers to "who serves?"), and one reply tag gets 16 a minute.
- A reply carries no proof that the replier is a server. Its share is its own to keep: an honest server answers only
  in its share, and a dishonest one gains nothing by answering outside it.

## A first lookup

For a name the member doesn't keep (never resolved, or what it kept has ended):

1. **Ask**, mode `share`, at the spread that last brought one to eight replies in this room (the first time: 6), then
   wider after 0.4 s and 1 s while nothing comes, as today's rounds.
2. **Check each reply's item** as a `get`'s answer is checked now (signature, proof of work, header, anchor, alive;
   the zone's signature). One reply an entry id is checked; a junk one is dropped at its first failed check. There is
   no limit on how many are let in, only a budget of checks a turn.
3. **At the first reply**, unless the round already asked everyone: ask once more, mode `dissent`, `shown` the owner
   key of the best item so far (zeros when every reply so far said none).
4. **0.7 s after that ask** (0.3 s after the first reply when everyone was asked), decide:
   - **every item names one owner key**: that owner. Of several last entries by one key (a server a renewal behind, a
     title forked), the latest. No history is needed: one key, one owner.
   - **none, from at least one server**: NXDOMAIN, kept 60 s, doubling to 10 minutes while the name stays unknown.
   - **two or more owner keys**: a contest. The member sends `fetch` to one replier for each key, eight at a time, the
     earliest `since` first, lets in handshakes from those names keys only, checks each `history` as it does today,
     and picks by "Who owns a name". It stops when the best run checked is older than every `since` left. The query
     gets SERVFAIL at 4 s if this isn't done; the lookup goes on and the next query has the answer.
   - **silence through the last round**: nobody serves. Remembered as today (30 s doubling to 10 minutes).
5. A reply that comes after the decision, within 3 s, is still checked: a different owner starts the contest, and what
   the member keeps changes if the newcomer's run is older.

Then the name is kept, and everything after is as now: it answers at once, and its refresh, 5 minutes on if the guest
still asks, goes to two servers found by "who serves?" over sessions. **A refresh never sends an `ask`**: that would
tell the room how long a name stays in use. The member redraws its two servers every 15 minutes while it holds any,
so a pair that serves a stale zone isn't kept for as long as the guest goes on asking.

## Why dissent makes the sample's honesty irrelevant

The share only bounds how many answer. An attacker can be every server in the sample and can add replies of its own
at will; each is either a valid chain for the id or nothing. The dissent ask then names the owner shown, and any
honest server that holds another owner replies with it. The member decides by the rule over everything it was shown,
so the real owner's chain wins if one honest holder heard the ask and its reply arrived. Registrations buy the
attacker nothing here: there is no place to win.

## Time and load (*estimates*)

- **A relay leg** (publish to delivery) is 100 to 250 ms on the relays that carried rooms in R4; a lost event and its
  resend, 1.4 s.
- **A first lookup in a room asked before**: ask and first reply ~0.4 s, dissent's wait 0.7 s: **~1.1 s**.
- **The first in a session**: the names client's relay connections and subscription first (0.3 to 0.6 s; it doesn't
  wait for DERP any more), and in a room of a few servers the rounds down to everyone (1 s): **~2 s**. Today's path
  (a DERP connection, question, call back, `serve`, `get`) was 1.3 s on the fake relay and wasn't measured on public
  ones; it has two DERP round trips and a handshake more.
- **A relay carries**, a first lookup: two to four asks (650 bytes each, forwarded to every server on that relay, as
  questions are now) and one to eight replies of 1.3 to 4.1 KB through two relays, to one subscriber. A member sends
  4 asks a second at most.
- **Servers**: a look in their store an ask; a reply only in their share or when they differ.
- **Not known**: whether every default relay forwards an ephemeral event of 4 KB, and at what rate it limits a
  server's replies. Two of 25 relays rate-limited a burst of 16 small events in R4. If a relay's limit is under the
  item's size, `REPLY_MAX` goes under it and items come by `fetch`: the design holds, a first lookup costs a session.

## What an attacker can still do

| | Cost | Result |
|---|---|---|
| Be the whole sample, show its own younger chain or none | registrations | nothing, while one honest holder's dissent arrives |
| Keep honest dissent away: flood asks until servers' reply budgets are spent | events at each server's 2 a second, sustained, through relays that rate-limit | members take what the attacker shows for names they don't keep, while it lasts. Loud; the budget for replies is apart from "who serves?" answers so the two can't starve each other |
| Hold many younger claims on one name, each lying about `since` | a registration on that name each, every term | that name's first lookups run a contest: a `fetch` and a history check a liar, eight at a time. A hundred liars (two hours of a core a term) hold a first lookup up for tens of seconds. The owner still wins |
| Send junk replies under an asker's tag (it reads the tag's inputs in the ask) | events | a failed check each (0.15 ms for a bad signature); no place taken from anyone |
| Forged asks that make servers reply (`dissent` with a made-up `shown`, or `share` at spread 0) | one event | every holder replies once: up to 4.1 KB each through two relays, where today's forged question costs a handshake each. Bounded by 2 replies a second a server and 16 a minute a tag. With hundreds of servers that is megabytes a second onto public relays: where such rooms exist, servers answer on one relay and thin their replies by the room's size |
| A relay that knows the room's ID drops replies | being a relay of the link | one relay of several: replies go through two, asks through all |
| Be both servers of a member's refresh | registrations (the plain draw) | a stale zone, or a release unseen, for 15 minutes at most before the redraw; never another owner (a kept chain yields only to an older run) |
| Swallow a publisher's `put`s, be a new server's sync partners | registrations | slower spread, as in the redesign document: each put and each round draws afresh |

## What a member reveals

As answer 3 accepted, and no more on a first lookup: the name id, to every server and to a relay that knows the room's
ID, from a key new each session. Two things follow from the shape that are worth saying:
- **A name that doesn't exist is asked again** when its negative answer runs out (60 s doubling to 10 minutes), for as
  long as the guest asks for it. Each is still a lookup of a name the member doesn't keep.
- **Replies show the room what was answered.** They carry registry records, which any asker can have anyway.

## What changes in the code

- **`wire.rs`**: `ask`'s three bytes and `shown` after a lookup's body; `reply`. `Serve` loses its run (one entry).
- **`room.rs`**: the names client subscribes to its reply tag and publishes and receives the two events (the
  plumbing a question uses); a member's names client no longer waits for its home region before a first lookup; the
  accept window, for a member, lets in only keys it sent `fetch` to.
- **`server.rs`**: `on_ask`, the replies' budget and the per-tag limit; `TIERS`, `tier`, the tier in `rank` and
  `choice`, and `SERVE_RUN` removed; `on_question`, `serve`, `get`, sync and `put` otherwise as they are.
- **`member.rs`**: a first lookup's states (rounds, replies, dissent, decide, contest) replace "find servers, `get`
  both, `history` if they disagree" for names not kept; the contest reuses the history check and `Kept::offer`. The
  servers a member holds, `get` in owner mode and `ids` stay, for refresh and the dialog; the 15-minute redraw is new.
- **Unchanged**: the store, sync, the agent, the publisher, the dialog's check, the page, the resolver's cases and
  waits.
- **Tests** (failing first, a planted bug each): a first lookup with no session opened; the sample all an attacker's
  (128 and 1,280 junk registrations, one honest holder: the member gets the owner); none shown and a holder dissents;
  one key's two last entries need no history; liars' `since` cost a fetch each and lose; a late dissent replaces
  what was kept; junk replies take no place; a refresh sends no `ask`; an item past `REPLY_MAX` comes by `fetch`; the
  reply budget apart from the answers'; no `ask` for a kept name. tests/page-room.test.ts's first-lookup time again.

## For the user

1. **Registry records pass through relays** as ephemeral events (replies), where until now only questions did.
   Nothing is stored and nothing is shown that an asker couldn't get: inside decision 2 as written, but it is new.
2. **Names that don't exist are announced again** each time their negative answer runs out. Answer 3 said "a first
   lookup's name id"; this reads it as "a lookup of a name the member doesn't keep".
3. **Public relays before N6.** The kickoff keeps public services to N0 and N6. Whether the default relays forward a
   4 KB ephemeral event, and how fast, decides `REPLY_MAX`: about a hundred events to the six defaults, from R3 or
   from N0c before it. Without it R3 builds with 4 KiB and N6 finds out.
4. **Optional, not in the plan above**: a publisher could check that the room has its last entry by an ordinary `ask`
   for its own name, and put again through a fresh draw when it hasn't. That announces the id from the owner's
   address (as any member's lookup would look), which answer 3 didn't cover. Left out unless wanted.

## As built (R3, 2026-11-17)

What this page left open, settled by its own reasoning:

- **Rounds**: always three, at 0, 0.4 and 1 s: the start, 3 bits wider, everyone. A room found at "everyone" asks
  everyone again at 0.4 and 1 s while nothing counts, so a server whose reply budget was spent (a guest asking several
  names at once in a small room) or a relay that lost the ask is asked again; servers reply to a nonce once. Past eight
  replies the next lookup starts 3 bits narrower (to 15 at most).
- **What counts as a reply**: one whose item held its checks, or one that said none or too big. A junk reply counts for
  nothing: it neither sets off the dissent nor the decision. `shown` is the owner key of the best item **checked** so
  far: an unchecked item bearing the owner's key would otherwise silence every holder.
- **Checks**: an entry checked whole once a lookup, by its id; its anchor with each copy, so a forged anchor on a copy
  of a real entry can't get the real one refused. A reply's item must be exactly one entry of the name, alive, with
  the owner's zone for the name if any.
- **Silence** after a reply counted in the last minute isn't "nobody serves": the query gets SERVFAIL and the next asks
  again (budgets spent, not an empty room).
- **NXDOMAIN's doubling** is kept while the name stays unknown: forgotten once its wait has passed as long again with
  the name unasked.
- **A contest** runs over repliers, not keys: each `(since, server)` in order, 8 fetches at once, a replier skipped when
  its key already has a run checked at least as old as it claims; it ends once nothing is in flight and the best run is
  older than every `since` left (a liar fetched first loses; a truncated run shown for the owner's key doesn't stop
  the owner's honest replier being fetched). An item too big is a replier of unknown key in the same list. A contest
  with no run that held gives no answer; the next query asks again.
- **A late reply** (3 s) with another key starts a contest; one that brings an owner to a name decided none is taken.
- **`fetch`**: the server's call back comes from its answers' budget (4 a second) and a key's 4 a minute, as a
  question's answer does (it calls a key the ask names, which proves nothing), not from the replies' budget; it then
  sends `items` unasked (transfer 0). The member sends a `fetch` only once its home region is up; `share` and
  `dissent` go at once, before it.
- **Two relays**: the reply goes through the relay that brought the ask and the one whose copy came next; with no copy
  1 s after the reply, through another connected relay.
- **The reply tag** is subscribed to before the names client's first ask (at its first lookup, not at its start), so a
  publisher, which never asks, never subscribes to one.
- **A reply's region** is the replier's names client's home region, filled in by the transport.
- **`REPLY_MAX`** bounds the item's encoded bytes (4,096); a member drops unread a sealed reply longer than the head,
  4 KiB and the seal; `Server::reply_max` lets the tests lower it.
- **A server with no live name** is in no share but "everyone".
- **An ask counts the name as asked for** at a server (the bound keeps it), as a member's `get` does.
- **The 15-minute redraw** waits for the requests in flight to the servers held.

Found while building it, not in the design: **the owner's own last entry shown with an old zone or none.** An
attacker in a first lookup's sample can reply with the owner's real last entry (public, valid) and no zone, or an old
one; the dissent then named the owner's key, so honest holders stayed silent, and the member kept the owner with that
zone until its refresh 5 minutes on (NXDOMAIN or an old address meanwhile). **Closed in R3a (2026-11-17)**:

- **`shown` covers the entry and the zone.** A `dissent`'s 8 bytes are `SHA-256` (BIP-340-style tagged,
  `waarm64/names/shown`) over the owner key, the last entry's id, and the zone's own tagged hash (nothing for none),
  truncated (`wire::shown`; a hash of zeros would read as "none" and is taken as `01 00 …`). The member hashes the
  best item checked so far as it would keep it: the owner by the rule, that key's latest last entry, its best zone
  (`Zone::beats`); a server hashes what it holds (the owning chain's last entry, its zone) and replies when the two
  differ. So the honest holder of a newer zone, or of a renewal, replies. The `ask` is still **164 bytes** (100 in the
  plain): the field stays 8 bytes, a hash in place of a key's prefix.
- **What it costs**: a server holding something *older* than what was shown (a sync behind) replies too; the member
  keeps the latest entry and the best zone of everything, as it did. In a room of 129 holders of one item, a lookup
  drew at most 5 to 15 replies over six lookups (two runs), where every holder dissenting would be 129.
- **What it reveals**: nothing new of the asker. The hash is of public records the replies before it carried, so a
  server, or a relay that knows the room's ID, learns which version of the records the asker was shown; before, it
  learnt the owner key's first 8 bytes. A 64-bit hash can't be steered by the attacker to match an honest holder's:
  it chooses among the owner's genuine records, a few, never a value.
- **Not covered, on purpose**: the anchor and its header (a valid anchor of the same entry from another calendar moves
  the entry's time by the gap between their blocks, hours: the member keeps the later time, which only lengthens its
  cover a little until the refresh; covering it would make every holder of another copy reply), `since` (it orders a
  contest and is unchecked anyway), and the replier's key and region (a `fetch`'s).
- **Not closed: an entry before a release.** An attacker can show the owner's last entry before its release (public,
  alive by its own time). Holders of the release hold no owner, so they don't dissent, and a reply can't carry a
  release (an item is one live entry): the member keeps the released owner until its refresh 5 minutes on, whose
  `get` sends the release. If the name has a next owner, its holder does dissent, but the contest's fetched runs carry
  no release (a `fetch` answers `history`, nothing held), so the old run wins it and the member keeps the released
  owner over the next one for those 5 minutes (confirmed on the bus with 128 liars and one honest holder). Closing it
  takes a reply and a fetched run that carry a release, and a member that takes one: docs/backlog.md.

Tests (R3a): `the_owners_own_records_shown_stale_dont_silence_the_dissent` (member_tests.rs: 128 liars as the whole
sample showing the owner's last entry with an old zone, with none, or a renewal behind in its grace; one honest holder
of the newest; six first lookups each: the newest entry and zone every time, no contest; and with no liars, holders of
what was shown stay silent); `a_server_replies_to_asks_by_their_mode` (server_tests.rs: silent for exactly what it
holds, a reply for an old zone, none, an entry behind, or the key's bare prefix). It failed on R3's code at the first
lookup of each kind (the old zone's `0x01…`, NXDOMAIN for the other two). Planted: the zone left out of the hash (both
sides) and the entry left out (both sides): the member test and the server test; a server hashing its entry without
its zone: the member test ("no zone") and the server test; a member hashing without the zone: the member test's
silence check (every holder replied).

Measured (cloud, 2026-11-17): on the bus (`member_tests.rs`) 128 and 1,280 junk registrations as the whole sample,
showing their own younger chain or saying none, against one honest holder: the owner every time, up to 2.4 s (a
contest of 4 to 5 fetches) or ~1.1 s (no contest), 6 to 26 replies a lookup; through the fake DERP and relay
(room/tests/names.rs) a first lookup in a room of two servers 1.3 s with no DERP packet to or from the member's names
client, the next 0.3 s, a contested one 1.3 s with each reply through two relays; forged asks (`server_tests.rs`):
2,000 from 200 keys over 10 s, 20 replies; one tag's 120 over 2 minutes, 32.
