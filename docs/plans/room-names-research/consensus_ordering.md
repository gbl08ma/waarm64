# Consensus and ordering mechanisms for "who registered a name first" in a coinless, permissionless, high-churn browser P2P network (state: November 2026)

Reading notes for the writer:

- Setting (from the repo's `docs/networking/rooms.md` and `docs/plans/networking-p2p.md`): a room has no owner, no membership list, free identities (a fresh WireGuard key per connection), members are browser tabs, sometimes nobody is online, and the room link already names a short list of infrastructure (up to 8 Nostr relays, up to 8 DERP regions). The plan doc's own sketch for names is "one append-only Merkle log on always-on relays with independent witnesses ... optionally anchored with OpenTimestamps" plus did:plc-like per-TLD logs.
- "Fetched" = read this session. "Recalled" = a well-known primary source whose URL I give but did not re-fetch this session; treat numbers from those as needing a check before they are printed as fact.
- Verdicts are in each section's Inferences, under "Suitability". Cost arithmetic is mine and is marked as such.

## 1. Nakamoto-style proof-of-work chains without a coin (ALFIS, merged mining, per-name PoW, checkpointing)

### Takeaway
A coinless PoW chain has no honest hashpower floor: its security is whatever the few honest laptops contribute, so anyone with one GPU or a few rented servers out-mines it. The one deployed coinless name chain (ALFIS) does not rely on PoW for ordering at all: PoW is a per-domain spam fee, and ordering/finality comes from 4-of-7 signatures by "senior" keys, with hard-coded checkpoints and manual resyncs when that fails.

### Cited Findings

ALFIS (deployed since 2021, Rust, native nodes, no browser node):
- Self-description: "a minimal blockchain without cryptocurrency"; 10 zones (.anon, .btn, .conf, .index, .merch, .mirror, .mob, .screen, .srv, .ygg) — [Revertron/Alfis README](https://github.com/Revertron/Alfis)
- Consensus constants in the code: `DOMAIN_DIFFICULTY` 24, `SIGNER_DIFFICULTY` 16, `ORIGIN_DIFFICULTY` 28, `KEYSTORE_DIFFICULTY` 23; `BLOCK_SIGNERS_ALL` 7, `BLOCK_SIGNERS_MIN` 4, `LIMITED_CONFIDENCE_DEPTH` 4; `NEW_DOMAINS_INTERVAL` 86,400 s (one new domain per key per day); `DOMAIN_LIFETIME` 365 days; `DOMAIN_RENEW_TIME` 30 days (owner-only window after expiry) — [constants.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/commons/constants.rs)
- There is no difficulty adjustment and no cumulative-work fork choice: a domain block needs a fixed difficulty (24, minus a discount of up to 8 for renewals/recent identities); a competing block deeper than 4 blocks is "Bad"; a block more than 60 s in the future of local time is rejected — [chain.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/blockchain/chain.rs)
- Signers: for each domain ("full") block, 7 signer keys are drawn deterministically from the chain's own history (keys that already authored blocks; minimum block count `index/100` past block 855); they "sign" by mining empty blocks at difficulty 16; a full block is locked after 4; the next full block is rejected unless the previous one is locked — [chain.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/blockchain/chain.rs)
- Domain states in code: alive until `timestamp + DOMAIN_LIFETIME`; then a grace period of `DOMAIN_RENEW_TIME` in which only the owner can renew; then free for any key — [chain.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/blockchain/chain.rs)
- Author's statement of the design: prevent forks instead of resolving them; nodes rewind only ~4 blocks; "If four signers are offline, then the system is frozen and waits for them"; signer blocks take "Just 3-10 seconds on decent desktop"; on the offline-signer problem: "I didn't find the solution to this" (Feb 2024) — [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364)
- Since then the code gained "healing" (RFC-0002: after `HEALING_TIMEOUT` = 5 days, or 3 days once healed, a standby pool of the top 7 keys by all-time block count plus 5 recent keys may sign; one anchor signature suffices, `HEALING_ANCHORS_MIN` = 1), signer bans (RFC-0003), a hard-coded checkpoint at block 22534, and a list of always-rejected hashes — [constants.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/commons/constants.rs), [chain.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/blockchain/chain.rs)
- In May 2026 the author's answer to a user's sync problem was to update, "delete current blockchain and sync it" — [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364)
- A critic's measurements and attack sketch in the same issue: a 24-zero-bit SHA-256 key took 38 s on 24 cores of an i9-12900KF (~100 keys/hour); the Blakeout variant took 1 h 9 min; since the key PoW is paid once and then unlocks one registration per day forever, "1 domain per day" does not stop squatting with many keys; with no difficulty adjustment the cost is "known and predictable"; an attacker only needs to capture the handful of most-used signer keys ("4-of-7") — [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364)

PoW chains with little hashpower, rented hashpower, merged mining:
- Ethereum Classic was 51%-attacked three times in August 2020 with hashpower rented from NiceHash; one attack reportedly returned >2,800% on ~$192,000 of rented hash; hourly attack-cost estimates quoted at the time ranged from ~$3,800 to ~$12,000 — [Decrypt](https://decrypt.co/41492/rented-hash-power-huge-problem-for-proof-of-work-etc-labs-ceo), [Forkast](https://forkast.news/hash-power-51-attack-rent-huge-vulnerability-proof-of-work-blockchain/)
- Vertcoin's December 2019 reorg was done with rented Lyra2REv3 hashrate from NiceHash (community analysis, not an official post-mortem) — [metalicjames gist](https://gist.github.com/metalicjames/f2acdb9ef448ec5298173b36c7c54133)
- Merged mining did not save Namecoin from concentration: "a single miner with well over 51% of the compute power for months" — [Blockstack, USENIX ATC'16](https://www.cs.princeton.edu/~mfreed/docs/blockstack-atc16.pdf); three different pools each held ~80% at some time — [J. Rand, QCon London 2017 slides](https://qconlondon.com/london-2017/system/files/presentation-slides/qcon_slides_-_jeremy_rand.pdf)
- Namecoin's namespace was almost entirely squatted: of ~120,000–196,000 registered names only 28 were non-trivially used (the two counts are from the paper and a blog summary of it) — [Kalodner et al., WEIS 2015](https://www.cs.princeton.edu/~arvindn/publications/namespaces.pdf), [CITP blog](https://blog.citp.princeton.edu/2015/05/21/an-empirical-study-of-namecoin-and-lessons-for-decentralized-namespace-design)
- Selfish mining: a pool with less than half the power can earn more than its share by withholding blocks; the paper's threshold is 1/4 to 1/3 depending on network position (recalled) — [Eyal & Sirer, arXiv:1311.0243](https://arxiv.org/abs/1311.0243)

### Inferences
- **Scale of the honest side.** ALFIS's hard-coded checkpoint sits at block 22534 after roughly five and a half years of operation, i.e. on the order of 10 domain+signing blocks a day. A chain this small has no meaningful cumulative work; ALFIS's real security is the signer set plus the developer's checkpoints. That is a federated design wearing PoW as a rate limit, and it is the honest lesson from the only coinless name chain in production.
- **Why "heaviest chain" fails here.** With no coin there is no miner revenue, so honest work is only what registrants spend on their own claims, and that is zero while nobody is registering. Difficulty adjustment makes it worse: when participation falls to a few tabs, difficulty falls with it, and a returning attacker rewrites as far back as the lowest-difficulty stretch allows. Long-range rewrites are cheap in exactly the "nobody online for a week" case the room must survive. Checkpointing fixes it only by introducing someone whose checkpoints are believed (developer, room key, or a committee), which is the thing the design wanted to avoid.
- **Merged mining** means depending on a cryptocurrency's miners and getting them to include our commitments; without a reward they have no reason to. Excluded by the no-cryptocurrency constraint, and Namecoin shows it centralizes anyway.
- **Per-name PoW "heaviest claim wins"** is not first-come: the owner of a name is whoever has spent the most, at any later time. With a browser-vs-native gap of roughly 2–8x per core and attackers having hundreds of cores (section 9), any desirable name is stealable for cents to dollars. A cumulative variant (renewals add work; a challenger must exceed the total) gives incumbents only a linear head start: an attacker with 1,000x the owner's hash rate overtakes a year of the owner's work in under 9 hours.
- **Per-registration PoW as a spam fee** (ALFIS's use, NIP-13's use) is sound and cheap to verify, but only prices bulk squatting; it decides nothing about order.
- **Suitability:** a PoW chain for ordering: unsuitable (tiny hashpower, empty-network rewrites, browsers are the worst miners). PoW per claim for anti-spam: suitable as a component. ALFIS's lifecycle rules (365-day lifetime, 30-day owner-only renewal window, one new name per key per day, renewal discount) are a directly reusable, production-tested parameter set. ALFIS's signer mechanism: instructive but not copyable as is (froze when 4 signers were offline; needed healing rules, bans, a checkpoint and manual resyncs).

### Gaps
- No official ALFIS specification was found; the mechanics above are from source code and an issue thread. Chain size on disk and node count are unknown.
- The exact age of block 22534 was not established; the blocks-per-day figure is an estimate.
- Blakeout's GPU/ASIC resistance has no independent analysis that I found.
- No measured figures for difficulty-adjustment attacks (timewarp etc.) on coinless chains; none exist in production to measure.

## 2. Feeless DAG ledgers with per-transaction PoW (Nano, IOTA)

### Takeaway
In both Nano and IOTA, per-transaction PoW is only a rate limit; conflict resolution comes from token-weighted voting (Nano) or from a coordinator and later stake (IOTA). Remove the token and what is left is a data structure (per-account chains) and a spam fee, not an ordering mechanism.

### Cited Findings
- Nano: representatives vote on each block; confirmation needs ">67% of online vote weight"; a principal representative needs ≥0.1% of online weight; weight is delegated account balance; forks can only come from the account owner (bad software or double-spend); typical confirmation under 1 s; a block is ~200 bytes — [Nano docs, ORV](https://docs.nano.org/protocol-design/orv-consensus/)
- Nano's PoW: one nonce per block, "a few seconds" to compute, negligible to verify, not covered by the signature (so it can be delegated or precomputed); it makes spam cost linear; since V27 prioritization is by 63 account-balance buckets, least-recently-used account first within a bucket — [Nano docs, spam/work/prioritization](https://docs.nano.org/protocol-design/spam-work-and-prioritization/)
- Nano pruning: the design allows pruning to one block per account plus pending; an experimental implementation shrank a ledger from 23.8 GB to 7.5 GB (2020), shipped as experimental in V22 — [nano-node issue #1094](https://github.com/nanocurrency/nano-node/issues/1094), [Nano docs, ledger](https://docs.nano.org/protocol-design/ledger/)
- IOTA: the original Tangle relied on the Coordinator, a central node issuing milestones; it was replaced by a validator committee with the 2023 Stardust upgrade, and IOTA Rebased (live 5 May 2025) is delegated proof-of-stake with Mysticeti consensus and a capped validator set (sources give ~50 initially, up to 100–150) — [IOTA blog, 2025 review](https://blog.iota.org/iota-2025-review/), [IOTA blog, Rebased](https://blog.iota.org/iota-rebased-fast-forward/)
- The IOTA 2.0 research design used "mana" (derived from token holdings/activity) for Sybil protection — [IOTA Tangle 2.0, arXiv:2209.04959](https://arxiv.org/pdf/2209.04959)

### Inferences
- Nano's lattice works without global ordering only because each account chain has one writer (section 5): the only conflicts are an owner equivocating against itself. A name claim is a conflict between two different writers, which the lattice has no rule for other than the vote, and the vote is weighted by money.
- Reusable without a token: (a) one signed hash chain per name/owner, so updates and renewals after the first claim need no consensus, only fork detection (an owner who forks its own chain can be punished deterministically); (b) per-block PoW outside the signature so a weak device can delegate it; (c) pruning to the head block per chain; (d) Nano's later lesson that PoW alone did not stop spam and prioritization by a scarce resource was added. Not reusable: vote weight. Any substitute weight (key age, mined key bits, uptime) is covered in section 7.
- IOTA's history is itself evidence: a feeless DAG with per-transaction PoW ran for years only with a central coordinator, and the eventual replacement was stake, not a coinless mechanism.
- **Suitability:** as a consensus, unsuitable (the token is the mechanism). As a ledger shape (per-name chains, head-only pruning), suitable and proven in production.

### Gaps
- Nano's fork-resolution and quorum doc sections are marked work-in-progress, so the precise handling of prolonged partitions was not confirmed from the docs.
- Whether "mana" survives in any form in IOTA Rebased was not confirmed.
- No GPU-seconds-per-block figure for Nano's work threshold was found this session.

## 3. State pruning and compact chains (state commitments, snapshot sync, superlight clients, recursive SNARKs)

### Takeaway
Bounded state is the easy part: a name registry with expiry is naturally a key-value map whose size is the number of live names, and an authenticated map (sparse Merkle/Urkel tree) plus "keep only the state and its root" gives constant-size sync and sub-kilobyte proofs. The compact-chain literature only compresses the proof of a chain's work or validity; it does not create security that the underlying consensus lacks.

### Cited Findings
- Handshake commits the name tree root in each 236-byte header, updates the tree every 36 blocks (~6 hours) to bound history bloat, has 10-minute blocks, and names must be renewed within two years or they return to auction — [Handshake protocol summary](https://hsd-dev.org/protocol/summary.html)
- Urkel tree: designed for proofs under 1 KB even with hundreds of millions of leaves; sibling nodes are a constant 32 bytes; an early measurement gave ~800-byte proofs, 1–2 ms proof creation, average depth 27–28 bits — [urkel package](https://www.npmjs.com/package/urkel), [Stanford Blockchain Conference 2019 transcript](https://diyhpl.us/wiki/transcripts/stanford-blockchain-conference/2019/urkel-trees), [2019 gist](https://gist.github.com/Haseeb-Qureshi/62380ae5d50898c6174fba31cef472eb)
- FlyClient: Merkle Mountain Range commitments plus probabilistic sampling; a logarithmic number of headers; an Ethereum sync proof under 500 KB, ~6,600x smaller than SPV (4 GB of headers in 2019); works with variable difficulty; NIPoPoWs are succinct only when no adversary influences the honest chain and need fixed difficulty — [FlyClient, ePrint 2019/226](https://eprint.iacr.org/2019/226)
- "Mining in Logarithmic Space" (Kiayias, Leonardos, Zindros) lets miners themselves keep only polylogarithmic chain data — [ePrint 2021/623](https://eprint.iacr.org/2021/623)
- Mina: recursive proofs prove one block at a time; browser proving runs on a WASM backend capped at a 4 GB address space; the native prover (Node only) is ~2–2.5x faster; raw Kimchi proving times are ~0.6 s at 2^11 gates, 3.3 s at 2^15, 6.3 s at 2^16 (hardware unstated, no recursion) — [o1js native prover docs](https://docs.o1labs.org/o1js/advanced-concepts/native-prover), [o1-labs/proof-systems](https://github.com/o1-labs/proof-systems)
- Mina nodes need 32 GB of RAM at peak, with a target of 16 GB — [o1Labs performance roadmap](https://www.o1labs.org/blog/mina-performance-roadmap)
- Mina's chain proof is a constant ~22 KB (recalled) — [Coda/Mina paper, ePrint 2020/352](https://eprint.iacr.org/2020/352)
- Nano prunes to one block per account (see section 2) — [Nano docs, ledger](https://docs.nano.org/protocol-design/ledger/)
- ALFIS expires a domain after 365 + 30 days (it becomes free to claim), which bounds live state though not the chain — [chain.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/blockchain/chain.rs)

### Inferences
- **Size of our state.** A record of name hash (32 B), owner key (32 B), expiry and sequence (16 B), signature (64 B) and a small payload is ~200–300 bytes; 100k names is 20–30 MB raw, 1k names a few hundred KB. That fits IndexedDB/OPFS and syncs in seconds; a Merkle proof over 100k leaves is ~17 hashes, ~550 bytes. Bounded growth follows from expiry alone if history is not needed for validity.
- **What history is for.** Old blocks/entries are needed only to (a) verify the head is the legitimate one and (b) resolve disputes. If the head is authenticated by something other than replaying history (witness cosignatures, a checkpoint, a SNARK), history can be dropped. So the pruning question reduces to "what authenticates the current root", i.e. back to the ordering mechanism.
- **Superlight clients (FlyClient/NIPoPoW)** prove "this chain has the most work" compactly. With tiny total work that statement is worthless; they add nothing here.
- **Recursive SNARKs** could prove "this state root follows from valid transitions since genesis" (signatures valid, owner-only updates, expiry respected), letting all history be dropped. They do not prove uniqueness of the history (an attacker can produce an equally valid proof of a different history), so they do not replace ordering. Cost realism: seconds per small proof natively and a multi-GB WASM heap in a tab that already hosts an emulator; signature verification inside a circuit is expensive. Engineering weight is far beyond the benefit for a state of tens of MB.
- **Mimblewimble cut-through, UTXO accumulators, stateless clients, assumeutxo** all serve the same end (sync from a commitment instead of history) for UTXO sets; for a key-value registry the plain authenticated map already does it. assumeutxo's trust model (a snapshot hash shipped with the software, verified in the background) maps to "a state root the room trusts from witnesses".
- **Suitability:** authenticated key-value state with a root (Urkel/sparse Merkle), expiry-based pruning, head-only per-name chains: suitable, proven in production (Handshake, Nano). FlyClient/NIPoPoW: not useful. Recursive SNARK chain: not justified in a browser beside an emulator.

### Gaps
- No measured browser (WASM) proving time for a recursive Mina/o1js proof was found; only native-ish Kimchi numbers and the 4 GB cap.
- No current independent benchmark of Urkel proof sizes at Handshake's present tree size.
- Mimblewimble, assumeutxo and stateless-client claims above are from general knowledge; no sources were fetched for them.

## 4. Sleepy/dynamic-availability consensus, proof of space/time, VDFs, elapsed time, personhood

### Takeaway
The sleepy-model protocols tolerate nodes coming and going, but every one of them replaces PoW with a Sybil-resistant roster (a PKI or stake) and assumes that at all times the awake honest participants outnumber the corrupt ones; neither holds in a room with free identities and empty periods. VDFs prove elapsed sequential work, not order, and the browser is the slowest VDF evaluator in the room.

### Cited Findings
- Sleepy consensus: honest nodes are "alert" or "sleepy"; secure while alert nodes outnumber corrupt ones at any time; drops proof-of-work; assumes a PKI and a common reference string — [Pass & Shi, ePrint 2016/918](https://eprint.iacr.org/2016/918)
- Permissionless consensus is provably harder than permissioned (lower bounds) — [Pass & Shi, "Rethinking Large-Scale Consensus", ePrint 2018/302](https://eprint.iacr.org/2018/302)
- Goldfish is a synchronous protocol safe and live under variable participation; its vote expiry is fragile under network delay; and no protocol can have both liveness under dynamic participation and safety under partitions — [arXiv:2302.11326](https://arxiv.org/pdf/2302.11326), [SoK: Speedy Secure Finality, arXiv:2512.20715](https://arxiv.org/html/2512.20715v1)
- Snow White, Ouroboros Genesis and Goldfish are proof-of-stake protocols: participation weight is stake (recalled) — [Snow White, ePrint 2016/919](https://eprint.iacr.org/2016/919), [Ouroboros Genesis, ePrint 2018/378](https://eprint.iacr.org/2018/378), [Goldfish, arXiv:2209.03255](https://arxiv.org/abs/2209.03255)
- VDF hardware gap: a 28 nm ASIC for class-group squaring is reported 3.6x (ePrint/IEEE versions) to 9.1x (TCHES version) faster than optimized C++ on a fast CPU — [Zhu et al., ePrint 2022/755](https://eprint.iacr.org/2022/755), [TCHES](https://tches.iacr.org/index.php/TCHES/article/view/9958)
- Chia's ASIC timelords: 800,000–1,000,000 iterations/s forecast, against ~260,000 for the fastest non-ASIC timelords (about 4x), company-reported — [Chia blog, Oct 2023](https://www.chia.net/2023/10/26/were-going-to-ludicrous-speed/), [Chia, June 2024](https://www.chia.net/2024/06/10/global-expansion-of-chia-network-security-with-successful-asic-timelord-rollout/), [Chia timelord docs](https://docs.chia.net/timelord-architecture/)

### Inferences
- **Sleepy model vs a room.** Two assumptions break. (1) A roster: sleepy protocols elect leaders from a known key set; with free keys an attacker is the majority of the roster. Stake is the usual fix and is excluded. (2) Honest majority among the awake at every moment: when one honest tab and one attacker are online, or nobody is, the attacker is the majority. The availability/finality dilemma also bites directly: a dynamically available protocol necessarily lets each side of a partition keep registering, and reorganizes one side on merge.
- **Ouroboros Genesis's contribution** (a chain-selection rule that lets a newcomer pick the right chain without checkpoints by comparing block density just after the fork point) depends on honest stake majority in that window; with free identities the density is forgeable.
- **VDF "age" claims.** A VDF proves that T sequential steps followed its seed. Seeded with a public beacon value it proves "not before"; it never proves "not after", and it does not prove the claim was published. Per-name VDF chains ("claim strength accumulates with age") need the owner to compute continuously, which contradicts owner absence for weeks and a closed tab, and cost one core per name. The speed gap stacks: WASM big-integer arithmetic vs native assembly, then ~4–9x for an ASIC, so an attacker manufactures "a year of browser time" in weeks. Verification (Wesolowski/Pietrzak proofs) is cheap in a browser; evaluation is not competitive.
- **Proof of space (Chia)** needs tens to hundreds of GB of plotted disk per identity and timelords running VDFs; a browser tab cannot plot or hold that, and space is as rentable as hashpower.
- **Proof of elapsed time** (Intel SGX-based) needs trusted hardware attestation, unavailable to web pages, and SGX has a long break history. Not applicable.
- **Proof of personhood** (biometrics, social graphs, government ID) would give one-identity-one-vote and make BFT committees sound, but it is excluded by the room's no-account, pseudonymous design.
- **Suitability:** sleepy/PoS-family consensus: unsuitable without stake or a roster. VDF/PoSpace/PoET: unsuitable. If the room is given a roster by other means (section 7), ordinary BFT or a witnessed log is simpler than sleepy consensus.

### Gaps
- No source was found stating an impossibility specifically for "sleepy consensus with free identities and no resource"; the argument above is inference from the protocols' stated assumptions and the Sybil literature.
- No WASM VDF evaluation benchmark was found; the browser gap is argued, not measured.
- Chia plot sizes and PoET details are from general knowledge, not fetched.

## 5. Avoiding global consensus: BFT CRDTs, consensus-free transfers, deterministic conflict rules, commit-reveal

### Takeaway
First-come registration of a user-chosen name is a uniqueness constraint, and that is the textbook example of what cannot be done without consensus or Sybil countermeasures. Everything after the first claim (updates, renewals, transfers by the owner) is single-writer and needs no consensus, only equivocation detection. Deterministic tie-break rules give convergence, but they define "winner" as something other than "first", and each such rule is a theft rule for whoever can game it.

### Cited Findings
- Kleppmann's BFT CRDTs tolerate "any number of Byzantine nodes (making it immune to Sybil attacks)" and guarantee strong eventual consistency by addressing updates by hash in a DAG; the approach "makes no assumption about the number of Byzantine nodes", unlike 3f+1 schemes that "cannot be deployed in open peer-to-peer systems, since they would be vulnerable to Sybil attacks" — [Kleppmann, "Making CRDTs Byzantine Fault Tolerant", PaPoC 2022](https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf)
- The limit, as a theorem: "it is possible for a peer-to-peer database to be immune to Sybil attacks if and only if all of the possible transactions are I-confluent (invariant confluent) with respect to all of the application's invariants" — [Kleppmann & Howard, "Byzantine Eventual Consistency and the Fundamental Limits of Peer-to-Peer Databases", arXiv:2012.00472](https://arxiv.org/abs/2012.00472)
- Uniqueness is the paper's first counter-example: if two transactions "create data items with the same value in that attribute, then {T1,T2} is not I-confluent ... each of T1 and T2 individually preserves the constraint, but the combination of the two does not"; its table lists "Uniqueness of an attribute" as unsafe when an update "inserts tuple with user-chosen value of that attribute (may be safe if the value is determined by the hash of the message containing the update)" — [arXiv:2012.00472](https://arxiv.org/abs/2012.00472)
- The same paper's advice for mixed applications: implement the I-confluent parts without Sybil countermeasures and use consensus only for the rest, e.g. "an auction could aggregate bids in an I-confluent manner, and only require consensus to decide the winner" — [arXiv:2012.00472](https://arxiv.org/abs/2012.00472)
- Asset transfer with one owner per account has consensus number 1 (no consensus needed); an account shared by k owners has consensus number k — [Guerraoui et al., "The Consensus Number of a Cryptocurrency", PODC 2019, arXiv:1906.05574](https://arxiv.org/abs/1906.05574)
- FastPay and Astro build payments on Byzantine consistent/reliable broadcast instead of consensus, but still among a fixed, known validator set with fewer than a third faulty (recalled) — [FastPay, arXiv:2003.11506](https://arxiv.org/abs/2003.11506), [Astro, "Online Payments by Merely Broadcasting Messages", DSN 2020](https://infoscience.epfl.ch/record/277959)
- NIP-13 commits the target difficulty inside the event so that a low-effort miner who gets lucky cannot claim a high difficulty — [NIP-13](https://github.com/nostr-protocol/nips/blob/master/13.md)
- drand supports timelock encryption (encrypt to a future round; decryptable by anyone once the round is published), with a browser JS library (tlock-js) — [drand, timelock on mainnet](https://docs.drand.love/blog/2023/03/28/timelock-on-fastnet), [tlock paper](https://appliedcryptography.page/papers/tlock-bls.pdf)

### Inferences
- **Mapping to the registry.** A name is an object any of k parties may claim, so claiming it is the k-shared-account case (consensus number k), not the owned-account case. Once claimed, the name is single-owner: updates, renewals inside the owner's window, and transfers signed by the owner are consensus number 1, and a BFT CRDT / per-name signed chain handles them with any number of Sybils. So consensus (or a trusted orderer) is needed for exactly two events: a claim on a free name, and the moment a name passes from "owned, in renewal window" to "free" (expiry is a claim-vs-renewal race, hence also a contention point, and it needs a shared notion of time).
- **The paper's loophole confirms the room's current design.** Uniqueness is safe "if the value is determined by the hash of the message": that is the existing `<key>.<tag>.p2p.internal` names. Human-chosen names are precisely the unsafe case.
- **Deterministic rules without time, and what each lets an attacker do:**
  - *Lowest hash / highest PoW wins:* converges, but a name is never final; a later, stronger claim takes it. First-come is replaced by "richest ever". Theft cost = out-working the owner once.
  - *Accumulated work (owner keeps adding):* owner must keep spending; an absent owner falls behind; gap in hardware decides (section 9).
  - *Earliest self-declared timestamp:* forgeable; everyone claims time zero.
  - *Earliest externally anchored timestamp:* unforgeable but secretly pre-makeable (section 6, withheld claims).
  - *VDF age:* see section 4.
  - *First seen by me:* each node keeps what it saw first; no convergence after a partition, and an eclipse attacker chooses what a newcomer sees first. This is honest about being local (a petname-like model) but is not a registry.
  - *Lexicographic rule plus finality delay* ("lowest hash among claims seen within Δ of the first, then frozen"): needs agreement on when the window closed, which is consensus again.
- **Commit-reveal and front-running.** Whoever orders claims (a log operator, relays, a committee) can see a claim for `bank` and insert its own first. Standard fix: commit H(name, key, salt), get the commitment ordered, reveal later; priority goes to the earliest commitment. Timelock encryption to a drand round automates the reveal (no second online step), but adds the League of Entropy threshold as a party able to decrypt early. Commit-reveal stops front-running by observers; it does not stop a blanket squatter who commits to a whole dictionary, which is what the PoW fee is for.
- **Suitability:** BFT CRDT / per-name signed chains for everything after the claim: suitable, Sybil-immune, cheap, tolerant of churn and empty periods (state is self-certifying, any copy from any relay or peer is as good as another). For the claim itself: impossible without an orderer or Sybil countermeasure; pick the weakest acceptable orderer rather than pretend the rule is "first". Commit-reveal: suitable as an add-on against front-running.

### Gaps
- FastPay/Astro details are recalled, not re-fetched.
- No paper was found that analyses first-come naming specifically under "highest PoW wins"; the squatting/theft analysis is mine.
- GNU Name System (RFC 9498) avoids the problem by giving up global uniqueness (per-user zones, petnames, delegation); it is outside this brief but is the main deployed "no consensus" alternative and should be weighed by whoever covers naming models.

## 6. External anchors as clock and total order (transparency logs, witnesses, did:plc, OpenTimestamps, drand, Roughtime)

### Takeaway
Bracketing a claim between a drand round ("not before") and a Bitcoin attestation ("not after") gives unforgeable time, but time alone does not give first-come: a claim can be timestamped and withheld, and then revealed to pre-empt whoever registers later. First-come needs an ordered, publicly available log; the practical, deployed way to get one without a blockchain is an append-only Merkle log whose operator cannot fork it unseen because independent witnesses cosign its checkpoints. That makes the log operator able to censor and front-run, but not to rewrite or equivocate.

### Cited Findings
- tlog-witness (C2SP): a witness keeps only the latest checkpoint size/hash per log; it cosigns a new checkpoint only given a valid Merkle consistency proof from the size it last cosigned (409 if the old size mismatches, 422 if the proof fails); cosignatures are timestamped; the witness must persist atomically before answering; proofs are at most 63 hashes — [C2SP tlog-witness](https://github.com/C2SP/C2SP/blob/main/tlog-witness.md)
- Sigsum: log server protocol and witness cosignature format are "stable v1"; the witness cosigning protocol is a release candidate; trust policy and proof bundle formats are work in progress; implementations in Go, C, Rust; a public "Witness Network" exists — [Sigsum docs](https://www.sigsum.org/docs/)
- A Sigsum policy is a quorum rule over named witnesses (e.g. 2 of the listed); the witnesses "protect against split-view attacks"; a maintainer notes that a cosignature "doesn't say there are no split-views, just that none has been presented to the witness" — [Sigsum poster, KTH](https://chains.proj.kth.se/workshop_5_assets/posters/sisgsum.pdf), [sigsum-general list](https://lists.sigsum.org/mailman3/hyperkitty/list/sigsum-general@lists.sigsum.org/message/R7PREM72YFEN26O35WN24WMGUVVY3MTF)
- A shared public witness network for many logs is being organized by the transparency.dev community; a litewitness implementation exists — [transparency.dev blog](https://blog.transparency.dev/can-i-get-a-witness-network), [litewitness](https://pkg.go.dev/filippo.io/torchwood/cmd/litewitness)
- did:plc: each DID has a hash-chained log of signed operations; 1–5 rotation keys in priority order; a higher-priority key can override a lower one's operation within 72 hours by signing a fork from the earlier operation; the central directory validates, timestamps and orders operations and keeps nullified ones public; clients can verify every signature, but the directory can deny service or "misorder" (serve the wrong fork); mirroring, snapshots and third-party auditing are "considered", not specified — [did:plc spec v0.1](https://web.plc.directory/spec/v0.1/did-plc)
- OpenTimestamps: aggregation servers Merkle-ize many digests into one Bitcoin transaction so user timestamps are free; a calendar returns a pending proof in about a second; Bitcoin confirmation takes ≥10 minutes on average; block time is accurate only "within a few hours", "almost certainly within a day"; calendars are a central point of failure for pending proofs (two are used by default) — [P. Todd, OpenTimestamps announcement](https://petertodd.org/2016/opentimestamps-announcement)
- OpenTimestamps' own stated limit: a timestamp "only proves a message existed, not the message", and "Timestamps do not by themselves solve the doublespend problem" — [P. Todd, OpenTimestamps announcement](https://petertodd.org/2016/opentimestamps-announcement)
- drand quicknet: one threshold-BLS beacon every 3 seconds, unchained (each round verifiable alone), run by all League of Entropy members; in October 2023 that was 23 nodes with a threshold of 12 of 22 — [drand, quicknet is live](https://docs.drand.love/blog/2023/10/16/quicknet-is-live), [drand, fastnet sunset](https://docs.drand.love/blog/2023/07/03/fastnet-sunset-quicknet-new)
- drand quicknet was still running and publicly usable in August 2025 — [drand blog, Aug 2025](https://docs.drand.love/blog/2025/08/26/verifying-bls12-on-ethereum)

### Inferences
- **The withheld-claim problem, explicitly.** Let a claim be valid if it embeds drand round r (not before t_r) and carries an OTS proof into Bitcoin block h (not after t_h), and let the earliest bracket win.
  1. Mallory builds claims for every dictionary name under her keys, Merkle-izes them into one root, embeds the current drand round, and submits the root to an OTS calendar. Cost: one free request, repeated as often as she likes (hourly, say).
  2. She publishes nothing.
  3. Alice registers `alice` honestly at a later time.
  4. Mallory reveals her earlier-bracketed claim for `alice`. Under "earliest wins" she owns it.
  The bracket proves when Mallory's claim existed; nothing proves it was absent from the public record. Timestamps prove existence, never non-existence, and "published" is not a property a hash anchor can carry.
- **Patches and where each lands:**
  - *Reveal deadline* ("a claim counts only if published within W of its anchor"): "published within W" is a fact about what the network saw, so someone must attest to it: witnesses or a log. It reduces to the witnessed log.
  - *PoW per claim:* makes blanket pre-claiming cost per name per period instead of free. It prices the attack (section 9: cheaply) but does not stop a targeted one against names Mallory guesses will matter.
  - *Finality window* ("a name is final W after its first public claim unless an earlier-bracketed claim appears"): bounds theft to W, but again needs agreement on when the first public claim appeared; a node that was offline or eclipsed disagrees. Workable only with an availability layer that nodes agree on.
  - *Put the claims themselves on Bitcoin:* gives availability and order, but costs fees and is a cryptocurrency dependency; excluded.
  - *Anchor a whole-registry state root instead of single claims:* an attacker (or a malicious log operator) can keep and stamp a secret fork of the registry equally well. Same problem one level up.
- **So bracketed time plus a data-availability rule is enough only if the availability rule is enforced by parties whose attestation the room trusts.** At that point the time bracket is secondary: the log's own sequence gives the order, and anchoring adds (a) an external audit trail that the log's history was not rewritten after the fact, even if every witness later colludes, and (b) a not-before that stops a log operator from back-dating entries.
- **What a witnessed log gives and does not give.** With k-of-n honest witnesses: no rewriting of history and no two views of the log (safety). Not given: liveness and fairness. The operator can refuse a claim (censorship), delay it, or insert its own claim ahead (front-running; mitigated by commit-reveal, section 5). Witnesses check consistency only, not content, so validity (signatures, owner-only updates, expiry) must be re-checked by every client or by auditors; this is cheap for a registry this small. Witnesses are light: one checkpoint per log in state, one consistency check and signature per update, so a witness could be a tiny service or, in principle, a long-lived member.
- **Fork evidence.** Two checkpoints with the same log key and incompatible roots are a compact, transferable proof of misbehaviour, as are two successors of one per-name chain entry signed by the same owner key. A room can ban a log key on such proof. This is detection after the fact: which fork to keep still needs a rule (e.g. the one with witness quorum; if both have quorum, the witnesses failed).
- **did:plc as precedent.** In production at scale (Bluesky), and it is exactly "self-certifying per-identity logs + one central orderer", with the orderer trusted for ordering and availability but not for authenticity. The 72-hour override by a higher-priority key is a useful recovery pattern for per-name ownership. Its admitted weakness (the directory can misorder) is what witnesses are for.
- **Roughtime** (signed time from multiple servers with chained requests that expose a lying server) would give a browser a trustworthy "now" for expiry checks more cheaply than drand, but adds no ordering. drand is the stronger not-before because the value cannot be known in advance by anyone below the threshold.
- **Empty network and churn.** A log on always-on infrastructure is indifferent to member churn and to nobody being online, which is the room's hard case. The room link already lists relays and DERP servers the room depends on; a log and witness list in the link is the same kind of dependency, and a "serious room runs its own" just as it does for relays. Without at least one always-on party there is no place for a claim to be recorded while the room is empty, in any design.
- **Suitability:** witnessed append-only log with client-side validity checks: the best fit found; all pieces are deployed (CT since 2013, Sigsum v1, C2SP specs, public witness network), browser cost is a few signature and Merkle checks. OTS anchoring of log checkpoints: cheap, optional, strengthens auditability; it uses Bitcoin as a free public clock, without fees or keys, which the brief allows as a mechanism but is still a soft dependency on calendar servers. drand not-before in claims: suitable and cheap (one BLS verification), with a soft dependency on the League of Entropy. Bracketed time alone as the ordering rule: unsuitable (withheld claims).

### Gaps
- Current (2026) League of Entropy node count and threshold were not confirmed; the 23 nodes and 12-of-22 are from 2023.
- Certificate Transparency's gossip/SCT auditing status, Roughtime's draft status and a BLS12-381 verification time in WASM were not fetched; statements about them are from general knowledge.
- Whether public witnesses in the transparency.dev witness network would accept arbitrary small logs (such as one per room), and at what rate, was not established. This decides whether a room can use existing witnesses or must bring its own.
- I found no deployed system that uses OTS plus a reveal deadline as its sole ordering rule; the analysis of that construction is mine.

## 7. Committees and federations (threshold signing, FBA, seniority- or PoW-weighted voting, web of trust)

### Takeaway
Every committee scheme moves the problem to "who is on the committee". With free identities, any open admission rule based on age or one-time work is buyable, and a committee of browser tabs fails liveness whenever its quorum is asleep, as ALFIS's 4-of-7 did in production. Committees work here only when membership is named explicitly by the room (in its link) or by each user's own trust choice.

### Cited Findings
- ALFIS's committee is drawn from keys with enough past blocks in the chain; it froze when four signers were offline, and the fix was a standby pool of the top keys by all-time block count that takes over after 3–5 days, with a single anchor signature sufficing — [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364), [constants.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/commons/constants.rs)
- The criticism of that admission rule: the validators are chosen from ledger state that validators themselves shape at no external cost; an attacker with ~100 VPSes mining blocks with rotating keys could come to hold the most-used signer keys — [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364)
- Stellar's federated Byzantine agreement: each node chooses its own quorum slices; Sybil resistance comes from naming specific trusted peers; safety needs quorum intersection, which can be lost by misconfiguration; deciding whether intersection holds is NP-complete; too many nodes down halts progress — [Stellar, "Why quorums matter"](https://stellar.org/blog/developers/why-quorums-matter-and-how-stellar-approaches-them), [Lachowski, arXiv:1902.06493](https://arxiv.org/pdf/1902.06493), [SCP Internet-Draft](https://datatracker.ietf.org/doc/html/draft-mazieres-dinrg-scp-05)
- drand is a working example of a volunteer threshold committee: a fixed, vetted membership (application required) running distributed key generation and threshold BLS — [drand docs](https://docs.drand.love/docs/overview/), [drand, quicknet is live](https://docs.drand.love/blog/2023/10/16/quicknet-is-live)
- The room's own key miner tests 26–34 million keys a second on 8 vCPUs: 8 chosen hex digits in ~3 minutes, 9 in ~45 minutes — repo file `docs/networking/rooms.md` ("The room and its names"); no public URL
- Nano's quorum counts only *online* vote weight (>67% of it) — [Nano docs, ORV](https://docs.nano.org/protocol-design/orv-consensus/)

### Inferences
- **Threshold signing among volunteers (FROST, threshold BLS).** Produces one compact signature that clients verify against one room key, hiding churn in the committee. Costs: a distributed key generation and a resharing round at every membership change, each needing a quorum online simultaneously and reliable pairwise channels; browser tabs that come and go make resharing the dominant failure. And someone must decide who joins. drand does this with a human-vetted consortium of always-on servers; nothing comparable exists for a room.
- **Seniority by timestamped key age.** Age is free to manufacture in bulk: stamp a Merkle root of a million fresh keys once, wait. A patient attacker's keys are as old as anyone's. Age only helps against attackers who arrive late, and it entrenches whoever was first (including a first-mover attacker).
- **Weight by accumulated PoW in the key (the room already mines keys).** Verification is free (count the key's matching bits) and it is a one-time cost bound to the identity, but (a) it is exactly the purchasable resource of section 9, at elliptic-curve speeds where GPUs help a lot; (b) one-time cost then unlimited use is what the ALFIS critic showed to be weak; (c) weight proportional to work is "one hash one vote", i.e. PoW consensus with tiny total work. Useful as an admission fee or rate limit, not as vote weight.
- **Seniority by activity in the log** (ALFIS's rule) is circular: the committee admits the blocks that confer committee membership.
- **Online-weighted quorums** (Nano) plus free identities let the awake attacker be the quorum at 4 a.m.
- **FBA / web of trust.** Sound Sybil resistance because trust is explicit, but it needs configured, always-on validators and gives per-user views that agree only where slices intersect. For a room, the natural "slice" is one list in the room link; that collapses FBA to a fixed k-of-n set, i.e. the witness policy of section 6. Per-user web-of-trust naming is a petname system, not a registry.
- **A room master key** is the degenerate committee (1-of-1). Its weaknesses are a single point of compromise and of liveness; a k-of-n witness policy in the link is strictly better on both and is the same kind of object (keys in the link).
- **Suitability:** open-admission committees (age, mined keys, activity): unsuitable as the security basis. Threshold-signing committees of browser members: unsuitable (liveness, resharing under churn). A small named set of always-on witnesses/cosigners chosen per room: suitable; it is what section 6 arrives at. Key-mining PoW: suitable as an admission/anti-spam cost only.

### Gaps
- FROST (RFC 9591) and dynamic-committee resharing costs were not fetched; the statements are general knowledge.
- No measurement exists of how many long-lived members a typical room would have; whether members could serve as witnesses is an empirical question about the product.
- GPU speedup for Curve25519 key mining was not sourced (the repo's plan doc only notes a GPU miner as discussed).

## 8. Sybil and eclipse resistance; partition and merge (two valid registrations of one name)

### Takeaway
Deployed systems resolve a post-partition double registration in one of four ways: the heavier chain wins and the loser's registration silently vanishes; a bounded reorg depth turns deep forks into a manual resync; a weighted vote picks one; or a single orderer makes partitions of the order impossible. None preserves "first" across a true partition, because there is no first.

### Cited Findings
- Nakamoto-family and Handshake: names live in the chain; a reorg removes the losing side's registrations (Handshake state is the Urkel root committed in headers) — [Handshake protocol summary](https://hsd-dev.org/protocol/summary.html)
- ALFIS: forks deeper than 4 blocks are rejected as "Bad" and raise a `ForkDetected` event; recovery in practice has been a hard-coded checkpoint and "delete current blockchain and sync it" — [chain.rs](https://raw.githubusercontent.com/Revertron/Alfis/master/src/blockchain/chain.rs), [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364)
- ALFIS eclipse posture: new nodes learn peers only from bootstrap nodes and peer exchange, and nodes that offer deep forks are banned — [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364)
- Nano: conflicting blocks are settled by representative vote at >67% of online weight — [Nano docs, ORV](https://docs.nano.org/protocol-design/orv-consensus/)
- did:plc: the directory's order is the order; a fork within one identity is resolved by key priority within 72 hours, and losing operations stay visible as nullified — [did:plc spec](https://web.plc.directory/spec/v0.1/did-plc)
- Witnessed logs: a witness never cosigns two incompatible histories from the size it last saw, so with an honest witness quorum a log cannot present two views — [C2SP tlog-witness](https://github.com/C2SP/C2SP/blob/main/tlog-witness.md)
- BEC/CRDT systems: any number of Byzantine nodes cannot corrupt correct replicas' state, but only for invariant-confluent operations — [arXiv:2012.00472](https://arxiv.org/abs/2012.00472)
- No protocol has both liveness under dynamic participation and safety under partition — [arXiv:2302.11326](https://arxiv.org/pdf/2302.11326)

### Inferences
- **The room's partitions are unusual.** Members reach each other through the link's relays; two halves that cannot see each other mostly means disjoint relay reachability or members online at disjoint times ("temporal partition"). The latter is the common case: A registers while alone, leaves; B registers the same name while alone. Any members-only design must resolve this on merge, and any rule (lowest hash, most work, earliest stamp) makes one honest user lose a name they were told they had.
- **Choice forced by the CAP-style result:** either registration is available when partitioned and names are provisional until some later finality, or registration needs a reachable orderer/quorum and is simply unavailable when that is down. For names (rare writes, long-lived, costly to lose) the second is the conventional choice: CT, did:plc, DNS registries all refuse rather than fork. A UI can make "pending until witnessed" visible.
- **Eclipse.** A newcomer who learns state only from peers can be fed a stale or forged registry by an attacker who surrounds it (trivial with free identities). Defences that do not need honest-majority peers: state self-authenticated by a root that carries witness cosignatures (stale is the worst case, and freshness is bounded by cosignature timestamps); multiple independent relays (already the room's practice for lookups). Defences that need honest peers (majority of what I hear) are unsafe here.
- **Rollback by staleness** is the residual risk for any design: presenting an old but valid state to hide a recent transfer or renewal. Timestamped cosignatures (tlog-witness has them) or a drand round in the checkpoint bound how stale an accepted head may be.
- **Sybil resistance without money, summarized:** none of {age, activity, one-time PoW, online presence} resists a patient or modestly funded attacker when used as voting weight. The mechanisms that are actually Sybil-proof are (a) no voting at all (self-certifying data, I-confluent operations) and (b) explicitly named parties. PoW is a price, not an identity.
- **Suitability:** refuse-rather-than-fork with an explicit pending state: fits a registry. Merge rules among peers: every option produces honest losers; acceptable only if names are advertised as provisional for a finality period.

### Gaps
- No source describes Handshake/Namecoin user-facing behaviour for registrations lost in a reorg; the statement is from how chain state works.
- Nano's documented fork-resolution details are incomplete (work-in-progress sections).
- No data on how often room members are online at disjoint times.

## 9. Cost realism of proof-of-work in browsers

### Takeaway
A browser is 2–8x slower per core than native code on the same CPU for CPU-bound and memory-hard functions, and four to six orders of magnitude slower than GPUs/ASICs for plain SHA-256. With a memory-hard function, "one minute of laptop PoW" costs an attacker roughly one native core-minute or less, so registering 10,000 names costs single-digit dollars of rented CPU. PoW can price out casual bulk squatting; it cannot protect a namespace anyone cares about.

### Cited Findings
- SHA-256 PoW (mCaptcha): the same work took 2.0 s native on an i7-9750H and 3.4–3.5 s in Chromium 92 WASM (4.0–4.2 s in Firefox 91), i.e. ~1.7–2x slower in the browser — [mCaptcha PoW performance](https://mcaptcha.org/blog/pow-performance/)
- Argon2 (argon2-browser's table, Argon2d, 1 MiB, 100 passes, an older build): Chrome WASM+SIMD 119 ms, plain WASM 225 ms, native -O3 with SSE 15 ms, native without SSE 42 ms, i.e. ~5–8x slower in the browser — [argon2-browser README](https://github.com/antelle/argon2-browser)
- RandomX in JS/WASM (randomx.js): 22 H/s on one thread and 208 H/s on 16 threads in Node on a machine where native light-mode mining gives ~100 H/s per thread; browsers lack native AES instructions and directed rounding modes, which RandomX uses — [l-m.dev talk, Nov 2025](https://l-m.dev/talks/zero-to-randomx-js-webmining.pdf), [randomx.js](https://github.com/l1mey112/randomx.js)
- A browser RandomX miner reportedly reaches ~13% of native xmrig efficiency on an Apple M4 (secondary report) — [RandomX-bonanza](https://ithub.global.ssl.fastly.net/aa022/RandomX-bonanza)
- General WASM overhead: 45% (Firefox) average slowdown on SPEC CPU in the 2019 study — [Jangda et al., USENIX ATC'19](https://www.usenix.net/system/files/atc19-jangda.pdf)
- GPU SHA-256: one community table lists an RTX 4090 at ~63 GH/s for hashcat SHA-256; the page mixes verified and estimated numbers and should be treated as approximate — [tutorials.technology table](https://tutorials.technology/blog/08-Hashcat-GPU-benchmarking-table-Nvidia-and-amd.html); the raw hashcat benchmark gist is at [Chick3nman, RTX 4090 benchmark](https://gist.github.com/Chick3nman/32e662a5bb63bc4f51b847bb422222fd)
- WebGPU hashing exists as proofs of concept without published hash rates; in another workload (LLM inference) WebGPU reached ~11–12% of CUDA on the same card — [Web-Mining README](https://github.com/TalDerei/Web-Mining/blob/main/README.md), [arXiv:2604.02344](https://arxiv.org/pdf/2604.02344)
- NIP-13: difficulty = leading zero bits of the event id; PoW can be outsourced because the id does not commit to the signature; the committed target stops lucky low-effort mining from counting as high effort; no difficulty is recommended — [NIP-13](https://github.com/nostr-protocol/nips/blob/master/13.md)
- Nano's PoW likewise sits outside the signature so it can be delegated — [Nano docs](https://docs.nano.org/protocol-design/spam-work-and-prioritization/)
- ALFIS data point for a "minutes on a desktop" target: a 24-bit SHA-256 key in 38 s on 24 cores; the Blakeout version in 1 h 9 min on the same machine — [Alfis issue #364](https://github.com/Revertron/Alfis/issues/364)
- Rented hashpower markets make PoW cost an operating expense, not a capital one — [Cloud Security Alliance, "Rent to pwn"](https://cloudsecurityalliance.org/articles/rent-to-pwn-the-blockchain-51-attacks-made-easy)

### Inferences
All arithmetic below is mine. Assumptions that are *not* sourced: cloud spot CPU at about $0.01–0.04 per vCPU-hour, a rented RTX 4090 at about $0.30–0.70 per hour, and a browser single-thread SHA-256 rate of a few MH/s. Replace them with measured values before quoting.
- **Plain SHA-256 (NIP-13 style).** One minute on an 8-thread laptop at ~5 MH/s per thread is ~2.4e9 hashes (about 31 bits). A single RTX 4090 at 20–60 GH/s does that in 0.04–0.12 s. 10,000 names: 7–20 GPU-minutes, about $0.05–0.25. A Bitcoin ASIC is another three to four orders of magnitude beyond the GPU. SHA-256 PoW is a speed bump for scripts and nothing else.
- **Memory-hard (Argon2id with ~256 MiB–1 GiB, RandomX).** GPUs and ASICs lose most of their edge, so the attacker's advantage is roughly (WASM penalty) x (number of cores). One laptop-minute = 480 WASM thread-seconds = about 60–280 native core-seconds (penalty 8x down to 1.7x). 10,000 names = 170–780 core-hours = roughly $2–30 on spot instances. 100,000 names: $20–300. A botnet or an idle cluster pays nothing.
- **What difficulty would actually deter.** To make 10,000 names cost ~$1,000 at $0.02 per core-hour, each name must cost ~5 native core-hours, i.e. 10–40 hours of an 8-thread laptop tab. Not acceptable for honest users, and the emulator already wants the CPU and RAM (a 1 GiB Argon2 instance per worker competes with the guest's memory in the same tab).
- **Mitigations that change the slope rather than the constant:** renewal PoW (squatting costs recur; ALFIS discounts renewals instead, the opposite incentive, to favour real owners); price by name length or dictionary membership; a per-key rate limit only helps if keys cost something (ALFIS's one-per-day per mined key); per-claim PoW bound to a recent beacon value so work cannot be stockpiled; committed target (NIP-13) so luck does not count. Delegable PoW (outside the signature) helps weak devices and equally helps attackers and creates PoW-for-hire, as NIP-13 itself notes.
- **Equihash and scrypt:** both have had ASICs for years (Zcash, Litecoin); they do not narrow the gap the way large-memory Argon2id or RandomX do. Not sourced this session.
- **WebGPU** would let honest users run GPU-friendly PoW faster, but attackers' native GPUs are still faster on the same algorithm, so it does not improve the ratio; it only raises the absolute floor and excludes devices without it.
- **Suitability:** memory-hard per-claim PoW (Argon2id, since audited WASM builds exist and RandomX in the browser is an order of magnitude from native) bound to a beacon round, with recurring cost on renewal: suitable as anti-spam and as a mild anti-squatting price. As a security mechanism for ordering or ownership: unsuitable at any difficulty a browser user would tolerate.

### Gaps
- No authoritative same-machine benchmark of Argon2id (large memory) in Chromium WASM with SIMD vs native AVX2 was found; the 5–8x figure comes from an old Argon2d table at 1 MiB and likely overstates today's gap.
- No published WebGPU SHA-256 hash rate was found.
- The RTX 4090 SHA-256 figure is from a low-quality aggregator (I recall ~22 GH/s from primary hashcat benchmarks, unverified this session); the conclusion is insensitive to a 3x error.
- Cloud prices are assumptions, not sourced.
- GPU Argon2id rates at 256 MiB+ and RandomX ASIC/FPGA status were not sourced.

## 10. Cross-cutting summary (maturity and verdicts)

### Takeaway
Nothing deployed or published gives first-come naming among free, churny, sometimes-absent identities without either a priced resource or named parties. The mechanisms sort into: proven and fitting building blocks (self-certifying per-name chains, authenticated state with expiry, witnessed append-only logs, beacon/timestamp anchoring, memory-hard PoW as a fee), and mechanisms that fail on the room's assumptions (PoW chains, DAG voting, sleepy/PoS consensus, VDF age, open committees, time-bracket-only ordering).

### Cited Findings
- Deployed in production: ALFIS (coinless name chain with signer committee) — [Alfis](https://github.com/Revertron/Alfis); Handshake (name chain with Urkel state) — [Handshake](https://hsd-dev.org/protocol/summary.html); Nano (per-account chains, ORV) — [Nano docs](https://docs.nano.org/protocol-design/orv-consensus/); did:plc (central orderer over self-certifying logs) — [did:plc](https://web.plc.directory/spec/v0.1/did-plc); Sigsum and C2SP witness specs (v1 / release candidate) — [Sigsum docs](https://www.sigsum.org/docs/), [tlog-witness](https://github.com/C2SP/C2SP/blob/main/tlog-witness.md); OpenTimestamps — [announcement](https://petertodd.org/2016/opentimestamps-announcement); drand quicknet — [drand](https://docs.drand.love/blog/2023/10/16/quicknet-is-live); NIP-13 — [NIP-13](https://github.com/nostr-protocol/nips/blob/master/13.md)
- Paper or prototype only: BFT CRDTs / Byzantine eventual consistency — [arXiv:2012.00472](https://arxiv.org/abs/2012.00472); sleepy consensus — [ePrint 2016/918](https://eprint.iacr.org/2016/918); FlyClient as specified (deployed in part, e.g. via MMR header commitments, in some chains; not verified here) — [ePrint 2019/226](https://eprint.iacr.org/2019/226); mining in logarithmic space — [ePrint 2021/623](https://eprint.iacr.org/2021/623)
- The governing impossibility: Sybil immunity if and only if all transactions are invariant-confluent, and uniqueness of a user-chosen attribute is not — [arXiv:2012.00472](https://arxiv.org/abs/2012.00472)

### Inferences
Verdict table (my assessment; "attacker needs" is to steal a name or rewrite history; "censor" is to block a registration).

| Mechanism | Attacker needs (steal / rewrite) | Censor | Churn, partition, empty room | Browser cost | State growth | Maturity | Verdict |
|---|---|---|---|---|---|---|---|
| Coinless PoW chain, heaviest wins | More hash than the honest tabs: one GPU or a few dollars of cloud | Same | Rewrites after quiet periods; partitions fork, loser's names vanish | Mining competes with the emulator; chain sync | Unbounded unless state-root pruning | Deployed only with a coin | Unsuitable |
| ALFIS-style PoW fee + drawn signers | Capture 4 of 7 drawn keys, or the anchor keys | 4 signers offline froze it | Needed healing, bans, a checkpoint, manual resync | Light to verify | Chain grows; live names bounded by expiry | Deployed, small | Lifecycle rules reusable; committee not |
| Per-name highest PoW | Out-work the owner once | Not applicable | Converges after merge; honest loser | Verification trivial | Bounded | No deployment found | Unsuitable as ownership rule |
| Nano/IOTA-style voting | Majority of weight; weight is a token | Majority of weight | Online-weight quorum is capturable when few are online | Light | Prunable to heads | Deployed with tokens | Unsuitable; ledger shape reusable |
| Sleepy / PoS family | Majority of awake roster; roster is free keys | Same | Assumes awake honest majority always | Light | Chain | Deployed with stake | Unsuitable |
| VDF age / PoSpace / PoET | Faster hardware (4–9x ASIC plus WASM gap) / disk / broken TEE | Not applicable | Owner must compute continuously | Evaluation hopeless, verification fine | Bounded | Deployed with coins (Chia) | Unsuitable |
| BFT CRDT, per-name signed chains | Owner's private key | Withhold data only | Indifferent to churn, partitions, emptiness | Signature checks | Head-only per name | Papers; pattern deployed (Nano, did:plc) | Suitable for all post-claim operations; cannot decide the claim |
| Time bracket only (drand + OTS) | Nothing: pre-stamp and withhold | Not applicable | Works offline | One BLS check plus OTS proof | Bounded | Parts deployed; construction is not | Unsuitable alone; useful as audit and not-before |
| Witnessed append-only log | Log key plus k of n witness keys | Log operator alone can censor or front-run (commit-reveal helps) | Indifferent to member churn; needs log and k witnesses up to register | Merkle and signature checks; MBs of state | Bounded by expiry if history is prunable under cosigned roots | Deployed (CT, Sigsum, C2SP) | Best fit found |
| Open committee by age / mined key / activity | Patience or modest compute | Same | Quorum asleep means halt | DKG and resharing heavy | n/a | ALFIS variant deployed | Unsuitable |
| Named k-of-n cosigners in the room link | k of n named keys | n-k+1 named parties | Needs them reachable | Light | n/a | Deployed pattern (witness policies, drand) | Suitable; same object as the witness policy |
| Room master key | One key | That key's holder | Needs holder's service online, or offline-signed delegations | Trivial | n/a | Trivially deployable | Works; strictly dominated by k-of-n named keys |
| Memory-hard PoW per claim | (not a security mechanism) ~$2–30 per 10k names at 1 laptop-minute | n/a | Works offline | 1 minute, hundreds of MB | n/a | Deployed (ALFIS, NIP-13 with SHA-256) | Suitable as a fee only |

- The requirement set is over-constrained: {open, coinless, free identities, sometimes empty, first-come, no trusted party} cannot all hold (section 5's theorem plus section 4's assumptions). The constraint with the cheapest relaxation, given that a room link already names trusted infrastructure, is "no trusted party" relaxed to "a small named set that can censor but not forge, rewrite or equivocate without leaving proof".
- The split that every viable option shares: consensus-free, self-certifying per-name ownership chains for updates, renewals and transfers; an orderer only for first claims and expiries; PoW and commit-reveal as hygiene around the orderer; external anchors (drand, OTS) to make the orderer's history auditable after the fact.

### Gaps
- No end-to-end deployed system combines a witnessed log, per-name signed chains, expiry pruning and browser-only clients for naming; the fit is assembled from parts that are each deployed elsewhere.
- Whether history can be pruned under cosigned roots while still letting a late auditor verify past validity (for example that an expired name really expired before it was re-registered) needs design work: tlog-witness cosigns append-only trees, not a mutable map, so a map-over-log construction or periodic cosigned state snapshots would be needed. Not researched here.
- Threat-model inputs not available to this research: who would run a public room's log and witnesses, and whether the global public room can have any party its members accept.
