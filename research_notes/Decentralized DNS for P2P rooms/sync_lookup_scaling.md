# Replication, sync and lookup of a 1k–100k-record signed name registry among high-churn browser peers (as of 2026-11)

Legend for sources. **[fetched]**: the page was read in this session. **[search]**: seen only as a search snippet in
this session. **[memory]**: cited from the researcher's training knowledge (cutoff mid-2026); the URL is the
canonical one but the page was **not re-fetched**, so the number should be re-checked before it is quoted in a
report. **[repo]**: this repository's docs. Everything under "Inferences" is the researcher's own arithmetic or
reasoning, not a sourced fact. Tool budget ran out before several numeric claims could be re-verified; those are
listed under "Gaps".

## 0. What the existing rooms overlay offers a registry (from the repo)

### Takeaway
The overlay gives authenticated point-to-point IPv6 between any two members who know each other's key, with a
relayed path (DERP) usable ~0.3–1.4 s after a cold lookup on public servers and a direct WebRTC path later; it gives
**no membership list, no broadcast, and nothing stored on relays**, and it caps a node at 64 WebRTC connections, 8
outgoing lookups a second and 1,024 peers. A registry therefore has to bring its own peer discovery (a rendezvous)
and must keep its steady state to a handful of long-lived neighbours.

### Cited Findings
- No owner, no membership list, no directory in the protocol; "nothing lists who is in it"; an offline peer can't be
  found — [repo: docs/networking/rooms.md "Decisions"](/home/user/waarm64/docs/networking/rooms.md)
- Layer 3 only: no broadcast or multicast between guests; a node's address is the room /48 plus the first 80 bits of
  its WireGuard (X25519) node key, and a name is `<key base32, 52 chars>.<tag>.p2p.internal` — [repo: rooms.md](/home/user/waarm64/docs/networking/rooms.md)
- Finding a peer: the dialer publishes a sealed lookup as a Nostr **ephemeral** event (kind 26354, ~570 bytes on the
  wire) under the target's hourly tag on every relay of the link (six public defaults); the target calls back through
  DERP and the WireGuard handshake (IKpsk2 with the room's pre-shared key) decides. Resent after 1 s and 3 s, given up
  at 6 s — [repo: rooms.md "Finding a peer"](/home/user/waarm64/docs/networking/rooms.md)
- Rate limits and caps: 8 lookups/s out per member, 64 lookups waiting; a target opens at most 128 MAC-valid events/s
  per relay, answers 16 call backs/s (64 queued, served within 4 s), lets in 16 trial handshakes/s (20 s each), holds
  at most 1,024 peers; a peer is forgotten after 3 min without guest traffic — [repo: rooms.md](/home/user/waarm64/docs/networking/rooms.md)
- Connections on demand: at most 64 WebRTC connections (`MAX_RTC`), idle ones closed after 60 s, peers past the cap
  go through DERP; a peer's new connection at most every 2 s, own offers at most 4/s; the data channel is negotiated,
  **unordered with no retransmits**, one WireGuard packet per message, dropped when more than 64 KiB is buffered — [repo: rooms.md "The direct path"](/home/user/waarm64/docs/networking/rooms.md)
- Cold-start latency measured on public servers (2026-11-11, DERP RTT 98 ms): first echo after lookup + call back +
  handshake 294–450 ms on most relays, ~1.4 s on some, ~1.3–1.4 s right after a 16-lookup burst; one relay
  rate-limited the burst ("too many requests") — [repo: bench/net/REPORT.md "Rooms on public servers"](/home/user/waarm64/bench/net/REPORT.md)
- Throughput: 183 Mbit/s direct vs 126 Mbit/s via DERP on loopback in the dev VM; 50.9 vs 35.1 in a cloud session; a
  bare data channel set up in 92 ms on loopback; "Loopback hides how often ICE fails across real NATs" — [repo: rooms.md "Numbers"](/home/user/waarm64/docs/networking/rooms.md)
- Scale: 1,000 members cost the relay 16.9 REQ/s and 2.8 KB/s idle; a member costs ~1.4 MiB of linear memory and no
  measurable idle CPU; nothing grows with room size — [repo: bench/net/REPORT.md "Rooms at scale"](/home/user/waarm64/bench/net/REPORT.md)
- Relays: a tag filter (`#x`) is how a relay forwards; public relays' own terms (rate limits, PoW, payment) decide how
  far they carry a room; DERP is tailcat's public relays, "rate-limited, best-effort and revocable" — [repo: rooms.md "What a room needs from a Nostr relay", "Decisions"](/home/user/waarm64/docs/networking/rooms.md)
- Crypto already in the tree: `k256` (BIP-340 Schnorr on secp256k1), BLAKE2s, ChaCha20-Poly1305, X25519; "an X25519
  key can't sign" (so a lookup can't be checked against the key it names) — [repo: rooms.md](/home/user/waarm64/docs/networking/rooms.md)
- Chromium has no `RTCPeerConnection` in workers but a data channel can be transferred to a worker at creation — [repo: rooms.md "Findings"](/home/user/waarm64/docs/networking/rooms.md)
- Storage on the page: IndexedDB for records, OPFS for bytes (`web/app/store.ts`); the page already calls
  `navigator.storage.persist()` and shows `navigator.storage.estimate()`; private windows have no OPFS (state in
  memory until the tab closes) — [repo: docs/machines.md](/home/user/waarm64/docs/machines.md)
- The plan page already sketches names as per-TLD signed logs plus an append-only Merkle log on always-on relays with
  independent witnesses; and notes spam in public rooms is open (PoW on lookups/fresh keys as a direction) — [repo: docs/plans/networking-p2p.md](/home/user/waarm64/docs/plans/networking-p2p.md)
- The key miner does 26–34 M X25519 keys/s on 8 vCPUs, which calibrates what a PoW-on-key cost means here — [repo: rooms.md "The room and its names"](/home/user/waarm64/docs/networking/rooms.md)

### Inferences
- A relay forwards an event to **every** subscriber of its `#x` tag, so a tag shared by many members is a ready-made
  multicast/rendezvous primitive (today each tag has one subscriber). It is the only way in the current design for
  members to find registry peers without knowing a key first.
- Because DERP carries data as soon as the handshake completes, the cost of a "new hop" in this overlay is the cold
  lookup (~0.3–1.4 s measured), not ICE; WebRTC only improves throughput afterwards.
- A registry protocol would run either as IP inside the tunnel (needs its own reliability, since the channel is
  unreliable) or on a second, reliable data channel of the same `RTCPeerConnection`.
- Any membership list or shared rendezvous tag reveals that an address is online and serves the registry, which the
  "nothing lists who is in it" decision currently rules out: that is a user decision, not a technical one.
- X25519 node keys cannot sign records as they stand; options known in the literature are XEdDSA (signing with an
  X25519 key, [Signal spec, memory](https://signal.org/docs/specifications/xeddsa/)) or a separate owner key
  (BIP-340 via `k256` is already a dependency).

### Gaps
- No measurement in the repo of ICE success rate or data-channel throughput across real NATs.
- DERP's actual rate limit on tailcat's public relays is not stated in the docs read.

## 1. Full replication via gossip (Plumtree, HyParView, GossipSub, iroh-gossip); bandwidth, convergence, bootstrap

### Takeaway
At N≈2,000 and ≤100k small records, epidemic broadcast over a small partial view (HyParView-style active view of
~5, Plumtree eager/lazy push) is cheap in steady state (bytes per second per node); the real costs are the
**newcomer's bootstrap** (1–14 MB plus signature verification) and peer discovery without a member list. GossipSub's
attack hardening leans on peer scoring signals (long-lived identities, IP colocation) that mostly do not exist for
ephemeral browser tabs behind relays.

### Cited Findings
- HyParView keeps a small symmetric **active view** (fanout+1; 5 for 10,000 nodes in the paper) over reliable
  connections and a larger **passive view** (30) refreshed by shuffles, and repairs the active view from the passive
  one on failure; the paper reports high reliability even with very large simultaneous failure fractions — [Leitão et al., DSN 2007, memory](https://asc.di.fct.unl.pt/~jleitao/pdf/dsn07-leitao.pdf)
- Plumtree builds a spanning tree inside the gossip overlay: payloads are pushed eagerly on tree links and only
  announced (IHAVE) on the others; GRAFT/PRUNE repair the tree; in a stable network each node receives close to one
  payload copy per message — [Leitão et al., SRDS 2007, memory](https://asc.di.fct.unl.pt/~jleitao/pdf/srds07-leitao.pdf)
- GossipSub v1.1 parameters: mesh degree D=6 (bounds roughly 4–5 to 12), heartbeat 1 s, lazy gossip to D_lazy=6;
  v1.1 adds peer scoring, flood publishing, adaptive gossip, opportunistic grafting, outbound-mesh quotas, peer
  exchange on prune and prune backoff — [libp2p gossipsub v1.1 spec, memory](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md); evaluation against Sybil/eclipse/cold-boot attacks in [Vyzovitis et al., arXiv 2007.02754, memory](https://arxiv.org/abs/2007.02754)
- iroh-gossip implements HyParView membership plus Plumtree broadcast per topic — [iroh-gossip docs, memory](https://docs.rs/iroh-gossip/latest/iroh_gossip/); iroh compiles to WebAssembly for browsers but browser nodes are relay-only (no hole punching) — [iroh browser support docs, memory](https://www.iroh.computer/docs/wasm-browser-support)
- Classic rumor-spreading bound: push gossip reaches all n nodes in about log2 n + ln n rounds — [Karp et al., FOCS 2000, memory](https://ieeexplore.ieee.org/document/892324)
- Chromium advertises a data-channel `max-message-size` of 256 KiB; messages ≤16 KiB are the safe cross-browser size — [MDN "Using WebRTC data channels", memory](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels); `RTCSctpTransport.maxMessageSize` should be read at runtime — [MDN, search](https://developer.mozilla.org/docs/Web/API/RTCSctpTransport/maxMessageSize)
- Secure Scuttlebutt's EBT is Plumtree applied to per-feed append-only logs with vector-clock "notes" — [ssbc/ssb-ebt, memory](https://github.com/ssbc/ssb-ebt)

### Inferences
- **Update traffic is negligible.** 100k records renewed every 30 days is ~3,300 updates/day ≈ 2.3/min. With
  Plumtree each node gets ~1 payload (~110–150 B signed record) plus ~4 IHAVEs (~40 B) per update: ~10–15 B/s per
  node. Even a 10× burst is nothing next to an emulator's traffic.
- **Propagation time.** Tree depth with degree 5 at N=2,000 is ~log4(2000) ≈ 5.5 hops; at 50–150 ms per hop over open
  channels a new record reaches everyone in well under 2 s. Anti-entropy alone (one random-peer reconciliation per
  node per minute) would need ~log2 N ≈ 11 periods, i.e. ~10 min: fine as repair, too slow as the only mechanism.
- **Churn load on the overlay.** With a median session of 20 min (exponential), 2,000 nodes produce ~1.2 leaves and
  ~1.2 joins per second network-wide; each node with 5 neighbours loses one every ~6 min. HyParView's passive view
  (30 entries) is what makes that repair cheap, but each repair here is a cold lookup (~0.3–1.4 s, 8/s budget).
- **Bootstrap bytes.** State sizes (section 5): ~1 MB ≈ 10k signed records, ~11–14 MB ≈ 100k signed records, 25 MB ≈
  100k records with history or JSON overhead. Transfer time = size/throughput: at 10 Mbit/s 0.8 s / 8 s / 20 s; at
  2 Mbit/s (a weak uplink, or a rate-limited DERP path) 4 s / 40 s / 100 s; at the repo's loopback 180 Mbit/s it is
  CPU-bound. Split across 3–5 seeds in parallel by key range it divides accordingly.
- **Bootstrap CPU likely dominates at 100k.** Verifying 100k Ed25519/BIP-340 signatures at an assumed 150–400 µs each
  in WASM is 15–40 s of one core (batch verification roughly halves it). This is an estimate to be measured, not a
  number from a source; it argues for verifying in a worker, lazily, or trusting a root for the bulk (section 4).
- **Snapshot + delta is the natural shape:** a returning node loads its OPFS copy and reconciles only the difference
  (section 2); a first-time node streams a snapshot from a few peers or from parked storage (section 7) and then
  joins the gossip. Aggregate first-time-bootstrap upload at 1.2 joins/s × 11 MB ≈ 13 MB/s network-wide ≈ 6.5 KB/s
  per node on average if spread evenly, but it concentrates on whoever answers first.
- **Peers can't enumerate members**, so HyParView's "contact node" has to come from a rendezvous: a shared registry
  tag on the Nostr relays (section 0), the peers remembered in OPFS from the last session, or peers learned through
  shuffles. Without that, gossip has nothing to start from.
- **Sybil/eclipse.** Open membership + small views is exactly what eclipse attacks target; GossipSub's scoring
  (time in mesh, first deliveries, IP colocation) presumes persistent identities and visible IPs, which a room member
  behind DERP with a fresh key does not offer. For a registry whose records are individually signed and whose merge is
  a union, an eclipsed node sees **stale or missing** data, not forged data; the defence is diversity of sources
  (several peers, own OPFS copy, parked snapshot) rather than scoring.
- **Verdict:** well suited as the dissemination layer at this N and state size; unsuited as the only persistence
  mechanism (sometimes nobody is online).

### Gaps
- No source found (or fetched) for real-world reliable data-channel throughput between browsers across NATs; common
  practitioner figures of "tens of Mbit/s" are unverified here.
- HyParView's exact failure-tolerance percentage and GossipSub's exact D_lo were not re-read; treat as approximate.
- iroh's state in late 2026 (1.0 status, browser gossip maturity) was not checked.
- No published measurement of Plumtree/HyParView specifically over browser WebRTC with minute-scale sessions was found.

## 2. Set reconciliation (RBSR/Negentropy, Minisketch, IBLT/Rateless IBLT, MST, Prolly trees, Merkle-CRDTs)

### Takeaway
Range-based set reconciliation (Negentropy) is the best-fitting anti-entropy primitive: no parameter to guess, 2–3
round trips at 100k items, pure-JS and pure-Rust implementations, native support in Nostr relays (NIP-77), and its
timestamp-ordered ranges fit expiry-driven deletion. Rateless IBLT is the bandwidth-optimal alternative for small
diffs in half a round trip but has less browser-ready code; Merkle Search Trees are the choice when the same
structure must also yield lookup proofs.

### Cited Findings
- Negentropy implements Meyer's RBSR: both sides sort items by (timestamp, ID); ranges carry Skip, Fingerprint or
  IdList; differing fingerprints split into sub-ranges; IDs are 32 bytes, timestamps u64; an optional frame-size
  limit caps message size at the cost of more round trips — [hoytech/negentropy README, fetched](https://github.com/hoytech/negentropy)
- Fingerprint: sum of the IDs mod 2^256, concatenated with the count, SHA-256, truncated to 16 bytes — [NIP-77, fetched](https://github.com/nostr-protocol/nips/blob/master/77.md)
- Round trips depend on set size, not on the number of differences: with branching 16, N=10^6 needs ~4.98 messages ≈
  3 round trips, N=10^9 needs 4 — [Doug Hoyte, "Range-Based Set Reconciliation", fetched](https://logperiodic.com/rbsr.html)
- Fingerprint security: XOR fingerprints can be collided in ~2 s by Gaussian elimination; the additive mod-2^256
  fingerprint took ~28 h on 8 cores with 60 GB RAM and 1.5 TB storage using a generalized-birthday solver, needing
  "several hundred" malicious records — [logperiodic.com/rbsr.html, fetched](https://logperiodic.com/rbsr.html)
- Implementations listed as stable: C++ (Vector, BTreeMem, BTreeLMDB), JavaScript (reference, Vector storage), Rust
  (Yuki Kishimoto), Go, C#, Kotlin, Perl; used by strfry and Waku Sync; strfry "routinely" syncs sets of tens of
  millions — [hoytech/negentropy, fetched](https://github.com/hoytech/negentropy); [logperiodic.com/rbsr.html, fetched](https://logperiodic.com/rbsr.html)
- Negentropy "does not support the concept of updating or changing a record while preserving its ID" (an update is a
  delete plus an insert) — [hoytech/negentropy, fetched](https://github.com/hoytech/negentropy)
- NIP-77 wire protocol: NEG-OPEN (filter + initial message), NEG-MSG, NEG-ERR (`blocked:` when the query is too big,
  `closed:` on timeout), NEG-CLOSE; status draft/optional; protocol version byte 0x61 — [NIP-77, fetched](https://github.com/nostr-protocol/nips/blob/master/77.md)
- Meyer's paper gives the general construction (any monoid fingerprint over a sorted set, logarithmic rounds,
  communication proportional to the difference times a log factor) — [Meyer, "Range-Based Set Reconciliation", arXiv 2212.13567, memory](https://arxiv.org/abs/2212.13567)
- Minisketch (PinSketch): a sketch of capacity c for b-bit elements is exactly b·c bits (information-theoretically
  optimal), decoding cost grows quadratically in c, elements at most 64 bits, and decoding fails outright if the
  difference exceeds c — [bitcoin-core/minisketch, memory](https://github.com/bitcoin-core/minisketch); its authors' largest size of interest is 4,096 and elements are ≤64 bits — [logperiodic.com/rbsr.html, fetched](https://logperiodic.com/rbsr.html); Erlay uses it with 32-bit short IDs for Bitcoin transaction relay — [Naumenko et al., arXiv 1905.10518, memory](https://arxiv.org/abs/1905.10518)
- Rateless IBLT: 3–4× lower communication than non-rateless schemes of similar computation cost, 2–2,000× lower
  computation than schemes of similar communication cost; covers differences from one to millions of items; on
  Ethereum state sync 5.6× lower completion time and 4.4× lower communication than the production system — [Yang, Gilad, Alizadeh, SIGCOMM 2024, arXiv 2402.02668, fetched (abstract)](https://arxiv.org/abs/2402.02668)
- Rateless IBLT overhead is about 1.35 coded symbols per difference for large differences and at most ~1.72 for small
  ones; the reference implementation is in Go — [arXiv 2402.02668 body and github.com/yangl1996/riblt, memory; not in the abstract](https://github.com/yangl1996/riblt)
- Classic IBLT-based difference digests need the difference size estimated first (strata estimator) and ~2× overhead —
  [Eppstein et al., "What's the Difference?", SIGCOMM 2011, memory](https://conferences.sigcomm.org/sigcomm/2011/papers/sigcomm/p218.pdf)
- Merkle Search Trees: a deterministic, history-independent search tree whose node boundaries come from key hashes;
  proposed for anti-entropy in open networks with low update rate relative to state size — [Auvolat & Taïani, SRDS 2019, memory](https://inria.hal.science/hal-02303490)
- atproto repositories are MSTs keyed by record path, layer = leading zero bits of SHA-256(key) counted in 2-bit
  chunks (fanout ~4), exported as CAR files, with a signed commit over the root — [atproto repository spec, memory](https://atproto.com/specs/repository)
- Prolly trees (Noms, Dolt): B-tree-like, chunk boundaries chosen by a rolling hash of content so the shape is
  history-independent; ~4 KB target chunks; diff cost proportional to the difference — [Dolt docs, memory](https://docs.dolthub.com/architecture/storage-engine/prolly-tree)
- Merkle-CRDTs: CRDT deltas as nodes of a Merkle DAG, sync by walking heads back; the DAG grows without bound absent
  compaction — [Sanjuán et al., arXiv 2004.00107, memory](https://arxiv.org/abs/2004.00107)
- Earthstar/Willow use range-based reconciliation (Willow: 3-dimensional) and support entries that expire by
  timestamp / prefix pruning rather than tombstones — [Willow sync spec, memory](https://willowprotocol.org/specs/sync/)

### Inferences
- **Negentropy at 100k items:** log16(100,000) ≈ 4.15 messages, so 2–3 round trips whatever the diff. Bytes (own
  estimate from the wire format: a range ≈ bound 2–10 B + mode 1 B + 16 B fingerprint): the opening message ≈
  16 ranges ≈ 0.3–0.5 KB; an identical set costs just that. One isolated difference costs ~3 levels × ~0.4 KB plus a
  leaf IdList (≤ a few dozen × 32 B) ≈ 1–2 KB; d scattered differences ≈ d × ~1 KB until their paths overlap, versus
  3.2 MB for the plain ID list. Comparing a single 32-byte whole-set root first makes the in-sync case ~50 B.
- **Rateless IBLT at 100k items:** a coded symbol for 32-byte IDs is ~48 B (sum, checksum, count), so d differences
  cost ~65–83 B each in one streamed flight, about 10× less than RBSR for isolated diffs and with no round-trip
  dependence; the sender's symbol stream is the same for every peer, so it can be cached and updated incrementally.
  Costs: one more codec to port to Rust/WASM or TS, and large first-contact diffs (a newcomer) are better served by a
  snapshot anyway.
- **Minisketch** is optimal in bytes (8 B per difference with 64-bit short IDs) but needs a capacity guess, fails
  all-or-nothing, and is C++ with field arithmetic: a poor fit for high-churn peers whose diff sizes vary from 0 to
  thousands.
- **Expiry-driven deletion.** All of these reconcile *sets*; deletion is the hard part only when it needs tombstones.
  If every record carries its signed expiry and every node drops records past expiry by rule, no tombstone is needed
  and a stale peer cannot resurrect anything (the record is self-evidently dead). Negentropy sorts by a u64
  "timestamp": using the **expiry** as that timestamp makes expired records a prefix that both sides skip by starting
  the range at now − slack, so clock skew produces no spurious diffs. MST/Prolly trees keyed by name need a rewrite
  of the path on each expiry (churn in the root every day when expiries are day-granular: fine, but the root moves).
  Renewals and key changes are delete+insert of an ID in RBSR; a peer offered the superseded record rejects it by
  sequence number/expiry, and the sets converge once the stale peer learns the newer one.
- **MST / Prolly** cost one round trip per tree level unless subtrees are fetched speculatively (depth ≈ 8–9 at
  fanout 4, ≈ 3 at fanout ~64 for 100k keys), i.e. more round trips than RBSR for the same diff, but they produce a
  **state root** and membership/non-membership paths as a by-product (section 4).
- **Merkle-CRDT DAGs** fit poorly: unbounded history, sync cost tied to history length, nobody to compact it.
- **Verdicts.** RBSR/Negentropy: strong fit (anti-entropy between peers and, via NIP-77, against a relay holding
  records as events). Rateless IBLT: strong on bytes, moderate on implementation readiness. Minisketch: weak fit.
  Plain IBLT: superseded by rateless. MST: good fit if a root and proofs are wanted. Prolly tree: workable, no
  advantage over MST here. Merkle-CRDT: poor fit.

### Gaps
- No published byte counts for Negentropy on 100k items with small diffs were found (the README and the article give
  none); the figures above are derived from the format and should be measured with the JS or Rust implementation.
- Which public relays (and which of the room's six defaults) accept NIP-77, and their `blocked:` thresholds, was not
  checked; the NIP names none.
- Whether a maintained WASM/JS port of Rateless IBLT or of Minisketch exists in late 2026 was not verified.
- The 1.35×/1.72× Rateless IBLT overheads come from memory of the paper's body, not the fetched abstract.

## 3. DHT-style partial replication in browsers (Kademlia over WebRTC, churn, Sybil/eclipse, one-hop, DHT on relays)

### Takeaway
A multi-hop DHT is a poor fit: the whole state (≤~14 MB) is smaller than what a DHT saves, each hop to a new browser
peer costs a signalled connection (here ~0.3–1.4 s cold), minute-scale sessions demand high replication factors and
constant repair, small open DHTs are cheap to eclipse, and a DHT stores nothing when nobody is online. If partial
replication were ever needed, a one-hop/full-membership scheme or relay-tag rendezvous per key range fits the
overlay better than iterative Kademlia.

### Cited Findings
- Kademlia: XOR metric, k-buckets (k=20), α=3 parallel iterative lookups, O(log n) hops, records republished
  periodically and expiring after 24 h — [Maymounkov & Mazières, IPTPS 2002, memory](https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf)
- IPFS measurement (SIGCOMM 2022): churn computed from 467,134 session observations — [Trautwein et al., arXiv 2208.05877, search](https://arxiv.org/pdf/2208.05877); the paper reports that the large majority of sessions are short (figures recalled as 87.6% under 8 h and 2.5% over 24 h) and DHT publication medians of tens of seconds versus retrieval of a few seconds — [same paper, memory; the search did not confirm the exact percentages](https://arxiv.org/pdf/2208.05877)
- ProbeLab: 80% of IPFS DHT requests from the EU resolve in under 500 ms (server nodes on public IPs, not browsers) — [IETF 118 ANRP slides, search](https://www.irtf.org/anrp/IETF118-ANRP-Trautwein.pdf)
- Classic churn studies found heavy-tailed session lengths with medians of minutes to about an hour in file-sharing
  networks — [Stutzbach & Rejaie, "Understanding Churn in Peer-to-Peer Networks", IMC 2006, memory](https://dl.acm.org/doi/10.1145/1177080.1177105)
- Mainline DHT: sub-second lookups are achievable only with tuned clients; typical lookups took over a second —
  [Jimenez et al., "Sub-Second Lookups on a Large-Scale Kademlia-Based Overlay", P2P 2011, memory](https://ieeexplore.ieee.org/document/6038665)
- Browsers and libp2p: JS DHT in the browser was described by maintainers as unstable; browser nodes are advised to
  run kad-dht in **client mode** because they are not online long enough to be good servers — [libp2p forum, search](https://discuss.libp2p.io/t/how-to-make-dht-work-in-the-browser/2494); [js-ipfs issue 3905, search](https://github.com/ipfs/js-ipfs/issues/3905)
- Browser-to-browser libp2p WebRTC needs a Circuit Relay v2 connection to carry the SDP for each new peer — [libp2p WebRTC docs, search](https://docs.libp2p.io/docs/webrtc-browser-connectivity/)
- WebTorrent in browsers does not use the DHT (`bittorrent-dht` is UDP, Node only); browser peers are found through
  WebSocket trackers — [WebTorrent FAQ, memory](https://github.com/webtorrent/webtorrent/blob/master/docs/faq.md)
- Hyperswarm's DHT is UDP hole-punching for Node; browsers reach it only through a relay — [holepunchto/hyperdht, memory](https://github.com/holepunchto/hyperdht)
- S/Kademlia: node IDs bound to keys with static and dynamic crypto puzzles, lookups over d disjoint paths; the
  paper reports ~99% lookup success with 20% adversarial nodes at d=8 — [Baumgart & Mies, 2007, memory](https://ieeexplore.ieee.org/document/4447808)
- Eclipse of arbitrary IPFS nodes with modest resources — [Prünster et al., "Total Eclipse of the Heart", USENIX Security 2022, memory](https://arxiv.org/abs/2011.12814); censoring a CID by placing ~k Sybils closest to it — [Sridhar et al., "Content Censorship in IPFS", NDSS 2024, memory](https://arxiv.org/abs/2307.12212)
- Sybil attacks observed in the wild on Mainline — [Wang & Kangasharju, "Real-World Sybil Attacks in BitTorrent Mainline DHT", GLOBECOM 2012, memory](https://ieeexplore.ieee.org/document/6503215); Tor v2 HSDirs could be taken over for any onion service by choosing fingerprints — [Biryukov et al., "Trawling for Tor Hidden Services", IEEE S&P 2013, memory](https://ieeexplore.ieee.org/document/6547103); I2P's floodfill netDb eclipsed with a few tens of nodes — [Egger et al., "Practical Attacks Against the I2P Network", RAID 2013, memory](https://link.springer.com/chapter/10.1007/978-3-642-41284-4_22)
- One-hop overlays: full membership tables are affordable up to around a million nodes at measured churn —
  [Gupta, Liskov, Rodrigues, "Efficient Routing for Peer-to-Peer Overlays", NSDI 2004, memory](https://www.usenix.org/legacy/event/nsdi04/tech/full_papers/gupta/gupta.pdf); Dynamo uses gossip-based full membership with consistent hashing and N=3 replicas — [DeCandia et al., SOSP 2007, memory](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- BEP 44 / IPNS precedent for untrusted DHT storage of signed mutable items with a sequence number (highest valid
  seq wins) — [BEP 44, memory](https://www.bittorrent.org/beps/bep_0044.html)

### Inferences
- **Hop cost here.** A hop to a peer already connected is one RTT (~50–200 ms). A hop to a new peer is a Nostr
  lookup + DERP call back + handshake: 294–450 ms typical, ~1.4 s on slow relays or after a burst (repo, section 0).
  At N=2,000 with k=20 an iterative lookup needs ~2–3 rounds, mostly to new peers: ~0.6–1.4 s typical and 3–4 s in
  the tail, against a 2 s budget, and each round spends α=3 of the 8 lookups/s. Generic WebRTC DHTs that wait for ICE
  (often 1–3 s per connection, unverified) are worse. Routing tables of ~100–200 contacts cannot be kept as open
  connections under the 64-connection cap and 60 s idle close, so nearly every hop is cold.
- **Replication under churn.** With exponential sessions of median m, the chance a replica holder leaves within a
  repair interval T is 1 − 2^(−T/m). For m=20 min, T=20 min: 0.5, so r=20 replicas lose a record with probability
  ~10^-6 per interval, ~7 records/day out of 100k (72 intervals/day): not enough. T=5 min: 0.16, r=8 gives ~4×10^-7
  per interval, still ~12 records/day at 288 intervals/day; r=12 gives ~3×10^-10. So r≈12–20 with repair every few
  minutes, i.e. each of 2,000 nodes holds 100k·r/N = 600–1,000 records (0.6–1% × r of the state; 6–14% of the total
  bytes at r=12–20) and must hand off continuously. Record owners can't republish (they may be offline for months), so
  persistence rests entirely on holders' handoff.
- **The saving is small.** Holding 1/10th of ≤14 MB saves ~12 MB of browser storage and a one-time download; it buys
  multi-hop lookup latency, repair traffic and attack surface. And when the room shrinks to a handful of nodes, r
  exceeds N and every node holds everything anyway; when it shrinks to zero, a DHT holds nothing.
- **Sybil.** In an open room a node ID is a free key (the miner makes 26–34 M keys/s), so an attacker can place k
  nodes closest to any name's hash in milliseconds and withhold or serve stale records. PoW node IDs (S/Kademlia)
  only raise that linearly against a browser's small PoW budget; disjoint paths multiply cold-hop cost. Signed
  records limit the damage to denial/staleness, but that is exactly a DNS failure.
- **One-hop / full membership.** A member list for 2,000 nodes is ~64–80 KB (32-byte keys) and churn of ~2.3 events/s
  × ~40 B ≈ 100 B/s per node to disseminate: affordable. It makes lookups 1 cold hop (meets ~2 s mostly) and gives
  consistent-hash placement with successor-list replication. But it is a membership list, which the rooms decisions
  exclude, and it shares the DHT's persistence and Sybil problems.
- **"DHT on Nostr relays".** A relay forwards an event to all subscribers of a tag, so key-space bucket b can be a
  tag H(room, "registry", b, hour); holders of that bucket subscribe, a querier publishes one ephemeral event and any
  online holder calls back: 1 relay hop + 1 call back ≈ the existing cold lookup latency (~0.3–1.4 s), no routing
  table, no enumeration. Costs: every query fans out to all subscribers of the tag (2,000 subscribers × 570 B ≈
  1.1 MB of relay egress per query per relay if unsharded; ~20 subscribers per bucket keeps it ~11 KB), public
  relays' rate limits apply, relays can observe query timing per bucket, and any member can flood the tag. With
  full replication the same trick with a single "any registry holder" tag serves bootstrap and fallback lookups.
- **Verdicts.** Iterative Kademlia over WebRTC: poor fit. S/Kademlia hardening: does not rescue it at this scale.
  One-hop full membership: technically feasible, conflicts with a binding decision, no persistence gain. Relay-tag
  rendezvous: good fit as a discovery/fallback-query primitive, not as storage.

### Gaps
- No production system that uses Nostr relays as DHT buckets was found; the pattern above is an inference from how
  relays forward by tag.
- Exact IPFS session-length percentages, S/Kademlia's success figures and the Sybil counts in the IPFS attack papers
  are from memory and were not confirmed by this session's searches.
- No measurement of browser tab session lengths for this kind of page exists; "median 10–30 minutes" is the brief's
  assumption.
- The current state of js-libp2p kad-dht in browsers in late 2026 could not be confirmed from an official page; the
  search returned mostly older forum posts.

## 4. Authenticated lookups against untrusted peers (state roots, proof sizes, learning a root, caching)

### Takeaway
Per-record signatures already prove a binding is authentic; what an untrusted peer can still do is withhold a record
or serve a superseded one. Proving freshness or non-existence needs a state root, and for 100k entries a
Merkle path is ~0.5–1 KB; the hard part is not the proof but how a browser learns a trustworthy root without an
owner (peer majority is Sybil-able; PoW headers and witness cosignatures are the known answers). With full local
replication almost all lookups are local and proofs matter only during bootstrap.

### Cited Findings
- Urkel tree (Handshake): a base-2 merkelized trie in append-only flat files; proof siblings are 32 bytes each;
  designed so proofs stay under 1 KB "even after hundreds of millions of leaves"; supports absence proofs; BLAKE2b-256
  in the example — [handshake-org/urkel, fetched](https://github.com/handshake-org/urkel)
- Sparse Merkle trees give membership and non-membership proofs of one hash per level, compressible to about
  log2(N) non-default siblings — [Dahlberg, Pulls, Peeters, "Efficient Sparse Merkle Trees", ePrint 2016/683, memory](https://eprint.iacr.org/2016/683)
- Handshake light clients (hnsd) take the name-tree root from PoW block headers and verify Urkel proofs from
  untrusted full nodes — [handshake-org/hnsd, memory](https://github.com/handshake-org/hnsd)
- Verkle trees shrink witnesses to roughly 150–200 bytes per access using polynomial/vector commitments, at the
  price of elliptic-curve (IPA or pairing) verification — [Buterin, "Verkle trees", 2021, memory](https://vitalik.eth.limo/general/2021/06/18/verkle.html)
- Transparency-log style roots: a signed tree head cosigned by independent witnesses that check append-only
  consistency — [C2SP tlog-witness, memory](https://github.com/C2SP/C2SP/blob/main/tlog-witness.md); [Sigsum, memory](https://www.sigsum.org/)
- atproto: each repository's MST root is in a commit signed by the account's key; consumers verify records against it —
  [atproto repository spec, memory](https://atproto.com/specs/repository)
- IPNS/BEP 44 style: no root; clients query several holders and keep the valid record with the highest sequence number —
  [BEP 44, memory](https://www.bittorrent.org/beps/bep_0044.html)

### Inferences
- **Proof sizes at 100k entries** (log2 100,000 ≈ 16.6): a compressed sparse-Merkle or Urkel path ≈ 17 × 32 B ≈ 544 B
  plus a ~32 B bitmap and the leaf; non-membership the same size (the path ends at an empty slot or another key).
  A CT-style sorted binary tree: 544 B for inclusion, ~1.1 KB for non-membership by two adjacent leaves, but a light
  client cannot check that the tree is sorted, so hashed-key tries (SMT/Urkel) or an MST are the sound choices. An
  MST at fanout 4 has ~8–9 levels of nodes of ~4 entries: ~1.5–3 KB per proof. Verkle would be ~150–200 B but adds a
  curve library and tens of ms of WASM verification for no benefit at this size.
- **What needs a root at all.** (a) Authenticity of name→key: the record's own signature suffices. (b) "This is the
  latest record for the name" and (c) "this name does not exist": need a root, or a quorum heuristic (ask k
  independent peers, take the highest sequence/expiry; NXDOMAIN only when all agree). (d) "Who registered first":
  needs an ordering authority and is outside sync.
- **How a light node learns a root, and the failure mode of each.** Majority of connected peers: free, but a Sybil
  majority among 3–5 neighbours is cheap in an open room. PoW header chain (Handshake, Namecoin, ALFIS): browsers can
  verify headers cheaply, but a hobby-scale chain's PoW is outmined by one GPU. Witness cosignatures on a tree head:
  small (a few 64–96 B signatures), verifiable offline, survives zero online peers if the signed head is parked
  somewhere, but needs always-on witnesses, which the plan page already contemplates. No root: accept
  withhold/staleness, bounded by expiry and by merging from several sources.
- **Caching so most lookups are local.** With a full local copy, resolution is a hash-map hit (microseconds) and the
  2 s target only matters (i) for a newcomer still bootstrapping and (ii) for names registered in the last seconds.
  For (i): query a connected neighbour (one RTT) or a rendezvous tag (cold lookup ~0.3–1.4 s) and accept a signed
  record, optionally with a path against the best-known root; cache positives until their expiry and negatives
  briefly (tens of seconds). The DNS answers the room's resolver gives the guest can carry short TTLs so a renewal or
  re-key is seen quickly.
- **Verdicts.** Per-record signatures: necessary baseline. SMT/Urkel root with paths: good fit if non-existence and
  freshness must be provable; cheap at this size. MST: good if the reconciliation structure and the proof structure
  should be one. Verkle: poor fit. Root from peer majority: weak under Sybil. Root from witnesses: fits the plan
  page's direction but needs infrastructure. Root from PoW: weak at hobby scale.

### Gaps
- Urkel's proof size as a function of N is not given by its README; the 544 B figure is derived.
- Handshake's tree-commit interval and hnsd details were not re-read.
- WASM verification cost of Merkle paths, BIP-340 and Verkle proofs in this codebase is unmeasured.

## 5. Compact encodings of the state

### Takeaway
A record is dominated by incompressible bytes: a 32-byte key and a 64-byte signature. Realistic totals are ~0.5 MB
(10k) and ~5 MB (100k) without signatures, ~1.1 MB and ~11 MB with one 64-byte signature each, and ~1.4 MB / ~14 MB
if the owner's signing key differs from the node key. Aggregation can halve signature bytes (Schnorr
half-aggregation) or erase them (BLS, or a consensus/witness-signed root) but removes the ability to verify one
record on its own.

### Cited Findings
- A room address is derived from the node key (the /48 plus its first 80 bits), so storing the 32-byte key makes a
  stored AAAA redundant — [repo: rooms.md](/home/user/waarm64/docs/networking/rooms.md)
- BIP-340 Schnorr: 32-byte x-only public keys, 64-byte signatures (already available through `k256`) — [BIP-340, memory](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki)
- Half-aggregation of Schnorr/EdDSA signatures is non-interactive and compresses n signatures to about half
  (32·n + 32 bytes); verification is one multi-scalar multiplication over all messages and keys — [Chalkias et al., ePrint 2021/350, memory](https://eprint.iacr.org/2021/350); [BIP-340 half-aggregation draft, memory](https://github.com/BlockstreamResearch/cross-input-aggregation/blob/master/half-aggregation.mediawiki)
- BLS signatures aggregate non-interactively to a single 48-byte (or 96-byte) group element whatever n is; verifying
  n distinct messages costs n+1 pairings — [draft-irtf-cfrg-bls-signature, memory](https://datatracker.ietf.org/doc/draft-irtf-cfrg-bls-signature/)
- XEdDSA lets an X25519 key pair produce EdDSA-compatible signatures — [Signal XEdDSA spec, memory](https://signal.org/docs/specifications/xeddsa/)
- DNS labels are at most 63 octets — [RFC 1035, memory](https://www.rfc-editor.org/rfc/rfc1035)

### Inferences
- **Per-record layout (minimal):** name length 1 B + name ~10 B average (cap 63) + key 32 B + expiry as epoch-day
  u16 2 B (covers until 2149) + sequence/flags ~2 B ≈ **47 B** unsigned; + 64 B signature ≈ **111 B**; + 32 B when a
  separate owner key signs for a node key ≈ **143 B**. As Nostr JSON events (hex id, pubkey, sig, tags) the same
  record is ~300–400 B.
- **Totals.** 10k names: ~0.47 MB unsigned, ~1.1 MB signed, ~1.4 MB with owner keys, ~3–4 MB as Nostr events.
  100k names: ~4.7 MB, ~11.1 MB, ~14.3 MB, ~30–40 MB. These line up with the 1 / 10 / 25 MB points of the brief.
- **Compression buys little.** Keys and signatures are uniformly random; only the ~10–13 B of name/expiry/sequence
  compress. Front-coding sorted names or a zstd dictionary might save 3–6 B per record: ≤5% of a signed snapshot.
  Not worth a dependency (and a zstd dependency would need the user's OK).
- **Dropping or aggregating signatures.**
  - Half-aggregation: 100k records ≈ 4.7 + 3.2 = ~7.9 MB instead of 11.1 MB; the aggregate verifies only as a whole
    (one bad record fails everything, and a subset can't be proven to a third party), though incremental
    re-aggregation exists. Usable for snapshots, not for gossip or single-record answers.
  - BLS: signature bytes vanish but keys become 48 B, node keys are X25519 so a second key is unavoidable, a pairing
    library is a heavy new dependency, and ~100k pairings in WASM is plausibly minutes. Poor fit.
  - State root only (signatures checked once by whoever admitted the record, then discarded): 100k ≈ 4.7 MB and no
    per-record verification CPU, but all trust moves to how the root is authenticated (section 4); a node can no
    longer convince another of a single record without a path to an agreed root.
  - Middle path seen in practice (atproto, CT): signatures travel with updates; snapshots carry records plus a root,
    with signatures available on demand.
- **Key choice.** One 32-byte value can serve as both identity and address source only if the signature scheme works
  on the node's X25519 key (XEdDSA) or the node key is derived from the signing key; otherwise +32 B per record.

### Gaps
- The average name length is assumed (10 B); real distributions (and whether names are per-TLD or flat) change totals
  by ±10%.
- No measurement of BIP-340/Ed25519 batch or half-aggregate verification speed in WASM in this toolchain (built
  without `simd128`).
- Whether half-aggregation has a maintained, audited Rust implementation in 2026 was not checked.

## 6. Browser storage and limits (OPFS/IndexedDB, WebRTC connections and messages, workers)

### Takeaway
Storage is not a constraint: Chromium allows an origin up to 60% of the disk and evicts whole origins only under
storage pressure, least-recently-used first, never a persisted one; a 1–25 MB registry is noise beside the page's
disk images. The binding limits are connections (the room's own cap of 64, far below Chromium's ceiling), the
256 KiB data-channel message size, and CPU shared with the emulator.

### Cited Findings
- Chromium: an origin may use up to 60% of total disk in both best-effort and persistent modes; all origins together
  up to 80% — [MDN "Storage quotas and eviction criteria", fetched](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- Eviction happens under storage pressure or when the browser-wide cap is exceeded, LRU by origin, deleting **all**
  of an origin's data together (IndexedDB, Cache, OPFS); persistent origins are skipped; data of regularly visited
  sites is "very rarely" deleted — [MDN, fetched](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- `navigator.storage.persist()` is granted or denied by Chromium without a prompt from the user's interaction
  history with the site; Firefox prompts — [MDN, fetched](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- Firefox best-effort: min(10% of disk, 10 GiB) per site group; Safari ~60% of disk for browser apps and deletes
  script-written data of origins without interaction for 7 days when tracking prevention is on — [MDN, fetched](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- Private/incognito sessions may have different quotas and data is deleted at the session's end — [MDN, fetched](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria); the page's OPFS lives in memory off the record — [repo: docs/remote-disks.md, docs/machines.md](/home/user/waarm64/docs/machines.md)
- Data-channel message size: read `RTCSctpTransport.maxMessageSize`; the fallback when the remote SDP omits the
  attribute is 65,536 bytes — [WPT RTCSctpTransport-maxMessageSize, search](https://chromium.googlesource.com/external/w3c/web-platform-tests/+/8fadb381209a215280dc3ad96d0f135b6005f176/webrtc/RTCSctpTransport-maxMessageSize.html); Chromium advertises 262,144 — [MDN "Using WebRTC data channels", memory](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
- Large messages without SCTP message interleaving monopolise the association — [Mozilla WebRTC blog, search](https://blog.mozilla.org/webrtc/large-data-channel-messages)
- The room's measured channel: set up in 92 ms and 142–173 Mbit/s on loopback (Chromium 141, unreliable channel);
  Chromium "queues megabytes before `send` throws" — [repo: rooms.md](/home/user/waarm64/docs/networking/rooms.md)
- A room member's module costs ~1.4 MiB of linear memory — [repo: bench/net/REPORT.md](/home/user/waarm64/bench/net/REPORT.md)

### Inferences
- A registry copy of ≤25 MB fits either IndexedDB (records, queryable by name) or one OPFS file plus an in-memory
  index; both live and die with the rest of the origin's data, so the registry's persistence equals the machines'.
- Snapshot chunks should be ≤16–64 KiB messages on a reliable ordered channel with `bufferedAmount` back-pressure;
  the room's existing channel is unreliable, so bulk sync needs a second channel or a reliability layer.
- Blink's hard ceiling on `RTCPeerConnection`s per page is commonly cited as 500, but the practical limit for a tab
  that also runs an emulator is the room's 64 (each connection holds ICE/DTLS/SCTP state and keepalives); a gossip
  view of 5–8 neighbours uses about a tenth of it, leaving the rest to the guest.
- Verification and reconciliation belong in a worker (the room worker or a sibling) so they never block the page's
  thread or the vCPU workers; cost is a few MiB of memory plus whatever CPU the signature checks take (section 1).

### Gaps
- The 500-connection ceiling was not confirmed by this session's search (no source returned); treat as unverified.
- No sourced figure for Chromium's incognito quota or the exact heuristics behind `persist()` (web.dev's
  persistent-storage article was not fetched).
- No sourced figure for reliable data-channel throughput between real browsers (dcSCTP) across the internet.

## 7. Bootstrapping an empty room (own copy, relays, Blossom/NIP-96, IPFS) and validating untrusted snapshots

### Takeaway
When nobody is online, state can only come from the node's own OPFS copy or from always-on third-party storage.
Nostr relays can hold records as events (and reconcile them with NIP-77) but public relays cap events at roughly
64–512 KiB and promise no retention; Blossom gives content-addressed blobs whose integrity is self-checking but
whose retention on free servers is undocumented. A snapshot from untrusted storage can be validated record by
record for authenticity and merged as a union; its completeness and freshness cannot be validated without an
authenticated root.

### Cited Findings
- NIP-11 `max_message_length` bounds incoming JSON and so the event size; examples and defaults seen: 65,535–65,536
  bytes in sample documents, 524,288 (512 K) as rnostr's default and in a sample document; one relay project raised
  its WebSocket limit from 500 KB to 10 MB — [NIP-11 mirror, search](https://nips.4rs.nl/nips/11); [rnostr example config, search](https://rust-digger.code-maven.com/src/rnostr-0.4.7/rnostr.example.toml)
- The room's own test relay closes a connection on a message past 1 MiB — [repo: rooms.md "Tests"](/home/user/waarm64/docs/networking/rooms.md)
- NIP-77 lets a client reconcile its event set with a relay's by filter; a relay may answer `blocked:` when the query
  is too big, optionally with a maximum record count — [NIP-77, fetched](https://github.com/nostr-protocol/nips/blob/master/77.md)
- Of 29 public relays tested for the rooms' ephemeral traffic, 21 carried it; some rate-limited a burst of 16 events —
  [repo: bench/net/REPORT.md "Rooms on public servers"](/home/user/waarm64/bench/net/REPORT.md)
- Blossom: blobs addressed by SHA-256 over plain HTTP (`GET /<sha256>`, `HEAD`, `PUT /upload`, `PUT /mirror` BUD-04,
  `DELETE`, `GET /list/<pubkey>`), uploads authorised by a Nostr-signed kind 24242 event, a user's server list in
  kind 10063; the spec states no retention or size limits — [hzrd149/blossom, fetched](https://github.com/hzrd149/blossom)
- Public Blossom servers named in community posts include blossomservers.com, cdn.satellite.earth and
  cdn.nostrcheck.me; nostr.build's paid accounts have no per-file limit; no free-tier limits or retention terms were
  found for blossom.primal.net or blossom.band — [search results, e.g. nobsbitcoin.com/blossom-intro](https://nobsbitcoin.com/blossom-intro); [nostr.build features, search](https://nostr.build/features)
- Operators' retention depends on tier and usage per public key (one operator's policy) — [Azzamo data-retention policy, search](https://docs.azzamo.net/policies/data-retention)
- atproto precedent: bootstrap from a CAR snapshot of the repository, then follow the event stream — [atproto sync spec, memory](https://atproto.com/specs/sync)

### Inferences
- **Own OPFS copy** is the first source for a returning node: free, instant, and stale only by the time away; with
  day-granular expiries a copy a month old is still mostly right. It is lost in private windows and with origin
  eviction.
- **Records as stored Nostr events.** One event per record (~300–400 B JSON) means 3–4 MB for 10k and 30–40 MB for
  100k per relay; a returning node can run NIP-77 against a relay and fetch only the difference, and relays become
  the "always-on peer" when the room is empty. Risks: public relays may refuse or purge an unknown kind at that
  volume, apply rate limits or require payment/PoW, and it reverses the rooms decision that nothing is stored on a
  relay (though a registry record is public by nature). A room's own relay removes the risk.
- **Snapshots as chunked events.** With a 64 KiB event cap and base64 in JSON (~33% overhead) a chunk carries ~45 KB:
  ~25 events per MB, ~250–320 events for an 11–14 MB snapshot, re-published by whoever is online every so often.
  Fragile on public relays (rate limits on bursts were observed at 16 events).
- **Blossom.** Integrity is free (the name is the hash), so the problem reduces to a small trusted *pointer*: a
  replaceable Nostr event or gossip message saying "snapshot of state root R at time t is blob H". Anyone can upload
  (any Nostr key signs the auth event on open servers), mirrors are one call (BUD-04), and a browser fetches with a
  plain HTTP GET (the page's COEP setting needs the server's CORS/CORP headers to allow it: to be checked per
  server). Retention on free servers is unknown, so several servers and periodic re-upload by online nodes would be
  needed. NIP-96 is the older HTTP upload scheme that Blossom has been displacing (status unverified).
- **IPFS pinning** needs an account or payment with a pinning service, which an ownerless room doesn't have, and
  browser retrieval goes through gateways; weaker fit than Blossom for the same job.
- **Validating a snapshot from untrusted storage.** Checkable locally: every record's signature, expiry, format, and
  (if used) proof of work; duplicates resolved by sequence/expiry. Not checkable without a root: omissions and
  superseded records. Since merging is a union with a deterministic winner per name, an untrusted snapshot can only
  fail by being incomplete or old, and merging several sources (own copy, two servers, the first peers met) bounds
  that. A snapshot whose signatures were dropped or aggregated (section 5) can only be accepted against an
  authenticated root.
- **Spam is the real validation problem:** a snapshot stuffed with validly signed junk registrations is "valid".
  That is admission control (cost per registration), not sync.
- **Verdicts.** Own OPFS copy: required baseline. Records on Nostr relays with NIP-77: good fit on a room's own relay,
  uncertain on public ones. Blossom snapshot + pointer: good fit for cold start, retention unproven. Chunked
  snapshot events: workable fallback, fragile. IPFS pinning: poor fit.

### Gaps
- strfry's default `maxEventSize` (recalled as 65,536) was not confirmed by search; the room's six default relays'
  NIP-11 limits and storage policies for unknown kinds were not fetched.
- No documented size limit, retention period or rate limit for any free public Blossom server was found; this would
  have to be measured, as the repo did for relays.
- Whether public Blossom servers send CORS/CORP headers compatible with a cross-origin-isolated page was not checked.
- NIP-96's deprecation status in late 2026 was not verified.

## 8. Lessons from systems that replicate everything to every peer (SSB, Briar, Earthstar, ALFIS, others)

### Takeaway
Full replication works well for small, bounded, self-pruning data sets and fails when state only grows: Scuttlebutt's
append-only logs made initial sync the dominant user-facing problem, while systems with built-in expiry or
overwrite (Earthstar/Willow) and tiny chains (ALFIS) stay syncable. The recurring pattern is snapshot or
range-reconciliation for catch-up plus epidemic push for live updates.

### Cited Findings
- Secure Scuttlebutt replicates whole per-identity append-only signed logs to every follower; nothing can be deleted;
  live replication uses EBT (Plumtree with per-feed vector clocks) — [Tarr et al., "Secure Scuttlebutt", ACM ICN 2019, memory](https://dl.acm.org/doi/10.1145/3357150.3357396); [ssbc/ssb-ebt, memory](https://github.com/ssbc/ssb-ebt)
- Briar's Bramble Synchronisation Protocol syncs message groups only between direct contacts with offer/request/ack
  records, no DHT and no global state — [Briar BSP spec, memory](https://code.briarproject.org/briar/briar-spec/blob/master/protocols/BSP.md)
- Earthstar documents are overwritten per (path, author) and can carry a delete-after time; its successor Willow
  specifies range-based (3-D) set reconciliation and prefix pruning so data is actually removed — [Willow data model and sync specs, memory](https://willowprotocol.org/specs/data-model/)
- ALFIS (Yggdrasil's naming system) is "a minimal blockchain without cryptocurrency" for names in its own zones;
  every node keeps the whole chain in a local `blockchain.db`; its predecessor Wyrd (a crawler-based DNS) was
  deprecated in its favour — [Revertron/Alfis, search](https://github.com/Revertron/Alfis); [Revertron/wyrd, search](https://github.com/Revertron/wyrd)
- Negentropy is in production for relay-to-relay full sync in strfry and in Waku Sync — [hoytech/negentropy, fetched](https://github.com/hoytech/negentropy)
- Bitcoin's Erlay replaces flooding of announcements with low-fanout flooding plus periodic sketch reconciliation —
  [Naumenko et al., arXiv 1905.10518, memory](https://arxiv.org/abs/1905.10518)
- Trystero's Nostr strategy announces to everyone on a topic and builds a full mesh; its README advises splitting
  users into groups — [repo: rooms.md "Decisions" (checked at 0.26.0)](/home/user/waarm64/docs/networking/rooms.md)

### Inferences
- SSB's lesson: unbounded logs + full replication = onboarding measured in minutes to hours and hundreds of MB; a
  registry must be a bounded *set* (one live record per name, expiry prunes), not a log every node replays.
- Briar's lesson: restricting sync to peers one already talks to makes Sybil irrelevant but gives no global
  namespace; a registry needs strangers to sync, so it inherits the open-network problems.
- Earthstar/Willow's lesson: expiry inside the signed record plus range reconciliation removes the tombstone problem
  (section 2).
- ALFIS's lesson: a hobby network's entire name system fits in a small file every node carries; the scale assumed
  here (≤100k names, ≤14 MB) is in the regime where "everyone has everything" is the simple, proven choice. Its
  costs are PoW mining for registration and full-chain download for newcomers.
- Erlay/strfry's lesson: combine a low-fanout eager push with periodic reconciliation, rather than relying on either.

### Gaps
- No figures were found for ALFIS's chain size, domain count or sync time (the project pages give none); they would
  have to be measured from a node or its explorer (viewer.alfis.name).
- SSB onboarding sizes/times are widely reported anecdotally but no primary measurement was fetched.
- No documented browser-only (no server peer) deployment of SSB, Earthstar or Briar at thousands of concurrent tabs
  was found; all rely on some always-on peer (pubs, rooms, servers) in practice, which is itself a lesson for the
  "sometimes no node is online" case.
