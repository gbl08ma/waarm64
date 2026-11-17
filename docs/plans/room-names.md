# Room names: registered names in a room (spec and plan, not built)

Human-chosen names in a room, registered first come by a key, for a term, with nothing of ours running and no
administrator: `test123` beside today's `<key>.<tag>.p2p.internal`. Chosen with the user, 2026-11-15, from the options
in [room-names-options.md](room-names-options.md) (its option 3, changed as below; the research notes behind it are
`room-names-research/`), then revised the same day after an out-of-context review of the first draft ("What the review
changed", at the end). Built so far: the records and the rules (N1, `net/ts/src/room/names/`: "Names", "Names nobody
lists", "Records", "Who owns a name" and the headers of "Bitcoin as the clock" say what the code does), the names
client and the servers' side (N2: "The names client", "Finding a server" and "Servers" say what the code does), and the
member's side and the resolver (N3: "A member resolving a name", "The resolver", and the page's side of "Persist"), and
the fixes of the out-of-context review of N1 to N3 (N4a, and N4b: finding 6, seven linked headers an anchor and the floor by time), the names agent (N4c: "The names agent"), and the page (N5: "What the user sees"); the rest is a plan. The numbers marked *estimate* are arithmetic, not measurements, and loop N0 replaces them. It extends [networking/rooms.md](../networking/rooms.md), whose terms (room, link, tag, lookup, call
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
| ref | 32 | the hash of a recent Bitcoin block (in the byte order Bitcoin computes it, the reverse of an explorer's): the entry was made after it |
| nonce | 8 | proof of work |
| signature | 64 | BIP-340 over the tagged hash (BIP-340's, tag `waarm64/names/entry`) of the room's value and the fields above |

A claim's `prev` is zeros and a renewal's or release's isn't: anything else is invalid.

- **Proof of work** is over the fields before the signature: the function's output has `POW_BITS` leading zero bits.
  It is bound to `ref`, so it can't be stockpiled or reused for the next term. The function must be cheap to check
  (a server checks every entry of the room), which bounds the memory a memory-hard one may use.
  **What it is for**: the price, every term, of a name held without being used: a dictionary stamped and held back
  ("What it does not give"), a back-order, a squat. Stamping is free and one stamp covers any number of claims, so
  without it a member could claim every word there is each term for a minute of signatures. It is not what keeps junk
  out of a registry (the servers' bound is). So the function is judged by what a million names cost an attacker a
  term on a GPU, which favours a memory-hard one. **Chosen (N0, provisional until the dev VM re-times it): Argon2id,
  1 MiB, one pass, one lane, 32-byte output**, over the 143 bytes before the signature, salted with `ref` (version
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
  ~256 bytes of proof on a 207-byte entry, a tab without a wide multiply against native squaring, and group
  arithmetic with no small vetted crate. Its one gain is a fixed time where hashcash is a draw (the mean under a
  minute, some several): the *Preparing* state's words allow for that.
- **An entry is valid** when its signature and proof of work hold, the header that travels with it for `ref` is
  `ref`'s block and proves itself ("Bitcoin as the clock"), and it has an anchor whose block's time `t` is within
  `ref`'s block's time minus 2 hours (block times aren't ordered to the minute) and plus `REF_WINDOW`.

**Anchor**: OpenTimestamps operations from the entry's id to a block's Merkle root, that block's header and the 6
headers after it (a *run*, "Bitcoin as the clock"; on the wire, indices into the item's headers, which an item holds
once each: 13 bytes an anchor, 480 a distinct block). It is
one path in the format's own serialization (the operations, then the Bitcoin attestation with the block's height,
which nothing trusts: the header gives the time): the calendar's receipt (id to its commitment) and its finished proof
(commitment to the root) joined. The verifier handles the three operations the calendars emit (append, prepend,
SHA-256) and the Bitcoin attestation; anything else, a fork in the path, or a message past the format's 4 KiB is an
invalid anchor; 4 KiB at most. **One anchor an entry is kept**, the one with the earliest time (equal: the lower block
hash, then the lower bytes, then the lower six after it); a node offered an earlier one for an entry it holds takes it, so an entry's time only
ever moves back, and every node that has seen the same anchors has the same time. A *pending* anchor (which of the
compiled calendars, by index, and the operations to its commitment: never a URL) proves nothing and is carried only on
a chain's last entry, one at most (of two, the lower), so that a server can fetch the finished one; it carries the
entry's owner key's BIP-340 signature over the tagged hash (`waarm64/names/pending`) of the room's value, the entry's
id and the pending's calendar and operations, and a server keeps only a signed one (else anyone's lower pending would
replace the owner's, and servers would ask a calendar for a commitment that doesn't exist: review 1); it is dropped when
the entry is anchored, when an anchored entry follows it, and once its entry could no longer be valid: now past `ref`'s
time plus `REF_WINDOW` plus 4 hours (a block's time can trail the moment it is mined, and a calendar serves the proof
six blocks later), when the entry, still unanchored, is dropped too.

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
| `drift` | 2 hours | how far a block's time may run ahead: a header's time may be this far past now, an anchor this far before `ref`, and a chain covers from this far before its first entry's time |
| pending slack | 4 hours | a pending anchor goes once now is past `ref` + `REF_WINDOW` + this ("Records") |
| `REF_WINDOW` | 48 hours | from `ref`'s block to the anchor's block, which must exceed the calendars' slowest, not their usual. N0 (bench/net/REPORT.md, NAMES loop 0): `ref` is ~1 hour old when an entry is made (p99 2.3), the slowest calendar alone (`finney`, when `alice` and `bob`, one operator, are both down) reached its block within 27 hours at worst in a year's samples, under the slow reading of the model (~16 under the fast one, which the batch's first proofs fit), and block times may run 2 hours ahead: 48 covers that with half again to spare for the days the samples missed. Provisional until N0b checks the model against the batch of real stamps. Not sensitive: all it costs is how far ahead proof of work can be made, and two days is the same against `TERM`; an entry that misses it is made again ("The names agent") |
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
  being mined (the batch of real stamps says which: N0b). No day of the year had fees that would have stalled the
  calendars for long (blocks' 10th-percentile fee rate at most 5 sat/vB). **About 2 hours** is what the dialog can
  say; `REF_WINDOW` covers the worst.
- **Headers prove themselves, and an anchor's block comes with the six after it.** A verifier needs the 80-byte header
  of `ref`'s block, and of an anchor's block **and the next 6** (a *run*); all travel with the entry. It checks the
  `ref` header's hash against `ref`, the anchor against its block's Merkle root, and of every header its proof of work
  against its own target, that target against **the floor at the header's own time** (below), and that its time isn't
  past now by more than 2 hours; of the run, that there are exactly six after the block, each naming the one before
  by its prev-hash, each timed from the block's time less 2 hours (Bitcoin orders block times only by the median of
  the eleven before) to the block's time plus 12 hours (`run_span`: six blocks have taken that long only in 2009 and
  2010; it keeps a forger from timing the six where the floor is lowest). Nothing else: no height, no explorer.
  Times, unlike heights, are in the header, so a header can't be passed off as an earlier block's. **Why six more**
  (review 1's finding 6, the user's decision 2026-11-17): a header proves its own work and nothing else, so a lone
  header mined in private at the floor, timed weeks back, with a Merkle root of the forger's, would anchor claims on
  any number of names in every room at that time (renewed with real stamps, they beat every chain claimed since, for
  good). Seven linked headers at about half of the difficulty cost about 3.5 blocks' work; still reusable
  ("What an attacker can do"; docs/backlog.md).
- **The floor by header time** (`Params::floor`, header.rs `floor`): a compiled schedule of points, each a time and
  the easiest target a header of that time may claim. The floor at a time is the latest point at or before it, its
  target doubled every 21 days past the point, five times at most; a time before the first point takes the first
  point's (no honest anchor is older than the release, so an old time buys a forger nothing). **The schedule now**: one
  point, block 976,177 (2026-11-16 19:25:21 UTC, compact `0x17021673`) at half of its difficulty (twice its target,
  compact `0x17042ce6`); so 1/2 of that difficulty for 21 days past it, then 1/4, … down to 1/64 from 105 days on.
  Why so, from the facts:
  - *Half*, not the whole: a real fall in difficulty mustn't fail honest headers. The largest fall in years, mid-2021,
    was about 45% over two retargets; half covers it from a point's time with room.
  - *Halving every 21 days past a point*: Bitcoin's retarget moves difficulty at most 4x per 2,016 blocks, and a fall
    by a factor `f` means those blocks took `f` times two weeks, so difficulty can fall at most about e-fold every 5.4
    weeks however hashrate goes (the product of the falls, for a given total time, is largest at e each). From a point at
    half, a floor that halves every 3 weeks stays under that bound at every time: future times keep working with no
    release, whatever the hashrate does, while the floor holds the full half for the first three weeks.
  - *Five times at most*: past 105 days the floor stays at 1/64 of the point's difficulty, so a release left unrenewed
    is never cheaper to forge than the lone header at 1/16 was (seven headers at 1/64 are 0.11 blocks). Difficulty
    falling 64-fold would take at least ~22 weeks of hashrate leaving at the worst rate and never happened; if it did,
    new entries would be refused until a release lowered the schedule, which is always safe.
  - *Growth doesn't cheapen the floor* only as far as releases add points: between them the floor is the last
    point's, decaying, while difficulty usually rises.
  - **Adding a point** (a later release): its time is past, its target twice that of the lowest difficulty since that
    time (so every real header since meets it), and taken while blocks aren't running slow (a retarget due to fall
    already would fall within the step's first weeks). Points are only appended, and a point changes the floor only
    from its own time on, so the headers old entries carry keep the floor they met (header.rs's test). Lowering the
    schedule never invalidates anything.
- **Who talks to an explorer**: only the agent, when it makes an entry, for a block hash to put in `ref` (one 6 deep,
  taken when two explorers, blockstream.info and mempool.space, agree) and for the headers of its own anchors: the
  block's and the six after it (Esplora's `block/<hash>/status` names the next block, `block/<hash>/header` gives a
  header; a calendar serves a proof at six confirmations, the block and five after it, so the sixth may take one block
  more). The tests' pretend explorer (tests/net/ots-calendar.ts) answers both.
- **Who talks to a calendar**: the agent, to stamp and to collect. Servers finishing a pending renewal they hold (each
  asking only with a chance set by a hash of the entry and its own key, backing off) is **not built, and waits for the
  user** (N4d): a calendar's finished proof reaches only the block's Merkle root and names a height, and since N4b an
  anchor counts only with its block's header and the six after it, which a calendar doesn't serve and only an explorer
  does; only the agent asks an explorer, for its own anchors (above; decision 4: servers use calendars alone, members
  nothing). A server holding a finished proof could complete it only from a run some item in the room already carries
  (another entry anchored in the same block), which a quiet room lacks; members may ask nobody; so every way that
  makes one short visit enough has some page other than the owner's ask an explorer for another's anchor.
  docs/backlog.md has the options. Until then a renewal's anchor reaches the room when its owner's agent collects it at
  a later visit (renewal at half a term leaves two weeks for it).
- A block that was orphaned still passes (its work was real) and its time is as good; a stale tip in `ref` would
  cost a re-mine, hence 6 deep.
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
servers out: review 1); a server it calls back is one it answers. So a
server never learns which node asked (not its key, so not its address or name; not its IP address, which only DERP
sees), and the question below can be sealed with the room's key without listing anyone. The node's own key carries
none of it: the guest's UDP on port 2 between members is the guest's, untouched. A server's names client starts when
the node runs (and again a minute after it fails) and runs while the room does; a member's (`names/member.rs`, room.rs
`MemberHost`) starts at the guest's first query for a name that isn't a key (its question waits until its home region
is up, so the servers' call backs reach it) and closes after 10 minutes without one (a minute's wait after it fails;
the next query then starts it again). Registry messages are UDP between two
names clients' room addresses, port 2 both ends (`NAMES_PORT`), binary, 1,200 bytes a datagram at most (`wire.rs`):
a message goes in numbered parts (kind, transfer, part, parts: 9 bytes, then up to 1,191 of the message), each
acknowledged, resent after 0.5, 1 and 2 s and given up 2 s after that (the transfer fails), at most 8 of a peer's
unacknowledged at once (a derper queues 32 packets a client and drops the oldest: bench/net/REPORT.md); a message is
1 MiB at most, and a peer may have 16 incomplete, 2 MiB, held at once (every new part counts; an incomplete transfer
is dropped 10 s after its last new part); at most 8 MiB is queued to a peer unacknowledged, past which a send fails
(a peer that asks much and acknowledges nothing can't make us hold all we would answer). A message is a type, the
transfer it answers (0: none) and a body.

### Finding a server

"Who serves the registry?" is an ephemeral event like a lookup (the same kind, MAC and seal with the room's lookup
key: `lookup::seal_bare`) under a tag of the room's own, `BLAKE2s(tag salt, "names", hour)` (`Room::names_tag`), its
body a lookup's (the names client's key, its region, the time, a nonce) and one byte more, `spread`: 123 bytes.
Servers subscribe to that tag (their names client does), and drop a question as they drop a lookup (the MAC first,
copies through other relays, the relay's budget, an hour off the clock, our own key, a region outside the link), its
copies by nonce **and round** (the three rounds share a nonce).

- **Who answers.** A server answers when its answer's **rank** falls in the share: the top 64 bits of `BLAKE2s(nonce,
  owner key)`, doubled once for each **tier** its name's chain is short of the top (a tier is a half term of the
  chain's age, from the first entry of the run its `serve` shows, six at most: 90 days), must have their top `spread`
  bits zero; for the owner key of one of its live names (it serves the one with the lowest rank), it has synced, and its budget
  allows (4 a second, **apart from** the node's call backs and trials: a budget of the names client's own, in a client
  of its own, so a flood of questions can't keep a server's own lookups out). The hash is over the owner key, not the
  names client's: an owner key costs a registration, a names client's key nothing, so keys made after the nonce is
  seen can't buy a place (review 1). It holds 32 askers at once: one is let go after 60 s without a request (junk, or
  a part of a message, doesn't count), or 10 minutes after it came whatever it sends, and with every place taken a
  newcomer takes the place of the one held longest (but never a sync partner's). The asker sends `spread` 6 (1/64),
  then 3 (1/8) after 0.4 s, then 0 (everyone) after 1 s, and stops at the first round that brings an answer. Measured
  (`server_tests.rs`, 200 questions each, each server its own name held for the top tier): one server answers in the third round (176 of
  200; 2 in the first, 22 in the second); twenty in the second (137; 44 in the first, by 1.1 servers, 19 in the
  third); 500 in the first, every time, by 7.6 servers on average. (A forged question can still ask everyone at once: each server spends one
  handshake from that separate budget. rooms.md "Spam".)
- **Crossed answers.** A server that is asking itself and answers a lower key waits 0.5 s before calling it back: two
  servers asking at once would each start a handshake to the other, and crossed handshakes both fail (rooms.md
  "Finding a peer"); by then the lower key's call back carries both ways.
- **The answer** is a call back to the asker's region (none when a session with it is up), then a `serve` message:
  the tail of the owning chain of a live name of the server's, its last entry and the run before it back to the first
  entry 90 days old (the top tier's age) or the claim, 8 entries at most (`SERVE_RUN`: a name renewed at half a term
  needs 7), each with its anchor and headers, and a BIP-340 signature by that name's owner key over the tagged hash
  (`waarm64/names/serve`) of the room's value, the asker's nonce and the server's names key. The asker checks every
  entry whole (signature, proof of work, headers, anchor), that they make one unbroken run with nothing off it and
  that it covers now, and takes the tier from the run's first entry (`check_serve`; a second `serve` of a name that
  answered already is refused before it is checked). So only a node that holds a live name's secret can serve, which
  costs a registration, and only one that has held it for months ranks at the top, which costs time.
- **The choice.** An answer counts when its owner key's hash falls in the share of a round already sent (an honest
  server answers only so), and once a name: a second `serve` with an owner key or a name id that answered already is
  refused, so one registration answering from many names-client keys is one answer. The asker waits 0.3 s from the
  first answer, then keeps two: **the older tier first, then the lower `BLAKE2s(nonce, owner key)`** (`choice`): not
  the two fastest, which an attacker could always be, nor the lowest names-client keys, which it could grind for; the
  others are let go. **Why the tier** (review 2's finding 2): a claim on a junk id costs a minute of proof of work and
  a share of one stamp, so with the hash alone 128 junk registrations, an hour of a core a term, were both servers of
  ~93% of questions against five honest ones; ranked by age, a registration made yesterday wins a place only against
  servers as young as it is, and rounds sample it 1/64 as often, so a Sybil needs registrations held for three months
  and renewed all along (`member_tests.rs`: 128 two-day-old claims against five 120-day-old servers, both servers the
  attacker's in at most 1 of 40 questions, 22 of 30 before). In a room younger than that, servers rank by age among
  themselves: rounds sample young ones as rarely, so more questions reach the last round (everyone). The accept window
  does the same: once full of keys that served, a newcomer takes the place of the last by that order, never of the best
  two, so junk answering first can't fill it. Both of a member's servers are an attacker's only when its registrations
  are as old as the honest servers' and rank below them. A
  member that has only one answer by then asks everyone at once (the last round, and 0.3 s again), so it holds two where the
  room has two: a lone server could leave a name out or show a younger chain unseen (N3: in a room of two servers, a
  quarter of questions stopped at one). A member holds its servers while it asks and for 3 minutes after the last
  `get`; one that fails (a transfer given up, its session gone) is let go, and with none left the next lookup asks
  again, so a new question draws both afresh (the first draft replaced one of the two at each round; a fresh nonce
  already redraws them, and a member that asks rarely asks anew anyway). A server holds them for its sync round (below),
  and asks afresh each round.
- **Nobody answered** within 1.5 s of the third round (2.5 s from the first): the queries that waited get NXDOMAIN
  then (measured through the fake DERP and relay: 2.5 s), and the fact is remembered, for 30 s the first time and twice as long each time after, to 10 minutes; during
  it, names that aren't keys get NXDOMAIN at once and no question goes out. The next query after it asks again, so a
  member finds a server that appeared, or the room's first name, with no reconnection: within 30 s when its guest
  rarely met the silence, within 10 minutes at worst. An answer resets the doubling. A room with no names costs a
  member one question (three events) every 10 minutes at most, and only while its guest asks for such names. Names
  the member already holds answer throughout: they don't need a server. A server nobody answered is alone: it counts
  as synced (there is nothing to sync with) and asks again after the same wait (5 minutes at most), with a fifth of it
  at random on top, so servers that started together don't ask together again.
- Questions have a rate of their own (1 a second), not the guest's lookups'.

### A member resolving a name

(`names/member.rs`, `member_tests.rs`; through the resolver, room/tests/names.rs.)

- `get` (owner mode: the name id, and the last entry and zone the member keeps, if any) goes to both servers; each
  answers with what the member lacks of the owning chain's last entry (its anchor and headers) and the zone, or "none"
  (an empty answer: the server has no chain that owns the name now).
- **The member checks the last entry only** (signature, proof of work, its headers, its anchor, alive by its clock),
  with the last entry it keeps, if the server's continues it, and checks the zone's signature; the chain the server
  says owns the name is the one ending at that entry. One alive chain is the owner whatever its history, since nothing
  contests it; a server can leave a better chain out, which is why there are two, chosen as above. An answer that
  doesn't hold up (a forged entry, anchor, header or zone, a dead chain) counts as none from that server.
- **The servers disagree** (their chains end at different entries) or **an answer contests what the member keeps**
  (`Kept::offer` would refuse it): the member asks each for `history` (a `get` mode: the owning chain's whole unbroken
  run and the zone), checks every entry, each once however often the answer repeats it, a slice a turn as a server
  does (a history may carry 1,024 entries: ~0.7 s of the room's worker in one turn otherwise; review 1); the first
  that fails refuses that server's run, so a junk history costs one check; and picks by "Who owns a name" over every
  entry shown, which `Kept::offer` then takes or refuses. Last entries
  alone can't be compared (a renewal's time isn't its chain's seniority): an impostor claimed ten days ago beats the
  owner's renewal of four days ago until the owner's run shows its claim of twenty (`member_tests.rs`).
- **What a member keeps**: each name it resolved, with its chain's last entry, the earliest entry time it ever verified
  for that chain, the zone and when servers last confirmed it, persisted (a record a name, version 2: under 2 KB with a
  wide zone; 1,024 names at most, the least asked for going first). While that chain covers now, another chain replaces
  it only by showing a run that starts earlier. So a member that knew a name refuses an impersonator after a reset, with
  no rule of its own. (`chain.rs`, `Kept`: a run that holds the kept last entry continues it, the earliest time staying
  the lower; a copy of the kept chain cut short is nothing new; another branch of the same owner key starting no later
  replaces it, as a fork of one title is settled by the order; a run that holds neither, such as a renewal shown alone,
  is refused while the kept chain covers, and the member asks for `history`.) The same chain shown again (its last entry
  the one kept) takes the newer zone, if any.
- **A kept answer answers at once**, for as long as its chain resolves; one confirmed more than 5 minutes ago is also
  asked again in the background, and the next query gets what came back. So only a name this member never resolved
  waits on a server; the price is that a zone change or a lost name shows one query late (measured on the bus: the
  query at 5 minutes gets the old zone, the next the new). In its grace a kept name is NXDOMAIN while it was confirmed
  in the last 5 minutes, and waits for a renewal the servers may hold after that. Both servers saying none doesn't
  drop a kept chain that still covers (a server that lost it says nothing against it).
- Both say none: NXDOMAIN, kept 60 s. One says none: the other's answer stands (but still goes through `Kept::offer`:
  one server's chain against a contesting kept one is asked for `history` and refused, `member_tests.rs`). Neither
  answers (both transfers given up): asked once more, with servers found again if need be; the query meanwhile gets
  the resolver's SERVFAIL.
- **The dialog's check** for a name being typed must not tell a server which id someone is about to claim (it could
  guess the name and stamp too): it asks for `ids` (a `get` mode with the id's first byte only), every id in the 1/256 of
  the registry that shares it, each with when its owner's hold ends (0: nobody's now), and looks for its own there
  (`Member::ids`, `ids_done`; not counted as the name being asked for). The page asks through a publisher
  (`ts_room_names_ids`): "What the user sees".

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
  listed ones from a work list 4 at a time. A peer's `sync`s may make the server fingerprint 16 times its registry a
  sync round; a `have` names 32 ids at most, and what `have`s make it ask a peer waits 64 at once. Both settle a range before they
  summarize it, so time has done the same to both. A changed name (a `put`, a sync) is told in `have` to the servers
  of this round and those that synced with this one in the last 10 minutes, but the one it came from. A server
  answers "who serves?" only once its first sync round is over and what it brought is verified (not what was `put`
  meanwhile: below), or nobody answered it. Measured through the fake DERP and relay (room/tests/names.rs): two servers converge in 40 s from their start
  (the first question finds nobody, both then serve, the next finds the other); twenty servers holding 40 names in 6
  minutes (8,900 DERP packets in all, a 51 KB registry each); after a reset, three owners' names are back everywhere
  in 40 s. (The tests' entries carry one 4-operation pretend anchor each, so bytes are small against real anchors'.)
- **`get`** has three more modes, a member's: `owner` (the owning chain's last entry and the zone, those the member
  lacks; nothing when no chain owns the name now) and `history` (the owning chain's whole run and the zone), each
  counting as the name being asked for; and `ids` (every id held under one first byte, answered `ids`; not counted). A server that leaves names out (or lies) is outvoted in sync by
  any other server holding them, and a member asking it for one gets nothing from it and the name from its other
  server (N3: the answer that has one stands).
- **Take from anyone**: `put` (an item, from an owner's agent or a member that holds a better chain than the server
  showed it), checked like anything else and settled; answered `taken` when the owning chain's last entry is the
  put's, else `better` with the server's item (empty when it holds nothing of the name). Puts wait in a queue of their
  own (4 a peer, 64 in all; past that refused), verified after what sync brought, a slice of one put at a time in
  turn.
- **Verify** signatures, proof of work and anchors before keeping or serving, a slice each turn of the module (an
  entry 4 units, an anchor or a zone 1, 24 units a turn: ~6 entries, ~4 ms in Chromium's wasm; while any wait, the
  module asks to be ticked again at once), an entry already held only for an anchor that differs; what was verified
  is stored as verified and not checked again at load. An entry that fails a check only a forgery fails (anything but
  a `ref` header from the future, which a clock behind can make) ends its item's check, nothing of the item is kept,
  and its id is remembered (4,096 lately) when what failed is the entry's own bytes (signature, proof of work, form,
  room), so 1,024 copies of a junk entry cost one check, not 1,024 Argon2ids (review 1). In Chromium's wasm (N0, cloud): an entry is ~0.66 ms whole
  (Argon2id 0.49, BIP-340 0.15, its anchor's 46 SHA-256s 0.015, a header 0.0005), so a 5,000-name registry's 60,000
  take ~40 s of one core.
- **Bound**: `MAX_NAMES` 20,000 and 128 MiB of items. Past either, a server drops names, never its own, the ones
  nobody has asked it for longest first (asked: a member's `get`, or the name's arrival; sync doesn't count), deletes
  them from its store and doesn't fetch them by sync for a day unless a member asks. A dropped name isn't lost (its
  owner holds the title and puts it back), and junk registered in bulk is what nobody asks for (unless its registrant
  asks: askers can't be told apart, so an attacker can keep its junk asked for and have honest names that are rarely
  asked dropped first. Not handled: N6 measures it). Proof of work alone can't bound the registry: a GPU makes
  100,000 claims for the price of a few hours (*estimate*), and one stamp covers them all.
- **Persist** per name, binary, one record each (a version byte, when it was last asked for, the item): the module
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

### Size, and where it stops

*Estimates*; N0 replaces them. An entry is 207 bytes; its anchor 300 to 1,250 (the one measured was ~1,240 whole; entries a calendar put in one block share
the anchor's tail and its header; how much is N0's to measure); its headers 80 for `ref` and 560 for the anchor's
block and the six after it (N4b: 480 of those and 13 bytes of indices came with the six). Two entries a month: a name
costs a server about 0.4 KB for its zone plus 2.3 to 4.2 KB a month it has been held (1 to 3 before the six).

| Names, held six months on average | A server keeps | A new server's first sync through DERP (0.6 to 3 Mbit/s measured on public relays) |
|---|---|---|
| 1,000 | 14 to 26 MB | under a minute to 6 minutes |
| 5,000 | 70 to 130 MB | 3 to 30 minutes |
| 20,000 | 290 to 510 MB | too much for a tab |

A member keeps a few KB. So what grows with a room is each **server's** copy, and every new owner pays the first sync,
in the background, before it serves. Past a few thousand long-held names it needs one of: servers that hold a share of
the id space each; owners syncing with each other directly (WebRTC, which shows an owner's IP address to other
owners, so the user's call); fewer renewals a term. None is in v1; the first is the one to build.

## The resolver

`resolve()` (room.rs) gains, after the key-name case, for a name under `<tag>.p2p.internal` (the name, or one label under
it) that passes "Names"' rules:

- on a server's node, from the registry it holds whole (`Server::resolve`); a name of this node's own that isn't public
  yet (or lapsed) answers from its title's zone, or this node's address for the name itself (a server can be tried by
  name before its registration is public); a name not held waits while the first sync isn't over, else NXDOMAIN;
- on a member's, a name it keeps, its chain alive: AAAA from the slot the name asked opens (none opens: NXDOMAIN), TTL
  60; the module learns the key (and asks again in the background when what it keeps is older than 5 minutes);
- otherwise the query waits while the names client asks: answered when the answer comes; SERVFAIL after 4 s
  (`DNS_WAIT`; 64 queries wait at most, past that SERVFAIL at once; a first query that must also find servers took 1.3 s
  through the fake DERP and relay and 1.4 s on the page test's rig (tests/page-room.test.ts, a cloud session); a guest's resolver retries);
- NXDOMAIN at once for a reserved or ill-formed name, a name both servers don't have (for 60 s), and any name not kept
  while the member remembers that nobody answered "who serves?" ("Finding a server": 30 s to 10 minutes).

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
export takes them as its own (`importNames`). The module does the work (`ts_names_*`, pure: JSON in and out; make, mine
in slices of 256 tries, sign and check an entry; a calendar's receipt made a pending anchor the owner key signs; the
commitment to ask for and a finished proof's anchors; an anchor taken with its seven headers; a zone; a title's status;
a server's better item judged), in a worker of its own for proof of work (production: 3 to 64 s an entry in Chromium,
a mean of ~39 s over five, cloud x86_64); no JavaScript crypto. It needs no running machine:

- **On every page load** (web/app/main.ts starts it when any title is kept; none, no worker), and hourly while open
  (sooner when a backoff ends), for each title, under **one Web Lock a title** (`waarm64-names:<identityKey>:<room
  hash>:<name>`, taken if free: another tab doing it is left to it): collect finished anchors (each calendar's pending
  proof at its compiled URL; the 404 without CORS of a pending one is a failed fetch: asked again with a backoff, 5
  minutes doubling to an hour; one past its window is asked at once whatever the backoff), with the block's header and
  the six after it from an explorer (`block-height`, `block/<hash>/header`, `status`'s `next_best`; not yet six: later);
  renew when the owning chain's last entry is `TERM / 2` old and no renewal waits for its anchor (`ref` from the two
  explorers' block 6 deep, which must agree, its header checked against the agreed hash; proof of work; the signature;
  stamped at the three calendars, each receipt a pending anchor the owner key signs, the lowest on the entry, all three
  kept to collect from); make the claim of a title that has none. **An entry whose anchor came past `REF_WINDOW`** (the
  module refuses it: `AnchorWindow`), or that is still unanchored once its window and the slack are over, is dropped
  and made again (a new `ref`, proof of work, stamps), with the same backoff; an entry no calendar stamped likewise.
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
  renewal is made from the room's branch), or **another key's chain: the title is lost**, renewal stops and the page
  says so (`TitleView.state` `lost`, `lostTo`).
- **When the connection's room runs**, the node is a server: the room's worker gives the module the connection's titles
  in its config (`room.names.titles`, each the owner key derived from the secret and the item) and again as they change
  (the agent's BroadcastChannel `waarm64-names`; `ts_room_names_titles`: a member given titles becomes a server).
- **A zone's `seq`** (64 bits) is `n << 32 | branch`: `n` counts up past every `seq` the title has seen, `branch` is
  this copy's, 32 random bits drawn when the title is registered and again by **every copy taken in** from an export
  (`importNames`; the export itself writes nothing), so the same text pasted into two browsers gives two branches. Two
  copies share a branch with a chance of 2^-32 a pair, and only then could they make two zones with one `seq` (which
  would reuse a seal's key: "Names nobody lists"). Why 32 bits (N4d): with N4c's one byte, a branch drawn at each paste
  would collide one pair in 256; one given out by the exporter can't tell two pastes of one export apart. The zone's
  version byte is 2, items' 3 and an export's names' `v` 2 since (pre-release: older ones are refused).
- **The services are compiled in** (web/names.ts `CALENDARS`, the module's order and URLs, and `EXPLORERS`,
  blockstream.info's and mempool.space's Esplora APIs): the agent fetches nothing else (its `get` refuses another URL),
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

**Naming a machine.** In the Network menu of a connected room adapter, **[Name this machine…](ui:network:NetNames.name)** opens one dialog:

1. A field. Under it, as typed (300 ms after the last key): not a valid name (the rules, by the module), this
   connection's already, free, taken until about a date, or, where no server answers, that nobody in the room can say
   (Register stays offered: first come still holds, and the claim is private until anchored). **The check doesn't tell
   a server which id is about to be claimed**: the agent hashes the name and asks the room's servers for every id
   under its first byte (`ids`), through a checker, a publisher kept open for a minute after the dialog's last check so
   the servers it found answer the next at once (`ts_room_names_ids`, `names-ids` events); since N5 a server's `ids`
   answer carries each id's cover end (when the owning chain's hold ends, 0 when nobody owns it now), so "taken until"
   needs no `get` naming the id. Nothing lists a room's names, here or anywhere: the registry couldn't.
2. Two notices, always shown, no boxes: [Members of this room who know the name can find this machine and see when it's online, and your machine helps other members look names up.](ui:network:NameDialog.notice.find); [Open this web app at least every 2 weeks to keep the name.](ui:network:NameDialog.notice.visit) ("this web app" is the page's word for itself, docs/copy.md).
3. **[Register](ui:network:NameDialog.register).** The dialog closes; the adapter shows the name with its state:
   [Preparing](ui:network:names-view.preparing) (proof of work), *Reserved, public in about N hours; it already works on
   this machine*, then *Active, kept until about <date> unless you visit*; in its grace, lapsed, let go and lost as the
   agent reports them.

No key is shown or asked for. Changing where a name points (a member's name in the room, or a key, pasted), adding a
label under it and letting it go are in the adapter's details. The Machines page shows a stored machine's names (its
Network tab, each room adapter's) with the date each stops resolving unless renewed, and the page says, on load, after
the agent's first pass, when one is inside its last week (kept until less than 7 days on). All words are in
`web/messages/en/network.json` (the Machines page's line in `machines.json`).

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
| Race a new registration | none | nothing: a claim is public only once anchored, and the dialog's check doesn't name the id |
| Tie a claim it somehow knew of | several claims in the same block | wins most ties: the tie-break can be ground. It needs the name before the claim is public |
| Hash a dictionary against a server's ids | one registration, then cheap | learns which guessable names exist and where they point; nothing about the others |
| Serve, and leave names out or serve an old zone | one registration | a member it serves misses a name or a change until its other server, chosen by its chain's age and its owner key's hash, says otherwise; both servers the attacker's (registrations as old as the honest servers', renewed all along, ranking below them for that question; junk registrations made lately rank after every older server): the member sees what it shows (it can't forge) |
| Hold a name after a reset | one registration | impersonates it to members that never resolved it, until a server that holds the owner's chain is asked |
| Forge a Bitcoin header | seven linked headers at the floor of their time: about 3.5 blocks' work at the schedule's half (0.11 of a block at its 1/64, a release unrenewed for 15 weeks), once | the forger's run, timed (say) 36 days back with a Merkle root of its own, anchors claims on any number of names in every room at that time; renewed with real stamps, they beat every chain claimed since, and the run serves again for any number of claims: **accepted for now** (the user, 2026-11-17: review 1's finding 6). Ideas for servers to check later, which would make servers ask an outside service and need the user's OK: docs/backlog.md |
| Calendars all down | | no new claims or renewals; existing names resolve; `GRACE` is the margin |
| Explorers all down | | the same: only the agent uses them |
| Flood "who serves?" | lookups' limits | servers' answers come from a budget of their own; a forged asker key gets one handshake from each server asked, and an asker's place, which the next newcomer takes when all 32 are held |
| Fill an asker's accept window | a handshake (a DERP connection) per place, a registration per place that serves | a place held a second without a `serve` goes to the next newcomer; with every place served, the place of the last by age and hash (never the best two's) |
| Make a server work (`put`, `sync`, `have`) | a session (any asker's) for `put`, one registration for the rest | `put`s 4 at a time, a junk one costing one check; `sync` 16 registries' fingerprints a round; `have` 64 gets at once |
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

Done in the cloud session of 2026-11-16 (N0a, bench/net/REPORT.md "NAMES loop 0"): items 1 to 3, and item 4's
batch of stamps (collected by N0b). What it found is in "How long an anchor takes", "Records" and the parameters'
table; times are a shared x86_64 host's, good for the choices, re-timed in the dev VM. The year of transactions in
item 1 couldn't be read whole within a few hundred requests (a calendar's transactions are one request each:
"How long an anchor takes"), so it is a complete record of the calendars' last days and samples through the year.

1. **Time to anchor** from each calendar, the slowest as well as the usual: sets `REF_WINDOW` and what the dialog
   promises. From a year of each calendar's transactions on Bitcoin, read through the two explorers ("How long an
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
   the size table.
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
  answers, persistence, the tests' pretend calendar and explorer (tests/net/ots-calendar.ts), and titles for tests
  (net/ts/examples/names-title.rs, on the module built with the `test-params` feature: below). tests/page-room.test.ts:
  two Debian guests, one name, by full name and by the short one, a label under it, a zone change, the reserved names,
  a room with no server, one whose first server appears while a guest keeps asking.
- **N4** The agent: secrets, titles, the worker, stamping, collecting, renewing, publishing without a machine, forks
  between two browsers, a lost name, export and import.
- **N5** The page: the dialog, the adapter's states, the details, the Machines page's dates, the catalog.
- **N6** Scale and abuse: 1,000 members, 20 servers and 5,000 names (a server's load, a cold lookup, a join storm of
  500, junk in bulk against the bound, also when its registrant asks for it); days on the public services with real stamps; the final review.

## Tests' parameters

Production's parameters need real Bitcoin work (seven linked headers at half of a real block's difficulty), so a test can't
make a title they accept. The parameters are not configuration: the module runs on `Params::BUILT`, which is
`Params::PRODUCTION` unless the crate is built with the `test-params` feature, which compiles in `Params::TEST` (the
tests' pretend Bitcoin: regtest's floor, Argon2id of 8 KiB and 2 bits) instead. `net/ts/build.sh --test-params` builds
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
