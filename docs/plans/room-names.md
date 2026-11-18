# Room names: registered names in a room (spec and plan, not built)

Human-chosen names in a room, registered first come by a key, for a term, with nothing of ours running and no
administrator: `test123` beside today's `<key>.<tag>.p2p.internal`. Chosen with the user, 2026-11-15, from the options
in [room-names-options.md](room-names-options.md) (its option 3, changed as below; the research notes behind it are
`room-names-research/`), then revised the same day after an out-of-context review of the first draft ("What the review
changed", at the end). Built so far: the records and the rules (N1, `net/ts/src/room/names/`: "Names", "Names nobody
lists", "Records", "Who owns a name" and the headers of "Bitcoin as the clock" say what the code does), the names
client and the servers' side (N2: "The names client", "Finding a server" and "Servers" say what the code does), and the
member's side and the resolver (N3: "A member resolving a name", "The resolver", and the page's side of "Persist"), and
the fixes of the out-of-context review of N1 to N3 (N4a, and N4b: finding 6, seven linked headers an anchor and the floor by time, which R1 undid: [room-names-redesign.md](room-names-redesign.md)), the records as the redesign has them (R1: no `ref`, an anchor's block's one header against one compiled floor), servers finishing renewals and checking blocks at the explorers, and renewals made ahead (R2: "Bitcoin as the clock", "Servers": "Outside the room", "The names agent"), a first lookup that asks the room through the relays and "who serves?" back to the plain draw (R3, [room-names-r3.md](room-names-r3.md): "Finding a server", "A member resolving a name", "Servers": "Asks"), the names agent (N4c: "The names agent"), and the page (N5: "What the user sees"); the rest is a plan. The numbers marked *estimate* are arithmetic, not measurements, and loop N0 replaces them. It extends [networking/rooms.md](../networking/rooms.md), whose terms (room, link, tag, lookup, call
back, the module) it uses. The track's brief is [NAMES-KICKOFF.md](../../NAMES-KICKOFF.md).

## What it is, in one paragraph

A name's owner is whoever holds the oldest unbroken chain of **timestamped claims** on it. A claim is a signed record
stamped through OpenTimestamps, so that a Bitcoin block proves it existed by that block's time; a name is held for a
term (about 30 days) and kept by renewing, each renewal stamped the same way. Every claim proves its own place in line,
so **the owner's copy is the title**. The room's registry is a cache of such chains: **name owners hold all of it and
serve it; everyone else asks the room for the one name it wants** and checks the answers itself. A room that loses the
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
  (Widened by the user on 2026-11-17, R3: a lookup of a name a member doesn't keep shows the name's id to the room's
  servers and to a relay that knows the room's ID, from a key new each session; "A member resolving a name".)
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
- **Instant registration.** A first claim stays private until its Bitcoin proof exists (about an hour, a few at worst: N0), or a
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
`localdomain`, `gateway`, `router`, `broadcasthost`, Debian's `/etc/hosts` names `ip6-localhost`, `ip6-loopback`,
`ip6-localnet`, `ip6-mcastprefix`, `ip6-allnodes`, `ip6-allrouters`, and `ip6-allhosts`), and labels that are
top-level domains or look like one: **every two-letter label** (the country codes, and those still to come), the
original and sponsored generic ones (`com`, `net`, `org`, `edu`, `gov`, `mil`, `int`, `arpa`, `info`, `biz`, `name`,
`pro`, `aero`, `coop`, `museum`, `mobi`, `asia`, `tel`, `travel`, `jobs`, `cat`, `post`, `xxx`), the special-use
names (`local`, `localhost`, `test`, `example`, `invalid`, `onion`, `alt`, `internal`) and the private ones in habitual
use (`lan`, `home`, `corp`, `intranet`, `private`), and `p2p` (`id.rs`, `RESERVED`). Without it, whoever registered
`wpad` first would configure every guest's proxy, and whoever held `com` would answer `example.com.<tag>.p2p.internal`,
which a guest's search list asks for. The ~1,400 newer generic top-level domains (`app`, `dev`, …) are not on it: they
are words people want as names, and a guest asks for `x.dev.<tag>.p2p.internal` only after `x.dev` itself failed
(docs/backlog.md).

A registered name is `<name>.<tag>.p2p.internal`, under the domain the lease already gives the guest, so the room's
resolver gets the query with no change to the lease, and a guest whose resolver uses the lease's domain as a search
domain reaches it as plain `<name>` (DHCPv6 option 24 carries it; the RA has no DNSSL: N3 checks Debian and Arch, and
what they ask the search domain unprompted). A key name is 52 characters, so the two never collide. A name's zone may
add one label under it (`git.<name>.<tag>.p2p.internal`; a DNS label, `[a-z0-9]` and inner `-`, up to 63 characters). A nicer suffix is the later decision; it changes the resolver's
match and the lease's domains, nothing else here.

## Names nobody lists

No record, message or stored registry holds a name in words. Three things do it:

- **The name id** is BLAKE2s in its keyed mode, keyed with a key of the room's (from its ID, a label of its own), over
  the name. Entries and zones carry the id; servers order by it; a resolver hashes what the guest asked and asks for
  that.
- **A zone is sealed under its name**: each place it points (the name itself, a label under it) is a slot, an 8-byte
  tag and a node key sealed with ChaCha20-Poly1305, tag and key both derived from the room's key, the name id, the
  owner key, the full name asked **and the zone's `seq`** (so no key or tag is used twice and the unused slots, random
  bytes, can't be told from the used across versions; the owner key because every owner of a name, after a lapse or a
  back-order, starts at a small `seq`: review 1). The AEAD's nonce is zero (its key is never reused but by a zone of
  the same name, owner and `seq`) and its associated data the zone's head (version, room, name id, owner, `seq`), so a slot can't be moved to another
  name or version; the slots are sorted by their bytes, so their order says nothing. A zone has 4 or 16 slots, so a
  holder sees neither how many labels a name has nor where any points. Whoever knows the name opens its slot; the
  owner's signature is over the sealed bytes, so anyone can check a zone without reading it. Two zones of one title
  with the same `seq` and different contents would reuse a key: the agent never makes two (a fork of a title, two
  browsers changing a zone, could: each copy has a branch of its own, 32 random bits in `seq`'s low half, "The names
  agent").
- **An owner key per name**, so a registry doesn't show that five ids are one person's.

**What a server still learns:** how many names the room has; each id's owner key and the times of its entries (an
owner's names renewed in one visit land in one block, which anyone who guesses those names sees in their `history`;
and their anchors show more than the block: stamps made within the same second or so are near-siblings in the
calendar's tree, under ~450 bytes of path apart where stamps 10 seconds or more apart differ by 290 to 700 (N0b), so
a server holding the ids sees them stamped together without guessing the names; the agent doesn't spread renewals yet, docs/backlog.md, but an `ids` answer's cover ends are rounded up to a week so that it doesn't group them); which ids are asked for,
though not by whom (the names client's key is new each session); and **any name it can guess**: hashing a dictionary
against the registry's ids is cheap, and a slow hash wouldn't change that by much (a million guesses at 0.1 s each is a
day of one machine, and every resolver would pay the 0.1 s on each name a guest asks). So this hides names that aren't
guessable and stops anyone listing a room's names, as NSEC3 does for a DNS zone and GNS for its records; it doesn't
make `www` a secret. In a private room the key comes from an ID outsiders don't have.

**What moves to the resolver:** the registry can't check a name's spelling, so an id for a name no resolver would ask
can be registered and is dead weight its registrant paid for. The rules of "Names" are enforced where names are still
words: the resolver, and the dialog that registers.

## Records

Binary, fixed order, integers little-endian. Every record starts with a version byte and the room's 40 prefix
bits; the hash that is signed also takes a 32-byte value derived from the room's whole ID, so a record of one room
means nothing in another, even one whose prefix was made to collide.

**Entry** (175 bytes, version 2; version 1 carried `ref`, a recent block's hash, and is refused: rooms are
pre-release):

| Field | Bytes | |
|---|---|---|
| version, kind | 1, 1 | kind: 0 claim, 1 renew, 2 release |
| room | 5 | the /48's 40 bits |
| name id | 32 | |
| owner | 32 | the owner key |
| prev | 32 | the id of the entry before; zeros in a claim |
| nonce | 8 | proof of work |
| signature | 64 | BIP-340 over the tagged hash (BIP-340's, tag `waarm64/names/entry`) of the room's value and the fields above |

A claim's `prev` is zeros and a renewal's or release's isn't: anything else is invalid.

- **Proof of work** is over the fields before the signature: the function's output has `POW_BITS` leading zero bits.
  It is bound to its name (salted with the name id), so work done for one name serves no other; it can be done ahead
  of time, which saves nothing (a term costs the same entries' work whenever it is done), and a renewal names the entry
  before it, so its work is its own. The function must be cheap to check
  (a server checks every entry of the room), which bounds the memory a memory-hard one may use.
  **What it is for**: the price, every term, of a name held without being used: a dictionary stamped and held back
  ("What it does not give"), a back-order, a squat. Stamping is free and one stamp covers any number of claims, so
  without it a member could claim every word there is each term for a minute of signatures. It is not what keeps junk
  out of a registry (the servers' bound is). So the function is judged by what a million names cost an attacker a
  term on a GPU, which favours a memory-hard one. **Chosen (N0, provisional until the dev VM re-times it): Argon2id,
  1 MiB, one pass, one lane, 32-byte output**, over the 111 bytes before the signature, salted with the name id (version
  0x13; Node's `crypto.argon2Sync` gives the same, which the tests pin). A GPU's lead over a tab (bench/net/REPORT.md, NAMES
  loop 0) is ~3,900x at BLAKE2s (hashcat's published RTX 5090 figure against a tab's measured rate) and at most
  ~280x at Argon2id of 1 MiB (*estimate* from the card's memory bandwidth: no Argon2 figure at these sizes is
  published, and scrypt's suggests the card does worse than that bound), not the ~10x the first draft assumed: a
  memory-hard function narrows the gap only past what fits on the card's chips, and memory a server can afford to
  check stays small. 1 MiB is the knee: 256 KiB leaves the card most of its lead, 4 MiB keeps the same ratio at four
  times the check (2 minutes of a core for 60,000 entries). A million names (two entries each a term) cost an attacker at least
  ~64 RTX 5090-hours a term (*estimate*, from the card's bound; ~9 at BLAKE2s, for the same minute in a tab), and a server checks 60,000 entries in ~30 s of one core in wasm (BLAKE2s:
  20 ms).
  **Not a verifiable delay function** (weighed 2026-11-16): one is sequential an instance, but a dictionary is a
  million instances side by side, so it evens the field a core, as a memory-hard function does; and it costs
  milliseconds to check in wasm (60,000 entries: minutes of a server's first sync),
  ~256 bytes of proof on a 175-byte entry, a tab without a wide multiply against native squaring, and group
  arithmetic with no small vetted crate. Its one gain is a fixed time where hashcash is a draw (the mean under a
  minute, some several): the *Preparing* state's words allow for that.
- **An entry is valid** when its signature and proof of work hold and it has an anchor, whose block's header proves
  itself ("Bitcoin as the clock"): its time `t` is that block's. Nothing ties an anchor to when the entry was made: an
  anchor collected late times the entry late, which only ever costs its owner.

**Anchor**: OpenTimestamps operations from the entry's id to a block's Merkle root, and that block's header ("Bitcoin
as the clock"; on the wire, an index into the item's headers, which an item holds once each: 80 bytes a distinct
block). It is
one path in the format's own serialization (the operations, then the Bitcoin attestation with the block's height,
which nothing trusts: the header gives the time): the calendar's receipt (id to its commitment) and its finished proof
(commitment to the root) joined. The verifier handles the three operations the calendars emit (append, prepend,
SHA-256) and the Bitcoin attestation; anything else, a fork in the path, or a message past the format's 4 KiB is an
invalid anchor; 4 KiB at most. **One anchor an entry is kept**, the one with the earliest time (equal: the lower block
hash, then the lower bytes); a node offered an earlier one for an entry it holds takes it, so an entry's time only
ever moves back, and every node that has seen the same anchors has the same time. A *pending* anchor (which of the
compiled calendars, by index, and the operations to its commitment: never a URL) proves nothing and is carried only on
a chain's last entry, one at most (of two, the lower), so that a server can fetch the finished one; it carries the
entry's owner key's BIP-340 signature over the tagged hash (`waarm64/names/pending`) of the room's value, the entry's
id and the pending's calendar and operations, and a server keeps only a signed one (else anyone's lower pending would
replace the owner's, and servers would ask a calendar for a commitment that doesn't exist: review 1); it is dropped when
the entry is anchored, when an anchored entry follows it, and once its entry can no longer link (chain.rs
`Name::stale`): now past the entry before's `t + TERM + GRACE`, when the entry, still unanchored, is dropped too. A
claim can always link (an anchor at any time makes it a claim then); a server keeps no unanchored claim, and pending
renewals only on the owning chain's last entry, which can link as long as that chain owns the name.

**Zone** (366 bytes with 4 slots, 1,038 with 16): version (2), room, name id, owner, `seq` (8), the slots (56 each), a
signature. An address is computed from the node key a slot opens to, as today, and the resolver's answer teaches the
module the key, so lookups to a named machine are sealed to it as lookups to a key name are. The highest `seq` wins
(equal: the lower hash). A zone needs no anchor: only the owner can write it, so there is nothing to order. A server
takes a new zone for a name at most once in 10 minutes.

## Who owns a name

Times are Bitcoin block headers' timestamps, which a header carries under its own proof of work; **now** is the node's
wall clock (rooms already need it right to within most of an hour).

- An entry at time `t` holds the name until `t + TERM` and keeps it from others until `t + TERM + GRACE`.
- **A chain is unbroken** when each renewal is by the same owner key, names the entry before, and has a time not
  before that entry's and at most its `t + TERM + GRACE`; nothing follows a release, and an entry without an anchor
  breaks the run (it has no time). A node's entries of a name form a tree by `prev`; **a chain** is an unbroken run to
  a leaf (an entry no valid step follows), so a renewal by another key, or one too late, starts a run of its own. It
  **covers** from its first entry's time less `drift` (a block's time may run that far ahead of a node's clock, so a
  chain anchored in such a block is alive as soon as it can be checked, not dropped until the clock catches up) to its
  last entry's `t + TERM + GRACE`. A `release` (anchored like any entry)
  ends the cover at its own time.
- **A chain's seniority** is the time of the first entry of the unbroken run a node holds of it: the claim's, when it
  holds the whole chain.
- **The owner now** is, of the chains that cover now, the one with the earliest seniority. Equal: the lower SHA-256 of
  the first entry's anchor block's hash and its id. The same first entry (one chain forked, or one a longer copy of
  the other): the one whose cover ends later, then the lower last id; a chain with a release beats the same chain
  without it. That is a total order, so two nodes with the same chains pick the same one.
- **The name resolves** while now is before the owning chain's last `t + TERM` (the last claim's or renewal's, and
  before a release's time); in the grace after it, it resolves for nobody and only the owner can renew.

The rule reads only chains that are alive, so a dead chain can be dropped by everyone without changing any answer
(a released one is kept, as a tombstone, until its cover would have ended, or a stale copy without the release would
bring the name back; a chain dead as held comes back only with a later renewal, which arrives with its run, as the
owner's title carries it), and nodes holding the same chains agree in whatever order they got them: partitions and
resets merge without negotiation. The owner is computed from every entry a node holds of the name (`chain.rs`,
`Name`), each with its earliest anchor, which is what makes the order not matter: a node that kept only its best
chain could disagree with one that kept them all when copies arrive partial (a chain shown without its last anchor
looks dead and is dropped; its anchor, arriving alone, then finds nothing to attach to). It has one deliberate consequence: a chain claimed while another held the name, and renewed
ever since, takes the name when the holder lapses (a back-order that costs proof of work every term). A server keeps
one chain a name, the owner's, computed from everything it was given; offered a worse one, it answers with the better
("Servers": what it keeps, and why servers still converge).

A fork happens to honest owners (a title exported to a second browser, both renewing): the order above settles it, the
agent takes the room's branch as its own and renews from it, and one Web Lock a title keeps two tabs from renewing at
once.

| Parameter | Proposed | |
|---|---|---|
| `TERM` | 30 days | the user's "a month, or shorter" |
| `GRACE` | 7 days | |
| `drift` | 2 hours | how far a block's time may run ahead: a header's time may be this far past now, and a chain covers from this far before its first entry's time |
| floor | `0x17216730` | the easiest target a header may claim, one number compiled in: 1/16 of the difficulty of block 976,177 ("Bitcoin as the clock") |
| renew when | the last entry is older than `TERM / 2` | two entries a month a name; the page says "every 2 weeks", and a name is lost only past 3 |
| `POW_BITS`, function | 16, Argon2id (1 MiB, t = 1, p = 1) | target: under a minute of one core in a tab, in the background. N0 (cloud, provisional): 0.49 ms a try in Chromium's wasm, so a mean of 32 s; hashcash is a draw: half within 22 s, 90% within 74 s, 99% within 2.5 minutes. Checking one costs one evaluation |

## Bitcoin as the clock

- **Stamping** (the page, `fetch`): the entry's id is POSTed to three calendars (`alice` and `bob` at
  opentimestamps.org, `finney` at eternitywall.com; two operators). Checked from a cross-origin-isolated page in
  Chromium, 2026-11-15: a receipt in 1.2 to 1.9 s, 172 to 226 bytes; the finished proof of a 2015 commitment still
  served (699 bytes, `access-control-allow-origin: *`), so an owner can collect an anchor weeks later. While a proof is
  pending the calendar answers 404 **without** the CORS header, which a page sees as a failed fetch: any failure there
  means "ask again later", with a backoff. One anchor is enough; three calendars are for availability.
- **How long an anchor takes** is the wait for the calendar's next transaction, its mining, and six blocks more (a
  calendar serves a proof only once its block is 6 deep). Each calendar's page says its rate, and its transactions are
  on Bitcoin, so its whole history can be read from an explorer. On 2026-11-16: `alice` a transaction every 1.19 hours
  on the week's average (the latest ones 2 to 6 blocks apart), `bob` 1.63 hours (3 to 11 blocks), `finney` 6.0 hours
  (35 to 62 blocks, so up to ~11 hours to a proof); fees of 0.1 to 2.4 sat/vB, so the slow case is a busy mempool.
  **N0 (2026-11-16)**: a calendar pays from several coins in turn, each transaction spending the change of an
  earlier one on its own coin, so its history can't be listed by address and was sampled (bench/net/REPORT.md, NAMES
  loop 0). From the calendars' complete record of their last days, a stamp's proof came in a median of 1.0 hours at
  `alice`, 1.1 at `bob` and 4.2 at `finney`, at worst 4, 5 and 12; the first of the three in 0.9 (p99 2.4, worst
  3.1). Through a year's samples, one coin of each calendar (so an upper bound): the first of the three within 1.9
  hours for 90% of stamps and 4.8 at worst; `finney` alone up to 14 hours, or 26 if a stamp misses the transaction
  being mined. No day of the year had fees that would have stalled the calendars for long (blocks' 10th-percentile
  fee rate at most 5 sat/vB). **N0b (2026-11-17), the batch of 80 real stamps collected** (bench/net/REPORT.md
  "NAMES loop 0b"): every one finished. A stamp goes into the calendar's next mined transaction unless it is made in
  the ~10 minutes before the block that mines it (the 39 of 160 at `alice` and `bob` that missed one were made 1.4 to
  9.1 minutes before its block; none missed two); a calendar serves the proof from the sixth confirmation (its status
  page counts its transactions under 6 confirmations as waiting, and only those). N0a's model with that correction:
  the first of the three in 1.0 hours (p90 1.7, p99 2.5, worst 3.2) over the last days, 1.3 (p90 2.1, worst 5.3) over
  the year's samples; `finney` alone up to 15 hours (26 missing a transaction). The batch, one evening: the first of
  the three 1.24 to 2.39 hours, median 1.48 (`alice` first for 78 of 80, `bob` for 2); `finney` 3.0 to 4.9. **About
  2 hours** is what the dialog can say of the proof; the page collects it later than that while its asks are spaced
  5 minutes doubling to an hour (at 80 and then 140 minutes: 76 of the batch's 80 would have shown the late line
  with the page open: docs/backlog.md). A slow calendar costs only the wait: no window ties an anchor to when its
  entry was made. Servers finishing a renewal (from 30 minutes on) ask a few times in vain before the sixth
  confirmation, never sooner than 1.2 hours after the stamp in the batch.
- **A header proves itself, and an anchor carries its block's one header** (R1, the user's decision of 2026-11-17 on
  [room-names-redesign.md](room-names-redesign.md)'s question 2). A verifier needs the anchor's block's 80-byte
  header, which travels with the entry. It checks the anchor against the header's Merkle root, the header's proof of
  work against its own target, that target against **the floor**, and that the header's time isn't past now by more
  than 2 hours. Nothing else: no height, no explorer, no headers after it (a server also asks an explorer about each
  block, in the background: "Servers", "Outside the room"; an anchor counts until it is refused). Times, unlike heights, are in the header, so
  a header can't be passed off as an earlier block's.
- **The floor** (`Params::floor`): one compiled target, 1/16 of the difficulty of block 976,177 (2026-11-16 19:25:21
  UTC, compact `0x17021673`): sixteen times its target, compact `0x17216730`, whatever a header's time. It keeps junk
  headers out and guards members, who ask no explorer: a header mined in private at the floor, timed weeks back with
  a Merkle root of its own, costs 1/16 of a block's work and would anchor claims on any number of names in every room
  at that time ("What an attacker can do"). Servers asking an explorer about each block (R2, decision 4 as the user
  widened it on 2026-11-17: "Servers", "Outside the room") close that at servers; nothing closes it for a member both
  of whose servers are the forger's. Sixteen times under a real block covers any fall in difficulty there has been (the largest in years,
  mid-2021, was about 45%); a release may raise it, and a header that met it once may then be refused, so a raise
  must stay under every block since the oldest anchor still alive (a term and a grace: 37 days). The design's earlier
  run of seven headers and floor schedule (N4b) are gone, and with them `ref` and its window (the redesign document
  says why: neither did what it was added for).
- **Who talks to an explorer**: the agent, for the header of each of its own anchors: the hash of the block at the
  proof's height (`block-height/<h>`) and that block's header (`block/<hash>/header`), two GETs, from one explorer
  (blockstream.info, then mempool.space when it fails or serves a header the module refuses). The header's Merkle root
  must be the anchor's, or that explorer has another block there (a reorganisation): the other is asked. **Servers**
  (R2, decision 4 as the user widened it on 2026-11-17): the same two GETs for a renewal they finish, and one GET a
  distinct block their registry is anchored in, `block/<hash>/header` ("Servers", "Outside the room"). Members ask
  none. The tests' pretend explorer (tests/net/ots-calendar.ts; for Rust tests, room/names/testkit.rs `Services`)
  answers all three.
- **Who talks to a calendar**: the agent, to stamp and to collect; servers, to finish a pending renewal they hold (R2,
  the user's decision of 2026-11-17 on review 2's finding 3, option A: "Servers", "Outside the room"), at the calendar
  its pending anchor names by its compiled index. So a renewal's anchor reaches the room hours after the visit that
  stamped it, with no page open.
- A block that was orphaned still passes (its work was real) and its time is as good.
- The OpenTimestamps libraries are LGPL: nothing is copied from them; the verifier is written from the format
  (`THIRD_PARTY.json` gets a reference row).

## The registry

### The names client

Everything a node does with the registry goes through a room client of its own, in the same worker and module as the
node's (`room.rs`, a `Client` in its names mode, carrying `names/server.rs`'s logic, `NamesHost`): same room, **a
node key made new each session**, relay only, no guest, no signalling, its own DERP and Nostr connections (the
worker's connection numbers from `NAMES_CONN`, 0x40000000, are its), and **incoming handshakes only while its own
question is open** (2.5 s, at most 32 at once: the servers answering it; a key let in that hasn't served a second
after its handshake makes room for a newcomer, so junk handshakes from anyone who read the question can't shut the
servers out: review 1), **or from the servers a member's `fetch` named** (by key, while it waits: R3); a server it
calls back is one it answers. So a
server never learns which node asked (not its key, so not its address or name; not its IP address, which only DERP
sees), and the question below can be sealed with the room's key without listing anyone. The node's own key carries
none of it: the guest's UDP on port 2 between members is the guest's, untouched. A server's names client starts when
the node runs (and again a minute after it fails) and runs while the room does; a member's (`names/member.rs`, room.rs
`MemberHost`) starts at the guest's first query for a name that isn't a key (a first lookup asks the room through its
relays at once; "who serves?" and a contest's `fetch` wait until its home region is up, so the servers' call backs
reach it) and closes after 10 minutes without one (a minute's wait after it fails;
the next query then starts it again). Registry messages are UDP between two
names clients' room addresses, port 2 both ends (`NAMES_PORT`), binary, 1,200 bytes a datagram at most (`wire.rs`):
a message goes in numbered parts (kind, transfer, part, parts: 9 bytes, then up to 1,191 of the message), each
acknowledged, resent after 0.5, 1 and 2 s and given up 2 s after that (the transfer fails), at most 8 of a peer's
unacknowledged at once (a derper queues 32 packets a client and drops the oldest: bench/net/REPORT.md); a message is
1 MiB at most, and a peer may have 16 incomplete, 2 MiB, held at once (every new part counts; an incomplete transfer
is dropped 10 s after its last new part); at most 8 MiB is queued to a peer unacknowledged, past which a send fails
(a peer that asks much and acknowledges nothing can't make us hold all we would answer). A message is a type, the
transfer it answers (0: none) and a body. Transfer ids count up across a client's peers, so a peer forgotten on one
side and met again doesn't take new transfers for ones it remembers as done.

### Finding a server

"Who serves the registry?" is for what must not name an id (R3): the refresh of names a member keeps, the dialog's
check, a publisher's `put`s, and servers' sync partners. A first lookup asks the room instead ("A member resolving a
name"). It is an ephemeral event like a lookup (the same kind, MAC and seal with the room's lookup
key: `lookup::seal_bare`) under a tag of the room's own, `BLAKE2s(tag salt, "names", hour)` (`Room::names_tag`), its
body a lookup's (the names client's key, its region, the time, a nonce) and one byte more, `spread`: 123 bytes.
Servers subscribe to that tag (their names client does), and drop a question as they drop a lookup (the MAC first,
copies through other relays, the relay's budget, an hour off the clock, our own key, a region outside the link), its
copies by nonce **and round** (the three rounds share a nonce).

- **Who answers.** A server answers when its answer's **rank** falls in the share: the top 64 bits of `BLAKE2s(nonce,
  owner key)` must have their top `spread` bits zero; for the owner key of one of its live names (it serves the one
  with the lowest rank), it has synced, and its budget
  allows (4 a second, **apart from** the node's call backs and trials: a budget of the names client's own, in a client
  of its own, so a flood of questions can't keep a server's own lookups out). The hash is over the owner key, not the
  names client's: an owner key costs a registration, a names client's key nothing, so keys made after the nonce is
  seen can't buy a place (review 1). It holds 32 askers at once: one is let go after 60 s without a request (junk, or
  a part of a message, doesn't count), or 10 minutes after it came whatever it sends, and with every place taken a
  newcomer takes the place of the one held longest (but never a sync partner's). The asker sends `spread` 6 (1/64),
  then 3 (1/8) after 0.4 s, then 0 (everyone) after 1 s, and stops at the first round that brings an answer. Measured
  (`server_tests.rs`, 200 questions each, each server its own name): one server answers in the third round (176 of
  200; 2 in the first, 22 in the second); twenty in the second (137; 44 in the first, by 1.1 servers, 19 in the
  third); 500 in the first, every time, by 7.6 servers on average. (A forged question can still ask everyone at once: each server spends one
  handshake from that separate budget. rooms.md "Spam".)
- **Crossed answers.** A server that is asking itself and answers a lower key waits 0.5 s before calling it back: two
  servers asking at once would each start a handshake to the other, and crossed handshakes both fail (rooms.md
  "Finding a peer"); by then the lower key's call back carries both ways.
- **The answer** is a call back to the asker's region (none when a session with it is up), then a `serve` message:
  the last entry of the owning chain of a live name of the server's, with its anchor and header, and a BIP-340
  signature by that name's owner key over the tagged hash (`waarm64/names/serve`) of the room's value, the asker's
  nonce and the server's names key. The asker checks the signature, then the entry whole (proof of work, header,
  anchor) and that its chain covers now (`check_serve`; one entry exactly; a second `serve` of a name that answered
  already is refused before it is checked). So only a node that holds a live name's secret can serve, which costs a
  registration.
- **The choice.** An answer counts when its owner key's hash falls in the share of a round already sent (an honest
  server answers only so), and once a name: a second `serve` with an owner key or a name id that answered already is
  refused, so one registration answering from many names-client keys is one answer. The asker waits 0.3 s from the
  first answer, then keeps the two with the lowest `BLAKE2s(nonce, owner key)` (the plain draw): not the two fastest,
  which an attacker could always be, nor the lowest names-client keys, which it could grind for; the others are let
  go. The accept window does the same: once full of keys that served, a newcomer takes the place of the last by that
  hash, never of the best two, so junk answering first can't fill it. Registrations buy places in this draw (128 junk
  ones are both servers of most questions against five honest ones): what it is used for is what that can't hurt
  much. A refresh's servers can show a stale zone or hide a release, never another owner (a kept chain yields only to
  an older run), and the member redraws them every 15 minutes; a `put` or a sync round draws afresh each time. **Why
  not the tiers** (N5a's answer to review 2's finding 2, out since R3): ranking answers by their chain's age only
  delayed an attacker by the three months it took its registrations to age, at costs that didn't end (old names'
  servers answered more, young rooms reached the last round more, a `serve` carried up to eight entries); a first
  lookup now asks the room and believes content, not a draw ([room-names-redesign.md](room-names-redesign.md) "2. An
  attacker as a member's servers", [room-names-r3.md](room-names-r3.md)). A
  member that has only one answer by then asks everyone at once (the last round, and 0.3 s again), so it holds two where the
  room has two: a lone server could leave a name out or show a younger chain unseen (N3: in a room of two servers, a
  quarter of questions stopped at one). A member holds its servers while it asks and for 3 minutes after the last
  request, and **redraws them 15 minutes after they were drawn** (R3), so a pair that serves a stale zone isn't kept for
  as long as the guest goes on asking; one that fails (a transfer given up, its session gone) is let go, and with
  none left the next refresh asks again. A server holds them for its sync round (below), and asks afresh each round.
- **Nobody answered** within 1.5 s of the third round (2.5 s from the first): the queries that waited get NXDOMAIN
  then (measured through the fake DERP and relay: 2.5 s), and the fact is remembered, for 30 s the first time and twice as long each time after, to 10 minutes; during
  it, names that aren't keys get NXDOMAIN at once and no question goes out. The next query after it asks again, so a
  member finds a server that appeared, or the room's first name, with no reconnection: within 30 s when its guest
  rarely met the silence, within 10 minutes at worst. An answer resets the doubling. A room with no names costs a
  member one question (three events) every 10 minutes at most, and only while its guest asks for such names. Names
  the member already holds answer throughout: they don't need a server. A server nobody answered is alone: it counts
  as synced (there is nothing to sync with) and asks again after the same wait (5 minutes at most), with a fifth of it
  at random on top, so servers that started together don't ask together again.
- Questions have a rate of their own (1 a second), not the guest's lookups'. **A question's key proves nothing** (it
  is the asker's names client's, which can't sign, and no secret of the room tells one key's owner from another
  member), so questions naming a victim's node key would have every server call it back, spending its incoming trials,
  and send it `serve`s on port 2: a server answers questions naming one key 4 times a minute at most (review 2's
  finding 12; an honest names client asks rarely). With 20 servers that is 1.3 call backs a second at a victim, of its
  16 trials. A proof of the key would need a round trip before the call back (the asker initiating), which the
  question can't carry: docs/backlog.md.

### A member resolving a name

(`names/member.rs`, `member_tests.rs`; through the resolver, room/tests/names.rs. R3, as
[room-names-r3.md](room-names-r3.md) designed it, the user having widened decision 12 on 2026-11-17.)

- **A first lookup** (a name the member doesn't keep: never resolved, or what it kept has ended) **asks the room
  through the relays**: no server is found first, no session is opened, nothing is drawn. An **`ask`** is an ephemeral
  event under the room's names tag, sealed and MAC'd as "who serves?" is (164 bytes: a lookup's body, the name id, the
  mode, `spread`, and 8 bytes `shown`); a **`reply`** comes back under the asker's **reply tag**, `BLAKE2s(tag salt,
  "names-reply", names key, hour)` (`Room::reply_tag`), which the names client subscribes to (the previous, current
  and next hour's) before its first ask goes out (a publisher never asks, so never subscribes). A reply carries the
  ask's nonce, the replier's names key and region, `since` (the first entry's time of the owning chain's run as the
  server holds it; unchecked, it only orders a contest), and an item: none (it holds no owner for the id), the owning
  chain's last entry with its anchor and header and the zone, or "too big" (past `REPLY_MAX`, 4 KiB of item: the user's
  value until a dev VM session measures what the default relays forward; the replies are 1.3 to 4.1 KB on the wire,
  *estimate*), which carries that last entry alone, without the zone, so it holds something checkable (review 3,
  finding 2: a bare "too big" from a made-up server, free to forge, forced a contest that fetched every one).
  1. **`share`**, at the spread that last brought one to eight replies in this room (6 the first time; past eight, 3
     bits narrower next time, up to 15), then 3 bits wider at 0.4 s, then everyone at 1 s, while nothing counts.
     Three rounds whatever the start: a room found at "everyone" sends "everyone" again at 0.4 and 1 s, which a server
     whose reply budget was spent, or a relay that lost the ask, answers. The rounds share a nonce; a server replies
     to a nonce once.
  2. **Each reply is checked for what it holds** (the entry: signature, proof of work, its header and anchor, its chain
     covering now; the zone: the owner's, this name's, its signature), never for who sent it. An entry is checked whole
     once a lookup however many replies carry it; its anchor with each copy (a forged anchor on a copied entry mustn't
     refuse the honest copy); a reply that fails a check is dropped and **counts for nothing**: only a reply that held
     (an item, none, or a too big whose entry held) is a reply. There is no limit on how many are let in, only the checks' budget a turn
     (24 units, as a server's) and the relays' (`LOOKUP_EVENTS_PER_SECOND` a relay).
  3. **At the first reply**, unless its round asked everyone: one more ask, **`dissent`**, `shown` naming the best
     item checked so far as it would be kept: 8 bytes of `SHA-256` (tagged `waarm64/names/shown`) over its owner key,
     that key's latest last entry's id and its best zone's hash (nothing for none) (`wire::shown`; zeros when every
     reply so far said none). Every server whose own (owner key, owning chain's last entry, zone) hashes otherwise
     replies, whatever the share: another owner, a later entry of the owner's (a renewal), or another zone (R3a: the
     key alone let a sample of liars show the owner's own last entry with an old zone, none, or an older entry in its
     grace, and silence every holder). A server holding exactly what was shown stays silent; one holding something
     older replies too, and the member keeps the latest entry and the best zone of everything shown.
  4. **0.7 s after that ask** (0.3 s after the first reply when everyone was asked), it decides:
     - one owner key shown: that owner, its **latest** last entry (a server a renewal behind, a title forked), with no
       history (one key, one owner); what is kept starts from that entry's time;
     - none, from at least one server: **NXDOMAIN, 60 s, twice as long each time after while the name stays unknown,
       to 10 minutes** (forgotten once its wait has passed as long again unasked);
     - two or more owner keys, or one shown only by items too big (its zone is fetched): a **contest**. Every replier
       is listed by its `since` (of one owner key, the 32 with the earliest `since` are kept); the member
       sends **`fetch`** (`shown` the first 8 bytes of one replier's names key) to the earliest, 8 at a time, a replier
       whose key already has a run checked as old as it claims skipped, and lets in handshakes from those names keys
       only. The server named calls back and sends the owning chain's whole run (`items`, as `history`; an item of
       the id with no entries when it holds nothing), checked as a `history` is, a slice a turn. Each item goes to
       the contest of its own id waiting on that server, and the session is let go once no contest waits on it: a
       server fetched for two names at once answers each in a transfer of its own (review 3, finding 3: the first
       contest waiting took both, dropped the other's run and closed the session, so an impostor won the other
       name; `two_contests_at_once_each_get_their_own_run`). It stops once nothing is in flight and the best run checked (by "Who owns a
       name" over every run that held) is older than every `since` left, or **10 s after it started**
       (`CONTEST_FOR`); the owner is that best, only if every key shown is settled: its run checked, or each of its
       repliers claiming a run younger than the best. A liar about `since` costs a fetch and loses
       (`liars_since_cost_a_fetch_each_and_lose`); a contest with no run that held, or with a key unsettled (its
       repliers made up, crowding out its real holder, or out of time), gives no answer (the next query asks again),
       never another owner's (`a_contest_crowded_by_forged_repliers_ends_in_time_and_never_for_another_owner`). So
       forged repliers hold a contest 10 s at most; a contest needs a second live chain of the name (a registration)
       or a key shown only too big, and forged copies of the owner's entry from made-up servers then cost that name
       its answer, not its owner.
     - silence through the last round, 2.5 s after the first: **nobody serves** (30 s, doubling to 10 minutes, reset
       by a reply), unless a reply counted in the last minute (the room's reply budgets were spent: a guest asking
       many names at once): then the query gets the resolver's SERVFAIL, and the next asks again.
  5. **A reply up to 3 s after the decision** is still checked: another owner key (or a key shown only too big) starts a
     contest, and what is kept changes if the newcomer's run is older (`Kept::offer`); a name decided none takes an
     owner that comes late.
  Asks go out at 4 a second at most (rounds, dissents, fetches). Measured on the bus (`member_tests.rs`): 128 and
  1,280 junk registrations as the whole sample, showing their own younger chain of the name or saying none, against
  one honest holder: the owner every time; ~1.1 s when the junk said none, up to 2.4 s with its younger chain (a
  contest, 4 to 5 fetches); 6 to 26 replies a lookup. Through the fake DERP and relay (room/tests/names.rs), a first
  lookup in a room of two servers took 1.3 s (the rounds down to everyone) with no DERP packet to or from the member's
  names client, and the next 0.3 s; a contested one 1.3 s, with two fetches through sessions the servers opened, each
  reply through two relays.
- **What a first lookup shows**: the name id, to every server of the room and to a relay that knows the room's ID,
  from a key new each session; a name that doesn't exist is announced again each time its negative answer runs out.
  Registry records pass through relays as replies (ephemeral: nothing is stored). Both are the user's (2026-11-17).
- **A refresh** (a name kept, confirmed more than 5 minutes ago, or in its grace and not confirmed lately) **never
  sends an `ask`**: that would tell the room how long a name stays in use. It goes to the two servers "who serves?"
  drew: `get` (owner mode: the name id, and the last entry and zone the member keeps) to both; each answers with what
  the member lacks of the owning chain's last entry (its anchor and headers) and the zone, or "none" (an empty
  answer: the server has no chain that owns the name now).
- **The member checks the last entry only** (signature, proof of work, its headers, its anchor, alive by its clock),
  with the last entry it keeps, if the server's continues it, and checks the zone's signature; the chain the server
  says owns the name is the one ending at that entry. An answer that doesn't hold up (a forged entry, anchor, header
  or zone, a dead chain) counts as none from that server.
- **The servers disagree** (their chains end at different entries) or **an answer contests what the member keeps**
  (`Kept::offer` would refuse it): the member asks each for `history` (a `get` mode: the owning chain's whole unbroken
  run and the zone), checks every entry, each once however often the answer repeats it, a slice a turn as a server
  does (a history may carry 1,024 entries: ~0.7 s of the room's worker in one turn otherwise; review 1); the first
  that fails refuses that server's run, so a junk history costs one check; and picks by "Who owns a name" over every
  entry shown, which `Kept::offer` then takes or refuses. A lookup being checked isn't asked again meanwhile, and an
  answer goes only into a lookup asking that server in its own mode (review 2: stray owner answers sent while one was
  checked filled the `history` lookup it started, deciding it on last entries). Last entries
  alone can't be compared (a renewal's time isn't its chain's seniority): an impostor claimed ten days ago beats the
  owner's renewal of four days ago until the owner's run shows its claim of twenty (`member_tests.rs`).
- **What a member keeps**: each name it resolved, with its chain's last entry, the earliest entry time it ever verified
  for that chain and whether that time is the chain's claim's, the zone and when servers last confirmed it, persisted (a
  record a name, version 3: under 2 KB with a wide zone; 1,024 names at most, the least asked for going first). While
  that chain covers now, another chain replaces it only by showing a run that starts earlier than the kept claim. A
  first lookup that saw one owner key keeps only its last entry, often a renewal, whose time is no claim's: until a run
  from the kept chain's claim is seen (a refresh whose server shows it, through `history`), another key's run never
  replaces it on seniority alone, as a back-order claimed between the owner's claim and its last renewal would look
  older (review 3, finding 1; `a_back_order_doesnt_replace_a_kept_name_whose_claim_wasnt_seen`). The price: while no
  claim of the kept chain was seen, a truly older chain of another key (the kept one a back-order taken uncontested,
  renewed since) wins only once the kept chain's run from its claim is shown, or the kept chain stops covering. So a member that knew a name refuses an impersonator after a reset, with
  no rule of its own. (`chain.rs`, `Kept`: a run that holds the kept last entry continues it, the earliest time staying
  the lower; a copy of the kept chain cut short is nothing new; another branch of the same owner key starting no later
  replaces it, as a fork of one title is settled by the order; a run that holds neither, such as a renewal shown alone,
  is refused while the kept chain covers, and the member asks for `history`.) The same chain shown again (its last entry
  the one kept) takes the newer zone, if any; a run shown whole lowers the earliest time kept.
- **A kept answer answers at once**, for as long as its chain resolves; one confirmed more than 5 minutes ago is also
  refreshed in the background, and the next query gets what came back. So only a name this member doesn't keep
  waits; the price is that a zone change or a lost name shows one query late (measured on the bus: the query at 5
  minutes gets the old zone, the next the new). In its grace a kept name is NXDOMAIN while it was confirmed in the last
  5 minutes, and waits for a renewal the servers may hold after that (so a first lookup made while a renewal is still
  pending keeps the name NXDOMAIN for 5 minutes: tests/names-room.test.ts waits for the servers first). Both servers
  saying none doesn't drop a kept chain that still covers (a server that lost it says nothing against it). **A release
  does** (review 2's finding 5): a server whose tombstone holds the member's last entry, off the owning chain, answers
  its `get` with the release and what leads to it from that entry (8 entries at most), and the member, having checked
  them, ends what it keeps and asks again as a first lookup, so it takes the name's next owner at once rather than
  refusing it for the weeks the kept chain would have covered. One server is enough: the release is the owner's own,
  signed and anchored.
- A refresh both servers answer none: what is kept stands while it covers. One says none: the other's answer stands
  (but still goes through `Kept::offer`: one server's chain against a contesting kept one is asked for `history` and
  refused, `member_tests.rs`). Neither answers (both transfers given up): asked once more, with servers found again if
  need be.
- **The dialog's check** must not tell a server which id someone is about to claim (it could guess the name and stamp
  too). **It runs when Register is pressed, not as the name is typed: one first byte a press** (the user's decision,
  2026-11-17). Register asks for `ids` (a `get` mode with one byte: every id the server holds under it), each with when
  its owner's hold ends rounded up to a week (0: nobody's now), and looks for its own there (`Member::ids`, `ids_done`;
  not counted as the name being asked for). Each press goes through a checker made for it and closed with its answer
  (a fresh names-client key), so no server links one press to another. One byte filters a server's guesses by 1/256,
  so a guessable name may be guessed, and nothing more is told.
  - Why: checked as typed, `a`, `al`, …, `alice` asked for each prefix's first byte from one names client, and with
    the room's key any server can hash names, so of the 37 next characters about one passed each byte, and the name
    could be read off as it was typed (review 2's finding 1).
  - What lost: N5a asked for every id the servers hold at once, the answer kept a minute (the name told nothing at
    all). It cost ~40 bytes a name held, 800 KB at the bound, every dialog. The user chose one byte at Register
    instead, and that all-ids form is gone from the wire: an `ids` get carries exactly one byte, and anything else is
    refused as ill-formed.
  - The page asks through a publisher (`ts_room_names_ids`): "What the user sees".

### Servers

(`names/store.rs`, `names/server.rs`.)

- **Hold**, per name, what a rule of the entries held and the time says (`Held::settle`), the same on every server:
  the owning chain ("Who owns a name", from every entry the server was given, so the order they came in can't matter)
  with its whole run; the unanchored renewals that continue its last entry (two at most, the lowest ids: a title
  forked between two browsers makes two), each until it is anchored or could no longer be; released chains still kept
  as tombstones that, without their release, would beat the owner (two at most); the newest zone, if the owner key
  signed it. Everything else is dropped, so a worse chain offered is refused. Each entry keeps one anchor (the
  earliest) and its item carries the headers its entries need, once each. **Why one chain and not every chain
  alive** (N1 left it open: docs/backlog.md): a function of the set is what makes servers converge, and this one does
  so even with copies arriving partial, because a server's sync `get` says everything it holds (below) and the other
  sends whatever it lacks, so a run one server holds cut short (its last anchor missing, so it looked dead) arrives
  whole from the other, and a run cut short is only ever worse than the whole run (later seniority, or an earlier end).
  Two servers that hold the same kept set agree, and the kept set of what both hold is each one's kept set settled
  again. Keeping every alive chain would carry back-orders and junk chains on every name; the price of one is that a
  back-order (a younger chain alive beside the owner) isn't carried: it owns the name when the holder lapses (the
  rule's answer is the same), but servers have it only once its owner's agent puts it again, at its next renewal (two
  weeks at most) or when the agent sees the name free (N4).
- **Sync with each other** (`Run`): a sync round asks "who serves?" afresh and syncs with the two servers it keeps,
  at the start and every 5 minutes with 30 s of jitter either way. A range of name ids (those that start with a
  number of nibbles: `wire::Range`) is summarized as a fingerprint, 8 bytes, the XOR of 8 bytes of `BLAKE2s(id,
  version)` over its names, and their count; a name's version is 8 bytes of SHA-256 over its kept entries' ids and
  their anchors' digests and its zone's hash. The asker sends `sync` with its summary of everything; the other
  answers `same`, the 16 sub-ranges' summaries, or, where its range holds 64 names or fewer, a listing (8 bytes of id
  and the version, each); the asker descends into the sub-ranges that differ (4 requests in flight), and for each
  listed name it lacks or holds otherwise sends `get` (`all`: the id or its 8 bytes, the zone it holds as `seq` and 4
  bytes of hash, and every entry it holds as 8 bytes of id and 4 of its anchor's digest; the answer, `items`, carries
  the entries it lacks or whose anchor differs, and the zone if it differs), and at the end tells the other in `have`
  what it holds that the other lacks or holds otherwise, which the other then `get`s. **Only a server that proved a
  live name** is answered `sync`, `have` and `get` of everything (an asker's session is anyone's): the servers our
  question chose proved one by their `serve`, and a run's first `sync` carries the asker's proof (a live name's entry,
  checked whole, and its owner key's signature over the tagged hash, `waarm64/names/peer`, of the room's value and
  both names clients' keys; checked once a session). A run is bounded: sixteenths of a range of 63 nibbles or more, or
  a listing past 64 names, end it (an honest partner lists those; at depth 64 a range is one id), and it sends at
  most 8,192 `sync`s (20,000 names each differing take ~4,400) and as many `get`s as the bound holds names, the
  listed ones from a work list 4 at a time, and lasts 4 minutes at most (`RUN_MAX`, under a round's 5; review 2: a
  partner answering each request just before its 15 s could stretch a run to hours while the new server answered
  nobody): a run that ends by its time ends the round as any other does, and the next round goes on from what came. A peer's `sync`s may make the server fingerprint 16 times its registry a
  sync round; a `have` names 32 ids at most, and what `have`s make it ask a peer waits 64 at once. A `get`'s answer
  is taken only for the name asked (its id, or an 8-byte prefix's two at most), and what a peer's answers bring waits to
  be verified 256 items and 4 MiB at most (4,096 and 32 MiB from everyone): past it its `have`s ask nothing and its
  run's `get`s wait for room (review 3, finding 4: items for any name, unbounded, outran verification). Both settle a range before they
  summarize it, so time has done the same to both. A changed name (a `put`, a sync) is told in `have` to the servers
  of this round and those that synced with this one in the last 10 minutes, but the one it came from. A server
  answers "who serves?" only once its first sync round is over and what it brought is verified (not what was `put`
  meanwhile: below), or nobody answered it. Measured through the fake DERP and relay (room/tests/names.rs): two servers converge in 40 s from their start
  (the first question finds nobody, both then serve, the next finds the other); twenty servers holding 40 names in 6
  minutes (8,900 DERP packets in all, a 51 KB registry each); after a reset, three owners' names are back everywhere
  in 40 s. (The tests' entries carry one 4-operation pretend anchor each, so bytes are small against real anchors'.)
- **`get`** has three more modes, a member's: `owner` (the owning chain's last entry and the zone, those the member
  lacks; nothing when no chain owns the name now; a tombstone's release when the member's last entry is on it) and `history` (the owning chain's whole run and the zone), each
  counting as the name being asked for; and `ids` (every id held under one first byte, answered `ids`; not counted). A server that leaves names out (or lies) is outvoted in sync by
  any other server holding them, and a member asking it for one gets nothing from it and the name from its other
  server (N3: the answer that has one stands).
- **Asks** (R3, `Server::on_ask`), once its first sync is done: a `share` whose rank (the plain draw over its live
  names' owner keys; no live name: only "everyone") falls in the share, and a `dissent` when it holds an owner for the
  id and its (owner key, last entry, zone) isn't what `shown` names (any owner for zeros; R3a), are replied: the owning chain's last entry with its
  anchor and header, and the zone (`owner_answer`, nothing held), or none, or "too big" past `REPLY_MAX` (the last entry
  alone); the reply
  counts the name as asked for. A reply proves nothing of the replier, so a server's share is its own to keep. Replies
  have **budgets of their own**: 2 a second (`REPLIES_PER_SECOND`), 16 a minute under one reply tag
  (`REPLIES_PER_TAG`), once a nonce, apart from "who serves?"'s answers and the call backs, so neither starves the
  other (measured: 2,000 forged asks from 200 keys over 10 s make 20 replies, and questions are answered meanwhile;
  one tag's 120 asks over 2 minutes 32). A reply goes through the relay that brought the ask and the one whose copy came
  next (another after 1 s without one: `REPLY_SECOND_WAIT`), so one relay that drops replies doesn't silence it. A
  `fetch` naming this server's names key is a call back, from the answers' budget (4 a second) and a key's few a minute,
  as a question's answer is, then `items` with the owning chain's whole run and the zone, unasked (the transfer it
  answers is 0).
- **Take from anyone**: `put` (an item, from an owner's agent or a member that holds a better chain than the server
  showed it), checked like anything else and settled; answered `taken` when the owning chain's last entry is the
  put's and its zone, if any, was taken or is the one held, else `better` with the server's item (a zone refused, within
  10 minutes of the last or not beating the one held, is `better` too: review 2) (empty when it holds nothing of the name). Puts wait in a queue of their
  own (4 a peer, 64 in all; past that refused), verified after what sync brought, a slice of one put at a time in
  turn.
- **Verify** signatures, proof of work and anchors before keeping or serving, a slice each turn of the module (an
  entry 4 units, an anchor or a zone 1, 24 units a turn: ~6 entries, ~4 ms in Chromium's wasm; while any wait, the
  module asks to be ticked again at once), an entry already held only for an anchor that differs; what was verified
  is stored as verified and not checked again at load. An entry that fails a check (only a forgery fails one: what
  is checked of an entry is its own bytes) ends its item's check, nothing of the item is kept, and its id is
  remembered (4,096 lately: signature, proof of work, form, room), so 1,024 copies of a junk entry cost one check, not 1,024 Argon2ids (review 1). Likewise an entry checked
  whole is remembered (16,384 lately, without its anchor): a valid one put again, a dead chain's say, which `settle`
  drops so that it is never held, costs only its anchor's check (~1/40 of the whole; review 2: a dead title's 150
  entries put in a loop cost every server 0.1 s a put). In Chromium's wasm (N0, cloud): an entry is ~0.66 ms whole
  (Argon2id 0.49, BIP-340 0.15, its anchor's 46 SHA-256s 0.015, a header 0.0005), so a 5,000-name registry's 60,000
  take ~40 s of one core.
- **Bound**: `MAX_NAMES` 20,000 and 128 MiB of items. Past either, a server drops names, never its own, the ones
  nobody has asked it for longest first (asked: a member's `get`, or the name's arrival; sync doesn't count), deletes
  them from its store and doesn't fetch them by sync for a day unless a member asks. A dropped name isn't lost (its
  owner holds the title and puts it back), and junk registered in bulk is what nobody asks for (unless its registrant
  asks: askers can't be told apart, so an attacker can keep its junk asked for and have honest names that are rarely
  asked dropped first. Not handled: N6 measures it). Proof of work alone can't bound the registry: a GPU makes
  100,000 claims for the price of a few hours (*estimate*), and one stamp covers them all.
- **Persist** per name, binary, one record each (a version byte, when it was last asked for, the item), and per block
  checked ("Outside the room", version 3): the module
  emits each as it changes (action 11, the name id and the record; none: delete it) and takes them back before its
  first tick (`ts_room_names_load`), trusted; a record is written again for being asked for only once that moved an
  hour. The node's own names aren't stored there (their titles are the agent's). A member's records (what it keeps, a
  version byte of 2) go the same way. **The page's side** (N3, web/room.ts `roomNamesStore`, web/room-worker.ts): IndexedDB
  `waarm64-room`'s store `names` (the database's version 2), each record under the room and the connection (16 bytes
  of SHA-256 over the room's ID and the connection's `identityKey`, in hex: a private room's ID is a secret, and two
  stored connections in one room keep theirs apart) and the id, written in batches of a second (and before the worker
  posts `detached` or is terminated: closing a room waits up to 3 s for it), read back at the start and streamed into
  the module before its first tick; one the module doesn't take (another role's, a lapsed name's: a server's `load`
  says whether anything of the record is held) is deleted. Only a stored connection's (one with an `identityKey`): an
  ephemeral one keeps nothing.

- **Outside the room** (R2, `names/outside.rs`; decision 4 as the user widened it on 2026-11-17: servers ask, members
  never). The module asks, the page fetches: action 12, a GET whose URL the module builds only from the compiled
  calendars (anchor.rs `Calendar::url`) and explorers (`EXPLORERS`, the agent's two), never from a record; the room's
  worker fetches it through web/names.ts `serviceFetch`, which refuses any other URL, and gives back the status and
  the body (`ts_room_names_fetched`; status 0: no answer). Four fetches out at once, 30 s each at most.
  - **Renewals finished.** A renewal the server holds with a signed pending anchor (the owning chain's last entry's,
    "Hold") is asked of that anchor's calendar (`/timestamp/<commitment>`) from 30 minutes after the server first held
    it, then decided once a slot of 15 minutes: the server asks when 8 bytes of BLAKE2s over the entry's id, its own
    names client's key and the slot fall under a chance of one over the room's servers as its questions counted them
    (each question's answers times the round's share, plus itself, at most 64, averaged over questions), halved for
    each 12 hours the renewal has waited, to an eighth. So a room's servers together ask about once a slot for an
    entry, whatever their number, then fewer. With the finished proof: the block at its height and that block's header
    (the agent's two GETs, the other explorer when one fails or its header isn't the anchor's), and the anchor is
    taken as anything put is (checked, settled, stored, told to the servers it syncs with in `have`): the room has it
    within minutes, and the block counts as checked. Measured (server_tests.rs, the pretend calendar and explorer):
    twenty servers holding a renewal whose calendar never finishes it ask it 2 to 8 times an hour, 57 times in its
    first 12 hours and 30 in the next 12; two servers over 60 days of three names, each renewal stamped at a visit
    and finished two to three hours on: 33 calendar asks for 6 renewals (all finished by the servers) and 23 explorer
    asks in all.
  - **Blocks checked.** Each distinct block the registry's anchors are in (its own titles' included) is asked of an
    explorer once, **by its hash** (`block/<hash>/header`: the same header back, checked). The redesign named
    `block-height/<h>`; by hash instead, because the height an anchor carries is trusted for nothing ("Records"):
    anyone relaying an honest entry with another height would have had its block refused, and an orphaned block,
    which "passes", is at no height. Not found (404) at both explorers: the block is **refused**, every anchor in it
    dropped from the registry (their entries count for nothing, so the chains they made settle again, stored and told
    as any change), and remembered for a day, an anchor in it offered meanwhile refused at its check, and one checked
    before the refusal in a job still being verified dropped when the job is kept (review 3, finding 6). One explorer's
    word is enough: one denies and the other confirms, checked; one denies and the other can't be reached, asked again
    after 5 minutes, doubling to 6 hours (the tries kept through the check and a transport's restart: review 3,
    finding 7, every retry had waited 5 minutes; 16 asks a block in 12 hours with both explorers down, was 290).
    **Until a block is checked its anchors count** on their header's work, as a
    member's do, so names work with the explorers down. The pace: one check every 3 s at most (`Params::check_every_ms`),
    the newest arrival first, so a new server's first sync (hundreds or thousands of blocks) takes a while and a new
    arrival is checked within seconds; N6 measures what the explorers tolerate. Checks run from the module's ticks:
    a lookup, a `get` or the resolver never waits for one. Each verdict is stored as a record of its own under the
    block's hash (version 3: the verdict, its time, the hash), loaded back at the start (a refusal past its day isn't:
    the page deletes it), and a check no anchor needs any more is forgotten (its record deleted) at the next minute's
    settle.

### Size, and where it stops

Measured over N0a's 240 real anchors (N0b, bench/net/REPORT.md "NAMES loop 0b"). An entry is 175 bytes; its anchor
**905 to 1,256 bytes, median 1,185** (as anchor.rs encodes it: ~20 levels of a calendar's tree, its transaction, a
block's path), and 6 bytes of lengths and an index in an item; its block's header 80, once an item, which for a name
whose entries are two weeks apart is once an entry (R1: before it, 80 for `ref` and 560 for the anchor's block and
the six after it). So **1.17 to 1.52 KB an entry (1.45 typical)**, and with two entries a month a name costs a server
about 0.4 KB for its zone plus **2.3 to 3.0 KB a month it has been held** (2.9 typical; the estimate was 1.1 to 3.0,
whose low end assumed anchors shared).

| Names, held six months on average | A server keeps | A new server's first sync through DERP (0.6 to 3 Mbit/s measured on public relays) |
|---|---|---|
| 1,000 | 14 to 19 MB | under a minute to 4 minutes |
| 5,000 | 72 to 93 MB | 3 to 21 minutes |
| 20,000 | 290 to 370 MB | too much for a tab |

Anchors a calendar put in one transaction share their path's tail, and those in one block their header, but an item
is one name's and carries neither across names. A store that kept a registry's anchors by calendar transaction
(not built) would save what a second anchor in the same transaction doesn't add: one made at another moment adds
304 to 713 bytes of its own (median 619). A room of N names stamps about N/360 entries an hour, ~N/300 to each of
`alice`'s transactions: ~30% less at 1,000 names, ~40% at 5,000, headers included. A constant factor, not the shape.

A member keeps a few KB. So what grows with a room is each **server's** copy, and every new owner pays the first sync,
in the background, before it serves. Past a few thousand long-held names it needs one of: servers that hold a share of
the id space each; owners syncing with each other directly (WebRTC, which shows an owner's IP address to other
owners, so the user's call); fewer renewals a term. None is in v1; the first is the one to build. N0b's measured sizes confirm this: they raise the small rooms' figures
(the low end was an estimate of shared anchors) and leave the large ones where they were.

## The resolver

`resolve()` (room.rs) gains, after the key-name case, for a name under `<tag>.p2p.internal` (the name, or one label under
it) that passes "Names"' rules:

- on a server's node, from the registry it holds whole (`Server::resolve`); a name of this node's own that isn't public
  yet (or lapsed) answers from its title's zone, or this node's address for the name itself (a server can be tried by
  name before its registration is public); a name not held waits while the first sync isn't over, else NXDOMAIN;
- on a member's, a name it keeps, its chain alive: AAAA from the slot the name asked opens (none opens: NXDOMAIN), TTL
  60; the module learns the key (and asks again in the background when what it keeps is older than 5 minutes);
- otherwise the query waits while the names client asks the room: answered when the answer comes; SERVFAIL after 4 s
  (`DNS_WAIT`; 64 queries wait at most, past that SERVFAIL at once; a contest still going on then goes on, and the
  next query has the answer; a first lookup took 1.3 s through the fake DERP and relay in a room of two, 0.3 s once
  the room's spread was known; a guest's resolver retries);
- NXDOMAIN at once for a reserved or ill-formed name, a name the replies said none for (60 s, doubling to 10 minutes),
  and any name not kept while the member remembers that nobody serves ("A member resolving a name": 30 s to 10
  minutes).

Every type is answered alike (AAAA has the address, A and the rest an empty answer). Each query for a name that isn't a
key is logged (`resolver: <name> (type <n>): <answer>`), to the worker's console only. Guest-visible, in that names that
were NXDOMAIN now answer, and some answers take seconds.

## The names agent (the page)

(Built in N4c: web/names.ts, web/names-ops.ts, web/names-worker.ts; net/ts room/names/agent.rs and the publisher in
room.rs.) The agent owns the owners' secret and the titles, which are the only place a name is kept in words: IndexedDB
`waarm64-room` (version 3), store `owner` (the secret, 32 random bytes, under the connection's `identityKey`, as
`identity` keeps its node key; made at the first registration) and store `titles` (a record a title under
[identityKey, a hash of the room's ID, the name]: the room's ID and link, the title's item, the calendars' pending
anchors of each unanchored entry, the zone's points and counter, the backoffs, lost or released). **A title is the only
copy of ownership**: registering asks the browser for persistent storage (`navigator.storage.persist()`), and deleting
the connection says so and shows its export (N5; the dialog doesn't: decision 6 allows it two notices). **A connection's export carries its names**: `<node key>.<base64url of the secret and the
titles>` (web/app/room-export.ts, web/names.ts `exportNames`, `parseRoomExport`), and a connection made from a pasted
export takes them as its own (`importNames`); a connection that has an owners' secret already keeps it, and each title
taken in keeps the bundle's with it (`TitleRecord.secret`), so that its renewals and zones are signed by its own owner
key (review 2's finding 11: they were the connection's, which broke the chain), and the agent renews a chain only with
the key its title's secret derives. The module does the work (`ts_names_*`, pure: JSON in and out; make, mine
in slices of 256 tries, sign and check an entry; a calendar's receipt made a pending anchor the owner key signs; the
commitment to ask for and a finished proof's anchors; an anchor taken with its block's header; a zone; a title's status;
a server's better item judged), in a worker of its own for proof of work (production: 3 to 64 s an entry in Chromium,
a mean of ~39 s over five, cloud x86_64); no JavaScript crypto. It needs no running machine:

- **On every page load** (web/app/main.ts starts it when any title is kept; none, no worker), and hourly while open
  (sooner when a backoff ends), for each title, under **one Web Lock a title** (`waarm64-names:<identityKey>:<room
  hash>:<name>`, taken if free: another tab doing it is left to it): collect finished anchors (each calendar's pending
  proof at its compiled URL; the 404 without CORS of a pending one is a failed fetch: asked again with a backoff, 5
  minutes doubling to an hour; one that can no longer link is asked at once whatever the backoff), with its block's
  header from an explorer ("Who talks to an explorer"); renew when the owning chain's last entry is `TERM / 2` old and
  no renewal waits for its anchor (the renewal made ahead, below, or else proof of work and the signature now; stamped at the three calendars, each receipt a pending
  anchor the owner key signs, the lowest on the entry, all three kept to collect from); make the claim of a title that
  has none. An entry no calendar stamped is dropped and made again, with the same backoff. Nothing else drops one
  (review 2's finding 4): every anchor counts whenever it comes, a calendar's answer that isn't a proof (a proxy's
  page) moves on to the next calendar, a header one explorer serves that the module refuses to the other's, a clock
  behind to a later try. A renewal still unanchored past its link end (the entry before's `t + TERM + GRACE`: the
  module's `linkEnd` and `stale`) may have an anchor timed before then that no open page collected: it is kept and
  asked for, and dropped only a week past its link end (a renewal so collected still links, and revives its chain). A
  claim never goes stale.
  **The next renewal is made ahead** (R2; room-names-redesign.md §3: possible since R1 removed `ref`): once a pass has
  published, the agent makes the renewal that will follow the title's newest entry of its own chain (the renewal
  waiting for its anchor, else the owning chain's last entry, else the claim waiting for its own), proof of work and
  signature, and keeps it unstamped in the title (`TitleRecord.ahead`: its `prev` and the entry). A visit that finds a
  renewal due stamps that one (seconds: the three calendars' POSTs) and hands it to the servers with its signed pending
  anchor, who finish it ("Servers", "Outside the room"); proof of work happens only after that, for the next. So a
  visit of a few seconds every 2 weeks keeps a name: a renewal is stamped at a visit 15 to 29 days after the entry
  before it, and the servers have its anchor hours later, before the 30 days end. Measured (tests/names-agent.test.ts,
  the pretend calendars): a due visit's pass stamps and publishes with no proof of work before the publish; the
  promise itself (server_tests.rs `visits_14_days_apart_and_seconds_long_…`): visits 14 days apart, each only stamping
  and putting, the calendar finishing 2 to 3 hours after, the page closed between: the name resolves and is owned by
  its chain at every hour of 60 days, at both servers. Let it go drops the one made ahead.
  **[Let it go](ui:network:NameEntry.release)** drops the title's renewals that wait for their anchors (one collected later would be a branch whose
  cover outlasts the release's, so the name would stay: review 2's finding 6) and makes the release on the owning
  chain's last entry; a release no calendar stamped, or one that never came, is made again at the next pass.
- **Publishing** is a `put` through a **publisher**: a room client that is a names client alone (room.rs
  `Config::publish`: a fresh key, relay only, nothing let in but its question's answers, no guest, no node), which asks
  "who serves?", keeps two servers as a member does, and puts the title's item (every entry it holds, the zone) to each,
  each answer a `names-put` event (`taken`, `better` with the server's item, `failed`, `nobody`). So the page does it
  whether or not a machine runs, under no lock: once the claim is anchored (never before: "a claim held back"), and
  whenever the item changed since a server last took it (a renewal made, with its signed pending anchor; an anchor
  collected; a zone changed), and once a visit and an hour besides (so a room that was reset, or settled a fork the
  other way, is seen within the hour). With no server online there's nobody to put to; the title is safe and the next
  pass tries again.
- **A server's better item** is checked whole (each entry the title doesn't hold as shown: signature, proof of work,
  headers, anchor; a forged one is refused and nothing is taken) and judged with the title's entries: the owner now is
  the title's own chain (`ours`: a renewal still pending shows so), **another branch of the title's own key** (a title
  forked between two browsers: its entries, and a newer zone of the same key, are taken into the title, and the next
  renewal is made from the room's branch; either way, a server that holds the title's chain but answered `better`
  over its zone didn't take it: one of the room's at or past the title's is counted past, by a new zone sealed with
  `n` beyond it, and the title is put again 11 minutes on, `putAgain`, not called published until a server takes it:
  review 2), or **another key's chain: the title is lost**, renewal stops and the page
  says so (`TitleView.state` `lost`, `lostTo`). Not while the title's own chain has lapsed as collected and an entry of
  it waits for its anchor (collected, it may revive the chain, whose claim may be the elder), and a lost title is
  still put once a visit and hourly, so that it is judged again: its chain owning the name again clears `lost` (review
  2's finding 8). Nor when another server of the same pass took the title (or showed its own chain), nor until an
  explorer knows the better chain's first block (`block/<hash>/header`, the header `judge` returns): one both explorers
  deny is a forged header, which honest servers refuse, and one neither could be asked about is judged again at the
  next pass, renewing meanwhile (review 3, finding 5: a liar drawn as one of the two servers, its chain older on a
  forged header, stopped the owner's renewals until the name lapsed everywhere). The title's key is its claim's.
- **A title publishes through its connection's link as it is now** (review 2's finding 16): the page's views take a
  connection's titles by its key and the room's ID, not by the link a title was registered with, and when a connected
  room adapter shows titles kept with another link, or the user changes or lets go of one, the agent stores the
  connection's link in them (`relink`), so a connection rejoined with other relays keeps its names and they don't go on
  through relays that went away.
- **When the connection's room runs**, the node is a server: the room's worker gives the module the connection's titles
  in its config (`room.names.titles`, each the owner key derived from the secret and the item) and again as they change
  (the agent's BroadcastChannel `waarm64-names`; `ts_room_names_titles`: a member given titles becomes a server).
  The server checks each title's entries and zone as it checks anything from outside (at once: a title is a few
  entries, and those it holds or checked lately cost nothing), and a title with an entry that doesn't hold is refused
  whole: titles can come from a pasted export, which anyone can craft (review 2's finding 15: a forged senior chain
  would have displaced the real owner's in the node's own registry).
- **A zone's `seq`** (64 bits) is `n << 32 | branch`: `n` counts up past every `seq` the title has seen, `branch` is
  this copy's, 32 random bits drawn when the title is registered and again by **every copy taken in** from an export
  (`importNames`; the export itself writes nothing), so the same text pasted into two browsers gives two branches. Two
  copies share a branch with a chance of 2^-32 a pair, and only then could they make two zones with one `seq` (which
  would reuse a seal's key: "Names nobody lists"). Why 32 bits (N4d): with N4c's one byte, a branch drawn at each paste
  would collide one pair in 256; one given out by the exporter can't tell two pastes of one export apart. The zone's
  version byte is 2, items' 3 and an export's names' `v` 2 since (pre-release: older ones are refused).
- **The services are compiled in** (web/names.ts `CALENDARS`, the module's order and URLs, and `EXPLORERS`,
  blockstream.info's and mempool.space's Esplora APIs): the agent fetches nothing else (its `get` refuses another URL;
  so does `serviceFetch`, through which a room's worker fetches what its server asks: "Outside the room"),
  a pending anchor names its calendar by index, a receipt's own URI is never fetched, and no link, option or stored
  value names a service. Tests route these URLs to the pretend ones (Node: `fetch`; Chromium: Playwright's routes).
- **N5's API** (`NamesAgent`): `register(conn, name, points)` (a name the rules refuse: `NamesError` `Name`),
  `setZone`, `release`, `titles(identityKey?)` (each title's `state`: `preparing`, `reserved` with `publicAbout`,
  `active`, `grace`, `lapsed`, `released`, `lost`; and its dates: `claimedAt`, `keptUntil`, `renewAt`, `lapsesAt`),
  `pass`; the page's agent is `namesAgent()`. Measured (tests/names-agent.test.ts, the pretend calendar and explorer):
  register to public ~0.15 s once the blocks are there; collected and published through the rig's DERP 1.3 s.

## What the user sees

(Built in N5: web/app/NameDialog.svelte, NetNames.svelte, NameEntry.svelte, areas/names.svelte.ts, names-view.ts;
docs/frontend.md "Network" says how.)

**Reaching someone's name: nothing.** No switch, no notice. The first time a guest asks for a name that isn't a key,
the names client finds servers and asks; the answer comes within the resolver's wait or on the guest's own retry. The
adapter's details gain one line, for the curious: a member's names resolved and servers held, or a server's names held
and the servers it synced with lately (the module's `names` event, sent when the numbers change).

**Registering a domain.** The page calls a name a **domain** (the user, 2026-11-18: a term people can look up, which
can't be taken for a connection's, an adapter's or the room's own name; and it's held by the connection, by its key,
wherever the connection is attached, not by a machine), a label a **subdomain**. In the Network menu of a connected
room adapter, **[Register a domain…](ui:network:NetNames.name)** opens one dialog:

1. A field, the whole domain under it (`<name>.<tag>.p2p.internal`, or the room's suffix while nothing is typed). Under it, as typed, only what the page can say alone, asking no server: not a valid name (the rules, by
   the module), or this connection's already. **The room is asked when Register is pressed** (the user's decision,
   2026-11-17; step 3). Nothing lists a room's names, here or anywhere: the registry couldn't.
2. Two notices, always shown, no boxes: [Members of this room who know the domain can reach this connection's
   address and see when it's online. While this connection is connected, this web app helps other members look
   domains up.](ui:network:NameDialog.notice.find); [Open this web app at least every 2 weeks to keep the
   domain.](ui:network:NameDialog.notice.visit) ("this web app" is the page's word for itself, docs/copy.md; it serves
   the room's domains whenever the connection is connected, whether a machine runs or not).
3. **[Register](ui:network:NameDialog.register).** It first asks the room's servers for every id under the name's
   id's first byte, one byte a press, through a checker made for that press (`ts_room_names_ids`, `names-ids` events;
   a server's `ids` answer carries each id's cover end, when the owning chain's hold ends, 0 when nobody owns it now,
   so "taken until" needs no `get` naming the id). Then:
   - **free**: the name is registered and the dialog closes, with no step added (the kickoff's decision 6);
   - **taken**: the dialog stays open and says until about when (*mybox is taken, until about <date> unless its owner
     renews it.*); Register is offered again once the name changes;
   - **nobody can say** (no server answered): the dialog stays open and says so (*Nobody in the room can say whether
     mybox is free right now: no machine that serves the room's names answered. Press Register again to register it
     all the same.*), and Register pressed again with the same name registers it. First come still holds, and the
     claim is private until anchored.
     A second press of the same name is the least intrusive way on: no button, box or question of its own, and none
     on the path where the name is free.

   Once registered, the adapter shows the name with its state:
   [Preparing](ui:network:names-view.preparing) (proof of work), *Reserved, public in about N hours; it already works on
   this machine* (counted from the claim's own stamp, again when it is made again; past the usual wait, [Reserved, public
   once this web app has been open a while; it already works on this machine.](ui:network:names-view.reservedLate), as
   only an open page collects the proof: review 2's finding 17), then *Active, kept until about <date> unless you visit*; in its grace, lapsed, let go and lost as the
   agent reports them.

No key is shown or asked for. Changing where a name points (a member's name in the room, or a key, pasted), adding a
label under it (15 at most: past four points a zone is sealed wide, 16 slots) and letting it go are in the adapter's
details. The Home page shows a stored machine's names (its
Network tab, each room adapter's) with the date each stops resolving unless renewed, and the page says, on load, after
the agent's first pass, when one is inside its last week (kept until less than 7 days on). All words are in
`web/messages/en/network.json` (the Home page's line in `machines.json`).

**An ephemeral connection can't hold a name** (N5's choice): one whose key lives in the page's memory is gone when the
page closes, while a title lives in IndexedDB for weeks and is renewed at every load, pointing at a key nobody holds.
Saying "the names go with the page" would be untrue for the title and useless for the name, so the dialog says the
connection can't hold one and offers no Register (an ephemeral connection that shares a stored one's key can: the key
and its titles last). **Deleting a room connection that holds names** (its key no other connection's) asks in a question
of its own that names them and shows the connection's export (the key, then its names) in a field to copy; deleting it
then forgets the owners' secret and the titles. **The wizard's key field** is that export, and a pasted one brings its
names.

## What an attacker can do

| | Cost | Result |
|---|---|---|
| Register many names | proof of work each, again every term | squatting; the names lapse when it stops paying. Servers drop the unasked-for first; members never see them |
| Stamp a dictionary and hold it back | the same work, every term, for as long as it waits | takes a name later registered by someone else: accepted |
| Race a new registration | none | a guessable name, at best: a claim is public only once anchored, and the dialog's check sends one byte of the id a press of Register (the user's decision, 2026-11-17), never the id; a byte a prefix, as typed, spelled the name out (review 2) |
| Tie a claim it somehow knew of | several claims in the same block | wins most ties: the tie-break can be ground. It needs the name before the claim is public |
| Hash a dictionary against a server's ids | nothing: 256 `ids` requests from any session list every id (the dialog's check needs the request; review 2 corrected the cost from "one registration") | learns which guessable names exist (and, with a `get`, where they point); nothing about the others; the cover ends listed are a week coarse |
| Be the whole sample of a first lookup, show its own younger chain or none | registrations (any age) | nothing, while one honest holder hears the `dissent` and its reply arrives: the member takes the owner by its run (R3; 128 and 1,280 junk registrations against one holder, `member_tests.rs`) |
| Show the owner's own records in the sample, stale: its last entry with an old zone or none, or an entry a renewal behind | registrations | nothing, while one honest holder of the newest hears the `dissent`: `shown` names the entry and the zone with the key, so that holder differs and replies, and the member keeps the latest entry and the best zone (R3a, `the_owners_own_records_shown_stale_dont_silence_the_dissent`) |
| Show the owner's last entry before its release (public, alive by its own time) | registrations | holders of the release hold no owner, so they don't dissent, and a reply can't carry a release: the member keeps the released owner, even against the name's next owner (whose dissent starts a contest the old run wins, the fetched runs carrying no release), until its refresh 5 minutes on ends it. docs/backlog.md |
| Hold many younger claims on one name, each lying about `since` | a registration on that name each, every term | that name's first lookups run a contest: a `fetch` and a run's check a liar, 8 at a time; the owner still wins |
| Junk replies under an asker's tag (it reads the tag's inputs in the ask) | events | a failed check each; no place taken from anyone; "too big" carries a checkable entry (review 3); copies of real entries from made-up servers narrow the next lookup's first spread at most (its rounds widen to everyone) |
| Copies of an owner's entry from made-up servers claiming `since` 0, in a contest | events, and a registration on that name for the contest | the name's first lookups give no answer for 10 s each (`CONTEST_FOR`); never another owner |
| Forged asks that make servers reply | one event | every holder replies once (a `dissent` with a made-up `shown`, a `share` at spread 0): bounded by 2 replies a second a server and 16 a minute a tag; with hundreds of servers, megabytes a second onto public relays (backlog) |
| Keep honest dissent away by spending servers' reply budgets | forged asks at every server's 2 a second, sustained | members take what the attacker shows for names they don't keep, while it lasts. Loud; the budget is apart from "who serves?"'s |
| Serve a member's refresh, and leave names out or serve an old zone | registrations (the plain draw) | a stale zone or a release unseen for 15 minutes at most, before the member redraws; never another owner (a kept chain yields only to an older run) |
| Hold a name after a reset | one registration | impersonates it to members that never resolved it, until a server that holds the owner's chain is asked |
| Forge a Bitcoin header | one header at the floor: 1/16 of a block's work (about 0.2 BTC of mining revenue forgone, or hash power rented for that), once | the forger's header, timed (say) 36 days back with a Merkle root of its own, anchors claims on any number of names in every room at that time; renewed with real stamps, they beat every chain claimed since, and the header serves again for any number of claims. Servers ask an explorer about each block (R2: the user's decision of 2026-11-17; "Servers", "Outside the room") and refuse it, with every anchor in it, once both explorers deny it: within seconds of its arrival at a server already synced, later while a new server's first sync's checks are paced. A member asks no explorer: a reply or a fetched run from a server that shows the forged chain (the forger's own, since R3 any in a first lookup's sample or contest) wins there, as it does at servers while the explorers can't be reached ([room-names-redesign.md](room-names-redesign.md) "Bitcoin beyond the proof") |
| Lying explorers | one explorer that lies, or both | one alone can pass a forged header only together with the floor's work (as with none), and can't have a real block refused (the other confirms it); both together can have a real block refused at servers, its names unanchored there until the explorers answer truly (the owners' copies are untouched) |
| Calendars all down | | no new claims or renewals; existing names resolve; `GRACE` is the margin |
| Explorers all down | | claims and renewals are made and stamped; collecting and finishing their anchors waits; blocks stay unchecked, their anchors counting on their headers' work; existing names resolve |
| Flood "who serves?" | lookups' limits | servers' answers come from a budget of their own; a forged asker key gets one handshake from each server asked, and an asker's place, which the next newcomer takes when all 32 are held; a key named again and again (a victim's) 4 answers a minute from each server |
| Fill an asker's accept window | a handshake (a DERP connection) per place, a registration per place that serves | a place held a second without a `serve` goes to the next newcomer; with every place served, the place of the last by hash (never the best two's). A member's `fetch` lets in the servers it named only |
| Make a server work (`put`, `sync`, `have`) | a session (any asker's) for `put`, one registration for the rest | `put`s 4 at a time, a junk one costing one check, a valid one put again its anchors' checks only (past 16,384 distinct valid entries, whole checks again: docs/backlog.md); `sync` 16 registries' fingerprints a round; `have` 64 gets at once, each answer the name asked only, 256 items and 4 MiB a peer waiting to be verified |
| Watch a relay | | sees which IP addresses hold a room's names tag (its servers) and which ask under it: **new**, below. One that knows the room's ID also reads which name ids are looked up first (R3) |

## What changes that needed the user's OK (given 2026-11-15, all of it)

- **rooms.md's decisions that change**: "no directory in the protocol" and "the only names are names that are keys"
  (a registry of names, not of members, joins the protocol); a name's owner is discoverable and serves the registry.
- **Guest-visible**: the resolver answers registered names. No step count moves (`tests/steps.txt` has no room).
- **New outside services**: three calendars (a page that registers or renews, and servers finishing renewals: they
  see an IP address and a hash) and two explorers (a page that registers or renews; and, since R2, servers: the
  block of a renewal they finish and each block their registry is anchored in, the user's decision of 2026-11-17). Their lists could go in a
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
  Since R3 (the user, 2026-11-17), a relay that knows the room's ID also reads the name id of each first lookup (the
  ask), and replies carry registry records through relays (ephemeral, stored nowhere). A `dissent`'s `shown` (R3a: 8
  bytes of a hash of the owner key, a last entry's id and a zone, all public records) tells such a relay and every
  server which version of the name's records the asker was shown, which the replies before it carried anyway; before
  R3a it named 8 bytes of the owner key, the same kind of thing. Nothing of the asker or the name in words.
- **"Every 2 weeks"** (since the review), where the first draft said 3 (renewing at half a term, not a third, halves what
  servers carry).
- **Reserved names** (since the review): the list in "Names".

## Measure first (loop N0, no product code)

Done in the cloud session of 2026-11-16 (N0a, bench/net/REPORT.md "NAMES loop 0"): items 1 to 3, and item 4's
batch of stamps, collected on 2026-11-17 (N0b, "NAMES loop 0b": items 1's check and 4). What it found is in "How long an anchor takes", "Records" and the parameters'
table; times are a shared x86_64 host's, good for the choices, re-timed in the dev VM. The year of transactions in
item 1 couldn't be read whole within a few hundred requests (a calendar's transactions are one request each:
"How long an anchor takes"), so it is a complete record of the calendars' last days and samples through the year.

1. **Time to anchor** from each calendar, the slowest as well as the usual: sets what the dialog promises (and set
   `REF_WINDOW`, which R1 removed). From a year of each calendar's transactions on Bitcoin, read through the two explorers ("How long an
   anchor takes"), not from a week of stamps, which would be a sample without the bad days; checked against a batch
   of real stamps whose commitments are committed, so a later session collects them. (One stamp made 2026-11-15 20:46 UTC: at 76 minutes pending at all three, `alice` and `bob` each naming
   a Bitcoin transaction and "waiting for 6 confirmations", so a calendar serves a proof only once its block is 6
   deep; at 167 minutes anchored at `alice` and `bob`, still pending at `finney`. So between 1.3 and 2.8 hours at
   the two that finished, and the third slower. The finished part was 1,036 bytes at each, on a receipt of 170 to
   207: an anchor of about 1.2 KB before any sharing, more than the 0.9 this page first assumed.)
2. **Proof of work**: BLAKE2s hashcash against Argon2id at a few memory sizes: time to make one in Chromium's wasm and
   natively, what a GPU does to each, **and the time to check the 10,000 and 60,000 entries** of a 1,000 and a
   5,000-name registry in the module's wasm. Picks the function and `POW_BITS`, by what a million names cost an
   attacker a term on a GPU ("Records") against what checking a registry costs a server.
3. **Verification rate** in the module's wasm (BIP-340, an anchor's hashes, a header's): sets the slice a turn may
   spend.
4. **Anchor sizes**, raw and with shared tails and headers, over a few hundred real stamps (item 1's batch): replaces
   the size table. (N0b: 240 anchors, 905 to 1,256 bytes; "Size, and where it stops".)
5. **Through public DERP**: 5, 20 and 50 MB between two names clients, 8 in flight, a guest's ping running beside it;
   and what a second room client in the worker costs (memory, a DERP connection, idle CPU).
6. **A cold first lookup** on the public relays: since R3, an ask and its replies through them (~1 s in a room asked
   before, ~2 s the first time: room-names-r3.md, *estimate*); and whether the default relays forward a 4 KiB
   ephemeral event, which sets `REPLY_MAX`.

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
  answers, persistence, the tests' pretend calendar and explorer (tests/net/ots-calendar.ts), and titles for tests
  (net/ts/examples/names-title.rs, on the module built with the `test-params` feature: below). tests/page-room.test.ts:
  two Debian guests, one name, by full name and by the short one, a label under it, a zone change, the reserved names,
  a room with no server, one whose first server appears while a guest keeps asking.
- **N4** The agent: secrets, titles, the worker, stamping, collecting, renewing, publishing without a machine, forks
  between two browsers, a lost name, export and import.
- **N5** The page: the dialog, the adapter's states, the details, the Home page's dates, the catalog.
- **N6** Scale and abuse: 1,000 members, 20 servers and 5,000 names (a server's load, a cold lookup, a join storm of
  500, junk in bulk against the bound, also when its registrant asks for it); days on the public services with real stamps; the final review.

## Tests' parameters

Production's parameters need real Bitcoin work (a header at 1/16 of a real block's difficulty), so a test can't
make a title they accept. The parameters are not configuration: the module runs on `Params::BUILT`, which is
`Params::PRODUCTION` unless the crate is built with the `test-params` feature, which compiles in `Params::TEST` (the
tests' pretend Bitcoin: regtest's floor, Argon2id of 8 KiB and 2 bits, and servers that finish renewals and check
blocks within seconds, for the Node rig's real-time tests; a Rust test of the asks' rates runs production's pace,
`Params::TEST_PACED`) instead. `net/ts/build.sh --test-params` builds
that module to `target/net/ts-test.wasm` (a target directory of its own), which the page tests serve in `ts.wasm`'s place
(a Playwright route); `npm run dist` ships `ts.wasm` only, and no page, link or config can choose the other. A room's
`self` event says which it runs on (`params`: `production` or `test`). Checked: `cargo test`'s
`the_module_runs_on_production_parameters` (a pretend title's header is under the floor), and tests/room-names.test.ts
(the shipped module says `production`, the tests' `test`). Titles for the page tests come from
`net/ts/examples/names-title.rs` (the same feature); the agent's tests (tests/names-agent.test.ts, names-room,
names-browser) have the agent make its own on the pretend calendars and explorer of tests/net/ots-calendar.ts, at
the times they choose (`mine(n, time)` puts a block 6 deep in the past).

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
