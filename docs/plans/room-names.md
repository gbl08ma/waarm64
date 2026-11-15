# Room names: registered names in a room (spec and plan, not built)

Human-chosen names in a room, registered first come by a key, for a term, with nothing of ours running and no
administrator: `test123` beside today's `<key>.<tag>.p2p.internal`. Chosen with the user, 2026-11-15, from the options
in [room-names-options.md](room-names-options.md) (its option 3, changed as below; the research notes behind it are
`room-names-research/`), then revised the same day after an out-of-context review of the first draft ("What the review
changed", at the end). Nothing here is built; the numbers marked *estimate* are arithmetic, not measurements, and loop
N0 replaces them. It extends [networking/rooms.md](../networking/rooms.md), whose terms (room, link, tag, lookup, call
back, the module) it uses. The track's brief is [NAMES-KICKOFF.md](../../NAMES-KICKOFF.md).

## What it is, in one paragraph

A name's owner is whoever holds the oldest unbroken chain of **timestamped claims** on it. A claim is a signed record
stamped through OpenTimestamps, so that a Bitcoin block proves it existed by that block's time; a name is held for a
term (about 30 days) and kept by renewing, each renewal stamped the same way. Every claim proves its own place in line,
so **the owner's copy is the title**. The room's registry is a cache of such chains: **name owners hold all of it and
serve it; everyone else asks a server for the one name it wants** and checks the answer itself. A room that loses the
registry (everyone left) gets it back as owners return. Nothing is stored on a relay, there is no room key and no
server of anyone's; Bitcoin is used only as a clock (no coin, fee or wallet).

## Decisions taken (the user, 2026-11-15)

- **Room-wide names, a registrar's surface**: register, renew, point, let go. No petnames, no address books (a guest's
  `/etc/hosts` does that already).
- **A claim stamped earlier and held back can take a name** (the options' "withheld claim"): accepted. It is also what
  lets an owner come back after the room forgot it.
- **A room that empties loses its registry**: accepted; owners' nodes republish what they hold. Nothing is stored on
  Nostr relays, so rooms.md's "nothing about a node stays on a relay" stands and signalling stays replaceable.
- **Short terms**, renewed by the page on the user's behalf whenever it is open: "visit this page every N days".
- **Name owners serve the registry** and are found by an ephemeral "who serves the registry?" message; nothing about
  the sender goes in a room's link. Members who only use names announce nothing beyond what rooms.md already says.
- **OpenTimestamps is acceptable** as the clock.
- **The page may reach a room without a guest** to publish names ("The names agent").
- **The registry never holds a name in words**: names are looked up by a hash, and where a name points is sealed
  under the name ("Names nobody lists"). Which names are acceptable is then each resolver's rule, not the registry's.
- Left out on purpose: which suffixes names may use (a rule every node enforces, decided later; the default below needs
  no decision).

## What it does not give

- **Certainty that a free-looking name is free.** A name is *provisional*: an older chain can surface (an owner back
  from three weeks away, or an attacker who stamped a dictionary and waited) and take it. The window closes only as far
  as terms are short: a held-back chain must have been renewed, with proof of work, every term.
- **Protection from impersonation of a name nobody present remembers.** Between a room's reset and the owner's return a
  stranger can hold the name. A member that resolved the name before refuses the stranger while the chain it saw is
  alive; a server that holds the owner's chain hands it to everyone.
- **Instant registration.** A first claim stays private until its Bitcoin proof exists (hours: N0 measures it), or a
  watcher could stamp a competing claim into the same block. Renewals and changes of where a name points are instant.
- **Names in a room with nobody serving.** Where no owner is online, only key names resolve.
- **A registry of any size.** Servers carry every chain with its history, through DERP: *estimated* comfortable to
  about 2,000 names, heavy at 5,000 ("Size, and where it stops"). Members carry nothing.

## Terms

| | |
|---|---|
| **owner key** | A BIP-340 key (secp256k1, `k256`, already a dependency) that signs a name's entries. One per name, derived from a secret the room connection keeps beside its node key (made at the first registration), so one owner's names can't be told to be one owner's. A node key is X25519 and can't sign. |
| **name id** | What stands for a name everywhere outside its owner's and its users' own pages: 32 bytes, a keyed hash of the name. |
| **entry** | A signed record on a name: `claim`, `renew` or `release`. Its **id** is the SHA-256 of its bytes. |
| **anchor** | An OpenTimestamps proof from an entry's id to the Merkle root of a Bitcoin block. The entry's **time** is that block header's timestamp. |
| **chain** | A claim and its renewals, each naming the id of the one before. |
| **title** | A chain with its anchors and zone, as its owner keeps it (with the secret). |
| **zone** | Where a name points: a signed, numbered record, replaced whole. |
| **server** | A node whose page holds the title of a live name: it keeps the whole registry and answers others. |
| **member** | Any other node: it asks servers for the names its guest wants and keeps what it verified. |
| **names client** | The part of a node that talks to the registry. It is a room client of its own, under a key made new each session, relay only: nothing it does is tied to the node's key or shows its IP address. |

## Names

One label, `[a-z0-9]` and inner `-`, 1 to 32 characters, lower case, no `--` in the third and fourth places (no
punycode in v1: look-alike names are a registrar's oldest problem), and **not on a reserved list** compiled into the
resolver and the dialog: names a guest asks for unprompted or trusts by habit (`wpad`, `isatap`, `localhost`,
`gateway`, `router`, `broadcasthost`, and labels that are top-level domains or look like one: `com`, `net`, `org`,
`local`, `lan`, `home`, `internal`, …). Without it, whoever registered `wpad` first would configure every guest's
proxy, and whoever held `com` would answer `example.com.<tag>.p2p.internal`, which a guest's search list asks for.

A registered name is `<name>.<tag>.p2p.internal`, under the domain the lease already gives the guest, so the room's
resolver gets the query with no change to the lease, and a guest whose resolver uses the lease's domain as a search
domain reaches it as plain `<name>` (DHCPv6 option 24 carries it; the RA has no DNSSL: N3 checks Debian and Arch, and
what they ask the search domain unprompted). A key name is 52 characters, so the two never collide. A name's zone may
add labels under it (`git.<name>.<tag>.p2p.internal`). A nicer suffix is the later decision; it changes the resolver's
match and the lease's domains, nothing else here.

## Names nobody lists

No record, message or stored registry holds a name in words. Three things do it:

- **The name id** is BLAKE2s, keyed with a key of the room's (from its ID, a label of its own), over the name. Entries
  and zones carry the id; servers order by it; a resolver hashes what the guest asked and asks for that.
- **A zone is sealed under its name**: each place it points (the name itself, a label under it) is a slot, an 8-byte
  tag and a node key sealed with ChaCha20-Poly1305, tag and key both derived from the room's key, the full name asked
  **and the zone's `seq`** (so no key or tag is used twice and the unused slots, random bytes, can't be told from the
  used across versions). A zone has 4 or 16 slots, so a holder sees neither how many labels a name has nor where any
  points. Whoever knows the name opens its slot; the owner's signature is over the sealed bytes, so anyone can check a
  zone without reading it.
- **An owner key per name**, so a registry doesn't show that five ids are one person's.

**What a server still learns:** how many names the room has; each id's owner key and the times of its entries (an
owner's names renewed in one visit land in one block, so the agent spreads them when it can); which ids are asked for,
though not by whom (the names client's key is new each session); and **any name it can guess**: hashing a dictionary
against the registry's ids is cheap, and a slow hash wouldn't change that by much (a million guesses at 0.1 s each is a
day of one machine, and every resolver would pay the 0.1 s on each name a guest asks). So this hides names that aren't
guessable and stops anyone listing a room's names, as NSEC3 does for a DNS zone and GNS for its records; it doesn't
make `www` a secret. In a private room the key comes from an ID outsiders don't have.

**What moves to the resolver:** the registry can't check a name's spelling, so an id for a name no resolver would ask
can be registered and is dead weight its registrant paid for. The rules of "Names" are enforced where names are still
words: the resolver, and the dialog that registers.

## Records

Binary, fixed order, integers little-endian. Every record starts with a version byte (1) and the room's 40 prefix
bits; the hash that is signed also takes a 32-byte value derived from the room's whole ID, so a record of one room
means nothing in another, even one whose prefix was made to collide.

**Entry** (207 bytes):

| Field | Bytes | |
|---|---|---|
| version, kind | 1, 1 | kind: 0 claim, 1 renew, 2 release |
| room | 5 | the /48's 40 bits |
| name id | 32 | |
| owner | 32 | the owner key |
| prev | 32 | the id of the entry before; zeros in a claim |
| ref | 32 | the hash of a recent Bitcoin block: the entry was made after it |
| nonce | 8 | proof of work |
| signature | 64 | BIP-340 over a tagged hash of the fields above and the room's value |

- **Proof of work** is over the fields before the signature: the function's output has `POW_BITS` leading zero bits.
  It is bound to `ref`, so it can't be stockpiled or reused for the next term. The function must be cheap to check
  (a server checks every entry of the room), which weighs against a memory-hard one: N0.
- **An entry is valid** when its signature and proof of work hold and it has an anchor whose block's time `t` is
  within `ref`'s block's time minus 2 hours (block times aren't ordered to the minute) and plus `REF_WINDOW`.

**Anchor**: OpenTimestamps operations from the entry's id to a block's Merkle root, and that block's hash. The
verifier handles the three operations the calendars emit (append, prepend, SHA-256) and the Bitcoin attestation;
anything else is an invalid anchor; 4 KiB at most. **One anchor an entry is kept**, the one with the earliest time; a
node offered an earlier one for an entry it holds takes it, so an entry's time only ever moves back, and every node
that has seen the same anchors has the same time. A *pending* anchor (which of the compiled calendars, and its
commitment: never a URL) proves nothing and is carried only on a chain's last entry, one at most, so that a server can
fetch the finished one; it is dropped once its entry could no longer be valid.

**Zone** (362 bytes with 4 slots, 1,034 with 16): version, room, name id, owner, `seq` (4), the slots (56 each), a
signature. An address is computed from the node key a slot opens to, as today, and the resolver's answer teaches the
module the key, so lookups to a named machine are sealed to it as lookups to a key name are. The highest `seq` wins
(equal: the lower hash). A zone needs no anchor: only the owner can write it, so there is nothing to order. A server
takes a new zone for a name at most once in 10 minutes.

## Who owns a name

Times are Bitcoin block headers' timestamps, which a header carries under its own proof of work; **now** is the node's
wall clock (rooms already need it right to within most of an hour).

- An entry at time `t` holds the name until `t + TERM` and keeps it from others until `t + TERM + GRACE`.
- **A chain is unbroken** when each renewal is by the same owner key, names the entry before, and has a time not
  before that entry's and at most its `t + TERM + GRACE`. It **covers** from its first entry's time to its last
  entry's `t + TERM + GRACE`. A `release` (anchored like any entry) ends the cover at its own time.
- **A chain's seniority** is the time of the first entry of the unbroken run a node holds of it: the claim's, when it
  holds the whole chain.
- **The owner now** is, of the chains that cover now, the one with the earliest seniority. Equal: the lower SHA-256 of
  the first entry's anchor block's hash and its id. The same first entry (one chain forked, or one a longer copy of
  the other): the one whose cover ends later, then the lower last id; a chain with a release beats the same chain
  without it. That is a total order, so two nodes with the same chains pick the same one.
- **The name resolves** while now is before the owning chain's last `t + TERM`; in the grace after it, it resolves for
  nobody and only the owner can renew.

The rule reads only chains that are alive, so a dead chain can be dropped by everyone without changing any answer
(a released one is kept, as a tombstone, until its cover would have ended, or a stale copy without the release would
bring the name back), and nodes holding the same chains agree in whatever order they got them: partitions and resets
merge without negotiation. It has one deliberate consequence: a chain claimed while another held the name, and renewed
ever since, takes the name when the holder lapses (a back-order that costs proof of work every term). A server keeps
one chain a name, the best by the order above; offered a worse one, it answers with the better.

A fork happens to honest owners (a title exported to a second browser, both renewing): the order above settles it, the
agent takes the room's branch as its own and renews from it, and one Web Lock a title keeps two tabs from renewing at
once.

| Parameter | Proposed | |
|---|---|---|
| `TERM` | 30 days | the user's "a month, or shorter" |
| `GRACE` | 7 days | |
| `REF_WINDOW` | 24 hours | must exceed the calendars' slowest time to anchor, not their usual: N0 |
| renew when | the last entry is older than `TERM / 2` | two entries a month a name; the page says "every 2 weeks", and a name is lost only past 3 |
| `POW_BITS`, function | N0 | target: under a minute of one core in a tab, in the background |

## Bitcoin as the clock

- **Stamping** (the page, `fetch`): the entry's id is POSTed to three calendars (`alice` and `bob` at
  opentimestamps.org, `finney` at eternitywall.com; two operators). Checked from a cross-origin-isolated page in
  Chromium, 2026-11-15: a receipt in 1.2 to 1.9 s, 172 to 226 bytes; the finished proof of a 2015 commitment still
  served (699 bytes, `access-control-allow-origin: *`), so an owner can collect an anchor weeks later. While a proof is
  pending the calendar answers 404 **without** the CORS header, which a page sees as a failed fetch: any failure there
  means "ask again later", with a backoff. One anchor is enough; three calendars are for availability.
- **Headers prove themselves.** A verifier needs the 80-byte header of an anchor's block and of `ref`'s block; both
  travel with the entry. It checks the header's hash against the anchor and `ref`, its proof of work against its own
  target, that target against a floor compiled in (a fraction of the difficulty at a pinned date, so a forged header
  costs a real miner's work), and that its time isn't past now by more than 2 hours. Nothing else: no height, no chain
  of headers, **no block explorer**. Times, unlike heights, are in the header, so a header can't be passed off as an
  earlier block's.
- **Who talks to an explorer**: only the agent, when it makes an entry, for a block hash to put in `ref` (one 6 deep,
  taken when two explorers, blockstream.info and mempool.space, agree) and for the headers of its own anchors.
- **Who talks to a calendar**: the agent, to stamp and to collect; and servers, to finish a pending renewal they hold
  (each asks only with a chance set by a hash of the entry and its own key, and backs off, so a room's servers
  together ask a calendar a few times an hour for an entry, not each every minute).
- A block that was orphaned still passes (its work was real) and its time is as good; a stale tip in `ref` would
  cost a re-mine, hence 6 deep.
- The OpenTimestamps libraries are LGPL: nothing is copied from them; the verifier is written from the format
  (`THIRD_PARTY.json` gets a reference row).

## The registry

### The names client

Everything a node does with the registry goes through a room client of its own, in the same worker and module as the
node's (`net/ts/src/room/names/`): same room, **a node key made new each session**, relay only, no guest, incoming
handshakes only from servers answering its own question. So a server never learns which node asked (not its key, so
not its address or name; not its IP address, which only DERP sees), and the question below can be sealed with the
room's key without listing anyone. It costs a DERP connection of its own (N0 measures what else). A member's starts
at the first query for a name that isn't a key and stops after 10 minutes without one; a server's runs while the room
does. Registry messages are UDP between two names clients' room addresses, port 2 both ends (`NAMES_PORT`), binary,
1,200 bytes at most; a request is resent at 0.5, 1 and 2 s, a long answer comes in numbered parts, 8 in flight at most
(a derper queues 32 packets a client and drops the oldest: bench/net/REPORT.md).

### Finding a server

"Who serves the registry?" is an ephemeral event like a lookup (the same kind, MAC and seal with the room's lookup
key) under a tag of the room's own, `BLAKE2s(tag salt, "names", hour)`, its body a lookup's (the names client's key,
its region, the time, a nonce) and one byte more, `spread`. Servers subscribe to that tag (their names client does).

- **Who answers.** A server answers when `BLAKE2s(nonce, its key)` falls in the share `spread` names, it has synced,
  it has room (32 askers at once) and its budget allows (4 a second, **apart from** the node's call backs and trials,
  so a flood of questions can't keep a server's own lookups out). The asker sends shares of 1/64, then 1/8 after
  0.4 s, then everyone after 1 s, and stops at the first round that brings an answer: a room with 500 servers answers
  the first round with about eight, a room with one answers the third. (A forged question can still ask everyone at
  once: each server spends one handshake from that separate budget. rooms.md "Spam".)
- **The answer** is a call back to the asker's region, then a `serve` message: the item of a live name and a
  signature by its owner key over the asker's nonce and the server's names key. So only a node that holds a live
  name's secret can serve, which costs a registration.
- **The choice.** The asker waits 0.3 s from the first answer, then keeps the two servers with the lowest
  `BLAKE2s(nonce, server's key)`: not the two fastest, which an attacker could always be. It holds them while it asks
  and for 3 minutes after, and one of the two is replaced at each new question round.
- **Nobody answered** within 1.5 s of the third round (2.5 s from the first): the queries that waited get NXDOMAIN
  then, and the fact is remembered, for 30 s the first time and twice as long each time after, to 10 minutes; during
  it, names that aren't keys get NXDOMAIN at once and no question goes out. The next query after it asks again, so a
  member finds a server that appeared, or the room's first name, with no reconnection: within 30 s when its guest
  rarely met the silence, within 10 minutes at worst. An answer resets the doubling. A room with no names costs a
  member one question (three events) every 10 minutes at most, and only while its guest asks for such names. Names
  the member already holds answer throughout: they don't need a server.
- Questions have a rate of their own (1 a second), not the guest's lookups'.

### A member resolving a name

- `get` (the name id, and the last entry id the member holds, if any) goes to both servers; each answers with what the
  member lacks: the chain's last entry, its anchor and headers, the zone; or "none".
- **The member checks the last entry only** (signature, proof of work, anchor, headers, alive by its clock) and opens
  the zone. One alive chain is the owner whatever its history, since nothing contests it; a server can leave a better
  chain out, which is why there are two, chosen as above.
- **The servers disagree** (two chains for one id) or **the answer contests what the member holds** (below): the
  member asks each for `history`, the whole unbroken run, and picks by "Who owns a name".
- **What a member keeps**: each name it resolved, with its last entry and the earliest entry time it ever verified for
  that chain, persisted (small). While that chain covers now, another chain replaces it only by showing a run that
  starts earlier. So a member that knew a name refuses an impersonator after a reset, with no rule of its own.
- **A kept answer answers at once**, for as long as its chain is alive; one older than 5 minutes is also asked
  again in the background, and the next query gets what came back. So only a name this member never resolved waits
  on a server; the price is that a zone change or a lost name shows one query late.
- Both say none: NXDOMAIN, kept 60 s. One says none: the other's answer stands.
- **The dialog's check** for a name being typed must not tell a server which id someone is about to claim (it could
  guess the name and stamp too): it asks for `ids`, every id in the 1/256 of the registry that shares the id's first
  byte, and looks for its own there.

### Servers

- **Hold** the best chain of every name with its whole run, one anchor an entry, the headers those need (once each),
  the newest zone, tombstones.
- **Sync with each other**: a server holds two others (found as above) and compares by ranges, ordered by name id: a
  fingerprint of everything, then of 16 ranges, then of 16 within each that differs, down to ranges small enough to
  list (id and version, 8 bytes of each); then `get` with the last entry id held, so only what's missing crosses: a
  renewal is one entry, not its chain. A new item is told to the servers holding it (`have`). Every 5 minutes with
  jitter, and at the start; a server answers "who serves?" only once its first sync is done.
- **Take from anyone**: `put` (an item, from an owner's agent or a member that holds a better chain than the server
  showed it), checked like anything else.
- **Verify** signatures, proof of work and anchors before keeping or serving, a few milliseconds' worth each turn of
  the module; what was verified is stored as verified and not checked again at load.
- **Bound**: `MAX_NAMES` (proposed 20,000) and a byte budget. Past either, a server drops names, never its own, the
  ones nobody has asked it for longest first. A dropped name isn't lost (its owner holds the title and puts it back),
  and junk registered in bulk is what nobody asks for. Proof of work alone can't bound the registry: a GPU makes
  100,000 claims for the price of a few hours (*estimate*), and one stamp covers them all.
- **Persist** per name, binary, one record each in a store of its own in `waarm64-room`, written as items change and
  streamed into the module at start (not the tailnet client's `store` pattern, which keeps everything as hex strings
  in memory).

### Size, and where it stops

*Estimates*; N0 replaces them. An entry is 207 bytes; its anchor 300 to 900 (entries a calendar put in one block share
the anchor's tail and its header; how much is N0's to measure). Two entries a month: a name costs a server about 0.4 KB
for its zone plus 1 to 2 KB a month it has been held.

| Names, held six months on average | A server keeps | A new server's first sync through DERP (0.6 to 3 Mbit/s measured on public relays) |
|---|---|---|
| 1,000 | 7 to 14 MB | under a minute to 3 minutes |
| 5,000 | 35 to 70 MB | 2 to 15 minutes |
| 20,000 | 140 to 280 MB | too much for a tab |

A member keeps a few KB. So what grows with a room is each **server's** copy, and every new owner pays the first sync,
in the background, before it serves. Past a few thousand long-held names it needs one of: servers that hold a share of
the id space each; owners syncing with each other directly (WebRTC, which shows an owner's IP address to other
owners, so the user's call); fewer renewals a term. None is in v1; the first is the one to build.

## The resolver

`resolve()` (room.rs) gains, after the key-name case, for a name under `<tag>.p2p.internal` whose last label passes
"Names"' rules:

- a pending name of this node's own answers this node's address (a server can be tried by name before its
  registration is public);
- a name the member holds, its chain alive: AAAA from the slot the name asked opens, TTL 60; the module learns the key
  (and asks again in the background when what it holds is older than 5 minutes);
- otherwise the query waits while the names client asks: answered when the answer comes; SERVFAIL after 4 s (a first
  query that must also find servers takes 1 to 3 s on public relays, *estimate*; a guest's resolver retries);
- NXDOMAIN at once for a reserved or ill-formed name, a name both servers don't have, and any name not held while
  the member remembers that nobody answered "who serves?" ("Finding a server": 30 s to 10 minutes).

Guest-visible, in that names that were NXDOMAIN now answer, and some answers take seconds.

## The names agent (the page)

`web/names.ts` with a worker (`web/names-worker.ts`, for proof of work; it instantiates `ts.wasm` for a few pure
exports, `ts_names_*`: make, mine, sign and check an entry; no JavaScript crypto dependency). It owns the owners'
secret and the titles, which are the only place a name is kept in words (IndexedDB `waarm64-room`, stores `owner` and
`titles`, keyed as `identity` is, so names travel with a connection's key and are in its export). **A title is the
only copy of ownership**: registering asks the browser for persistent storage (`navigator.storage.persist()`), and the
dialog says to keep an export. It needs no running machine:

- **On every page load**, and hourly while open, for each title (one Web Lock a title): fetch finished anchors for
  pending entries and the headers they need; renew when due (a `ref` from the explorers, mine, sign, stamp); mark a
  claim public once anchored.
- **Publishing** is a `put` to two servers through a names client, which needs no guest and no key of the node's, so
  the page does it whether or not a machine runs, under no lock: when a claim becomes public, when a renewal is made
  (with its pending anchor, which the servers finish, so one short visit is enough), when an anchor finishes, when a
  zone changes. It pushes; it doesn't sync. With no server online there's nobody to push to (unless this node's
  machine runs, and is one); the title is safe and the next visit tries again.
- **When the connection's room runs**, the node is a server: the titles go to the module in its config and as they
  change.
- **Losing**: when a server shows a better chain for one of the titles, the agent stops renewing it and the page says
  so; when it shows another branch of the title's own chain, the agent takes it.

## What the user sees

**Reaching someone's name: nothing.** No switch, no notice. The first time a guest asks for a name that isn't a key,
the names client finds servers and asks; the answer comes within the resolver's wait or on the guest's own retry. The
adapter's details gain one line (names resolved, servers held), for the curious.

**Naming a machine.** In the Network menu of a room's adapter, **Name this machine…** opens one dialog:

1. A field. Under it, as typed: free, taken (until about a date), not a valid name, or, where no server answers,
   that nobody in the room can say. Nothing lists a room's names, here or anywhere: the registry couldn't.
2. Two notices, always shown, no boxes: *members of this room who know the name can find this machine and see when it
   is online, and your machine helps other members look names up*; *open this page at least every 2 weeks to keep the
   name*.
3. **Register.** The dialog closes; the adapter shows the name with its state: *Preparing* (proof of work), *Reserved,
   public in about N hours; it already works on this machine*, then *Active, kept until about <date> unless you visit*.

No key is shown or asked for. Changing where a name points, adding a label under it and letting it go are in the
adapter's details. The Machines page shows a stored machine's names with the date each lapses, and the page says, on
load, when one is inside its last week. All words go in `web/messages/en/network.json`.

## What an attacker can do

| | Cost | Result |
|---|---|---|
| Register many names | proof of work each, again every term | squatting; the names lapse when it stops paying. Servers drop the unasked-for first; members never see them |
| Stamp a dictionary and hold it back | the same work, every term, for as long as it waits | takes a name later registered by someone else: accepted |
| Race a new registration | none | nothing: a claim is public only once anchored, and the dialog's check doesn't name the id |
| Tie a claim it somehow knew of | several claims in the same block | wins most ties: the tie-break can be ground. It needs the name before the claim is public |
| Hash a dictionary against a server's ids | one registration, then cheap | learns which guessable names exist and where they point; nothing about the others |
| Serve, and leave names out or serve an old zone | one registration | a member it serves misses a name or a change until its other server, chosen by hash, says otherwise; both servers the attacker's: the member sees what it shows (it can't forge) |
| Hold a name after a reset | one registration | impersonates it to members that never resolved it, until a server that holds the owner's chain is asked |
| Forge a Bitcoin header | a real block's work, at the floor | one false time |
| Calendars all down | | no new claims or renewals; existing names resolve; `GRACE` is the margin |
| Explorers all down | | the same: only the agent uses them |
| Flood "who serves?" | lookups' limits | servers' answers come from a budget of their own; a forged asker key gets one handshake from each server asked |
| Watch a relay | | sees which IP addresses hold a room's names tag (its servers) and which ask under it: **new**, below |

## What changes that needed the user's OK (given 2026-11-15, all of it)

- **rooms.md's decisions that change**: "no directory in the protocol" and "the only names are names that are keys"
  (a registry of names, not of members, joins the protocol); a name's owner is discoverable and serves the registry.
- **Guest-visible**: the resolver answers registered names. No step count moves (`tests/steps.txt` has no room).
- **New outside services**: three calendars (a page that registers or renews, and servers finishing renewals: they
  see an IP address and a hash) and two explorers (only a page that registers or renews). Their lists could go in a
  room's link later, as relays do.
- **Parameters**: `TERM`, `GRACE`; the dialog's words.
- **A dependency**, only if N0 picks it: `argon2` (RustCrypto, MIT/Apache-2.0).
- **The module's interface** grows (titles in the config, per-name persistence, the `ts_names_*` exports); it is
  tailnet.md "The module"'s, not docs/abi.md's, and has no version number.
- **Added with hashed names, not asked for**: zones sealed under the name, and an owner key per name.
- **What a relay sees** (since the review). All of a room's servers subscribe to one tag and all askers publish under it,
  so a relay learns which IP addresses serve names and which ask for them in one room (and, for an ID it can guess,
  like `global`, which room). rooms.md says today that a relay "can't tell which room or address a tag stands for";
  for key lookups that stays true. The remedy rooms already name applies (one's own relays, or a VPN under them).
- **"Every 2 weeks"** (since the review), where the first draft said 3 (renewing at half a term, not a third, halves what
  servers carry).
- **Reserved names** (since the review): the list in "Names".

## Measure first (loop N0, no product code)

1. **Time to anchor** from each calendar, over a week of stamps, the slowest as well as the usual: sets `REF_WINDOW`
   and what the dialog promises. (One stamp made 2026-11-15 20:46 UTC: after 76 minutes still pending at all three; `alice` and `bob` each
   named a Bitcoin transaction and said "waiting for 6 confirmations", so a calendar serves a proof only once its
   block is 6 deep, an hour past the block at best.)
2. **Proof of work**: BLAKE2s hashcash against Argon2id at a few memory sizes: time to make one in Chromium's wasm and
   natively, what a GPU does to each, **and the time to check the 10,000 and 60,000 entries** of a 1,000 and a
   5,000-name registry in the module's wasm. Picks the function and `POW_BITS`.
3. **Verification rate** in the module's wasm (BIP-340, an anchor's hashes, a header's): sets the slice a turn may
   spend.
4. **Anchor sizes**, raw and with shared tails and headers, over a few hundred real stamps: replaces the size table.
5. **Through public DERP**: 5, 20 and 50 MB between two names clients, 8 in flight, a guest's ping running beside it;
   and what a second room client in the worker costs (memory, a DERP connection, idle CPU).
6. **A cold first lookup** on the public relays: question, call back, `serve`, `get`, to the answer.

## The loops

[NAMES-KICKOFF.md](../../NAMES-KICKOFF.md) says how the track runs, which tests each loop runs and each loop's done.

- **N0** The measurements above.
- **N1** Records and rules, pure Rust in `net/ts/src/room/names/` (`entry.rs`, `anchor.rs`, `header.rs`, `chain.rs`,
  `zone.rs`, `id.rs`): encoding, signatures, proof of work, the anchor verifier, headers and the floor, sealing, the
  order of chains. Vectors (a real anchored proof and its header, committed) and property tests: any order of merging
  the same chains, **with any subsets of their anchors**, gives the same owner; forks, releases and their stale copies.
- **N2** The names client, "who serves?", `serve`, and the servers' side: the store, range sync, `get`, `put`, `have`,
  the bound. Fake DERP and relay: two and twenty servers converge; a reset recovers from one owner's title; a server
  that leaves names out; a worse chain refused; forged anchors, headers and signatures; the answer rule's counts at 1,
  20 and 500 servers; a flood of questions leaving the node's own lookups alone; no WebRTC and no node key on port 2.
- **N3** The member's side and the resolver: `get`, `history`, what a member keeps, the waits and the negative
  answers, persistence, the tests' pretend calendar and explorer. tests/page-room.test.ts: two Debian guests, one
  name, by full name and by the short one, a label under it, a zone change, the reserved names, a room with no server.
- **N4** The agent: secrets, titles, the worker, stamping, collecting, renewing, publishing without a machine, forks
  between two browsers, a lost name, export and import.
- **N5** The page: the dialog, the adapter's states, the details, the Machines page's dates, the catalog.
- **N6** Scale and abuse: 1,000 members, 20 servers and 5,000 names (a server's load, a cold lookup, a join storm of
  500, junk in bulk against the bound); days on the public services with real stamps; the final review.

## Open, to settle in the loops

- Whether a claim may be published before its anchor when the user asks for it ("public now, may be raced"): not
  offered in v1.
- Old history: a chain grows by an entry a renewal for as long as a name is held, and a server needs all of it (a
  held-back chain is beaten only by showing an older unbroken run). No compact proof of an unbroken run was found.
- Transfer of a name to another owner key, and a recovery key: not in v1; until then a lost title is a lost name.
- The short name through the search domain on guests without systemd-resolved.

## What the review changed (2026-11-15)

An out-of-context review of the first draft (a fresh agent with the draft, rooms' docs and code; 25 findings) found
that it couldn't meet its own goals. What it was, and why it lost, so nobody rebuilds it:

- **Every member held the whole registry**, synced through DERP. With two or three entries a month a name, 5,000
  names were 50 to 100 MB a member, an hour or more a newcomer on public relays, gigabytes an hour through them for a
  busy room. Now members ask per name.
- **"Who serves?" carried the asker's node key**, sealed only with the room's key: in a public room anyone could list
  every member that ever asked for a name. Now the names client's key is new each session.
- **Times were block heights, checked against two explorers.** A header doesn't say its height, so every header
  needed an explorer's word: dozens of fetches before one name could be trusted, tens of thousands for a registry,
  from every member. Now times are the headers' own timestamps and members ask no explorer.
- **Servers answered by a share of the names they knew**, which says nothing of how many servers are online: no
  answer in a big registry with few servers, hundreds in a room of servers. Now the asker widens the share.
- **Any member could finish a pending anchor, from a URL in the record**: a thousand fetches a second at the
  calendars at scale, and an address an attacker chooses fetched by everyone.
- Left undefined, now defined: forked chains, released chains and their stale copies, which of several anchors gives
  an entry's time, the limit on zone changes, what bounds a server, reserved names, a room with no server.
