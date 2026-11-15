# Prior decentralized / alternative naming systems and what they teach (state: November 2026)

Scope note: the target is a per-room name registry for a browser-only P2P overlay (first-come by key, expiry and
renewal, unpermissioned, owner offline for weeks, no coin, no server of ours, thousands of names, lookups < 2 s, one
AAAA per name). Items marked **[background, not re-verified this session]** come from the researcher's prior knowledge
and carry the URL where they can be checked; everything else was read in this session. ALFIS facts come from a clone
of `Revertron/Alfis` at commit `4427af3` (2026-11-02), version 0.10.0.

## 1. ALFIS (Alternative Free Identity System): the coinless PoW chain, in depth

### Takeaway
ALFIS is the closest existing design to the wish list (no coin, PoW per name, 1-year expiry, key-owned names) and it
is alive, but its own 2026 history is a warning: finality rests on a 4-of-7 signature lock by keys that have authored
>= height/100 blocks, that set froze at 16 keys held by 5-6 people, and the chain **stalled on 2026-07-05** and needed
three consensus RFCs, hard-coded checkpoints and the maintainer's fleet to keep moving. PoW alone never decided
ordering there; a small de facto committee does.

### Cited Findings
**Data model**
- A block is `{index, timestamp, version, difficulty, random, nonce, hash, prev_block_hash, pub_key, signature, transaction?}`, CBOR on the wire, stored in SQLite (`blockchain.db`); one optional transaction per block, so one name operation per block — [block.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/block.rs), [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs)
- A transaction is `{class ("domain" | "origin"), identity, confirmation, signing, encryption, data}`; `identity = SHA256(SHA256(name))` and `confirmation = SHA256(SHA256(name) || signing_key)`, so the chain stores a hash of the name bound to the owner key (a watcher of the mempool can't re-register the same name under its own key without knowing the name) — [transaction.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/transaction.rs), [hash_utils.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/hash_utils.rs)
- Domain data: `{encrypted (the name, encrypted), zone, info, records[], contacts[]}`; at most 30 records (`MAX_RECORDS`), data fields up to 255 bytes (`MAX_DATA_LEN`) — [transaction.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/transaction.rs), [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs)
- 10 fixed zones: `.anon .btn .conf .index .merch .mirror .mob .screen .srv .ygg`; `.anon` and `.ygg` may only hold Yggdrasil addresses. IANA zones can't be mined — [README](https://github.com/Revertron/Alfis)

**Proof of work (fixed, never adjusted)**
- Constants: `ORIGIN_DIFFICULTY = 28`, `DOMAIN_DIFFICULTY = 24`, `SIGNER_DIFFICULTY = 16`, `KEYSTORE_DIFFICULTY = 23` — [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs)
- Block difficulty counts leading zero bits of the first 8 hash bytes plus trailing zero bits of the last 8; the hash is "Blakeout" over the compact block bytes; a key is only valid if its own hash has 23 leading zero bits (keys are mined too) — [hash_utils.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/hash_utils.rs), [chain.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/chain.rs)
- Why keys are mined (Russian "about" doc): each key pair may add one new domain per day; key mining exists because making domain mining itself harder against squatters "would make the network lose its convenience" — [docs/about_ru.md](https://github.com/Revertron/Alfis/blob/master/docs/about_ru.md)
- Rate limit: a key that mined a full block in the last `NEW_DOMAINS_INTERVAL = 86400` s gets `Cooldown` for a *new* domain; renewals/updates of existing domains are exempt — [chain.rs `can_mine_identity`](https://github.com/Revertron/Alfis/blob/master/src/blockchain/chain.rs)
- Discount: updating an existing identity lowers difficulty by (weeks since last change + 1), capped at 8 bits; a renewal gets 1 bit — [chain.rs `get_identity_discount`](https://github.com/Revertron/Alfis/blob/master/src/blockchain/chain.rs)
- Measured cost by a critic (2024-02): a 24-bit key with a plain hash took 38 s on a 24-core i9-12900KF (~100 keys/hour); with ALFIS's Blakeout it took 1 h 9 min; "a GPU implementation could be much faster and this does not prevent squatting" — [issue #364](https://github.com/Revertron/Alfis/issues/364)
- Signing blocks (difficulty 16) take "about 3-10 seconds on a desktop" (maintainer) — [issue #364](https://github.com/Revertron/Alfis/issues/364)

**Expiry and renewal**
- `DOMAIN_LIFETIME = 365 days`; then `DOMAIN_RENEW_TIME = 30 days` during which the name is `Expired` but only the owner may re-mine it; after that it is `Free` for anyone. Ownership = the `signing` key of the last transaction — [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs), [chain.rs `can_mine_domain`, `is_id_available`](https://github.com/Revertron/Alfis/blob/master/src/blockchain/chain.rs)

**Consensus: "Limited Confidence Proof-of-Activity"**
- From block 35 on, every full (domain) block must be followed by at least 4 (`BLOCK_SIGNERS_MIN`) empty signing blocks from 7 (`BLOCK_SIGNERS_ALL`) keys before the next full block is allowed. The 7 are drawn pseudorandomly (seeded by the tail of the full block's signature) from past block authors with at least `height/100` authored blocks — [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs), [RFC-0001 §1.1](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0001-emergency-signers.md)
- Forks are "prevented rather than resolved": nodes rewind at most `LIMITED_CONFIDENCE_DEPTH = 4` blocks; a deeper competing block raises a `ForkDetected` event for humans and is rejected; two blocks at one index are ranked by `is_better_than` (a block with a transaction beats an empty one, then higher hash difficulty, then lower nonce) — [chain.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/chain.rs), [block.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/block.rs), [issue #364](https://github.com/Revertron/Alfis/issues/364)
- Hard-coded `CHECKPOINTS` (index, hash) in the binary; a node truncates its chain at the first checkpoint it disagrees with. One was added at 22534 on 2026-10-03 ("Fixed sync getting stuck on side branches") — [chain.rs](https://github.com/Revertron/Alfis/blob/master/src/blockchain/chain.rs), [commit log](https://github.com/Revertron/Alfis/commits/master)
- P2P: TCP port 4244, at most 15 peers, sync starts with 4+ connected nodes — [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs)

**Size and adoption (measured by the project)**
- Height 21,755 on 2026-05-05; 22,524 on 2026-07-05; 22,529 on 2026-07-11. 695 distinct block-author keys (May), 715 (July) — [RFC-0001](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0001-emergency-signers.md), [RFC-0002](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md)
- "1,391 domains ever registered, 594 still resolving at the stall date" — [RFC-0002 §6.1](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md)
- Repo: 445 stars, 44 forks, 770 commits, 65 open issues; last commits 2026-11-02 — [GitHub](https://github.com/Revertron/Alfis)

**Failures (primary sources)**
- Signer set frozen: only 16 keys pass the `height/100` (~217-225 blocks) threshold; the top 9 produce 88-92% of signing blocks; four of the top 5 keys belong to one individual; "approximately 16 keys held by 5-6 individuals" — [RFC-0001 §1.2](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0001-emergency-signers.md)
- "The eligibility filter is a ratchet": a new key "cannot sign until it is drawable, and 225 full blocks is not a realistic path"; "the pool still only shrinks" — [RFC-0002 §1.1](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md), [RFC-0003 §7](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0003-dead-key-exclusion.md)
- **Stall of 2026-07-05**: full block 22,521 got 3 of 4 signatures and stopped; RFC-0002 ("healing signatures": after 5 days, 3 days in the degraded regime, a standby pool of 7 all-time top keys + 5 recent top keys may supply the missing signatures, at least one from an anchor) was activated at that height; the block was locked on 2026-07-11, "six days for one full block"; the next window stalled again — [RFC-0002](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md), [RFC-0003 §1.1](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0003-dead-key-exclusion.md)
- Four proven-dead keys carried ~27% of draw weight, so "the 4-of-7 lock fails on roughly every other window"; RFC-0003 bans no-show keys permanently (floor of 10 eligible keys), activated at 22,529 — [RFC-0003](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0003-dead-key-exclusion.md), [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs)
- A stall destroys names: "domains whose 30-day renewal grace elapses during the stall pass irrevocably out of their owners' reach": ~22 by 2026-09-01, ~57 by 2026-10-01, ~213 by 2027-01-01 — [RFC-0002 §6.1](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md)
- RFC-0001 (draft, 2026-05-05) proposes a FROST 5-of-9 emergency key compiled into the binary that can replace the signer list: i.e. the project's own answer to committee death is a threshold "master key" — [RFC-0001](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0001-emergency-signers.md)
- The project rejected time-based quorum relaxation ("activates symmetrically on both sides of a network partition ... long irreconcilable forks") and moving-window signer eligibility (an attacker "grinds blocks for a period"; renewals are exempt from the cooldown and discounted, "making activity cheaper to fake") — [RFC-0002 §1.3](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md)
- Critique (rkfg, 2024): no difficulty adjustment and no cumulative-work rule, so a rented-compute attacker can build an alternative history and show it only to new nodes; freezing the chain by targeting 4 signers is easy; maintainer confirmed "if four signers are offline, the system freezes" and it "is not designed for network splits" — [issue #364](https://github.com/Revertron/Alfis/issues/364)
- Predecessor on Yggdrasil: Wyrd (a crawler-based `.ygg` DNS) is "deprecated in favor of blockchain based DNS - ALFIS, the crawler is stopped forever" — [howto.yggno.de](https://howto.yggno.de/en:yggdrasil:dns:wyrd)

### Inferences
- ALFIS grows only when names change: ~22.5k blocks for ~1.4k names means ~80% of blocks are signing blocks; a per-room log of thousands of names at ~200-400 bytes a claim is a few MB at most, small enough for a browser to hold whole. State size is not the problem; ordering and liveness are.
- With no coin there is no reward for signing, so signers are volunteers and decay; any "committee from history" design ratchets toward a handful of keys. A room of ephemeral browser tabs has even less of a stable population than ALFIS's home servers. A committee of members is the wrong tool; either no committee (deterministic conflict rule over a gossiped set) or external witnesses.
- Reusable from ALFIS: name stored as a hash bound to the claiming key (front-running proof without a two-step commit), PoW on the key *and* per name, one new name per key per day, lifetime + owner-only grace, discounted renewal. Not reusable: its ordering mechanism.
- ALFIS can't run in a page as is (TCP P2P, SQLite, Blakeout threads); its browser reachability is nil. No WASM build is mentioned in the repo.

### Gaps
- Chain size in bytes isn't stated in the repo docs; Blakeout's parameters (memory size) weren't read.
- No independent measurement of how many ALFIS nodes run in late 2026.

## 2. Blockchain naming with coins: Namecoin, Handshake, ENS, Emercoin, Blockstack/BNS

### Takeaway
Coin chains solve first-come with global total order (PoW or the host chain) and solve squatting with money, badly:
Namecoin's flat tiny fee produced a namespace that was almost entirely squatted, Handshake's auctions produced
speculation and a 2026 retreat of its commercial ecosystem. Their reusable ideas are mechanisms: commit-reveal,
expiry-as-key-loss-recovery, semi-expiry, grace periods with owner-only renewal, decaying premiums after expiry, and
compact authenticated-map proofs for light clients.

### Cited Findings
**Namecoin** (alive, merge-mined with Bitcoin)
- Two-step registration: `name_new` publishes a salted hash, `name_firstupdate` reveals after a "mandatory minimum delay of 12 blocks"; fee 0.01 NMC (destroyed) plus a transaction fee — [Namecoin FAQ](https://www.namecoin.org/docs/faq/)
- A name "semi-expires" (stops resolving, still owned) after 31,968 blocks (~222 days) without renewal and fully expires 4,032 blocks (~28 days) later: 36,000 blocks in all; values up to 520 bytes — [Namecoin FAQ](https://www.namecoin.org/docs/faq/)
- Why expiry: pushes unused names back, and a name whose keys are lost "eventually returns to the available pool" — [Namecoin FAQ](https://www.namecoin.org/docs/faq/)
- Light clients: Electrum-NMC (SPV, headers); header-only clients lack authenticated denial of existence; chain was ~6.06 GB in January 2020 — [Namecoin FAQ](https://www.namecoin.org/docs/faq/), [Tor onion-names survey](https://onionservices.torproject.org/research/proposals/usability/discovery/onion-names/)
- Kalodner et al. (WEIS 2015): of ~120,000 registered names, "a mere 28" were not squatted and had nontrivial content; no real secondary market; ecosystem "dysfunctional" — [paper](https://www.cs.princeton.edu/~arvindn/publications/namespaces.pdf), [CITP blog](https://blog.citp.princeton.edu/2015/05/21/an-empirical-study-of-namecoin-and-lessons-for-decentralized-namespace-design) (the blog says 196,023 names; the paper ~120,000)
- 2026: still maintained; hashrate figures of hundreds of EH/s via merged mining (sources conflict: 551 EH/s vs 487 EH/s) — [CoinWarz](https://coinwarz.com/mining/namecoin/hashrate-chart), [boerse-global, March 2026](https://www.boerse-global.de/namecoin-zensurresistenz-im-fokus/767510)
- A Nostr proof of concept resolves identities through Namecoin names (one name acting as a NIP-05 provider) — [sec-6-decentralized-dns-nostr](https://github.com/ethicnology/sec-6-decentralized-dns-nostr)

**Handshake (HNS)** (alive but shrinking)
- 10-minute blocks; Vickrey auction per name: OPEN 37 blocks (~6 h), BIDDING 720 blocks (~5 days), REVEAL 1,440 blocks (~10 days); renew within two years or the name returns to auction; transfers finalize after ~2 days, during which the owner can REVOKE; a revoked name re-auctions after 4,176 blocks (~29 days) — [hsd protocol summary](https://hsd-dev.org/protocol/summary.html)
- Land-rush control: names released over the first year by `hash(name) mod 52` weeks; Alexa top 100,000 reserved for DNSSEC-proved claims — [hsd protocol summary](https://hsd-dev.org/protocol/summary.html)
- Name state is committed in an Urkel tree (base-2 merkelized radix tree, flat-file storage, 32-byte siblings, 76-byte internal nodes, absence proofs), updated every 36 blocks (~6 h); design goal: proofs under 1 kB "even with hundreds of millions of leaves" — [urkel](https://github.com/handshake-org/urkel), [hsd protocol summary](https://hsd-dev.org/protocol/summary.html)
- 2026: Namecheap sold Namebase (January 2026; offline for migration 2026-02-01) and ended Handshake TLD support on 2026-06-10; HNS market cap in the low millions of dollars — [webhosting.today](https://webhosting.today/2026/06/11/namecheap-ends-handshake-tld-support-as-web3-domain-projects-retreat/)

**ENS** (ideas only)
- After expiry: 90-day grace period (owner-only renewal; anyone may pay to renew for the owner), then a 21-day "temporary premium" starting at $100,000,000 and decaying exponentially to $0, a Dutch auction that removes the expiry-instant race; ENS v2 proposal EP 6.43 cuts grace to 28 days — [ENS support](https://support.ens.domains/en/articles/12311757-what-happens-when-an-ens-name-expires), [EP 6.43](https://docs.ens.domains/dao/proposals/6.43/)
- Namecoin's criticism: ENS has a multisig/DAO seizure mechanism — [Namecoin FAQ](https://www.namecoin.org/docs/faq/)

**Blockstack / BNS**
- Namecoin's comparison: Blockstack relied on trusted checkpoints, ~300.79 GB vs Namecoin's 6.06 GB (January 2020), and premined names — [Namecoin FAQ](https://www.namecoin.org/docs/faq/)
- Onename (Blockstack's precursor) left Namecoin for Bitcoin, citing its weaknesses — [article mirror](https://cgecko-proxy.deepspace.workers.dev/learn/3-reasons-onename-switched-from-namecoin-to-bitcoin)

### Inferences
- A flat, tiny, one-time cost (Namecoin's 0.01 NMC; ALFIS's fixed 24 bits) doesn't stop squatting; cost has to be recurring (renewal work) and bound per identity per time (ALFIS's one name per key per day, Handshake's weekly release) to matter. In a room of thousands of names the squatting incentive is far weaker than in a global namespace, so a modest PoW plus rate limit plausibly suffices.
- Semi-expiry (stop resolving before ownership lapses) is a cheap, coin-free way to make an owner notice. ENS's decaying premium translates to coinless form as "PoW difficulty for a just-expired name starts high and decays", which blunts expiry sniping.
- Urkel-style or sparse-Merkle authenticated maps give a browser a < 1 kB proof per lookup against a 32-byte root; the open question is who signs the root in a coinless system.

### Gaps
- Emercoin/EmerDNS: no source found this session for its 2026 status or parameters. **[background, not re-verified]** EmerDNS stores names in Emercoin's NVS with a paid lifetime in days and serves `.emc/.coin/.lib/.bazar` via OpenNIC peering — check [emercoin.com](https://emercoin.com/en/documentation/blockchain-services/emerdns/emerdns-introduction/).
- BNS's state after Stacks' 2024-25 upgrades wasn't checked. Handshake's hnsd light-client numbers (header sync size, proof bytes) weren't found; HNS hashrate trend is unconfirmed.
- ENS's commit-reveal minimum (60 s) is **[background, not re-verified]** — [docs.ens.domains](https://docs.ens.domains/).

## 3. No global consensus: petnames, GNS, I2P, Tor, meshname, OpenNIC

### Takeaway
The older privacy networks all gave up one corner of Zooko's triangle rather than build consensus: GNS and I2P chose
local/delegated names, Tor still has no deployed human-readable naming after a decade of proposals, meshname made
names that are addresses. Where "first come" exists (I2P registrars, OnioNS), it is a per-registrar or per-quorum
policy, i.e. a trusted party.

### Cited Findings
**GNU Name System (RFC 9498, November 2023)**
- Zones are keys (PKEY, EDKEY); names are delegations resolved label by label from a locally configured Start Zone; zTLD names are "globally unique but not memorable", petnames are memorable but local — [RFC 9498](https://www.rfc-editor.org/rfc/rfc9498.html)
- Records are signed, encrypted blocks under a storage key derived from zone key + label (no zone enumeration); storage must take 176-byte blocks and should take >= 1024; blocks expire and are republished by the zone owner; the DHT isn't standardized (R5N suggested) — [RFC 9498](https://www.rfc-editor.org/rfc/rfc9498.html)
- Revocation carries proof of work: 32 PoWs averaging >= 22 leading zero bits, Argon2id (t=3, m=1024 KiB, p=1), base epoch 365 days, so that flooding the network with revocations is costly and a revocation can be precomputed — [RFC 9498](https://www.rfc-editor.org/rfc/rfc9498.html)
- Tor's assessment: "Global uniqueness is not guaranteed, choosing a trustworthy zone is difficult, and that choice centralizes the system" — [Tor onion-names survey](https://onionservices.torproject.org/research/proposals/usability/discovery/onion-names/)

**I2P**
- No central authority: names are local (`hosts.txt`/blockfile), spread by address-book subscriptions (one enabled by default), "host add services" (registrars) and jump services (HTTP 301 with `?i2paddresshelper=key`); the design deliberately gives up global uniqueness — [I2P naming](https://i2p.net/en/docs/overview/naming)
- First match wins locally; a subscription "could otherwise claim a new site's name before its owner does", so subscribing is trust; registrars set their own policy and may require "hashcash or signed certificates"; names max 67 chars; `.b32.i2p` (52 chars, SHA-256 of the destination) is the key-name fallback and works only while the destination is online — [I2P naming](https://i2p.net/en/docs/overview/naming)

**Tor**
- Proposal 279 (name system API, 2017) is "Needs-Revision"; the Onion Plan's appendix on it is a 2022 draft; no human-readable naming shipped except rulesets (SecureDrop onion names in Tor Browser since mid-2022) — [prop 279](https://spec.torproject.org/proposals/279-naming-layer-api.html), [Tor onion-names survey](https://onionservices.torproject.org/research/proposals/usability/discovery/onion-names/)
- OnioNS (Victors, Li, Fu, PoPETs 2017; status "Research", never deployed): a random Quorum of Tor relays keeps the records; registration is a daily commit-reveal **lottery**: every registrant submits a ticket with PoW over a threshold, winners are drawn with weight proportional to work, at most one ticket per name, a capped number of winners per day; mirrors answer with Merkle proofs incl. denial of existence; an early draft had 127 Quorum members rotating weekly — [paper](https://www.petsymposium.org/popets/2017/popets-2017-0003.pdf), [tor-dev 2015](https://lists.torproject.org/mailman3/hyperkitty/list/tor-dev@lists.torproject.org/thread/RDRQOWABF2NHRTT65XXSV7TOYQ5ZWAL7)
- OnioNS's listed costs: relay operators must take part; users "must trust relays, directory authorities, and Bitcoin" (randomness beacon) — [Tor onion-names survey](https://onionservices.torproject.org/research/proposals/usability/discovery/onion-names/)
- Namecoin for onions: "Acquiring Namecoins anonymously is difficult ... full-node clients must download the chain, header-only clients lack authenticated denial" — [Tor onion-names survey](https://onionservices.torproject.org/research/proposals/usability/discovery/onion-names/)

**Yggdrasil / cjdns**
- meshname: `<base32 of the 16-byte IPv6>.meshname`; the node at that address is the authoritative DNS server for its own zone; "there is no need for a global authority or consensus"; meant "for machines rather than human users" — [meshname protocol](https://github.com/zhoreeq/meshname/blob/master/protocol.md)

**OpenNIC**
- An alternative DNS root run by volunteers (centralized per TLD operator, not first-come by key); listed as the main alternative to ALFIS — [AlternativeTo](https://alternativeto.net/software/alfis/)

### Inferences
- The room already has meshname-equivalent names (`<key>.<tag>.p2p.internal`). GNS-style delegation is the zero-consensus upgrade: `alice.<room-registry-key>` works at once if someone holds a registry key, which is exactly the "master key" the user dislikes. Petnames on the page (a local address book, import/subscribe to another member's list) are the I2P answer and need nothing new on the wire.
- OnioNS's batch lottery is the one coinless anti-land-rush idea in the literature: decide names per period, not per instant, so a race between two claims in the same period is settled by a verifiable draw rather than by network position. It needs a shared randomness beacon and an agreed set of tickets, which is again a quorum.
- GNS's precomputed-PoW revocation is a reusable pattern for "release"/"revoke" messages that must be cheap to verify and costly to spam.

### Gaps
- SDSI/SPKI and Zooko's triangle primary texts weren't fetched. **[background, not re-verified]**: SDSI (Rivest & Lampson 1996) introduced linked local names (`alice's bob`), the ancestor of GNS delegation; Zooko's 2001 essay claims names can't be at once human-meaningful, secure and decentralized, and Namecoin is the usual counter-example (it trades in a global chain).
- I2P's registrar policies (stats.i2p, reg.i2p: how long a host must stay up, signed update commands) aren't on the page read.
- cjdns naming attempts other than meshname weren't found.

## 4. Key-addressed records and signed logs: Pkarr/BEP44, did:plc, did:webvh, KERI, IPNS, key transparency

### Takeaway
These systems store or log what a key says; none allocates scarce human names without a trusted party. They do supply
the persistence and audit pieces a room registry needs: signed, sequence-numbered records that anyone can republish
without the private key (BEP44), per-identity hash-chained operation logs with a recovery window (did:plc), and
witness thresholds (did:webvh, KERI).

### Cited Findings
**Pkarr / Mainline DHT**
- A signed DNS packet of <= 1000 bytes under an ed25519 key, stored as a BEP44 mutable item; "for discovery, not storage"; relays (HTTP) exist because browsers "cannot open UDP sockets"; JS/WASM bindings (`@synonymdev/pkarr`); claims "10+ million active nodes" on Mainline — [pkarr README](https://github.com/pubky/pkarr)
- Pkarr's own stance on human names: "Memorable names need registries, which bring centralization"; build petnames or phonebooks on top — [pkarr README](https://github.com/pubky/pkarr)
- BEP44: values > 1000 bytes may be rejected; `seq` must increase; optional compare-and-swap (`cas`); salt <= 64 bytes; "items MAY expire after 2 hours" without re-announcement, re-announce about hourly; **any node may republish with the original signature, without the private key** — [BEP 44](https://www.bittorrent.org/beps/bep_0044.html)

**did:plc (Bluesky)**
- Per-DID log of signed operations chained by `prev` CID; 1-5 rotation keys in priority order; a higher-priority key may fork history from an earlier operation within **72 hours** (recovery window); operations <= 7,500 bytes; full audit log and `/export` of all operations are public — [did:plc spec](https://web.plc.directory/spec/v0.1/did-plc)
- One central directory orders operations; it "can only deny service or misorder forks", not forge — [did:plc spec](https://web.plc.directory/spec/v0.1/did-plc)
- Governance: Bluesky announced (September 2025) an independent Swiss association to run the directory and says "we do not expect a single global directory to be the final technical architecture" — [atproto blog](https://atproto.com/blog/plc-directory-org)

**did:webvh**
- A hash-chained DID log on a web server; optional witnesses co-sign each entry and an entry without the threshold of witness signatures is invalid; watchers (optional) detect rollbacks — [The Rubric, did:webvh part 2](https://the-rubric.castos.com/episodes/verifying-a-web-of-truth-didwebvh-part-2), [W3C CCG thread, Dec 2025](https://lists.w3.org/Archives/Public/public-credentials/2025Dec/0082.html)

### Inferences
- BEP44's "anyone can republish a signed record" is the answer to "persists while the owner is offline for weeks": persistence is the *room's* job (every member that has seen a valid claim can re-announce it), expiry is in the signed record itself (a `not-after`), and the store needs no trust. On Nostr the same holds: an event is self-certifying and any member can re-publish it to any relay.
- Mainline itself is out for a browser page without a relay (UDP), and Pkarr's hours-long retention would need an always-on republisher; neither fits "no component of ours". Public Nostr relays with stored (replaceable/addressable) events are the browser-reachable equivalent, with retention at each relay's whim.
- did:plc shows the smallest trusted role that makes first-come work: an orderer that can only censor or reorder, with a public log so misbehaviour is provable. The user's 2026-10-18 sketch (Merkle log on always-on relays + witnesses) is this design; its cost is exactly an always-online component.
- A per-name operation log (claim -> update -> renew -> release, each signed by the current key, each naming its predecessor's hash) makes owner-only update/release verifiable by anyone with no consensus at all. Consensus is needed for one thing only: which of two *first* claims wins.

### Gaps
- KERI (witness receipts, KAACE, duplicity detection, "first seen" rule): no source retrieved. **[background, not re-verified]**: a KERI controller designates witnesses that receipt each event; validators apply "first seen wins" and treat two signed versions of one event as provable duplicity — check [KERI spec](https://trustoverip.github.io/tswg-keri-specification/).
- CONIKS / key transparency: only listed by Tor as unevaluated. **[background, not re-verified]**: a provider commits to a Merkle prefix tree of name->key bindings each epoch; clients audit their own entry and cross-check roots; it presupposes a provider per namespace — [CONIKS paper](https://www.usenix.org/conference/usenixsecurity15/technical-sessions/presentation/melara).
- IPNS/DNSLink, Secure Scuttlebutt room aliases, Matrix room aliases, Bluesky handles: not fetched. **[background, not re-verified]**: IPNS names are keys (records with sequence numbers and validity, republished to the DHT); DNSLink, Bluesky handles (DNS TXT `_atproto` or `/.well-known/atproto-did`), NIP-05, SSB room aliases and Matrix aliases (`#alias:server`, first-come on that homeserver) all borrow uniqueness from DNS or from one server.

## 5. Naming on Nostr

### Takeaway
No deployed Nostr scheme does coinless, serverless first-come names: NIP-05 delegates to DNS, Nomen anchors order in
Bitcoin, and the one draft that avoids both (FIND) replaces it with votes by trusted registry operators. The
recurring reason is that relays don't order events and `created_at` is chosen by the publisher.

### Cited Findings
- NIP-13 defines PoW as leading zero bits of the event ID, for spam deterrence only; it is still a draft — [NIP-13](https://nostr.co.uk/nips/nip-13/)
- Nomen: a claim is a Bitcoin `OP_RETURN` with a 20-byte Hash-160 of `name + pubkey`; records are Nostr events; "uses the ordering guarantees of the Bitcoin blockchain as the arbitration method for opposing claims"; "the indexers are the arbitrators of consensus" and ignore later duplicates; a public indexer ran at nomenexplorer.com; v0.4.0 has indexers publish names to relays — [ursuscamp/nomen](https://github.com/ursuscamp/nomen), [Stacker News](https://stacker.news/items/182602)
- Criticism of Nomen: breaks if someone claims many names cheaply and never publishes the matching event — [Stacker News](https://stacker.news/items/182604)
- FIND draft NIP (ORLY relay project): registration proposals (kind 30100) and registry attestations (kind 20100); "trust-weighted attestations from registry service operators to achieve Byzantine fault tolerance without requiring centralized coordination or proof-of-work" — [next.orly.dev docs/names.md](https://git.imwald.eu/silberengel/next.orly.dev/src/tag/v4.1.0/docs/names.md) (search snippet; the page itself returned 404 when fetched)
- Unofficial drafts exist: "uNIP-53: Nostr-based domain registration system" (2023-03-22), "uNIP-DID" (2023-02-21) — [nip-index](https://codeberg.org/nostr/nip-index)
- Spaces (Bitcoin) explicitly rejects first-come for auctions — [Stacker News](https://stacker.news/items/1513125)

### Inferences
- Nothing to adopt wholesale; a rooms registry on Nostr would be new work. The pieces are standard: addressable/replaceable stored events as the persistence layer, NIP-13-style PoW over the claim, any member re-publishing.
- Because relays can't timestamp trustworthily, "first" must be defined without a clock of record. Options seen in this survey: (a) an external chain (ruled out), (b) a committee/witness vote (FIND, OnioNS, ALFIS, did:plc), (c) a deterministic rule over the set of valid claims every node eventually sees (e.g. most accumulated work, or lowest hash within a period), accepting that a name is only "probably final" after a settling time.

### Gaps
- FIND's exact timings, expiry and trust-weight rules couldn't be read (404). uNIP-53's content wasn't read. Nomen's maintenance status in 2026 is unknown.
- No source found for any Nostr name registry using PoW alone for ordering; absence of evidence, not proof none exists.

## 6. Research on coin-free naming and DNS over DHTs

### Takeaway
The DHT-DNS line (DDNS, CoDoNS) addressed storage and lookup of names someone else allocated and never reached
production; the literature has no accepted coin-free, committee-free first-come allocator. OnioNS's PoW-weighted
lottery and ALFIS are the two concrete coinless attempts, and both lean on a quorum.

### Cited Findings
- CoDoNS (Ramasubramanian & Sirer, SIGCOMM 2004): DNS on Pastry with Beehive proactive replication exploiting Zipf query popularity; its paper says DDNS (on Chord) suffers "high lookup latencies" from O(log N) hops; it kept DNSSEC-signed data from the existing hierarchy, i.e. it didn't allocate names — [CoDoNS paper](https://www.cs.cornell.edu/people/egs/beehive/codons-sigcomm04/node1.html)
- Operator reception (2006 dns-operations): "the DHT people were looking for an application, and DNS looked natural to them, but it isn't at all" — [dns-operations](https://lists.dns-oarc.net/pipermail/dns-operations/2006-April/000507.html)
- Kalodner et al.'s lesson for namespace design: squatting dominates when registration is cheap and flat — [paper](https://www.cs.princeton.edu/~arvindn/publications/namespaces.pdf)
- OnioNS: PoW threshold as barrier to entry plus a work-weighted lottery "to limit the rate of domain registration" and blunt land rushes — [paper](https://www.petsymposium.org/popets/2017/popets-2017-0003.pdf)

### Inferences
- DHT lookups (seconds, multi-hop, churn-sensitive) are a poor fit for browser tabs anyway; with thousands of names the whole registry (thousands x a few hundred bytes) fits in each member's memory, so "replicate everything, look up locally" beats any DHT and meets < 2 s trivially once synced; first sync from relays is the latency to budget.

### Gaps
- Cox, Muthitacharoen & Morris, "Serving DNS using a Peer-to-Peer Lookup Service" (IPTPS 2002) wasn't retrieved; **[background, not re-verified]** it concluded a DHT DNS has worse latency and loses DNS's administrative fault isolation.
- No post-mortem found on why CoDoNS stopped.

## 7. Wish list against the systems, and lessons on squatting, expiry and renewal races

### Takeaway
No surveyed system ticks every box. The boxes "unpermissioned first-come" + "no coin" + "no always-on party" are met
together only by ALFIS, and it met them by growing an informal always-on committee that then failed. Everything else
either uses a coin, a trusted orderer, or gives up global first-come.

### Cited Findings
Matrix (Y = yes, N = no, ~ = partly), each row resting on the sources cited in sections 1-6:

| System | Human names | First-come by key | No coin | No trusted/always-on party | Survives owner offline weeks | Expiry + renewal | Browser-reachable | Health 2026 |
|---|---|---|---|---|---|---|---|---|
| ALFIS | Y | Y | Y | ~ (16 signer keys, checkpoints) | Y | 365 d + 30 d grace | N | alive, stalled July 2026 |
| Namecoin | Y | Y | N | Y | Y | 36,000 blocks | N (needs gateway) | alive, niche |
| Handshake | Y (TLDs) | auction | N | Y | Y | 2 years | N (gateway) | declining |
| ENS | Y | Y | N | ~ (DAO) | Y | yearly + 90 d grace + 21 d premium | via RPC provider | alive |
| GNS | local/delegated | per zone | Y | Y (but zone owner) | needs republish | record expiry | N | specified (RFC 9498), small |
| I2P | local | per registrar | Y | registrars | Y | registrar policy | N | alive |
| OnioNS | Y | lottery | Y | Quorum of relays | Y | n/a | N | never deployed |
| meshname | N (keys) | n/a | Y | Y | N (node must answer) | n/a | n/a | idle |
| Pkarr | N (keys) | n/a | Y | Y (relays for browsers) | N (republish hourly) | 2 h DHT TTL | via relay | active |
| did:plc | N (DIDs) | n/a | Y | N (directory) | Y | none | Y (HTTPS) | active, Swiss association forming |
| Nomen | Y | Y (Bitcoin order) | N | indexers | Y | none found | via indexer | unknown |
| NIP-05 | Y | DNS | Y | N (web server) | Y | DNS | Y | ubiquitous |

- Lifecycle numbers worth copying: Namecoin semi-expiry 222 d then 28 d — [Namecoin FAQ](https://www.namecoin.org/docs/faq/); ALFIS 365 d + 30 d owner-only — [constants.rs](https://github.com/Revertron/Alfis/blob/master/src/commons/constants.rs); ENS 90 d grace then 21 d decaying premium — [ENS support](https://support.ens.domains/en/articles/12311757-what-happens-when-an-ens-name-expires); Handshake revoke -> ~29 d lockout — [hsd](https://hsd-dev.org/protocol/summary.html); did:plc 72 h recovery window — [did:plc spec](https://web.plc.directory/spec/v0.1/did-plc)
- A liveness failure during grace periods permanently strips owners (ALFIS: ~213 names at risk by 2027-01-01) — [RFC-0002 §6.1](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md)
- Renewals that are cheaper and unthrottled become a way to fake activity and weight — [RFC-0002 §1.3](https://github.com/Revertron/Alfis/blob/master/docs/rfc/0002-healing-signatures.md)

### Inferences
- **What the room can take, piece by piece:** (1) claim = signed record binding `H(name)` to a key with PoW (ALFIS, NIP-13 form), which is front-running proof without commit-reveal; (2) per-name hash-chained operation log for update/renew/release (did:plc); (3) persistence by any-member republish of self-certifying records to public relays, with expiry inside the record (BEP44, GNS); (4) per-key rate limit and key PoW against bulk squatting (ALFIS); (5) lifetime + owner-only grace + harder-then-decaying PoW for strangers after grace (ALFIS, ENS); (6) local full replica instead of a DHT (section 6); (7) petnames/address-book import as the fallback that needs no agreement (I2P, GNS).
- **The unsolved piece is ordering two conflicting first claims without a committee.** Candidates consistent with this survey: a deterministic, clock-free tiebreak over the gossiped claim set (e.g. more work wins, ties by lowest hash) with a settling period before a name is treated as final, in the spirit of OnioNS's period-based draw. Its known weakness is ALFIS critic rkfg's: with fixed difficulty and no cumulative chain, a late attacker with more compute can out-work an existing claim unless *age* counts, and age needs a witness. Honest options to present: accept "most accumulated renewal work wins" (owner's periodic renewals compound, an attacker must redo it all), or accept light external witnesses (relay-seen timestamps from several independent relays, OpenTimestamps), or accept the room master key.
- Expiry lengths should be set against the churn: owners offline "for weeks" suggests a lifetime of months with a grace of weeks; renewal should be possible long before expiry (so a brief visit suffices) and a renewal must be a full-cost, rate-limited operation or it becomes cheap weight.
- A room-scoped namespace caps the prize: unlike Namecoin there is no market for names, so Kalodner-style mass squatting needs only to be made annoying (per-key daily limit + key PoW), not economically impossible.

### Gaps
- No measurements exist for browser (WASM, possibly WebGPU) PoW rates against native/GPU attackers for a memory-hard function; the asymmetry decides what difficulty is tolerable for a tab. This needs an experiment, not a citation.
- Retention of stored events on the public "anything goes" Nostr relays over weeks, for a custom kind, is unmeasured here.
