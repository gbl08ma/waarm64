# NAMES2: room names' loose ends worth closing — kickoff

**In progress since 2026-11-23** (confirmed by the user; the questions it had are answered: "Decisions taken"). Progress: [NAMES2-HANDOVER.md](NAMES2-HANDOVER.md).

The user's brief (2026-11-23), in their words, on the backlog's "Room names' loose ends":

> The "Room names' loose ends" backlog entry is extremely long and I need your help to clean it up and organize it,
> perhaps even create one more properly structured track with loops for the things that are actually worth doing.

> Things that are lower priority for me, at least for now: vulnerabilities in the security/distributed model that
> would only affect a single user or domain (i.e. targeted attacks); anything requiring hour/day-long runs, or things
> that are simply measurements […]; items that are in the backlog because a small change or a small part of the
> approach "wasn't measured" […]
>
> Things that would be medium priority to me, depending on severity: gaps in the security/distributed model that
> allow a dishonest participant to ruin the functionality for everyone; implementation or design gaps that could
> leave a user's state in the system inconsistent […]
>
> Things that would be higher-priority concerns to me […]: correctness issues that could compromise the functionality
> of the system for a majority of honest participants; UX issues (note that the names/domains UI has already been
> redesigned since most of those backlog items were filled).

## The goal

What the Domains pane tells an owner is true, an honest owner's domain can't end in a state it doesn't leave, an
honest room's lookups don't fail under its own load, and a room's nodes don't hammer a public relay. Everything else
the NAMES track left stays in [docs/backlog.md](docs/backlog.md) "Room names' loose ends".

## Decisions taken

- Chosen by the user's priorities above: UX and correctness for honest participants first, then inconsistent state.
  Targeted attacks, measurements and long runs stay in the backlog.
- No change to the records' format or the wire protocol. A loop that finds it needs one stops and asks.
- What needs a design of its own is not here: servers holding a share of the id space, the reply flood in a room of
  hundreds of servers, the forged header at a member (backlog, "Needs a design, and the user's call").
- **New name asks what becomes of the connection's domains** (the user, 2026-11-23): New name is how a user gets away
  from members who learned their address, to one nobody knows, and a domain repointed by itself would lead them
  straight to the new one. So on a connection that holds domains, New name offers the choice: point them at the new
  key, or abandon them (let go, as [Let it go](ui:network:DomainCard.release) does).
- **A first silence from a room never heard is SERVFAIL**, "nobody serves" only at the second (the user, 2026-11-23):
  a room with no server answers NXDOMAIN ~2.5 s later than now.
- **A server's 16 replies a minute to one reply tag stay** (the user, 2026-11-23): one member asking 40 names at once
  isn't a realistic load, and it gets SERVFAILs, never a wrong answer.
- The pane was redesigned by DOMAINS after most of these items were written: each UX item starts by checking it still
  stands on today's pane (a screenshot), and one that doesn't is closed with a line saying so.

## The loops

One slice, one commit and a short report each; an item that no longer stands is a finding, written down.

1. **"About 2 hours" is true.** The agent asks for a claim's proof at 5, 10, 20, 40, 80, 140, 200 minutes
   (web/names.ts `RETRY_MS` doubling to `PASS_MS`), so a proof the calendars serve at 81 to 140 minutes is collected at
   140, past `PUBLIC_IN_MS`'s 2 hours, and the card falls to
   [the late wording](ui:network:names-view.reservedLate) with the page open: 76 of N0b's 80 real stamps would have
   (names.md "Findings"). Asks spaced around the expected proof (a first at an hour, then every 10 to 15 minutes to 3
   hours, then the doubling) make it true for ~90%, for a few more requests a claim to each calendar. Test: the
   agent's schedule against N0b's 80 recorded proof times (bench/net/REPORT.md "NAMES loop 0b"), failing first.
2. **A claim or a renewal that its calendars lost.** (a) A claim never goes stale, so when every calendar that
   stamped it lost the commitment the agent asks hourly for good and never makes it again: the domain stays Reserved
   for ever. A limit (made again after, say, a day with every calendar answering pending; the old one kept, since an
   anchor that does come still counts) ends it. (b) A server finishes the one pending anchor it keeps an entry (the
   lower of two); if that calendar never finishes, nothing finishes the renewal until the owner's next visit tries
   all three. Test the promise ("a visit of a few seconds every 2 weeks keeps a name", server_tests.rs's 60 days)
   with one calendar dead, and fix what it shows (the servers keeping both pending anchors is the likely fix).
3. **A title every copy agrees on.** (a) A copy of a title that renewed (another browser holding the backup) learns
   the other copy's release only as a "better" answer with no owner (`judge` says `none`, nothing taken in): its page
   shows the domain active until its own chain lapses and keeps renewing an ended branch. Take the release into the
   title on `none`. (b) A domain let go before its claim was public shows Let go, but what the agent publishes once
   the claim is anchored later (the claim with no release after it?) wasn't looked into (from the backlog's DOMAINS
   entry). (c) New name on a room connection that holds domains leaves them pointing at the old key until each
   card's [Point all at this connection](ui:network:DomainCard.pointHere) is pressed. New name's question offers
   the choice (decided above): point them at the new key, said with what that means (whoever knows a domain finds
   the new address), or abandon them.
4. **What a deleted connection leaves, and what a member logs.** The `names` store in `waarm64-room` is kept by
   room and connection: deleting a connection leaves its records for good (a member's few KB, a server's registry,
   up to 128 MiB). Sweep them at Delete. A member's resolver logs every query for a name that isn't a key to the
   worker's console, names in words included (the page tests read it): a count, or the words only under the tests'
   parameters.
5. **An honest room's lookups under its own load** (measured by N6a on the bus, bench/net/REPORT.md "NAMES loop
   6a"; each fix re-measured there with `bench/net/room-scale.ts names`):
   - 500 members joining in a minute, each asking one name (20 servers): 33 got NXDOMAIN, 30 of them silence taken
     for "nobody serves" (30 s). A first silence from a room never heard becomes SERVFAIL (asked again), "nobody
     serves" only the second (decided above).
   - A name in its grace resolved first while its renewal is pending is kept, and NXDOMAIN, for 5 minutes: a shorter
     freshness for a kept name in its grace ends it sooner.
6. **A relay that doesn't answer.** Every room node retries a dead default relay every few seconds for good (N6b:
   relay.degmods.com connected 142 times in 1.8 hours by two nodes; the backoff of 2, 4, 8, 16 s starts over after
   each connection that opens). A backoff that keeps growing while a relay keeps not answering, reset only by a
   connection that carried an event. This is the room client's as much as the names client's
   ([rooms.md](docs/networking/rooms.md) "What a room needs from a Nostr relay").
7. **The end:** an out-of-context review of what the loops changed; names.md, rooms.md and frontend.md updated; the
   backlog entry's pointer to this track removed, with what the loops left; the whole CI set.

## What needs the user's OK

- Anything guest-visible past loop 5's decided change, and any budget in names.md "Bounds and budgets".
- New words on the page beyond the catalog's entries for these loops; any dependency; any change to the records or
  the wire (none planned).

## Validation

- Each fix starts with its test, failing first: the Rust tests on the bus (`cargo test -p waarm64_ts`), the agent's
  (`tests/names-agent.test.ts`), the page's (`tests/names-page.test.ts`).
- `scripts/ci-fast.sh` after each loop; before a push `scripts/ci.sh` and `scripts/ci-net.sh` (names in two Debian
  guests); at the end the whole set. No run on the public services: loop 6 is tested on the tests' relay.

## The end

names.md says what exists; the backlog entry holds only what is left; PLAN.md's row set to done; this file and
NAMES2-HANDOVER.md deleted.
