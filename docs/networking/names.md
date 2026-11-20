# Registered names in a room

Human-chosen names in a room (`test123` beside `<key>.<tag>.p2p.internal`), the page calls them **domains**:
registered first come by a key, for a term, renewed by the page, with no server of ours, no room administrator and
nothing stored on a relay. **A name's owner is whoever holds the oldest unbroken chain of timestamped claims on it.** A
claim is a signed record stamped through OpenTimestamps, so that a Bitcoin block proves it existed by that block's time;
a name is held for a term (30 days) and kept by renewing, each renewal stamped the same way. Every claim proves its own
place in line, so **the owner's copy is the title**. The room's registry is a cache of such chains: **name owners hold
all of it and serve it; everyone else asks the room for the one name it wants** and checks the answers itself. A room
that loses the registry (everyone left) gets it back as owners return. Bitcoin is used only as a clock: no coin, fee or
wallet. It extends [rooms.md](rooms.md), whose terms (room, link, tag, lookup, call back, the module) it uses; why it
is built this way, and what lost, is "Why it is this way" at the end.

**The files.** `net/ts/src/room/names/`: `id.rs` (the rules, the reserved list, name ids, owner keys), `entry.rs`
(entries, proof of work), `anchor.rs` (the OpenTimestamps verifier, pending anchors), `header.rs` (headers and the
floor), `zone.rs`, `chain.rs` (who owns a name; `Name`, `Kept`), `wire.rs` (messages, items, transfers), `store.rs`
(what a server holds), `server.rs`, `member.rs`, `outside.rs` (what servers ask of calendars and explorers),
`agent.rs` (the page's `ts_names_*` operations), `testkit.rs`; `room.rs` hosts them (`NamesHost`, `MemberHost`, the
publisher, the resolver's cases). The page: `web/names.ts` (the names agent), `web/names-worker.ts`, `web/names-ops.ts`,
`web/room.ts` and `web/room-worker.ts` (the records' store, the titles to a running room), and in `web/app/`
`NameDialog.svelte`, `NetNames.svelte`, `NameEntry.svelte`, `areas/names.svelte.ts`, `names-view.ts`,
`room-export.ts`. The module's side of the interface is [tailnet.md](tailnet.md) "The module"; the page's is
[frontend.md](../frontend.md) "Network". Measurements: bench/net/REPORT.md "NAMES loop 0" to "NAMES loop 6b".

## Decisions

The user's, 2026-11-15 to 2026-11-18; they bind.

- **First come by the oldest unbroken chain alive now.** A claim stamped earlier and held back can take a name; a room
  that empties loses its registry and owners' nodes put it back. Both accepted: no witnesses, no pinning of names a
  node has seen, no stored relay state. Also accepted: a provisional name (an older chain can surface), a stranger
  holding a name between a room's reset and its owner's return.
- **Room-wide names, a registrar's surface**: register, renew, point, let go. No petnames or address books.
- **Nothing about a name stays on a Nostr relay.** "Who serves the registry?", a first lookup's `ask` and its
  `reply` are ephemeral events; nothing about a member goes in a room's link.
- **Name owners hold the whole registry and serve it; everyone else asks.** A node's registry traffic runs under a
  key made new each session, relay only: no server learns which node asked, and registry traffic never opens a WebRTC
  connection.
- **What a member reveals**: a lookup of a name it doesn't keep shows the name's id to every server of the room and to a
  relay that knows the room's ID (sealed with the room's key, from a key new each session), and again each time a
  negative answer runs out; registry records pass through relays as ephemeral replies (the user, 2026-11-17, widening
  the 2026-11-15 rule that members reveal nothing new). A publisher never asks for its own name. A relay can tell which
  IP addresses serve or ask for names in one room (and which room, for an ID it can guess): accepted; key lookups keep
  rooms.md's property.
- **Bitcoin is the clock, through OpenTimestamps**, and no drand. Times are block headers' own timestamps. The outside
  services are the three calendars and two explorers compiled in: the page asks them to register, renew and collect;
  **servers** ask the calendars to finish a renewal and the explorers for that renewal's block and once for each
  distinct block their registry is anchored in (the user, 2026-11-17); **members ask none**. Another service is the
  user's call.
- **Names are never in the registry in words**: looked up by a keyed hash, where they point sealed under the name, an
  owner key per name. Which names are acceptable is the resolver's and the dialog's rule.
- **The two hot paths**: reaching someone's name takes no switch, notice or reading; registering one is one dialog with
  two notices (discoverable; visit every 2 weeks) and no key shown. The room's servers are asked when Register is
  pressed, one first byte of the id a press, nothing as typed (the user, 2026-11-17). A step added to either is asked.
- **Short terms**: 30 days, a week's grace, renewed past half the term; the page says "every 2 weeks".
- **The page may reach a room without a guest** to publish names (a names client, no machine, no node key).
- **Reserved names** are compiled in ("Names"); the list may grow by the same reasoning (what a guest asks unprompted
  or trusts by habit).
- **Guest-visible**: the resolver answers registered names. No step count moves.
- **Dependencies**: `argon2` (RustCrypto, MIT/Apache-2.0) for the proof of work. The OpenTimestamps libraries are LGPL:
  the verifier is written from the format, nothing copied (a reference row in `THIRD_PARTY.json`).
- **The module's interface** (tailnet.md "The module", not docs/abi.md's) grew: titles in the config, per-name
  records, `ts_names_*`, the outside fetches. Wire and storage changes that stop older pages serving or syncing names
  are fine while rooms are pre-release; one that stops them meeting in a room is asked.
- **An ephemeral connection with a key of its own can't hold a name** (its title would outlive the key by weeks).
- Not decided: which suffixes names may use beyond the room's own domains ("Names").

## What it doesn't give

- **Certainty that a free-looking name is free.** An older chain can surface (an owner back from three weeks away, or
  an attacker who stamped a dictionary and waited) and take it. The window is only as wide as terms are short: a
  held-back chain must have been renewed, with proof of work, every term.
- **Protection from impersonation of a name nobody present remembers.** Between a room's reset and the owner's return a
  stranger can hold the name. A member that resolved the name before refuses the stranger while the chain it saw is
  alive; a server that holds the owner's chain hands it to everyone.
- **Instant registration.** A claim stays private until its Bitcoin proof exists (about 2 hours), or a watcher could
  stamp a competing claim into the same block. Renewals and zone changes are instant.
- **Names in a room with nobody serving.** Where no owner is online, only key names resolve.
- **A registry of any size**: comfortable to a few thousand names held for months, too much for a tab at 20,000
  ("Size, and where it stops").

## Terms

| | |
|---|---|
| **owner key** | A BIP-340 key (secp256k1, `k256`) that signs a name's entries. One per name, derived from a secret the room connection keeps beside its node key (made at the first registration), so one owner's names can't be told to be one owner's. A node key is X25519 and can't sign. |
| **name id** | What stands for a name everywhere outside its owner's and its users' own pages: 32 bytes, a keyed hash of the name. |
| **entry** | A signed record on a name: `claim`, `renew` or `release`. Its **id** is the SHA-256 of its bytes. |
| **anchor** | An OpenTimestamps proof from an entry's id to the Merkle root of a Bitcoin block, with that block's header. The entry's **time** `t` is the header's timestamp. |
| **chain** | A claim and its renewals, each naming the id of the one before. |
| **title** | A chain with its anchors and zone, as its owner keeps it (with the secret). |
| **zone** | Where a name points: a signed, numbered record, replaced whole. |
| **server** | A node whose page holds the title of a live name: it keeps the whole registry and answers others. |
| **member** | Any other node: it asks the room for the names its guest wants and keeps what it verified. |
| **names client** | The part of a node that talks to the registry: a room client of its own, under a key made new each session, relay only. |
| **publisher** | A names client alone, with no node or guest: how the page puts a title to the room. |

## Names

- **The rule** (`id.rs`): one label, `[a-z0-9]` and inner `-`, 1 to 32 characters, lower case, no `--` in the third and
  fourth places (no punycode: look-alike names are a registrar's oldest problem), and not on the **reserved list**:
  names a guest asks for unprompted or trusts by habit (`wpad`, `isatap`, `localhost`, `localdomain`, `gateway`,
  `router`, `broadcasthost`, Debian's `/etc/hosts` names `ip6-localhost`, `ip6-loopback`, `ip6-localnet`,
  `ip6-mcastprefix`, `ip6-allnodes`, `ip6-allrouters`, `ip6-allhosts`), and labels that are top-level domains or look
  like one: every two-letter label, the original and sponsored generic ones (`com`, `net`, `org`, `edu`, `gov`, `mil`,
  `int`, `arpa`, `info`, `biz`, `name`, `pro`, `aero`, `coop`, `museum`, `mobi`, `asia`, `tel`, `travel`, `jobs`,
  `cat`, `post`, `xxx`), the special-use names (`local`, `localhost`, `test`, `example`, `invalid`, `onion`, `alt`,
  `internal`), the private ones in habitual use (`lan`, `home`, `corp`, `intranet`, `private`), and `p2p` (`RESERVED`).
  Without it, whoever registered `wpad` first would configure every guest's proxy, and whoever held `com` would answer
  `example.com.<tag>.p2p.internal`, which a guest's search list asks for. The ~1,400 newer generic top-level domains
  (`app`, `dev`, …) aren't on it: words people want, and a guest asks `x.dev.<tag>.p2p.internal` only after `x.dev`
  failed.
- **Where a name lives**: `<name>.<tag>.p2p.internal`, under the domain the lease already gives, so a guest whose
  resolver searches the lease's domains reaches it as plain `<name>` (DHCPv6's domain list; the RA has no DNSSL;
  Debian takes it by default and asks nothing of it unprompted). Under the room's name too, when the room's ID is a
  label of its own (rooms.md "The room's name as a domain": lower case, a DNS label, not derived-looking):
  `test123.gabriel-lan.p2p.internal`, the domain the page shows. A key name is 52 characters, so the two never
  collide. A zone may add one label under a name (`git.test123.gabriel-lan.p2p.internal`; `[a-z0-9]` and inner `-`, up
  to 63 characters, no `--` third and fourth). A name's id, its records and the registry hold no suffix: another suffix
  changes the resolver's match and the lease's domains, nothing else.

## Names nobody lists

No record, message or stored registry holds a name in words.

- **The name id** is BLAKE2s in its keyed mode, keyed with a key of the room's (from its ID, a label of its own), over
  the name. Entries and zones carry the id; servers order by it; a resolver hashes what the guest asked.
- **A zone is sealed under its name**: each place it points (the name, a label under it) is a slot, an 8-byte tag and a
  node key sealed with ChaCha20-Poly1305, tag and key derived from the room's key, the name id, the owner key, the full
  name asked and the zone's `seq` (so no key or tag is used twice, and unused slots, random bytes, can't be told from
  used ones across versions; the owner key because every owner of a name, after a lapse or a back-order, starts at a
  small `seq`). The nonce is zero (the key is never reused but by a zone of the same name, owner and `seq`), the
  associated data the zone's head (version, room, name id, owner, `seq`), so a slot can't move to another name or
  version; slots are sorted by their bytes. A zone has 4 or 16 slots, so a holder sees neither how many labels a name
  has nor where any points. The owner's signature is over the sealed bytes: anyone can check a zone without reading it.
- **An owner key per name**, so a registry doesn't show that five ids are one person's.

**What a server still learns:** how many names the room has; each id's owner key and its entries' times; which ids are
asked for, not by whom; and **any name it can guess** (hashing a dictionary against the ids is cheap, and a slow hash
would cost every resolver on each name a guest asks as much as it cost the guesser: a million guesses at 0.1 s are a
day of one machine). So this hides names that aren't guessable and stops anyone listing a room's names, as NSEC3 does
for a DNS zone; it doesn't make `www` a secret. An owner's names renewed in one visit land in one block, and stamps made
within a second or so are near-siblings in a calendar's tree (under ~450 bytes of path apart, where stamps 10 s apart
differ by 290 to 700: N0b), so a server sees which ids were stamped together; an `ids` answer's cover ends are rounded
up to a week so that it doesn't group them. In a private room the key comes from an ID outsiders don't have.

**What moves to the resolver:** the registry can't check a name's spelling, so an id no resolver would ask can be
registered, dead weight its registrant paid for. The rules are enforced where names are still words: the resolver and
the dialog.

## Records

Binary, fixed order, integers little-endian. Every record starts with a version byte and the room's 40 prefix bits; the
hash that is signed also takes a 32-byte value derived from the room's whole ID, so a record of one room means nothing
in another, even one whose prefix was made to collide.

**Entry** (175 bytes, version 2):

| Field | Bytes | |
|---|---|---|
| version, kind | 1, 1 | kind: 0 claim, 1 renew, 2 release |
| room | 5 | the /48's 40 bits |
| name id | 32 | |
| owner | 32 | the owner key |
| prev | 32 | the id of the entry before; zeros in a claim (and only there) |
| nonce | 8 | proof of work |
| signature | 64 | BIP-340 over the tagged hash (`waarm64/names/entry`) of the room's value and the fields above |

- **Proof of work**: **Argon2id, 1 MiB, one pass, one lane, 32-byte output**, over the 111 bytes before the signature,
  salted with the name id, `POW_BITS` 16 leading zero bits (version 0x13; Node's `crypto.argon2Sync` gives the same,
  which the tests pin). Bound to its name, so work for one name serves no other; done ahead of time it saves nothing (a
  term costs the same entries' work whenever it's done), and a renewal names the entry before it, so its work is its
  own. **What it's for**: the price, every term, of a name held without being used (a dictionary stamped and held back,
  a back-order, a squat): stamping is free and one stamp covers any number of claims, so without it a member could
  claim every word there is each term for a minute of signatures. It isn't what keeps junk out of a registry (the
  servers' bound is). A try is 0.38 ms in the dev VM's wasm (M4), so a mean of 25 s in a tab, a draw: half within 17 s,
  90% within 57 s, 99% within 2 minutes. A GPU's lead over a tab is ~110x (RTX 3090) to ~220x (RTX 5090) (from
  published Argon2id-at-1-MiB mining rates; at BLAKE2s ~3,900x): a million names cost an attacker **~63 RTX
  5090-hours a term**, ~9 at BLAKE2s. A server checks 60,000 entries' work in ~23 s of a core in wasm.
- **An entry is valid** when its signature and proof of work hold and it has an anchor whose header proves itself
  ("Bitcoin as the clock"); its time `t` is that block's. Nothing ties an anchor to when the entry was made: an anchor
  collected late times the entry late, which only ever costs its owner.

**Anchor**: OpenTimestamps operations from the entry's id to a block's Merkle root, and that block's header (on the
wire an index into the item's headers, each held once an item: 80 bytes a distinct block). One path in the format's
own serialization (the operations, then the Bitcoin attestation with a height that nothing trusts): the calendar's
receipt joined to its finished proof. The verifier takes the three operations calendars emit (append, prepend,
SHA-256) and the Bitcoin attestation; anything else, a fork in the path, or a message past the format's 4 KiB is
invalid; 4 KiB at most. **One anchor an entry is kept**, the earliest (equal: the lower block hash, then the lower
bytes); a node offered an earlier one takes it, so an entry's time only moves back and every node that saw the same
anchors has the same time. Measured over 240 real anchors (N0b): 905 to 1,256 bytes, median 1,185.

**Pending anchor**: which compiled calendar (by index, never a URL) and the operations to its commitment, signed by the
entry's owner key (tagged `waarm64/names/pending`, over the room's value, the entry's id, the calendar and operations),
so that a server can finish it; it proves nothing. Carried only on a chain's last entry (one at most), kept only
signed, and dropped when the entry is anchored, when an anchored entry follows it, or once the entry can no longer link
(now past the entry before's `t + TERM + GRACE`: chain.rs `Name::stale`), when the unanchored entry goes too. A claim
can always link; a server keeps no unanchored claim.

**Zone** (366 bytes with 4 slots, 1,038 with 16; version 2): version, room, name id, owner, `seq` (8), the slots (56
each), a signature. The highest `seq` wins (equal: the lower hash); no anchor, since only the owner writes it. An
address is computed from the node key a slot opens to, and the resolver's answer teaches the module the key, so lookups
to a named machine are sealed to it as to a key name. A server takes a new zone for a name at most once in 10 minutes.

## Who owns a name

Times are headers' timestamps; **now** is the node's wall clock (rooms need it right to most of an hour already).

- An entry at time `t` holds the name until `t + TERM` and keeps it from others until `t + TERM + GRACE`.
- **A chain is unbroken** when each renewal is by the same owner key, names the entry before, and is timed not before
  it and at most its `t + TERM + GRACE`; nothing follows a release; an entry without an anchor breaks the run. A node's
  entries of a name form a tree by `prev`; **a chain** is an unbroken run to a leaf, so a renewal by another key, or one
  too late, starts a run of its own. It **covers** from its first entry's time less `drift` (a block's time may run
  that far ahead of a clock) to its last entry's `t + TERM + GRACE`. A `release` ends the cover at its own time and
  **beats every sibling branch at the entry it follows** (`Name::released_past`): the owner's other entries after that
  entry, and all after them, are on no chain, so a renewal servers finished beside a Let it go, or one made in another
  browser holding the title, doesn't keep the name for a term. Only the owner key signs a release.
- **Seniority** is the time of the first entry of the unbroken run a node holds: the claim's, when it holds it all.
- **The owner now** is, of the chains that cover now, the one with the earliest seniority. Equal: the lower SHA-256 of
  the first entry's anchor block's hash and its id. The same first entry (a fork, or one a longer copy of the other):
  the cover that ends later, then the lower last id; a chain with a release beats the same chain without it. A total
  order, so two nodes holding the same chains pick the same one.
- **The name resolves** while now is before the owning chain's last `t + TERM` (and before a release); in the grace it
  resolves for nobody and only the owner can renew.

The rule reads only chains alive now, so a dead chain can be dropped by everyone without changing any answer (a released
one is kept as a tombstone until its cover would have ended, or a stale copy without the release would bring the name
back), and nodes holding the same chains agree whatever order they got them in: partitions and resets merge without
negotiation. The owner is computed from **every entry a node holds of the name** (`chain.rs` `Name`), each with its
earliest anchor; a node that kept only its best chain could disagree with one that kept them all when copies arrive
partial (a chain shown without its last anchor looks dead and is dropped; the anchor, arriving alone, then finds
nothing). One deliberate consequence: a chain claimed while another held the name, renewed ever since, takes it when
the holder lapses (a **back-order**, costing proof of work every term). A fork between honest copies of a title is
settled by the order: the agent takes the room's branch and renews from it, and one Web Lock a title keeps two tabs
from renewing at once.

| Parameter | Value | |
|---|---|---|
| `TERM` | 30 days | |
| `GRACE` | 7 days | |
| `drift` | 2 hours | a header's time may be this far past now, and a chain covers from this far before its first time |
| floor | `0x17216730` | the easiest target a header may claim: 1/16 of the difficulty of block 976,177 |
| renew | the last entry older than `TERM / 2` | two entries a month a name; "every 2 weeks", a name lost only past 3 |
| proof of work | Argon2id 1 MiB t=1 p=1, 16 bits | a mean of 25 s in a tab; checking one is one evaluation |

## Bitcoin as the clock

- **Stamping** (the page, `fetch`): the entry's id is POSTed to three calendars, `alice` and `bob` at
  opentimestamps.org and `finney` at eternitywall.com (two operators): a receipt in 1 to 3 s, 170 to 230 bytes. A
  finished proof is served for years with `access-control-allow-origin: *`; **a pending one is a 404 without the CORS
  header**, which a page sees as a failed fetch: any failure there means "ask again later". One anchor is enough; three
  calendars are for availability.
- **How long an anchor takes**: the wait for the calendar's next transaction, its mining, and five blocks more (a
  calendar serves a proof from its transaction's sixth confirmation). A stamp lands in the calendar's next mined
  transaction unless made in the ~10 minutes before that block (N0b: 39 of 160 at `alice` and `bob` missed one, all 1.4
  to 9.1 minutes before; none missed two). The first of the three: a median of 1.0 hours over the calendars' recent
  record (p90 1.7, p99 2.5, worst 3.2), 1.3 over a year's samples (p90 2.1, worst 5.3); a batch of 80 real stamps, one
  evening, 1.24 to 2.39 hours (median 1.48, `alice` first for 78); `finney` alone up to 15 hours. **About 2 hours** is
  what the dialog says. No day of the past year had fees that would have stalled the calendars for long. A slow calendar costs only the wait.
- **A header proves itself**: a verifier checks the anchor against the header's Merkle root, the header's proof of
  work against its own target, that target against **the floor** (`Params::floor`: one compiled target, 1/16 of block
  976,177's difficulty), and that its time isn't past now by more than `drift`. No height, no explorer, no headers
  after it, so a member checks an anchor offline. Times, unlike heights, are in the header, so a header can't be passed
  off as an earlier block's. An orphaned block still passes (its work was real). The floor keeps junk headers out and
  guards members; sixteen times under a real block covers any fall in difficulty there has been (the largest in years,
  mid-2021, ~45%). A release may raise it, but must stay under every block since the oldest anchor alive (a term and a
  grace: 37 days).
- **Who asks an explorer** (blockstream.info, then mempool.space when it fails or serves a header the module refuses;
  their Esplora APIs): the agent, for each of its own anchors (the block at the proof's height, `block-height/<h>`,
  and its header, `block/<hash>/header`; a Merkle root not the anchor's means that explorer has another block there,
  and the other is asked); servers, the same two GETs for a renewal they finish, and one GET a distinct block their
  registry is anchored in, **by hash** ("Servers", "Outside the room"). Members ask none.
- **Who asks a calendar**: the agent, to stamp and collect; servers, to finish a pending renewal they hold, at the
  calendar its pending anchor names by index. So a renewal's anchor reaches the room hours after the visit that stamped
  it, with no page open.

## The registry

### The names client

Everything a node does with the registry goes through a room client of its own in the same worker and module
(`room.rs`, a `Client` in names mode): same room, **a node key made new each session**, relay only, no guest, no
signalling, its own DERP and Nostr connections (connection numbers from `NAMES_CONN`, 0x40000000), and **incoming
handshakes only while its own question is open** (2.5 s, 32 at once: the servers answering it; a key let in that
hasn't served a second after its handshake makes room for a newcomer) **or from the servers a member's `fetch` named**.
So a server never learns which node asked (not its key, address or name; not its IP address, which only DERP sees),
and the node's own key carries none of it. A server's names client runs while the room does (again a minute after it
fails); a member's (`member.rs`, room.rs `MemberHost`) starts at the guest's first query for a name that isn't a key
and closes after 10 minutes without one. A first lookup asks through the relays at once; "who serves?" and a contest's
`fetch` wait until its home region is up, so the servers' call backs reach it.

**Messages** are UDP between two names clients' room addresses, port 2 both ends (`NAMES_PORT`), binary, 1,200 bytes a
datagram (`wire.rs`): a message in numbered parts (a 9-byte head, then up to 1,191 bytes), each acknowledged, resent
after 0.5, 1 and 2 s and given up 2 s after that; at most 16 of a peer's unacknowledged at once (a derper queues 32
packets a client and drops the oldest, so two partners syncing into one server fill it and no more). A message is 1 MiB
at most; a peer may have 16 incomplete, 2 MiB, at once (every new part counts; dropped 10 s after its last new part);
8 MiB queued to a peer unacknowledged at most, past which a send fails. A message is a type, the transfer it answers
(0: none) and a body; transfer ids count up across a client's peers, so a peer forgotten on one side and met again
doesn't take new transfers for old ones.

### Finding a server

"Who serves the registry?" is for what must not name an id: the refresh of names a member keeps, the dialog's check,
a publisher's `put`s, and servers' sync partners (a first lookup asks the room instead: below). An ephemeral event like
a lookup (the same kind, MAC and seal with the room's lookup key) under the room's names tag, `BLAKE2s(tag salt,
"names", hour)` (`Room::names_tag`), its body a lookup's (the names client's key, region, time, nonce) and `spread`:
123 bytes. Servers subscribe to it and drop questions as they drop lookups (MAC first, copies through other relays, the
relay's budget, an hour off, their own key, a region outside the link), copies by nonce, key and round.

- **Who answers**: a server whose **rank**, the top 64 bits of `BLAKE2s(nonce, owner key)` for the owner key of one of
  its live names (the lowest), has its top `spread` bits zero, once it has synced, within a budget of its own (4 a
  second, apart from the node's call backs and trials, so a flood of questions can't keep the node's own lookups out).
  The hash is over the owner key, not the names client's: an owner key costs a registration, a names client's key
  nothing. It holds 32 askers at once (one let go after 60 s without a request, or 10 minutes after it came; with every
  place taken the longest-held makes room, never a sync partner). The asker sends `spread` 6 (1/64), then 3 after
  0.4 s, then 0 (everyone) after 1 s, and stops at the first round that brings an answer. Measured on the bus (200
  questions, a name a server): one server answers in the third round (176 of 200); twenty in the second (137); 500 in
  the first every time, by 7.6 servers.
- **The answer**: a call back to the asker's region (none when a session is up; a server asking itself that answers a
  lower key waits 0.5 s, as crossed handshakes both fail), then a `serve`: the owning chain's last entry of a live name
  of the server's, with its anchor and header, signed by that name's owner key over the tagged hash
  (`waarm64/names/serve`) of the room's value, the asker's nonce and the server's names key. The asker checks it whole
  and that its chain covers now. So only a node that holds a live name's secret can serve.
- **The choice** (the plain draw): an answer counts when its rank fell in a round already sent, once a name and once an
  owner key; 0.3 s after the first, the asker keeps the two with the lowest `BLAKE2s(nonce, owner key)` (not the
  fastest, which an attacker could always be, nor the lowest names-client keys, which it could grind) and lets the rest
  go. The accept window does the same once full. With one answer only, it asks everyone at once, so it holds two where
  the room has two. Registrations buy places in this draw; what it's used for is what that can't hurt much (a refresh
  can be shown a stale zone or a release hidden, never another owner). A member holds its servers while it asks and 3
  minutes after, and **redraws them 15 minutes after they were drawn**; one that fails is let go.
- **Nobody answered** 1.5 s after the third round: the waiting queries get NXDOMAIN, and the fact is remembered 30 s,
  twice as long each time after, to 10 minutes (names not kept get NXDOMAIN at once meanwhile; kept ones answer); the
  next query after it asks again, so a member finds a room's first server with no reconnection. A room with no names
  costs a member three events every 10 minutes at most, only while its guest asks. A server nobody answered counts as
  synced and asks again after the same wait (5 minutes at most, plus a fifth at random). **A server that refused a
  question meanwhile for not being synced asks again in 1.5 to 3 s** (`ASK_SOON`), and **a server asks only once its
  names client's home region is up**: two servers started together then hold each other's name 1.5 to 6.5 s after the
  later start on the bus, 7.3 to 8.8 s on the six default relays and tailcat's region 303.
- Questions go out at 1 a second. **A question's key proves nothing** (an X25519 key can't sign), so questions naming
  a victim's key would have every server call it back: a server answers questions naming one key 4 times a minute.

### A member resolving a name

(`member.rs`, `member_tests.rs`; through the resolver, room/tests/names.rs.)

- **A first lookup** (a name not kept) **asks the room through the relays**: no server found first, no session, nothing
  drawn. An **`ask`** is an ephemeral event under the names tag, sealed and MAC'd as a question is (164 bytes: a
  lookup's body, the name id, the mode, `spread`, 8 bytes `shown`); a **`reply`** comes back under the asker's **reply
  tag**, `BLAKE2s(tag salt, "names-reply", names key, hour)` (`Room::reply_tag`), subscribed to before the first ask (a
  publisher never asks, so never subscribes). A reply carries the ask's nonce, the replier's names key and region,
  `since` (the first time of the owning chain's run as it holds it; unchecked, it only orders a contest), and an item:
  none, the owning chain's last entry with its anchor, header and zone, a release with the entries before it that fit,
  or "too big" (past `REPLY_MAX`, 4 KiB of item, which every default relay forwards: then the last entry alone).
  1. **`share`** at the spread that last brought one to eight replies in this room (6 the first time; past eight, 3 bits
     narrower, to 15), then 3 bits wider after 0.4 s, then everyone after 1 s, three rounds whatever the start, each
     timed from when the round before **left** (asks go out 4 a second). A server replies to a nonce and asker key
     once.
  2. **Each reply is checked for what it holds**, never for who sent it: the entry whole once a lookup, its anchor with
     each copy, the zone (the owner's, this name's, signed). A reply that fails counts for nothing. Checks have the
     server's budget (24 units a turn) and the relays theirs.
  3. **At the first reply**, unless its round asked everyone: one **`dissent`**, `shown` 8 bytes of a tagged SHA-256
     (`waarm64/names/shown`) over the best item's owner key, that key's latest last entry's id and its best zone's hash
     (`wire::shown`; zeros when all said none). Every server whose own (owner key, last entry, zone) hashes otherwise
     replies, whatever the share; one holding exactly that stays silent. So a liar has to silence every honest holder,
     not win a draw.
  4. **0.7 s after it** (0.3 s after the first reply when everyone was asked), it decides: **one owner key** shown, that
     owner's latest last entry, no history needed; **none** from at least one server, NXDOMAIN 60 s, doubling to 10
     minutes while the name stays unknown; **two or more keys**, or one shown only too big, a **contest**: repliers by
     `since` (32 a key), `fetch` to the earliest, 8 at once, handshakes let in from those names keys only, each run
     checked as a `history` is; it ends when nothing is in flight and the best run is older than every `since` left, or
     at 10 s (`CONTEST_FOR`), and names an owner only if every key shown is settled, else no answer (the next query asks
     again), never another owner; **silence** 1.5 s after the last ask left, nobody serves (30 s doubling to 10
     minutes), unless a reply counted in the last minute (the reply budgets were spent: SERVFAIL, asked again). A key
     whose last entry a release replied ends is taken by nobody.
  5. A reply up to 3 s after the decision is still checked (another key starts a contest; a name decided none takes a
     late owner). **Replies spent by others**: past 8 replies a minute under its tag to nonces it never sent
     (`STRAYS_MAX`, `STRAY_FOR`), a first lookup decides nothing, never an impostor's answer.
- **A refresh** (a kept name confirmed more than 5 minutes ago, or in its grace) **never sends an `ask`** (that would
  tell the room how long a name stays in use): it goes to the two servers "who serves?" drew, `get` in owner mode (the
  name id and what it keeps); each answers with what it lacks of the owning chain's last entry and the zone, or none. It
  checks the last entry (signature, work, header, anchor, alive) and the zone. **When the servers disagree or contest
  what it keeps** (`Kept::offer` would refuse it), it asks each for `history` (the owning chain's whole run, up to
  1,024 entries, checked a slice a turn, each entry once; the first that fails refuses that run) and picks by the rule.
  Last entries alone can't be compared (a renewal's time isn't its chain's seniority).
- **What a member keeps**: each name it resolved, with its chain's last entry, the earliest entry time it verified for
  that chain and whether it was the claim's, the zone and when servers last confirmed it (a record a name, under 2 KB;
  1,024 names at most, the least asked for going first). While that chain covers now, another replaces it only by
  showing a run that starts earlier than the kept claim; while the kept chain's claim wasn't seen (a first lookup keeps
  only a last entry), another key's run never replaces it on seniority alone. So a member that knew a name refuses an
  impersonator after a reset, with no rule of its own. A kept name **answers at once** while its chain resolves,
  refreshed in the background when older than 5 minutes (so a zone change shows one query late); in its grace it is
  NXDOMAIN while confirmed in the last 5 minutes. Both servers saying none doesn't drop a kept chain; **a release
  does**: a server whose tombstone holds the member's last entry answers with the release and what leads to it (8
  entries at most), and the member ends what it keeps and asks again as a first lookup.
- **The dialog's check** must not tell a server which id is about to be claimed: Register asks for `ids` (every id held
  under one first byte, each with when its owner's hold ends rounded up to a week, 0 for nobody), through a checker made
  for that press (a fresh key), and looks for its own. One byte filters a server's guesses by 1/256. Each server's
  answer is weighed apart ("What the user sees").

### Servers

(`store.rs`, `server.rs`.)

- **Hold**, per name, what a rule of the entries held and the time says (`Held::settle`), the same on every server: the
  owning chain with its whole run; the unanchored renewals continuing its last entry and unanchored releases on its run
  (two, releases first, then the lowest ids), until anchored or unable to link; tombstones that, without their release,
  would beat the owner (two); the newest zone the owner key signed. Everything else is dropped, so a worse chain is
  refused. **One chain a name, not every chain alive**: a function of the set is what makes servers converge, even with
  copies arriving partial, because a sync `get` says everything held and the other sends what's lacking, and a run cut
  short is only ever worse than the whole. The price: a back-order isn't carried until its owner's agent puts it again
  (at its next renewal, two weeks at most, or when it sees the name free).
- **Sync** (`Run`): a round asks "who serves?" afresh and syncs with the two servers it keeps, at the start and every 5
  minutes (± 30 s); **a round whose sync brought names is followed by the next 30 to 40 s on** (`QUICK_ROUND`, 8 in a
  row). Ranges of name ids (`wire::Range`, by leading nibbles) are summarized by a fingerprint (the XOR of 8 bytes of
  `BLAKE2s(id, version)` over their names) and a count; a name's version is 8 bytes of SHA-256 over its kept entries'
  ids, their anchors' digests and its zone's hash. The asker sends `sync` with its summary; the other answers `same`,
  the 16 sub-ranges' summaries, or a listing where a range holds 64 names or fewer; the asker descends, `get`s (`all`
  mode: what it holds as short ids and digests, so only what's missing crosses) each listed name it lacks or holds
  otherwise, 8 requests in flight, and ends with `have` (what the other lacks), which the other `get`s. **Only a server
  that proved a live name** is answered `sync`, `have` and `get all` (by its `serve`, or a run's first `sync` carrying
  a live name's entry and its owner key's signature over both names keys, `waarm64/names/peer`). A run is bounded: past
  depth 63 or a listing past 64 names it ends; 8,192 `sync`s; as many `get`s as the bound holds names; **4 minutes**
  (`RUN_MAX`), after which the next round starts at once (a breach waits for the round's 5 minutes). A server answers
  "who serves?" only once its first round is over and verified, or nobody answered it. A changed name is told in
  `have` to this round's servers and those synced with in the last 10 minutes.
- **`get`'s member modes**: `owner` (the owning chain's last entry and zone, what the member lacks; a tombstone's release
  when the member's last entry is on it) and `history` (the whole run and zone), each counting as the name asked for;
  `ids` (one first byte; twice a session and four times a minute a server, past which an empty answer: "nobody can
  say" from that server).
- **Asks** (`Server::on_ask`), once synced: a `share` whose rank falls in it (**one draw a server**, its live name of the
  lowest id: a share is of the room's servers, not of their names) and every `dissent` that doesn't match what it holds
  are replied (an item, none, a release run, or too big), through the relay that brought the ask and the next one whose
  copy came (another after 1 s: `REPLY_SECOND_WAIT`). Replies have **budgets of their own**: 2 a second
  (`REPLIES_PER_SECOND`), 16 a minute under one reply tag (`REPLIES_PER_TAG`), once a nonce and asker key, apart from
  answers and call backs. A `fetch` naming its names key is a call back from the answers' budget, then `items` with
  the owning chain's whole run (transfer 0). An ask counts the name as asked for.
- **`put`** from anyone (an owner's publisher, a member holding a better chain), checked and settled: answered `taken`
  when the owning chain's last entry and zone are the put's, else `better` with the server's item (a zone refused, by
  the 10 minutes or not beating the one held, is `better` too). Puts wait in their own queue (4 a peer, 64 in all),
  verified after what sync brought.
- **Verify** signatures, proof of work and anchors before keeping or serving, a slice each turn (an entry 4 units, an
  anchor or zone 1, 24 a turn: ~6 entries, ~4 ms in Chromium's wasm; ticked again at once while work waits). A failing
  entry ends its item's check and is remembered (4,096); an entry checked whole is remembered by its **work key**
  (SHA-256 of the 111 bytes the work covers: 16,384), so a valid one put again costs its anchor's check (~1/40) and one
  its owner signed again costs a signature's. What a peer's answers bring waits 256 items and 4 MiB a peer, 4,096 and
  32 MiB in all; past it its `have`s ask nothing and its run's `get`s wait. An entry is ~0.66 ms whole in Chromium's
  wasm (Argon2id 0.49, BIP-340 0.15, an anchor's 46 SHA-256s 0.015), so 60,000 entries ~40 s of a core.
- **Bound**: `MAX_NAMES` 20,000 and 128 MiB of items. Past either, a server drops names, never its own, **the youngest
  owning chains first** (by seniority; a name no chain owns before any), and of one age those asked for least lately,
  deletes them, and doesn't fetch them by sync for a day unless a member asks. A dropped name isn't lost (its owner puts it
  back). Age, not asks: asks cost nothing and can't be told apart, so junk registered in bulk outranked every name
  nobody had asked for since it came (N6a's rig: each server dropped ~2,490 of the room's names and no junk); a
  chain's age is bought only with time.
- **Persist** per name (`action 11`: the id and the record, a version byte, when last asked for, the item; none: delete)
  and per block checked (version 3); taken back before the first tick (`ts_room_names_load`), trusted; written again
  for being asked for only once that moved an hour. A member's records likewise (what it keeps). The page keeps them in
  IndexedDB `waarm64-room`'s store `names` (web/room.ts `roomNamesStore`) under 16 bytes of SHA-256 over the room's ID
  and the connection's `identityKey` (a private room's ID is a secret), written in batches of a second and before the
  worker goes, streamed in at the start; one the module doesn't take is deleted. Stored connections only. The node's
  own names aren't stored there: their titles are the agent's.
- **Outside the room** (`outside.rs`; servers ask, members never). The module builds a GET only from the compiled
  calendars (`Calendar::url`) and explorers (`EXPLORERS`), never from a record; the room's worker fetches it through
  web/names.ts `serviceFetch`, which refuses any other URL (action 12, `ts_room_names_fetched`; status 0: no answer).
  Four out at once, 30 s each.
  - **Renewals finished**: a held renewal's signed pending anchor is asked of its calendar from 30 minutes after it came,
    then once a 15-minute slot when 8 bytes of BLAKE2s over the entry's id, the server's names key and the slot fall
    under one over the room's servers (counted from its questions' answers, 64 at most), halved each 12 hours to an
    eighth: the room's servers together ask about once a slot. With the proof, the explorer's block and header, and the
    anchor is taken as a put: the room has it within minutes. Twenty servers holding a renewal never finished ask 2 to
    8 times an hour, 57 in 12 hours.
  - **Blocks checked**: each distinct block once, **by hash** (`block/<hash>/header`), newest first, one every 3 s at
    most (`check_every_ms`), from ticks only (a lookup never waits). A 404 at both explorers refuses the block, every
    anchor in it dropped and the chains settled again, remembered a day; one explorer confirming is enough; unreachable,
    asked again after 5 minutes doubling to 6 hours. **Until checked, an anchor counts** on its header's work, so names
    work with the explorers down. Verdicts are stored. A first sync of 1,342 distinct blocks takes 67 minutes of checks.

## The resolver

`resolve()` (room.rs), after the key-name case, for a name under `<tag>.p2p.internal` or the room name's domain
(`Room::domains`; the name, or one label under it) that passes "Names"' rules:

- **on a server's node**, from the registry it holds (`Server::resolve`); its own name not public yet (or lapsed)
  answers from its title's zone, or the node's address for the name itself; a name not held waits while the first sync
  isn't over, else NXDOMAIN;
- **on a member's**, a kept name, its chain alive: AAAA from the slot the name opens (none: NXDOMAIN), TTL 60, the key
  learnt by the module;
- **otherwise the query waits** while the names client asks: answered when the answer comes, SERVFAIL at 4 s
  (`DNS_WAIT`; 64 wait at most, past that SERVFAIL at once; a contest goes on and the next query has it);
- **NXDOMAIN at once** for a reserved or ill-formed name, a name replies said none for (60 s doubling to 10 minutes),
  and any name not kept while the member remembers nobody serves.

Every type is answered alike (AAAA has the address, the rest an empty answer). Each query for a name that isn't a key
is logged to the worker's console (`resolver: <name> (type <n>): <answer>`). Measured: a first lookup 1.3 s through the
fake DERP and relay in a room of two, 0.3 s once the spread is known; on the public relays a fresh member's first name
1.52 to 1.59 s, a second 0.90 to 0.95, one that doesn't exist 0.64 to 1.0 to NXDOMAIN, a kept one 1 ms.

## The names agent

(web/names.ts, web/names-ops.ts, web/names-worker.ts; net/ts `room/names/agent.rs`, the publisher in room.rs.) The agent
owns the owners' secret and the titles, the only place a name is kept in words: IndexedDB `waarm64-room` (version 3),
store `owner` (32 random bytes under the connection's `identityKey`, made at the first registration) and `titles` (a
record under [identityKey, a hash of the room's ID, the name]: the room's ID and link, the item, the calendars' pending
anchors, the zone's points and counter, the backoffs, lost or released, the renewal made ahead). **A title is the only
copy of ownership**: registering asks for persistent storage, and deleting the connection shows its export. The module
does the work (`ts_names_*`, JSON in and out: make, mine in slices of 256 tries, sign and check an entry; pending
anchors; the commitment to ask; a finished proof's anchor with its header; a zone; a title's status; a server's better
item judged), in a worker of its own for proof of work; no JavaScript crypto. It needs no running machine.

- **At every page load** (web/app/main.ts starts it when a title is kept) and hourly while open (a pass that fails,
  such as a store's error, is tried again 5 minutes later; one still running when the agent stops arms nothing; its
  worker's failure or close refuses what waits on it), for each title, under
  **one Web Lock a title** (`waarm64-names:<identityKey>:<room hash>:<name>`, taken if free): collect finished anchors
  (a pending proof asked 5 minutes doubling to an hour), each with its block's header from an explorer; renew when the
  owning chain's last entry is `TERM / 2` old and no renewal waits; make the claim of a title that has none. An entry
  no calendar stamped is made again. Nothing else drops one: every anchor counts whenever it comes, a calendar's answer
  that isn't a proof moves on to the next, a header one explorer serves that the module refuses goes to the other. A
  renewal unanchored past its link end is kept and asked for a week more (it may have an anchor timed before then). A
  claim never goes stale.
- **The next renewal is made ahead**: once a pass has published, the agent makes the renewal that will follow the
  title's newest entry (proof of work and signature) and keeps it unstamped (`TitleRecord.ahead`). A visit that finds
  a renewal due stamps it (seconds) and hands it to the servers with its signed pending anchor; they finish it. So **a
  visit of a few seconds every 2 weeks keeps a name** (server_tests.rs: visits 14 days apart, page closed between,
  resolving and owned at every hour of 60 days).
- **Publishing** is a `put` through a **publisher** (room.rs `Config::publish`: a fresh key, relay only, nothing let in
  but its question's answers, no guest, no node): it asks "who serves?", keeps two servers and puts the title's item to
  each (`names-put` events: `taken`, `better`, `failed`, `nobody`). Once the claim is anchored (never before), whenever
  the item changed since a server took it, and once a visit and an hour besides (so a reset room or a fork settled the
  other way is seen within the hour).
- **A server's better item** is checked whole and judged with the title's entries: the title's own chain (`ours`);
  **another branch of the title's key** (a title forked between browsers: taken in, the next renewal from the room's
  branch; a zone a server didn't take counted past, put again 11 minutes on); or **another key's chain: lost**, renewal
  stops and the page says so. Not while the title's own chain has an entry waiting for its anchor, nor when another
  server of the same pass took it, nor until an explorer knows the better chain's first block (a forged header can't
  stop the owner's renewals). A lost title is still put hourly, and judged again.
- **[Let it go](ui:network:NameEntry.release)** drops the renewals waiting for their anchors and the one made ahead,
  and makes the release on the owning chain's last entry (made again if no calendar stamped it). A renewal servers
  already finished is ended by the release once both are anchored.
- **A running room** is given the connection's titles (`room.names.titles`, the owner key and item each) and again as
  they change (BroadcastChannel `waarm64-names`, `ts_room_names_titles`): a member given titles becomes a server. Each
  is checked whole **before it counts as the node's own**: a title with no entries, one not the title key's for its
  name, or one that doesn't hold, is refused (titles can come from a pasted export, which anyone can craft).
- **A connection's export carries its names**: `<node key>.<base64url of the secret and the titles>` (room-export.ts,
  `exportNames`, `parseRoomExport`), and a connection made from it takes them (`importNames`); each title keeps its own
  secret (`TitleRecord.secret`), and the agent renews a chain only with the key its secret derives. A title publishes
  through its connection's link as it is now (`relink`).
- **A zone's `seq`** (64 bits) is `n << 32 | branch`: `n` counts past every `seq` the title has seen (a registration
  starts it at the Unix time, past an earlier tenure's zones signed by the same owner key), `branch` 32 random bits
  drawn at registration and by every copy taken in, so one export pasted twice gives two branches (2^-32 a pair could
  share one and reuse a seal's key).
- **The services are compiled in** (`CALENDARS`, `EXPLORERS`): the agent fetches nothing else, a pending anchor names
  its calendar by index, a receipt's own URI is never fetched, and no link, option or stored value names a service.
- **The API** (`NamesAgent`, `namesAgent()`): `register(conn, name, points)`, `setZone`, `release`, `titles` (each
  `state`: `preparing`, `reserved` with `publicAbout`, `active`, `grace`, `lapsed`, `released`, `lost`; `claimedAt`,
  `keptUntil`, `renewAt`, `lapsesAt`), `pass`, `check`, `checkHere`. Measured: register to public ~0.15 s once the
  blocks are there (pretend services); production proof of work 3 to 64 s an entry in Chromium.

## What the user sees

(NameDialog.svelte, NetNames.svelte, NameEntry.svelte, areas/names.svelte.ts, names-view.ts; frontend.md "Network".)

- **Reaching someone's name: nothing.** No switch, no notice. The adapter's details have one line for the curious (a
  member's names resolved and servers held, or a server's names held and servers synced with: the module's `names`
  event).
- **Registering a domain.** In a connected room adapter's menu, [Register a domain…](ui:network:NetNames.name) opens one
  dialog: a field, the whole domain under it (`<name>.<room name>.p2p.internal`, or under the tag in a room whose ID
  isn't a label), and as typed only what the page can say alone (not a valid name; this connection's already). Two
  notices, always shown, no boxes: [Members of this room who know the domain can reach this connection's address and
  see when it's online. While this connection is connected, this web app helps other members look domains
  up.](ui:network:NameDialog.notice.find) and [Open this web app at least every 2 weeks to keep the
  domain.](ui:network:NameDialog.notice.visit) [Register](ui:network:NameDialog.register) asks the room's servers for one
  first byte; then **free**: registered, the dialog closes; **taken** (every server that answered lists it): it stays
  open with the earliest date given; **the servers disagree**: it says so ([The room's servers disagree about mybox: one
  says it is taken, until about <date>, and another doesn't. Press Register again to register it all the
  same.](ui:network:names-view.check.disputed)), and a second press registers; **nobody can say**: likewise, a second
  press registers. A second press is the least intrusive way on: no button, box or question, and none on the free path.
- **States**: [Preparing](ui:network:names-view.preparing) (proof of work), Reserved, public in about N hours (it already
  works on this machine; past the usual wait [Reserved, public once this web app has been open a while; it already works
  on this machine.](ui:network:names-view.reservedLate)), Active, kept until about a date unless you visit, in its grace,
  [Lapsed: anyone can register it now.](ui:network:names-view.lapsed), [Let go](ui:network:names-view.released), lost.
- **The details** per name: where it and each label point (a member's name or a key, pasted), [Add a
  subdomain](ui:network:NameEntry.addLabel) (15 at most; past four points the zone is sealed wide),
  [Point all at this connection](ui:network:NameEntry.pointHere), Save (checked as the module will: a label's rule, none
  twice, a target a member's name or key), Let it go. No key is shown or asked for.
- **Elsewhere**: a stored machine's Network tab lists each room adapter's names with the date each stops resolving
  unless renewed; at load, after the agent's first pass, the message bar names those in their last week. An ephemeral
  connection with its own key can't hold a name (the dialog says so, no Register). Deleting a room connection that holds
  names asks in a question of its own, with the export to copy, then forgets them. The wizard's key field is the
  export, and a pasted one brings its names. Words: `web/messages/en/network.json` (the Home page's in
  `machines.json`).

## Bounds and budgets

| What | Bound | Why |
|---|---|---|
| a name / a label | 1–32 / up to 63 characters | DNS labels; long names are no one's |
| a zone | 4 or 16 slots, 15 labels | a holder sees neither the count nor the targets |
| an entry / an anchor | 175 bytes / 4 KiB | the format's own limit |
| a zone change at a server | once in 10 minutes | a zone needs no anchor, so nothing else limits it |
| a datagram / a message / a peer's incomplete | 1,200 bytes / 1 MiB / 16 and 2 MiB | DERP's MTU; what a peer can make us hold |
| parts in flight / queued to a peer | 16 / 8 MiB | a derper's queue is 32 packets a client |
| a question's answers / asks a server holds | 4 a second / 32 | apart from the node's call backs |
| questions naming one key | 4 a minute a server | a key proves nothing |
| replies | 2 a second, 16 a minute a reply tag, once a nonce and key | a forged ask can make every holder reply |
| a member's asks / questions | 4 / 1 a second | |
| `REPLY_MAX` | 4 KiB of item | all six default relays forward it, and up to 32 KiB |
| a first lookup's contest | 8 fetches at once, 32 repliers a key, 10 s | liars cost a fetch each |
| strays under a member's tag | 8 a minute, then no decision | replies spent by others |
| `ids` | twice a session, 4 a minute a server | listing the registry |
| the resolver's wait | 4 s, 64 queries | a guest's resolver retries |
| negative answers | NXDOMAIN 60 s to 10 min; nobody serves 30 s to 10 min | a room with no names costs three events every 10 min |
| a member's kept names | 1,024, under 2 KB each | |
| a history | 1,024 entries, a slice a turn | ~0.7 s of the worker in one turn otherwise |
| verification | 24 units a turn (~6 entries, ~4 ms) | the worker stays responsive |
| a peer's answers waiting to be verified | 256 items, 4 MiB (4,096 and 32 MiB in all) | sync can't outrun the checks |
| puts | 4 a peer, 64 in all | |
| remembered | 4,096 failed entries, 16,384 checked by work key | a junk copy costs one check |
| a sync run | 8,192 `sync`s, 8 requests in flight, 4 minutes | a partner can't hold a new server up |
| the registry | 20,000 names, 128 MiB of items | a tab's memory |
| outside fetches | 4 at once, 30 s; a block check every 3 s | the explorers' tolerance |

## Size, and where it stops

An entry with its anchor, lengths and its block's header (80 bytes, once an item: once an entry for entries two weeks
apart) is **1.17 to 1.52 KB (1.45 typical)**; a name costs a server ~0.4 KB for its zone plus **2.3 to 3.0 KB a month
held**.

| Names, held six months | A server keeps | A new server's first sync through public DERP (~1.7 Mbit/s, 8 `get`s and 16 parts in flight over 95 ms) |
|---|---|---|
| 1,000 | 14 to 19 MB (~2.7x in the module's memory) | 1.2 to 1.7 minutes |
| 5,000 | 72 to 93 MB | 6 to 8 minutes, in runs of 4 minutes |
| 20,000 | 290 to 370 MB | too much for a tab |

Measured: 20 MB of items synced in 114 s through tailcat's region 303 and the six relays, a guest's ping on the node's
own DERP connection unmoved (90 ms); a room of 20 servers holding 5,000 names (15.5 MB of items) on the tests' relay
and derper: 41 MB of heap a server (2.66x its items; the rest is anchors decoded, ~3.4 KB an entry against ~1.2 KB
encoded), 0.3 cores for all 20 syncing from cold, under 0.1 idle, all 5,000 held everywhere within 296 s; members
1.4 MB each. The names client costs seven WebSockets (six relays and its DERP region), 64 KiB of module memory and
~0.04% of a core idle; a server's idle traffic ~10 KB a minute each way. The module is 92 KB Brotli larger with names.

A member keeps a few KB, so what grows is each server's copy, and every new owner pays the first sync before it serves.
Past a few thousand long-held names it needs one of: servers that hold a share of the id space each (the one to build);
owners syncing directly over WebRTC (shows an owner's IP address to other owners: the user's call); fewer renewals a
term. Anchors through one calendar transaction share their path's tail, and those in one block their header, across
names: a store keeping anchors by transaction would save ~30% at 1,000 names, ~40% at 5,000, a constant factor.

## What an attacker can do

| | Cost | What stops it | What's left |
|---|---|---|---|
| Register many names | proof of work each, every term | the bound drops the youngest chains first; members never see junk they don't ask for | squatting while it pays; junk claimed early and kept renewed pushes out names claimed after it |
| Stamp a dictionary and hold it back | the same work, every term | nothing but the price: ~63 RTX 5090-hours a term for a million names | takes a name later registered by someone else: accepted |
| Race a new registration | none | a claim is public only once anchored; the dialog sends one byte of the id a press | a guessable name, at best |
| Tie a claim it somehow knew of | claims in the same block | it needs the name before the claim is public | wins most ties: the tie-break can be ground |
| Hash a dictionary against a server's ids | a question a session | `ids` twice a session, 4 a minute a server | every id in ~64 minutes of one server, ~3 of twenty; guessable names learnt (and where they point, with a `get`) |
| Be the whole sample of a first lookup, showing its younger chain or none | registrations | one honest holder hears the dissent, the member takes the owner by its run (128 and 1,280 junk registrations against one holder: the owner every time) | a contest's time, ≤2.4 s |
| Show the owner's own records stale (an old zone, none, an entry behind) | registrations | `shown` covers the entry and zone, so a holder of the newest replies | |
| Replay the owner's last entry before its release | events | holders of the release reply it, and a member takes no key it ends | |
| Hold many younger claims on one name, lying about `since` | a registration each, every term | a liar costs a fetch and loses | that name's first lookups slower |
| Junk replies under an asker's tag | events | each fails a check and counts for nothing; "too big" carries a checkable entry | the next lookup's first spread narrower (its rounds widen to everyone) |
| Copies of an owner's entry from made-up servers, claiming `since` 0, in a contest | events, a registration on the name | the contest ends in 10 s, never for another owner | that name's first lookups get no answer |
| Forged asks that make servers reply | one event | 2 replies a second a server, 16 a minute a tag | with hundreds of servers, megabytes a second onto public relays (300 holders, 10 forged asks a second: 600 replies a second, ~2.5 MB/s) |
| Spend servers' reply budgets to keep dissent away | forged asks at every server's 2 a second | loud; apart from "who serves?"'s budget | members take what the attacker shows for names they don't keep, while it lasts |
| Spend one member's reply tag (it reads the key in its ask) | 16 events a minute | the member sees replies to nonces it never sent and decides nothing, never the impostor's | its first lookups get no answer while it lasts; the same on "who serves?" costs its refreshes, puts, checks and a new server's partners |
| Serve a member's refresh, leaving names out or a zone old | registrations | a kept chain yields only to an older run; the redraw every 15 minutes | a stale zone or a release unseen for 15 minutes |
| Hold a name after a reset | one registration | members that knew it refuse; a server holding the owner's chain hands it to everyone | impersonation to members that never resolved it, until the owner returns |
| Forge a Bitcoin header | one header at the floor: 1/16 of a block's work (~0.2 BTC of mining forgone), once | servers check each block by hash at an explorer and refuse it, with its anchors, once both deny it | a member asks no explorer: a reply or fetched run showing the forged chain wins there, as at servers while the explorers can't be reached |
| Lying explorers | one or both | one alone can't refuse a real block (the other confirms) | both can have a real block refused at servers until they answer truly; the owners' copies are untouched |
| Calendars all down | | | no new claims or renewals; names resolve; `GRACE` is the margin |
| Explorers all down | | anchors count on their headers' work | collecting and finishing wait; blocks unchecked |
| Flood "who serves?" | lookups' limits | answers from a budget of their own; 32 askers, the longest-held making room; a key named 4 times a minute | |
| Fill an asker's accept window | a handshake a place, a registration a place that serves | a place a second without a `serve` goes to a newcomer, never the best two's | |
| Make a server work (`put`, `sync`, `have`) | a session for `put`, a registration for the rest | puts 4 at a time, junk one check, valid again its anchor's, re-signed a signature's; `sync` 16 fingerprints a round; `have` 64 gets; 256 items and 4 MiB a peer waiting | past 16,384 distinct valid entries, whole checks again |
| A crafted export | handing it over | titles refused unless their key's | one made with a secret its sender knows passes: the sender can sign for the name too |
| Watch a relay | | lookups and records sealed with the room's key | which IP addresses serve and ask in a room; with the room's ID, which name ids are looked up first |

## Tests' parameters

Production's parameters need real Bitcoin work, so a test can't make a title they accept. The module runs on
`Params::BUILT`: `Params::PRODUCTION` unless the crate is built with the `test-params` feature, which compiles in
`Params::TEST` (regtest's floor, Argon2id of 8 KiB and 2 bits, servers that finish renewals and check blocks within
seconds; a Rust test of the asks' rates runs `Params::TEST_PACED`). `net/ts/build.sh --test-params` builds it to
`target/net/ts-test.wasm` (`scripts/ci.sh` builds both), which the page tests serve in `ts.wasm`'s place; `npm run
dist` ships `ts.wasm` only, and nothing on a page can choose the other. A room's `self` event says which (`params`).
Titles for the page tests come from `net/ts/examples/names-title.rs`; the agent's tests have the agent make its own on
the pretend services of `tests/net/ots-calendar.ts` (`mine(n, time)` puts a block 6 deep in the past).

## Tests and benches

- **Rust** (`cargo test -p waarm64_ts`, ~95 s; the root `Cargo.toml` optimizes `k256`, `elliptic-curve`, `argon2`,
  `blake2` and `sha2` in test builds): `room/names/tests.rs` (records and rules: alice's real proof of block 976,177 as
  the vector, merge order over 60 scenarios with forks, releases, stale copies and partial anchors, the floor, zones),
  `server_tests.rs` and `member_tests.rs` (the registry's logic on a bus in simulated time: answer counts at 1, 20 and
  500 servers, 128 and 1,280 junk registrations, contests, the release replayed, strays, the 60-day promise, the
  calendar's rates, the bound), `room/tests/names.rs` (through room.rs's fake DERP and relay: two and twenty servers
  converge, a reset, a flood of questions beside the node's own lookups, nothing under the node's key, no WebRTC, a
  first lookup with no DERP packet, a contest through sessions, names under the room's name), `agent.rs`'s ops, and
  `the_module_runs_on_production_parameters`.
- **Node** (each named to `node --test`): `tests/room-names.test.ts` (the pretend calendars and explorer, which module
  runs on which parameters, the `self` event's name, the records in IndexedDB in Chromium), `tests/names-agent.test.ts`
  (the agent on the tests' module and the pretend services: claims held back, anchors whenever they come, the Web
  Lock, lost titles, forks and pasted exports, the dialog's check, Let it go, only compiled services fetched),
  `tests/names-room.test.ts` (opt-in `WAARM64_TAILCAT=1`: real servers through the rig's derper, a renewal finished
  with the page closed, a fork settled, a lost name), `tests/names-browser.test.ts` (Chromium: the worker, IndexedDB,
  routes, an export into another profile), `tests/names-page.test.ts` (the words, the dialog's outcomes, and the
  `wording:` cases that pin the two notices), `tests/connections.test.ts` (export, import, names forgotten with the key).
- **Debian** (`scripts/ci-net.sh`): `tests/page-room.test.ts` grown by names (two guests in one Chromium, the tests'
  module served in `ts.wasm`'s place): no server, a server that appears while a guest keeps asking, full and short
  names, a label, reserved names, a zone change, what Debian asks unprompted, the dialog from typing to a name another
  machine reaches, the last week's notice, the export and Delete's question, an ephemeral connection refused.
- **Benches** (bench/net/REPORT.md): `bench/net/ots-stamps.ts` and `ots-history.ts` (real stamps and the calendars'
  history, N0), `bench/net/names-public.ts` (public DERP and relays: transfers, a cold lookup, two servers finding each
  other), `bench/net/names-window.ts` (a first sync's rate through the rig's derper behind a shaper),
  `bench/net/room-scale.ts names` (1,000 members, 20 servers, 5,000 names, junk against the bound),
  `net/ts/examples/names-memory.rs` (where a server's memory goes), `bench/net/names-long.ts` (two Node processes on
  the shipped module and the page's agent on the public services, for days: docs/backlog.md).

## Why it is this way

### First come needs an orderer

First-come uniqueness of a human-chosen name can't be enforced among free identities without an orderer or a Sybil
countermeasure (Kleppmann and Howard, [arXiv:2012.00472](https://arxiv.org/abs/2012.00472): a peer-to-peer database is
Sybil-immune exactly when every transaction is invariant-confluent, and uniqueness of a user-chosen value is their
first counter-example; it is safe only when the value is a hash of the update, which is why key names need no
agreement). Once a name is claimed, everything after (renewal, zone, release) is single-writer, which a signed chain a
name handles with any number of Sybils. Agreement is needed for two events only: a claim on a free name, and the moment
a name lapses (a claim against a renewal). And **time alone isn't order**: a timestamp proves a message existed, not
that it was public, so a claim can be stamped, withheld and revealed later. A rule that converges without an orderer
doesn't define "first": it defines most work, lowest hash, or earliest anchor, each a theft rule for whoever can game
it. Every surveyed naming system uses a coin, a trusted orderer, or gives up global first come (Namecoin, ENS,
Handshake; did:plc; GNS, I2P, Tor's proposals). The one coinless chain in production, ALFIS, orders by 4-of-7 signatures
of a de facto committee of 16 keys held by five or six people, and **stalled on 2026-07-05** when its signers went
offline.

### The options weighed (2026-11-15)

| Option | What decides a first claim | What it cost |
|---|---|---|
| A signer-quorum chain (ALFIS) | signatures of keys drawn from the chain's history | a committee of browser tabs that is asleep in a quiet room; eligibility buyable; deep forks need a checkpoint nobody can ship |
| A witnessed append-only log named in the link | the log's order, k witnesses cosigning | the only hard first come, but a server: nobody runs one for a room, no public log or witness service takes one from a page, the global room has none |
| Claims bracketed in time (drand + OpenTimestamps), a settling period | the earliest anchored claim | no server, no key; names provisional, a withheld claim priced only by proof of work |
| The heaviest claim wins | accumulated work | "richest ever": 1,000x the owner's rate overtakes a year in nine hours; an absent owner falls behind |
| A registrar key (or k-of-n) in the link | its countersignature | an administrator the room doesn't have; the global room has none |
| Petnames and zones | nothing: no room-wide uniqueness | no shared names |
| A tiered hybrid | the tier the link chooses | every path's code and explaining; the default tier is still option 3's |

**Why a chain on Bitcoin's clock won**: it is the only one that needs no server of anyone's, no key in the link and no
committee, and works in the global room and an empty one. Its hole (a withheld claim) can't be closed without a
witness, which is option 2; it is priced instead, every term, and terms are short. The user took it and changed it:
**no relay storage** (nothing about a node stays on a relay, so signalling stays replaceable; relays promise no
retention anyway), **no drand** (a BLS dependency, and a "made after" bound adds nothing a renewal's `prev` and the
anchor's time don't), **names by hash**. Bitcoin is a clock no member controls: Nostr's `created_at` is the writer's
(every relay probed stored an event dated a year back), and a header's time is under its own proof of work.

### Who holds the registry

The first draft had **every member hold the whole registry**, synced through DERP: 5,000 names were 50 to 100 MB a
member, an hour a newcomer on public relays. Now members ask per name and only owners, who have a reason to, hold it.
A DHT fits worse: the state is smaller than what a DHT saves, each hop to a new browser peer costs a signalled
connection, and it holds nothing when nobody is online. Range-based reconciliation (fingerprints of ranges, as
Negentropy) is the repair primitive: no parameter to guess, a few round trips.

### What was built and taken out

- **`ref` and `REF_WINDOW`** (an entry naming a recent block, its anchor due within 48 hours) were meant to stop proof
  of work being stockpiled. Work made early saves nothing (a term costs the same entries' work whenever it's done), a
  renewal's work is its own through `prev`, ordering never read `ref`, and it was no help against a forged header (any
  old block serves). It cost two explorers agreeing before an entry could be made and an anchor-past-window path. Gone
  with it: a renewal can now be made ahead, so a visit of seconds keeps a name.
- **Seven linked headers an anchor and a floor schedule** (review 1's finding 6): about 3.5 blocks' work against a
  forger, less the older the release, and a chore (someone adds a point to the schedule each release). Once servers may
  ask an explorer, its word ties a header to the chain; one header and one floor are left for members.
- **A block checked by height** (the redesign's plan): an anchor's height is unauthenticated, so a relayed honest entry
  with another height, or an orphan, would have been refused. By hash instead.
- **Servers ranked by their chain's age** (review 2's finding 2): any rule that picks k of the answers is a draw an
  attacker enters as often as it likes; age only made it wait three months (some 900 entries' work), at costs that
  didn't end (old names' servers answering more, young rooms reaching the last round, a `serve` of eight entries).
  **Dissent** makes the draw's honesty irrelevant: any one honest holder corrects the sample, and a first lookup
  believes content, not who sent it. That is why a first lookup's id is shown to the room (the user's trade).
- **A first lookup through a draw, then sessions** (find servers, `get` both, `history` if they disagree): now an `ask`
  and its `reply` through the relays, no DERP and no handshake unless two owners contest.
- **The dialog's check as typed**: `a`, `al`, …, `alice` each asked one first byte from one names client, and with the
  room's key a server could read the name off as it was typed. All ids at once instead cost ~40 bytes a name held, 800
  KB at the bound, every dialog. One byte at Register won.
- **The bound by asks**: asks cost nothing and an arrival counted as one, so bulk junk outranked the room's own names.
  By age instead.
- **The first draft** also had "who serves?" carry the asker's node key (anyone could list every member that ever
  asked), heights checked against two explorers by every member (tens of thousands of fetches for a registry), servers
  answering by a share of the names they knew (no answer in a big registry of few servers, hundreds in a room of
  servers), and any member finishing a pending anchor from a URL in the record (a thousand fetches a second at the
  calendars at scale, an address an attacker chooses fetched by everyone).
- **A verifiable delay function** instead of hashcash: sequential per instance, but a dictionary is a million instances
  side by side; milliseconds to check in wasm, ~256 bytes of proof on a 175-byte entry, no small vetted crate. Its one
  gain, a fixed time where hashcash is a draw, the *Preparing* state allows for.

### Findings (don't re-discover)

- **A calendar's pending proof is a 404 without CORS**: the page sees a failed fetch, not a status. Both explorers'
  404s for an unknown block do carry CORS, so a refusal is visible.
- **A calendar's history can't be listed by address**: it pays from several coins, each transaction spending an
  earlier one's change on its own coin; a year is ~16,000 requests. It was sampled (bench/net/REPORT.md "NAMES loop 0").
- **A stamp made within ~10 minutes of its calendar's block misses that transaction**, and a calendar serves a proof
  from the sixth confirmation (its status page counts transactions under 6 as waiting).
- **The agent's backoff collects a claim later than "about 2 hours"** (asks at 80, then 140 minutes): 76 of 80 real
  stamps would have shown the late line; the long run's proof collected at 1.38 hours a block 13 minutes old.
- **A GPU's lead at Argon2id of 1 MiB is ~110x to ~220x**, not the ~10x first assumed: a memory-hard function narrows
  the gap only past what fits on the card's chips, and memory a server can afford to check stays small. 256 KiB leaves
  the card most of its lead; 4 MiB keeps the ratio at four times the check.
- **A slow name hash doesn't protect guessable names** and would cost every resolver as much.
- **A derper queues 32 packets a client and drops the oldest**: 16 parts in flight a peer, 8 `get`s; 32 a peer had the
  rig's derper drop 16 to 117 parts. The `get`s, not the window, were the first sync's bound.
- **A server's question before its DERP region is up** loses every call back (a derper drops packets for an unknown
  destination): on a public region it took nobody answering for 30 s.
- **Two servers started together refuse each other** ("not synced yet") unless the refused one asks again soon.
- **A first lookup's rounds timed from its start** ran out while its asks still waited for the member's 4 a second:
  10 names at once in a small room were all NXDOMAIN.
- **A server that ranks by the best of many names** was in nearly every share: one draw a server.
- **A name's entries in a `BTreeMap`** cost 416 bytes a node of 11 whatever it held: a sorted `Vec` cut a server of
  5,000 names from 61.7 to 41.1 MB.
- **Transfer ids restarted per peer** let a peer forgotten on one side and met again drop new transfers as done.
- **The same `seq` in two copies of a title** would reuse a seal's key: one byte of branch drawn at paste collides one
  pair in 256, one given out by the exporter can't tell two pastes apart: 32 bits drawn by every copy taken in.
- **An entry's id takes its signature, its work doesn't**: an owner could sign one mined entry again as often as it
  liked, each copy costing a server an Argon2id; the work's verdict is remembered by the fields it covers.
- **`.alt` and systemd-resolved** (rooms.md "Findings") decided `.internal`, under which names live.
