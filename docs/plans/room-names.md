# Room names: registered names in a room (spec and plan, not built)

Human-chosen names in a room, registered first come by a key, for a term, with nothing of ours running and no
administrator: `test123` beside today's `<key>.<tag>.p2p.internal`. Chosen with the user, 2026-11-15, from the options
in [reports/Decentralized DNS for P2P rooms.md](../../reports/Decentralized%20DNS%20for%20P2P%20rooms.md) (its option
3, changed as below; the research notes behind it are `research_notes/`). Nothing here is built; the numbers marked
*estimate* are arithmetic, not measurements, and loop N0 replaces them. It extends
[networking/rooms.md](../networking/rooms.md), whose terms (room, link, tag, lookup, call back, the module) it uses.

## What it is, in one paragraph

A name's owner is whoever holds the oldest unbroken chain of **timestamped claims** on it. A claim is a signed record
stamped through OpenTimestamps, so that a Bitcoin block proves it existed by a certain height; a name is held for a
term (about 30 days) and kept by renewing, each renewal stamped the same way. Every claim proves its own place in line,
so **the owner's copy is the title**: the room's registry is a cache of such chains that members copy from each other,
and a room that loses it (everyone left) gets it back as owners return. Nothing is stored on a relay, there is no
room key and no server; Bitcoin is used only as a clock (no coin, fee or wallet), through public calendars and block
explorers a page can reach.

## Decisions taken (the user, 2026-11-15)

- **Room-wide names, a registrar's surface**: register, renew, point, let go. No petnames, no address books (a guest's
  `/etc/hosts` does that already).
- **A claim stamped earlier and held back can take a name** (the report's "withheld claim"): accepted. It is also what
  lets an owner come back after the room forgot it.
- **A room that empties loses its registry**: accepted; owners' nodes republish what they hold. Nothing is stored on
  Nostr relays, so rooms.md's "nothing about a node stays on a relay" stands and signalling stays replaceable.
- **Short terms**, renewed by the page on the user's behalf whenever it is open: "visit this page every N days".
- **Name owners serve the registry** and are found by an ephemeral "who serves the registry?" message; nothing about
  the sender goes in a room's link. Members who only use names announce nothing beyond what rooms.md already says.
- **OpenTimestamps is acceptable** as the clock.
- **A room connection may run without a guest** to publish names ("The names agent").
- **The registry never holds a name in words**: names are looked up by a hash, and where a name points is sealed
  under the name ("Names nobody lists"). Which names are acceptable is then each resolver's rule, not the registry's.
- Left out on purpose: which suffixes names may use (a rule every node enforces, decided later; the default below needs
  no decision).

## What it does not give

- **Certainty that a free-looking name is free.** A name is *provisional*: an older chain can surface (an owner back
  from three weeks away, or an attacker who stamped a dictionary and waited) and take it. The window closes only as far
  as terms are short: a held-back chain must have been renewed, with proof of work, every term.
- **Protection from impersonation of a name nobody present remembers.** Between a room's reset and the owner's return a
  stranger can hold the name; so can anyone against a member whose copy is older than a term. A member who holds the
  owner's current chain refuses the stranger and hands the chain to everyone it syncs with.
- **Instant registration.** A first claim stays private until its Bitcoin proof exists (hours: N0 measures it), or a
  watcher could stamp a competing claim into the same block. Renewals and changes of where a name points are instant.
- **Names in a room with nobody serving.** A newcomer to a room where no owner is online resolves only key names.

## Terms

| | |
|---|---|
| **owner key** | A BIP-340 key (secp256k1, `k256`, already a dependency) that signs a name's entries. One per name, derived from a secret the room connection keeps beside its node key (made at the first registration), so one owner's names can't be told to be one owner's. A node key is X25519 and can't sign. |
| **name id** | What stands for a name everywhere outside its owner's and its users' own pages: 32 bytes, a keyed hash of the name. |
| **entry** | A signed record on a name: `claim`, `renew` or `release`. Its **id** is the SHA-256 of its bytes. |
| **anchor** | An OpenTimestamps proof from an entry's id to the Merkle root of a Bitcoin block; the entry's **height** is the lowest block height among its valid anchors. |
| **chain** | A claim and its renewals, each naming the id of the one before. |
| **title** | A chain with its anchors and zone, as its owner keeps it (with the private key). |
| **zone** | Where a name points: a signed, numbered record, replaced whole. |
| **registry** | A node's copy of the best chain and newest zone of every name it has heard of. |
| **server** | A node running with the owner key of a live name: it answers "who serves the registry?" and other members' sync. |

## Names

One label, `[a-z0-9]` and inner `-`, 1 to 32 characters, lower case, no `--` in the third and fourth places (no
punycode in v1: look-alike names are a registrar's oldest problem). A registered name is
`<name>.<tag>.p2p.internal`, under the domain the lease already gives the guest, so the room's resolver gets the query
with no change to the lease, and a guest whose resolver uses the lease's domain as a search domain reaches it as plain
`<name>` (DHCPv6 option 24 carries it; the RA has no DNSSL: N3 checks Debian and Arch). A key name is 52 characters, so
the two never collide. A name's zone may add labels under it (`git.<name>.<tag>.p2p.internal`). A nicer suffix is the
later decision; it changes the resolver's match and the lease's domains, nothing else here.

## Names nobody lists

No record, message or stored registry holds a name in words. Three things do it:

- **The name id** is BLAKE2s, keyed with a key of the room's (from its ID, a label of its own), over the name. Entries
  and zones carry the id; sync orders by it; a resolver hashes what the guest asked and looks that up.
- **A zone is sealed under its name**: each place it points (the name itself, a label under it) is a slot, an 8-byte
  tag and a node key sealed with ChaCha20-Poly1305, tag and key both derived from the room's key and the full name
  asked. A zone has 4 or 16 slots, the unused ones random, so a holder sees neither how many labels a name has nor
  where any points. Whoever knows the name opens its slot; the owner's signature is over the sealed bytes, so anyone
  can check a zone without reading it.
- **An owner key per name**, so a registry doesn't show that five ids are one person's.

**What a holder of the registry still learns:** how many names the room has; each id's owner key and the heights of
its entries (when it was claimed and renewed; an owner's names renewed in one visit land in one block, so the agent
spreads them when it can); and **any name it can guess**: hashing a dictionary against the registry's ids is cheap,
and a slow hash wouldn't change that by much (a million guesses at 0.1 s each is a day of one machine, and every
resolver would pay the 0.1 s on each name a guest asks). So this hides names that aren't guessable and stops anyone
listing a room's names, as NSEC3 does for a DNS zone and GNS for its records; it doesn't make `www` a secret. In a
private room the key comes from an ID outsiders don't have, so there even a guessable name is hidden from them.

**What moves to the resolver:** the registry can't check a name's spelling, so an id for a name no resolver would ask
(too long, punycode, a suffix not allowed) can be registered and is dead weight its registrant paid for. The rules of
"Names" are enforced where names are still words: the resolver, and the dialog that registers.

## Records

Binary, fixed order, integers little-endian. Every record starts with a version byte (1) and the room's 40 prefix bits,
so a record of one room means nothing in another.

**Entry** (212 bytes):

| Field | Bytes | |
|---|---|---|
| version, kind | 1, 1 | kind: 0 claim, 1 renew, 2 release |
| room | 5 | the /48's 40 bits |
| name id | 32 | |
| owner | 32 | the owner key |
| prev | 32 | the id of the entry before; zeros in a claim |
| ref | 4 + 32 | a recent Bitcoin block, height and hash: the entry was made after it |
| nonce | 8 | proof of work |
| signature | 64 | BIP-340 over a tagged hash of the fields above |

- **Proof of work** is over the fields before the signature: the function's output has `POW_BITS` leading zero bits.
  It is bound to `ref`, so it can't be stockpiled or reused for the next term. Function and difficulty: N0 (below).
- **An entry is valid** when its signature and proof of work hold and it has an anchor at a height `h` with
  `ref.height <= h <= ref.height + REF_WINDOW`, `ref` being that height's real block.

**Anchor**: `height` (4 bytes) and OpenTimestamps operations from the entry's id to that block's Merkle root. The
verifier handles the three operations the calendars emit (append, prepend, SHA-256) and the Bitcoin attestation;
anything else is an invalid anchor; 4 KiB at most. A *pending* anchor (a calendar's receipt, its URL and commitment)
proves nothing and is carried only so that anyone can fetch the finished one.

**Zone** (~330 or ~1,000 bytes): version, room, name id, owner, `seq` (4), 4 or 16 sealed slots of 56 bytes ("Names
nobody lists"), a signature. An address is computed from the node key a slot opens to, as today, and the resolver's
answer teaches the module the key, so lookups to a named machine are sealed to it as lookups to a key name are. The highest
`seq` wins (equal: the lower hash). A zone needs no anchor: only the owner can write it, so there is nothing to order.

## Who owns a name

Heights are Bitcoin block heights; a node's **now** is the tip it last learned.

- An entry at height `h` holds the name until `h + TERM` and keeps it from others until `h + TERM + GRACE`.
- **A chain is unbroken** when each renewal is by the same owner key, names the entry before, and has a height above
  that entry's and at most its `h + TERM + GRACE`. It **covers** every height from its claim's to its last entry's
  `h + TERM + GRACE`. A `release` ends it at once.
- **The owner now** is the unbroken chain that covers now and has the lowest claim height. Equal heights: the lower
  SHA-256 of that block's hash and the claim's id (unknowable before the block, so it can't be ground).
- **The name resolves** while now is below the owning chain's last `h + TERM`; in the grace after it, it resolves for
  nobody and only the owner can renew.

The rule reads only chains that are alive, so a dead chain can be dropped by everyone without changing any answer, and
any two nodes holding the same chains agree, in whatever order they got them: partitions and resets merge without
negotiation. It has one deliberate consequence: a chain claimed while another held the name, and renewed ever since,
takes the name when the holder lapses (a back-order that costs proof of work every term). A registry keeps one chain a
name, the best it knows; offered a worse one, it answers with the better.

| Parameter | Proposed | |
|---|---|---|
| `TERM` | 4,320 blocks (~30 days) | the user's "a month, or shorter" |
| `GRACE` | 1,008 blocks (~7 days) | |
| `REF_WINDOW` | 144 blocks (~1 day) | must exceed the calendars' time to anchor: N0 |
| renew when | the last entry is older than `TERM / 3` | so the page says "every 3 weeks" with a week to spare |
| `POW_BITS`, function | N0 | target: under a minute of one core in a tab, in the background |

## Bitcoin as the clock

- **Stamping** (the page, `fetch`): the entry's id is POSTed to three calendars (`alice` and `bob` at
  opentimestamps.org, `finney` at eternitywall.com; two operators). Checked from a cross-origin-isolated page in
  Chromium, 2026-11-15: a receipt in 1.2 to 1.9 s, 172 to 226 bytes; the finished proof of a 2015 commitment still
  served (699 bytes, `access-control-allow-origin: *`), so an owner can collect an anchor weeks later. While a proof is
  pending the calendar answers 404 **without** the CORS header, which a page sees as a failed fetch: any failure there
  means "ask again later". One anchor is enough; three calendars are for availability.
- **Headers**: an anchor is checked against the 80-byte header at its height. The module learns `(height, header)`
  from two explorers (blockstream.info and mempool.space, both CORS-open, checked the same day) through its existing
  GET `Fetch`, takes a pair only when both agree, checks the header's own proof of work against a floor compiled in
  (a fraction of the difficulty at a pinned checkpoint, so a forged header costs a real miner's work), and keeps the
  table with the registry. Peers send the headers their chains need as hints; a hint is used once an explorer confirms
  it. With no explorer reachable, chains whose headers are already known keep resolving and new ones wait.
- **Depth**: an anchor counts once its block is 6 deep.
- **Now**: the tip from the explorers, asked again every 10 minutes while a room runs; between answers, the last tip
  plus the wall clock at a block per 10 minutes.
- The OpenTimestamps libraries are LGPL: nothing is copied from them; the verifier is written from the format
  (`THIRD_PARTY.json` gets a reference row).

## The registry between members

**Where it runs.** In the room module (`net/ts/src/room/names/`), as UDP between two members' room addresses inside
the WireGuard tunnel, port 2 both ends (`NAMES_PORT`; the guest's packets to or from it are dropped, as port 1's are).
Binary datagrams of at most 1,200 bytes; every exchange is a request and its answer, the requester resending at 0.5, 1
and 2 s, so nothing needs a reliable channel and DERP carries it as well as a data channel does. **Registry traffic
never starts a WebRTC connection** (rooms.md's rule holds: candidates go only where a guest asked), so a member's IP
address stays hidden from the servers it syncs with; it does keep the peer from being forgotten while a sync session
lasts.

**Finding a server.** "Who serves the registry?" is a lookup (rooms.md "Finding a peer": the same 122 bytes, MAC and
ephemeral kind) under a tag of the room's own, `BLAKE2s(tag salt, "names", hour)`, sealed with the room's lookup key,
with a `spread` byte in its body. Servers subscribe to that tag beside their own (six `#x` values in their REQ for
three) and answer by calling back, as a lookup's target does, but only when `BLAKE2s(nonce, own key)` falls under a
share set by `spread` and the number of live names the server knows; the asker raises `spread` with each resend (1 s,
3 s). So every server hears the question, a few picked by the nonce answer, and load spreads evenly over the servers
online without anyone keeping a list. A node holds 3 servers; a server takes 32 members at once and lets go of the
longest idle. A member with a registry from an earlier session falls back, after 6 s without an answer, to looking up
three targets of live names (a named machine is likely a server).

**Sync.** Items are ordered by name id; an item's version is a hash of its chain's last id, its anchors'
heights and its zone's `seq`. Two nodes compare a fingerprint of everything, then of 16 ranges, then of 16 within each
range that differs, down to ranges small enough to list (the id's and the version's first 8 bytes, 16 an item); whichever side has
the better or newer item sends it, in chunks. Messages: `root`, `range`, `list`, `get`, `item`, `have` (a server tells
the members it holds of an item it just took), `query` (one name id, for a resolver that can't wait: the server
learns which id a member wanted, not the name). A node syncs at the
start, every 5 minutes with jitter while the room runs, and on `have`. Both sides push: a member's copy can restore a
server's, which is how a room recovers after a reset without anyone detecting one.

**Verifying.** Signatures, proof of work and anchors are checked before an item is kept or answered from, a few
milliseconds' worth each turn of the module (it also carries the guest's packets), a name the resolver is asked for
first. A server can leave things out but not forge them; three servers and both-way sync make leaving out pointless.

**Keeping.** The registry and the header table persist per room in the page's storage, through the `store` event the
tailnet client already uses (web/tailscale-state.ts's pattern, a store of its own in `waarm64-room`); chains past
their grace are dropped at load and hourly.

**Size** (*estimates*): an entry ~200 bytes, an anchor ~900 before sharing (entries stamped in one block through one
calendar share most of it: perhaps 300 unique). A name costs ~1.5 KB plus ~0.5 KB a month it has been held: 5,000
names averaging six months, ~20 MB; the user's 100,000, several hundred MB, which is past what every member should
carry. The room for that, when a room gets there: members that verify and keep only owner, target and expiry (~120
bytes a name), or that ask servers per name and keep nothing ([backlog](../backlog.md) once built). First sync goes
through DERP, tailcat's public relays by default: N0 measures what they carry.

## The resolver

`resolve()` (room.rs) gains, after the key-name case: a name under `<tag>.p2p.internal` whose last label is a
registered, resolving name (by its id, once the name passes "Names"' rules) answers AAAA from the slot of its zone
that the name asked opens (the name itself, or with the label before it), TTL 60, and learns the key; a pending name of this node's own answers this node's address, so a server can be tried by name before its
registration is public. A name not in the registry: NXDOMAIN when the registry synced within the last 10 minutes;
otherwise the query waits up to 2 s on a `query` to the node's servers (found first, if it has none), then SERVFAIL, so
a guest's resolver retries and caches nothing. Guest-visible, in that names that were NXDOMAIN now answer.

## The names agent (the page)

`web/names.ts` with a worker (`web/names-worker.ts`, for proof of work; it instantiates `ts.wasm` for a few pure
exports, `ts_names_*`: make, mine, sign and check an entry; no JavaScript crypto dependency). It owns the owners'
secret and the titles, which are the only place a name is kept in words (IndexedDB `waarm64-room`, stores `owner` and `titles`, keyed as `identity` is, so names travel with a
connection's key and are in its export). It needs no running machine:

- **On every page load**, and hourly while open, for each title: fetch finished anchors for pending entries; renew
  when due (mine, sign, stamp); mark a claim public once anchored.
- **When the connection's room runs**, the titles go to the module in its config and as they change; the module
  serves them, pushes them to its servers and resolves them.
- **When it doesn't** (the machine is off, or the page is on another machine's), the agent publishes by itself: for a
  title with entries the room hasn't had, it runs that connection's room **without a guest**, for as long as pushing
  takes (find servers, sync, a minute at most), then closes it. The module runs without a guest already (the tests
  and benchmarks do); what's new is the page's path to it, which today refuses when the machine is off
  (`PageNetwork.connect`): the agent starts a room worker of its own under the key's lock (`roomKeyLock`: one running
  per key, so it waits if the connection runs elsewhere and gives way to a machine that starts), with incoming off and
  no guest's port, so nothing reaches or leaves a guest. It doesn't serve the registry in that minute. A renewal is
  published with its pending anchor, which any member can finish, so one short visit is enough: nobody need wait for
  the Bitcoin proof with the page open. With no server online there's nobody to push to; the title is safe and the
  next visit tries again. (The user, 2026-11-15: such connections may have a life apart from a guest's. This is the
  least of it that renewals need; a room connection that stays up without a machine isn't planned.)
- **Losing**: when the module learns a better chain for one of the titles, the agent stops renewing it and the page
  says so.

## What the user sees

**Reaching someone's name: nothing.** No switch, no notice. The first time a guest asks for a name that isn't a key,
the node finds servers and syncs; the answer comes within the resolver's 2 s or on the guest's own retry. The adapter's
details gain one line (names known, last synced), for the curious.

**Naming a machine.** In the Network menu of a room's adapter, **Name this machine…** opens one dialog:

1. A field. Under it, as typed, from the registry (by the id of what was typed): free, taken (until about a date), or
   not a valid name. Nothing lists a room's names, here or anywhere: the registry couldn't.
2. Two notices, always shown, no boxes: *members of this room who know the name can find this machine and see when it
   is online, and your machine helps other members look names up*; *open this page at least every 3 weeks to keep the
   name*.
3. **Register.** The dialog closes; the adapter shows the name with its state: *Preparing* (proof of work), *Reserved,
   public in about N hours; it already works on this machine*, then *Active, kept until about <date> unless you visit*.

No key is shown or asked for. Changing where a name points, adding a label under it and letting it go are in the
adapter's details. The Machines page shows a stored machine's names with the date each lapses, and the page says, on
load, when one is inside its last week. All words go in `web/messages/en/network.json`.

## What an attacker can do

| | Cost | Result |
|---|---|---|
| Register many names | proof of work each, again every term | squatting, as on the internet; the names lapse when it stops paying |
| Stamp a dictionary and hold it back | the same work, every term, for as long as it waits | takes a name later registered by someone else: accepted |
| Race a new registration | none | nothing: a claim is public only once anchored, and an anchor can't be had for an earlier block |
| Hash a dictionary against the registry | cheap | learns which guessable names exist and where they point; nothing about the others |
| Serve a partial registry | one registration | a member syncing with three servers still gets everything one honest server has |
| Hold a name after a reset | one registration | impersonates it to members who don't hold its chain, until one who does syncs |
| Forge a Bitcoin header | a real block's work, at the floor | one false anchor |
| Calendars all down | | no new claims or renewals; existing names resolve; `GRACE` is the margin |
| Explorers all down | | chains with known headers resolve; new ones wait |
| Flood "who serves?" | lookups' limits (rooms.md "Spam") | as lookups today |

## Measure first (loop N0, no product code)

1. **Time to anchor** from each calendar, over a week of stamps: sets `REF_WINDOW` and what the dialog promises. (One
   stamp made 2026-11-15 20:46 UTC is being watched; its result goes here.)
2. **Proof of work**: BLAKE2s hashcash against Argon2id at a few memory sizes, in Chromium's wasm and natively on one
   machine, and what a GPU does to each: picks the function and `POW_BITS`. Argon2 would be a new dependency.
3. **Verification rate** in the module's wasm (BIP-340 and an anchor's hashes): sets the slice a turn may spend.
4. **Anchor sizes**, raw and with shared tails, over a few hundred real stamps: replaces the size estimates.
5. **Sync through public DERP**: 1, 5 and 20 MB between two members on tailcat's relays.

## The track (`NAMES`)

Opened 2026-11-15: [NAMES-KICKOFF.md](../../NAMES-KICKOFF.md) is its brief (how it runs, which tests each loop runs,
each loop's done). The loops, as designed here:

- **N0** The measurements above, with their JSON under `bench/net/results/` and a section in bench/net/REPORT.md.
- **N1** Records and rules, pure Rust in `net/ts/src/room/names/` (`entry.rs`, `anchor.rs`, `bitcoin.rs`, `chain.rs`,
  `zone.rs`): encoding, signatures, proof of work, the anchor verifier, headers and the floor, ownership. `cargo test`:
  vectors (a real anchored proof and its header, committed), and a property test that any order of merging the same
  chains gives the same owner. The chain's parameters are a struct, so tests run a pretend Bitcoin of easy headers.
- **N2** The registry in the module: the store, port 2's messages, range sync, `have`, "who serves?" and its answer
  rule, limits. room/tests.rs's fake DERP and relay: two and twenty members converge; a reset recovers from one
  member's copy; a server that leaves names out; a worse chain refused; a forged anchor, header and signature.
- **N3** The resolver, persistence (`store`), headers through `Fetch`, with a pretend calendar and explorer for the
  tests (`tests/net/ots-calendar.ts`, no dependency, as the tests' relay). tests/page-room.test.ts: two Debian guests,
  one name, by full name and by the short one, a label under it, a zone change, NXDOMAIN against SERVFAIL.
- **N4** The agent: owners' secrets, titles, the worker, stamping, collecting, renewing on load, handing titles to
  the module, publishing without a guest. Tests with the pretend calendar: a claim held back until anchored, a renewal
  with the machine off that a second member then resolves, the key's lock against a machine starting meanwhile, a lost
  name, a title surviving export and import.
- **N5** The page: the dialog, the adapter's states, the details, the Machines page's dates, the catalog,
  docs/frontend.md.
- **N6** Scale and abuse: bench/net/room-scale.ts with 1,000 members and 5,000 names (sync bytes, time to a first
  answer, a server's load as members join); a week on the public calendars and relays with real stamps; an
  out-of-context review of `room/names/`.
- **The end**: `docs/networking/names.md` from this page, rooms.md's decisions and "What a room needs from a Nostr
  relay" updated, the leftovers in the backlog, this page and plans/networking-p2p.md's bullet gone.

## What changes that needed the user's OK (given 2026-11-15, all of it)

- **rooms.md's decisions that change**: "no directory in the protocol" and "the only names are names that are keys"
  (a registry of names, not of members, joins the protocol); a name's owner is discoverable and serves the registry.
- **Guest-visible**: the resolver answers registered names. No step count moves (`tests/steps.txt` has no room).
- **New outside services** a page with a room talks to: three calendars (only when registering or renewing: they see
  an IP address and a hash) and two explorers (every member with a room: an IP address and which block heights).
  Their lists could go in a room's link later, as relays do.
- **Parameters**: `TERM`, `GRACE`, the three weeks; the dialog's words.
- **Added with hashed names, not asked for**: zones sealed under the name, and an owner key per name. Either can go
  without touching the rest.
- **A dependency**, only if N0 picks it: `argon2` (RustCrypto, MIT/Apache-2.0).
- **The module's interface** grows (titles in the config, `store` and events for the room client, the `ts_names_*`
  exports); it is tailnet.md "The module"'s, not docs/abi.md's, and has no version number.
- **Wire**: servers' REQs carry six tags; pages from before don't serve or sync names, and otherwise still meet.

## Open, to settle in the loops

- Whether a claim may be published before its anchor when the user asks for it ("public now, may be raced"): not
  offered in v1.
- Old history: a chain grows by an entry a renewal for as long as a name is held. Dropping the middle of a chain a
  node verified itself is safe for that node and not for one that syncs from it; no compact proof of an unbroken
  chain was found.
- Transfer of a name to another owner key, and a recovery key: not in v1.
- The short name through the search domain on guests without systemd-resolved.
