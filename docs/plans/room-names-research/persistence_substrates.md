# Persistence, ordering and time substrates reachable from a static web page (state: 2026-11-15)

Conventions used below.
- "Own probe" = measured in this session on 2026-11-15 from a cloud container (curl with an `Origin:` header for CORS;
  a hand-written NIP-01 client over WebSocket for relays; throwaway random keys; every test event carried a NIP-40
  `expiration` of 30-60 min). The scripts are in the session scratchpad
  (`/tmp/claude-0/-home-user-waarm64/c65c4f95-ada3-523a-b48a-3e8521aa6b2f/scratchpad/probe/probe.py` and `burst.py`),
  not in the repo. A probe shows behaviour on one day from one IP; it is not a policy statement by the operator.
- Items marked **[unverified]** come from background knowledge (training data up to mid-2026) and were not re-checked
  against a primary source in this session. They sit under "Gaps" or are flagged inline.
- The roles asked about: **(a)** durable store for records, **(b)** fair "who was first" arbiter, **(c)**
  bootstrap/snapshot store for an empty room.

## 1. Nostr relays as storage (kinds, retention, limits, querying, timestamps, censorship)

### Takeaway
Free public strfry relays accept and store unknown regular and addressable kinds from fresh keys with no AUTH, no PoW
and no fee, serve them back by author/kind/single-letter tag, and most support COUNT and (about half of those probed)
Negentropy, so they are a workable best-effort store (a) and snapshot store (c). They are not an arbiter (b):
`created_at` is writer-chosen (default strfry accepts anything from 3 years in the past to 15 minutes in the future),
relays expose no receive time or sequence number, replacement is only per (kind, pubkey, d) so two different keys
claiming one name never collide at the relay, and no relay publishes a retention commitment.

### Cited Findings

**Protocol rules**
- Kind classes: regular events "are all expected to be stored by relays"; replaceable (10000-19999, plus 0 and 3):
  "only the latest event MUST be stored by relays, older versions MAY be discarded", per pubkey+kind; ephemeral
  (20000-29999) "are not expected to be stored"; addressable (30000-39999): latest per combination of `kind`, `pubkey`
  and `d` tag value. — [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- Tie-break for replaceable/addressable events with equal `created_at`: "the event with the lowest id (first in
  lexical order) should be retained, and the other discarded". — [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- `created_at` is only defined as "unix timestamp in seconds", set by the author and covered by the signature; the
  spec gives relays no duty to check it. Filters: `since <= created_at <= until`; with `limit: n` the initial result is
  the last n events by `created_at`, newest first. — [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- Standard machine-readable `OK`/`CLOSED` prefixes: `duplicate`, `pow`, `blocked`, `rate-limited`, `invalid`,
  `restricted`, `mute`, `error`. — [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- Only single-letter tags are indexed and queryable (`#x` filters); there is no range query on tag values, no prefix
  query on `d`, only `since`/`until` on `created_at`. — [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)

**strfry defaults (the implementation behind 12 of the 15 relays whose NIP-11 was read)**
- `rejectEventsNewerThanSeconds = 900`, `rejectEventsOlderThanSeconds = 94608000` (3 years),
  `rejectEphemeralEventsOlderThanSeconds = 60`, `ephemeralEventsLifetimeSeconds = 300`, `maxEventSize = 65536`
  (normalized JSON bytes), `maxNumTags = 2000`, `maxTagValSize = 1024`, `maxFilterLimit = 500`,
  `maxSubsPerConnection = 200`, negentropy `enabled = true` with `maxSyncEvents = 1000000`. No retention option and no
  rate-limit option in the config; policy is delegated to a `writePolicy.plugin` executable (empty by default).
  — [strfry.conf](https://raw.githubusercontent.com/hoytech/strfry/master/strfry.conf)
- strfry ships Negentropy both as a relay protocol and as a CLI `sync` (up/down/both) between relays.
  — [strfry docs/negentropy.md](https://github.com/hoytech/strfry/blob/master/docs/negentropy.md)

**NIP-11 documents read (own probe, `Accept: application/nostr+json`)**
- relay.damus.io: strfry 1.1.0-158; `max_message_length` 1,000,000, `max_limit` 500, `max_subscriptions` 200;
  NIPs 1,2,4,9,11,28,40,45,59,70; `negentropy: 1`. No `retention`, no `fees`, no `min_pow_difficulty`.
  — [relay.damus.io](https://relay.damus.io/)
- nos.lol: strfry 1.1.3; `max_message_length` 131,072, `max_limit` 500, `max_subscriptions` 200; NIPs
  1,2,4,9,11,28,40,45,70; description "Generally accepts notes, except spammy ones"; ToS link. No `retention`.
  — [nos.lol](https://nos.lol/)
- relay.primal.net: strfry 1.1.3; `max_message_length` 1,000,000, `max_limit` 500, `max_subscriptions` 20; NIPs
  1,2,4,9,11,28,40,45,70. No `retention`. — [relay.primal.net](https://relay.primal.net/)
- The other five default room relays: relay.novospes.com, relay.routstr.com, nostr.rblb.it (description: "This is a
  test releay to test things!"), relay.nostrmap.net: strfry 1.1.x, 131,072-byte messages, `max_limit` 500, NIPs incl.
  40, 45, 77. relay.degmods.com: an old strfry ("v236-c0dec7c", "strfry default" name, NIPs 1,2,4,9,11,12,16,20,22,28,33,40,
  no 45/77). None publishes `retention`. — [relay.novospes.com](https://relay.novospes.com/),
  [relay.routstr.com](https://relay.routstr.com/), [nostr.rblb.it](https://nostr.rblb.it/),
  [relay.nostrmap.net](https://relay.nostrmap.net/), [relay.degmods.com](https://relay.degmods.com/)
- nostr.wine (paid): admission 18,888,000 msats; `payment_required: true`, `restricted_writes: true`;
  `created_at_lower_limit` 94,608,000 s, `created_at_upper_limit` 300 s; `max_event_tags` 4000; NIPs incl. 42 and 50.
  — [nostr.wine](https://nostr.wine/)
- relay.snort.social now runs "memlay", described as "High-performance in-memory Nostr relay"; NIPs 1,9,11 only.
  — [relay.snort.social](https://relay.snort.social/)
- purplepag.es: kind-restricted indexer; advertises NIPs 1,11,42,70,86,51,77,9. — [purplepag.es](https://purplepag.es/)
- relay.nostr.band: TLS connection reset on the NIP-11 request (unreachable from the probe). — own probe,
  [relay.nostr.band](https://relay.nostr.band/)

**Write/read behaviour measured (own probe; one fresh key per relay; 8 events of ~200-byte content: kind 37195
addressable and kind 7195 regular, neither assigned by any NIP)**
- Accepted with no AUTH, no PoW, no payment, unknown kinds stored and returned by an `authors` REQ: relay.primal.net,
  nos.lol, nostr.mom, relay.novospes.com, relay.routstr.com, nostr.rblb.it, relay.degmods.com, relay.nostrmap.net,
  offchain.pub, relay.nostr.net, nostr.bitcoiner.social, nostr.oxtr.dev, relay.snort.social (13 of 15 tried).
  — own probe, e.g. [relay.primal.net](https://relay.primal.net/), [nos.lol](https://nos.lol/)
- Refused: purplepag.es ("blocked: kind 37195 is not allowed"; REQ needs a kind). relay.damus.io answered NIP-11 but
  its WebSocket upgrade returned HTTP 521 at probe time (origin down behind its CDN). — own probe,
  [purplepag.es](https://purplepag.es/), [relay.damus.io](https://relay.damus.io/)
- **Backdating:** an addressable event with a new `d` and `created_at` = now − 365 days was accepted and stored by all
  13 accepting relays. now − 4 years: "invalid: created_at too early" on 11 strfry relays, accepted by
  relay.nostrmap.net and relay.snort.social. — own probe
- **Future dating:** `created_at` = now + 20 min and now + 2 h: "invalid: created_at too late" on all 12 strfry relays
  (consistent with the 900 s default); relay.snort.social accepted both. — own probe
- **Replacement:** an older event (now − 10 days) for an existing (kind, pubkey, d): "replaced: have newer event" on all
  strfry relays; only the newer one is returned. — own probe
- **NIP-45 COUNT** answered correctly by 10 of 13 (not relay.degmods.com, nostr.oxtr.dev, relay.snort.social).
  — own probe
- **NIP-77 Negentropy** (`NEG-OPEN` → `NEG-MSG`) works on relay.novospes.com, relay.routstr.com, nostr.rblb.it,
  relay.nostrmap.net, offchain.pub, relay.nostr.net, nostr.bitcoiner.social, nostr.oxtr.dev. nos.lol, relay.primal.net
  and nostr.mom answer "ERROR: bad msg: negentropy disabled" although their NIP-11 carries `negentropy: 1`.
  relay.degmods.com returns a negentropy error (old strfry). relay.snort.social: unknown message. — own probe
- **Event size:** a 40 KB event accepted by relay.primal.net, nos.lol, offchain.pub; a ~100 KB event accepted by
  relay.primal.net, rejected by nos.lol and offchain.pub ("invalid: event too large: 100392"). — own probe
- **Rate limits seen in a burst of 60 events in ~10 s from one key and IP:** relay.primal.net 60/60 accepted; nos.lol
  60/60; relay.nostr.net 60/60 then "rate-limited: too many events from this key (60/60s)"; relay.nostrmap.net 30
  accepted then "rate-limited: max 30 events/60s"; offchain.pub 15 accepted then "Policy violated and pubkey is not in
  our web of trust." — own probe
- The project's own measurement (2026-11-11): 21 of Trystero's 29 Nostr relays carried a room's ephemeral events;
  nos.lol and relay.damus.io "carry no room"; three relays never answered a `limit: 0` REQ. —
  `docs/networking/rooms.md` ("The defaults", "Numbers") and bench/net/REPORT.md "Rooms on public servers"

**Relay population and availability (academic)**
- Wei & Tyson, data 2023-07-01 to 2023-12-31: 911 relays seen online, events retrieved from 712 (625 free, 87 paid);
  132 "dead" (offline over a week and at the end). About 50% of relays were available more than 99% of the time; about
  20% were down more than 40% of the time; excluding dead relays 90% were up more than 80% of the time. 56% of outages
  lasted under 15 min, 10% over 100 min; free and paid outage durations nearly identical.
  — [arXiv:2402.05709v2](https://arxiv.org/html/2402.05709v2)
- Same paper: mean replication 34.6 relays per post (median: half of posts on more than 14 relays); the largest relay
  held 73% of posts; relays in 44 countries and 151 ASes; removing the top 30 relays by post count keeps availability
  above 90%, 71% at the 50th; 95% of free relays cannot cover costs from donations (64% received no zaps).
  — [arXiv:2402.05709v2](https://arxiv.org/html/2402.05709v2)
- The paper does not measure relays deleting or pruning stored events. — [arXiv:2402.05709v2](https://arxiv.org/html/2402.05709v2)
- An informal 2026 Nostr post (self-described biased, 25 sampled events from three busy relays) found the median other
  relay held about 2 of the 25. Anecdote only. — [nostr.ae post](https://nostr.ae/nevent1qqsrxcu78t6wqsgk60j6ntmwrdet7n38u3w2geucez62wcr6t2vt28cpqq2kd8jj?lang=en)

**Other NIPs (spec pointers; text recalled, not re-fetched this session)**
- NIP-11 defines optional `retention` (per-kind time/count), `limitation.created_at_lower_limit`/`upper_limit`,
  `min_pow_difficulty`, `auth_required`, `payment_required`, `restricted_writes`.
  — [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md)
- NIP-13: PoW = leading zero bits of the event id, committed with a `nonce` tag; relays may demand a minimum.
  — [NIP-13](https://github.com/nostr-protocol/nips/blob/master/13.md)
- NIP-40: `expiration` tag; relays SHOULD drop expired events and SHOULD NOT serve them; not a deletion guarantee.
  — [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md)
- NIP-09: kind-5 deletion requests, honoured only for the same pubkey, best effort.
  — [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)
- NIP-03: kind 1040 carries an OpenTimestamps proof for another event id.
  — [NIP-03](https://github.com/nostr-protocol/nips/blob/master/03.md)
- NIP-45 COUNT, NIP-50 `search` filter (advertised by nostr.wine among those read), NIP-77 Negentropy (a spec mirror
  still labels it "draft optional"). — [NIP-45](https://github.com/nostr-protocol/nips/blob/master/45.md),
  [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md), [NIP-77 mirror](https://nips.4rs.nl/nips/77)
- Negentropy outside strfry: ORLY and Parrhesia relays document NIP-77 support; the applesauce client library requires
  a NIP-77 relay for its sync. — [ORLY guide](https://git.imwald.eu/silberengel/next.orly.dev/src/branch/main/docs/NEGENTROPY_SYNC_GUIDE.md),
  [Parrhesia](https://hexdocs.pm/parrhesia/sync.html), [applesauce](https://applesauce.hzrd149.com/loading/relays/negentropy.html)

### Inferences
- **`created_at` cannot arbitrate first-come.** A writer can date a claim up to 3 years back on a default strfry (1 year
  was accepted everywhere tried), relays store and serve it without any receive time, and the only relay-side ordering
  rule (latest wins, lowest id on a tie) applies within one author's (kind, pubkey, d). Two keys claiming the same name
  are two independent events to a relay. "Earliest `created_at` wins" is therefore won by whoever lies most; "the relay
  saw it first" is not observable by third parties.
- **Withholding/censorship:** a relay (or a writer who publishes to only some relays) can make a claim invisible to part
  of the room and reveal it later with an old `created_at`. Nothing in NIP-01 lets a reader prove non-existence at a
  time. Any first-come rule over relays alone needs an external not-after proof (section 4) or accepts that a hidden
  earlier claim can surface.
- **Addressable vs regular for a registry:** an addressable kind with `d` = name keeps one live record per (key, name)
  and lets a holder refresh in place; a regular kind keeps every version (more storage, but no silent overwrite, and a
  relay cannot be asked by the author to forget history except via NIP-09/NIP-40). Either is stored by the relays
  probed. Replaceable kinds (10000-19999) allow one record per key per kind only.
- **Capacity arithmetic:** a 100-300-byte record becomes a ~450-650-byte event (id, pubkey, sig, tags). 100k names is
  roughly 50-65 MB per relay per room, and a full read at `max_limit` 500 is 200+ paged REQs (paging by `until`), or one
  Negentropy session (strfry's `maxSyncEvents` default is 1,000,000). COUNT gives the size cheaply where supported.
- **Bulk writes are the constraint, not storage:** observed per-key limits of 30/min and 60/min, and one web-of-trust
  policy that cut a fresh key off after 15 events, mean a single browser re-publishing thousands of records (a snapshot,
  or re-seeding relays that lost data) will be throttled on several default relays; one record per key per name spreads
  across keys but per-IP limits are unknown.
- **How many relays:** with roughly half of relays above 99% availability and a fifth mostly down (2023 data), and with
  no retention promise anywhere, durability comes from writing to several (the room link already allows 8) and from
  readers/owners re-publishing what a relay is missing; Negentropy (8 of 13 probed) makes that repair cheap.
  NIP-40 expiry is honoured by strfry, so expiring records clean themselves up but also vanish if the owner is away
  past the expiry.
- **Role fit:** (a) yes, best effort, weeks to months plausible on strfry relays that do not prune, with no guarantee;
  (b) no; (c) yes: a snapshot is just more events (up to ~64 KB each on default strfry, ~128 KB WebSocket message cap
  on most, 1 MB on primal/damus).

### Gaps
- No relay probed publishes NIP-11 `retention`, and no measurement study of pruning was found. Actual retention of
  unknown kinds from unknown keys over weeks to months on damus/nos.lol/primal/the default six is **unknown**; it
  needs a long-running canary (publish, re-read weekly). Operators can prune by age or kind with their own scripts at
  any time.
- relay.nostr.band could not be reached; relay.damus.io's WebSocket was down (HTTP 521) during the probe, so its write
  policy for unknown kinds is unmeasured. [unverified] damus and nos.lol are widely reported to run spam-filter write
  plugins.
- Which relays demand NIP-13 PoW today: none of the 15 probed advertised `min_pow_difficulty` > 0 or answered `pow:`;
  no current list of PoW-requiring relays was found.
- Current relay counts (nostr.watch) for 2026 were not retrieved; the only solid population figure is 2023's 712-911.
- Per-IP connection and write limits of the big relays are undocumented; the burst test used one IP and 60 events.
- khatru, nostr-rs-relay and nostream Negentropy support was not confirmed either way.
- relay.snort.social accepted events dated 4 years back and 2 hours ahead and is in-memory by its own description: its
  retention across restarts is presumably nil [inference, unverified].

## 2. BitTorrent Mainline DHT (BEP44) and Pkarr relays

### Takeaway
BEP44 gives one ~1000-byte signed mutable value per Ed25519 key (plus salt), kept about 2 hours unless someone
re-announces it, with no enumeration or tag query; browsers reach it only through Pkarr HTTP relays (CORS works). It
suits a small pointer or "room head" that online members keep alive, not a 100k-record registry, and it dies with the
last republisher.

### Cited Findings
- Size: "Storing nodes MAY reject put requests where the bencoded form of v is longer than 1000 bytes"; salt at most 64
  bytes. — [BEP44](https://www.bittorrent.org/beps/bep_0044.html)
- Lifetime: items "MAY expire in 2 hours" without re-announcement and "SHOULD be re-announced once an hour"; a
  republisher may skip if more than 8 copies exist on the 8 closest nodes. — [BEP44](https://www.bittorrent.org/beps/bep_0044.html)
- Anyone can keep an item alive: "Any node that's interested in keeping a blob in the DHT alive may announce it",
  reusing the original signature (no private key needed). — [BEP44](https://www.bittorrent.org/beps/bep_0044.html)
- Mutable items: 64-byte Ed25519 signature over `seq` and `v` (and salt); `seq` must increase monotonically; storing
  nodes must not downgrade; optional `cas` (compare-and-swap on the stored seq, error 301 on mismatch). Storage key =
  SHA-1(public key [+ salt]). Immutable items are keyed by SHA-1 of the value. — [BEP44](https://www.bittorrent.org/beps/bep_0044.html)
- Pkarr: signed DNS packets (max 1000 bytes) under an Ed25519 key published to the Mainline DHT, with HTTP relays for
  clients that cannot speak UDP (browsers); relays may cache and may republish recently requested records; records are
  dropped by the DHT after hours, so the owner (or a relay) must republish. — [pkarr repo](https://github.com/pubky/pkarr),
  [pkarr site](https://pubky.github.io/pkarr/)
- Republish practice elsewhere: iroh's Pkarr DHT publisher republishes hourly by default.
  — [iroh source](https://docs.rs/crate/iroh/0.98.2/source/src/address_lookup/pkarr/dht.rs)
- CORS (own probe): `https://relay.pkarr.org/` and `https://pkarr.pubky.app/` both reflect the request `Origin` with
  `access-control-allow-credentials: true`; pkarr.pubky.app allows `GET, POST, PUT, OPTIONS` and exposes
  `pkarr-invalid-signed-packet-seq, pkarr-dht-stored-nodes`. — [relay.pkarr.org](https://relay.pkarr.org/),
  [pkarr.pubky.app](https://pkarr.pubky.app/)
- n0's `https://dns.iroh.link` (a Pkarr-relay-style endpoint used by iroh) sends `access-control-allow-origin: *`.
  — own probe, [dns.iroh.link](https://dns.iroh.link/pkarr)

### Inferences
- One key maps to one value: no "list all names in room X", no tags, no ranges, no counts, no set reconciliation. A
  per-name record would need a key derivable from (room, name), which makes the private key known to every member, so
  anyone can overwrite it (highest `seq` wins): no first-come property at all. Role (b): no.
- Role (a): only while at least one party republishes each record hourly; with zero members online everything is gone
  in about 2 hours, unless a Pkarr relay happens to keep republishing (not promised). Role (c): a 1000-byte pointer to
  a snapshot held elsewhere, under the same liveness condition.
- `seq` is writer-chosen (usually a timestamp), so it gives ordering per key only, not time.
- Two public relays is a thin, operator-dependent gateway (both run by the Pkarr/Pubky people plus n0's).

### Gaps
- Rate limits and cache/republish durations of the public Pkarr relays: no documentation found.
- How many public Pkarr relays exist beyond relay.pkarr.org, pkarr.pubky.app and n0's: no list found.
- Whether a PUT actually succeeds cross-origin from a browser (preflight for `PUT`) on relay.pkarr.org was not tested;
  only response headers on GET were read.

## 3. Other P2P and semi-centralized stacks from a browser

### Takeaway
None of the alternatives offers what free Nostr relays do (open write, weeks of retention, tag queries, dozens of
independent operators, plain WebSocket) without either an always-on peer of one's own or an account on someone's
service. The two with real hosted persistence are account-based: atproto PDS repos and Matrix rooms; Waku's store and
iroh's relays are closer to transports.

### Cited Findings
**Iroh**
- Iroh 1.0 was announced 2026-06-15. Public relays ("n0" preset): "Public relays are rate-limited for relayed traffic,
  which can change at any time." Support windows on the public relays: v1.0 until end of life; v0.35.x through
  2026-12-31; v0.9x and 1.0.0-rc through 2026-09-30. — [iroh 1.0 blog](https://iroh.computer/blog/v1)
- Browsers: iroh compiles to WebAssembly (wasm-bindgen; no published npm package, one writes a Rust wrapper); all
  browser connections go through a relay because the sandbox cannot send UDP; traffic stays end-to-end encrypted;
  WebTransport/WebRTC for direct browser paths are "may adopt later". iroh-gossip builds for browsers since 0.33.
  — [iroh wasm docs](https://docs.iroh.computer/deployment/wasm-browser-support)
- iroh-docs is a "meta protocol" on top of iroh-blobs and iroh-gossip, kept in a separate repo.
  — [iroh-docs](https://github.com/n0-computer/iroh-docs)
- An n0 relay answers plain HTTPS (`https://use1-1.relay.n0.iroh.link/` returned 200). — own probe

**IPFS / libp2p**
- IPNS: DHT servers expire records after about 48 hours regardless of the record's own validity, which can be much
  longer (e.g. a year), so a third party holding a still-valid signed record can republish it without the key.
  — [IPFS forum](https://discuss.ipfs.tech/t/ipns-publishing-guidance-for-high-availability/18928),
  [@helia/ipns docs](https://ipfs.github.io/helia/modules/_helia_ipns.index.html)
- The public delegated routing endpoint answers browsers: `https://delegated-ipfs.dev/routing/v1/providers/<cid>`
  returns JSON with `access-control-allow-origin: *`. — own probe, [delegated-ipfs.dev](https://delegated-ipfs.dev/routing/v1/providers/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi)
- Helia had an incompatibility between the delegated-routing client's IPNS methods and `@helia/ipns` (CID vs
  multihash keys), addressed in a PR. — [helia#852](https://github.com/ipfs/helia/pull/852)

**Waku**
- The Waku Network rate-limits publishers with RLN v2 (per-member messages per epoch); store nodes SHOULD keep only
  messages with a valid RLN proof; light-push clients are expected to generate the proof themselves; `@waku/rln` is a
  browser WASM library. — [Waku network RFC 64](https://rfc.vac.dev/waku/standards/core/64/network),
  [vac.dev RLN](https://vac.dev/rln), [@waku/rln](https://npmjs.com/package/@waku/rln)

**atproto (Bluesky PDS)**
- bsky.social write limits: CREATE 3 points, UPDATE 2, DELETE 1; 5,000 points/hour and 35,000/day per account (about
  1,666 creates/hour, 11,666/day); 3,000 API requests per 5 minutes per IP; createSession 30 per 5 min and 300/day.
  Other PDS providers set their own limits. — [Bluesky rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits),
  [PDS v3 rate limits](https://docs.bsky.app/blog/rate-limits-pds-v3)
- `https://bsky.social/xrpc/com.atproto.server.describeServer` answered with `ratelimit-policy: 3000;w=300`.
  — own probe, [bsky.social](https://bsky.social/xrpc/com.atproto.server.describeServer)

**Matrix**
- `https://matrix.org/_matrix/client/versions` answers with `access-control-allow-origin: *` (the client-server API is
  browser-reachable). — own probe, [matrix.org](https://matrix.org/_matrix/client/versions)

### Inferences
- **Iroh:** from a browser it is a relay-only encrypted transport plus gossip between online peers; nothing on n0's
  infrastructure stores application records for offline rooms, and iroh-docs needs some peer to hold the document.
  Roles (a)/(c): only with an always-on peer, which the project does not have. (b): no. It duplicates what DERP already
  gives rooms.
- **IPFS/IPNS:** content persists only while someone provides (pins) it; a browser tab is a poor provider (needs
  WebRTC-direct/WebTransport dials from DHT servers or a relay reservation) and free pinning is account-based. IPNS is
  one mutable pointer per key with ~48 h DHT life, republishable by anyone holding the signed record: same shape as
  BEP44 with a longer fuse. (a) no without pinning; (b) no; (c) weak.
- **atproto:** a free account's repo is durable, signed, hosted storage with generous write limits, readable by anyone
  over XRPC and visible on the firehose, and custom lexicon records are permitted by the protocol. But every writer
  needs an account (email, handle, ToS, moderation) or the room needs one shared account whose credentials every member
  holds; the PDS operator can delete or suspend it. As a room-wide, ownerless substrate it does not fit; as an optional
  mirror by a willing member it is the most durable free option found. The repo's commit `rev` is assigned by the PDS,
  so ordering is the operator's word.
- **Matrix:** a public room on a public homeserver is a durable, ordered, replicated event log with state events
  (`state_key` = name would be a native key/value map), but writers need registered accounts (matrix.org gates
  registration with CAPTCHA/email), ordering is the homeserver DAG's (`origin_server_ts` is server-claimed), and state
  resolution favours power levels, not first-come. Same account problem as atproto.
- **Waku:** store nodes are a message cache for offline delivery (days, not months), and writing needs an RLN
  membership, which is registered on a blockchain: that collides with "no cryptocurrency fees".

### Gaps (all [unverified] background knowledge unless stated; none of these was researched to a primary source this session)
- **Waku store retention** on The Waku Network: no figure found; believed to be operator-set and on the order of days
  to 30 days. Whether RLN membership currently costs a deposit/gas on its L2 was not confirmed.
- **atproto:** record size cap (believed ~1 MiB CBOR), behaviour of bsky.social towards unknown lexicons at volume, and
  whether XRPC write endpoints send CORS headers for arbitrary origins were not confirmed (the probe's header grep did
  not capture `access-control-allow-origin`).
- **Hypercore/Hyperswarm:** no native browser transport (UDP holepunching DHT); browsers need a `dht-relay` WebSocket
  bridge that someone must run; there are no well-known public ones. Persistence needs an always-on seeder.
- **WebTorrent:** browsers reach only WebSocket trackers (signalling for WebRTC), not the Mainline DHT; trackers store
  nothing beyond short-lived announces. Public tracker count is small and has been shrinking (Trystero keeps a list).
- **GUN:** public relay peers are few, volunteer-run and routinely wiped; no retention guarantee; last-write-wins HAM
  ordering trusts writer clocks within a window.
- **OrbitDB:** a library over Helia/libp2p pubsub; persistence is whatever peers pin; no public infrastructure.
- **Veilid:** has a DHT with signed records and a WASM build, but browser nodes depend on WebSocket-capable relay nodes
  and DHT record lifetimes/quotas are not documented as durable; public node population unknown.
- **Earthstar/Willow:** a data model and sync protocol with no public servers; someone must host a replica.
- **Automerge/Yjs:** the public sync servers (e.g. `sync.automerge.org`, y-webrtc signalling) are demos with no
  retention promise.
- **Secure Scuttlebutt:** rooms are rendezvous/tunnel servers, pubs replicate feeds only for followed identities;
  browser support is marginal and the ecosystem is in decline.
- **Arweave/Irys:** permanent storage for a fee (excluded). Irys historically offered free uploads under ~100 KiB via
  some nodes; current status unconfirmed.
- **Free public KV services:** none found with open anonymous write, CORS and a retention commitment; the usual ones
  (jsonbin-style, Cloudflare/Deno KV, Firebase) need an account, i.e. an owner, which is a backend by another name.

## 4. Public timestamping, beacons and transparency logs usable from a browser without fees

### Takeaway
Three free, CORS-open primitives exist: drand quicknet (a publicly verifiable 3-second clock that proves "created
after round R"), OpenTimestamps calendars (a proof of "existed before Bitcoin block B", arriving hours later), and
Bitcoin headers via public explorers (a PoW-backed coarse clock). Rekor accepts free signed submissions and its v1 API
still stamps an integrated time, but it is a centralized log meant for software signing, is rotating to v2 (which
dropped search and log-side timestamps), and is not a general data store.

### Cited Findings
**drand (League of Entropy)**
- `https://api.drand.sh/v2/beacons/quicknet/rounds/latest` and
  `https://drand.cloudflare.com/<chainhash>/public/latest` both return JSON with `access-control-allow-origin: *`.
  — own probe, [api.drand.sh](https://api.drand.sh/v2/beacons/quicknet/rounds/latest),
  [drand.cloudflare.com](https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/latest)
- quicknet chain info (live): `period` 3 s, `genesis_time` 1692803367, scheme `bls-unchained-g1-rfc9380`, chain hash
  `52db9ba7…e971`, 96-byte G2 public key; the latest round at probe time was 33,989,118 with a 48-byte signature.
  — own probe, [quicknet info](https://api.drand.sh/v2/beacons/quicknet/info)
- quicknet has run since 2023 on BLS12-381 with signatures on G1 (half the size of the earlier chain); the older
  "fastnet" was sunset. — [quicknet is live](https://docs.drand.love/blog/2023/10/16/quicknet-is-live),
  [fastnet sunset](https://docs.drand.love/blog/fastnet-to-be-sunset)
- drand describes its output as "publicly-verifiable, unbiased, and unpredictable randomness" and documents timelock
  encryption on the same network. — [drand docs](https://docs.drand.love/docs/overview/)
- League membership: one League page lists 11 named organizations (incl. Cloudflare, EPFL, Protocol Labs, Ethereum
  Foundation, Kudelski); drand.love says 15 independent organizations. The two figures conflict.
  — [Cloudflare LoE](https://cloudflare.com/leagueofentropy), [drand.love/loe](https://www.drand.love/loe)

**OpenTimestamps**
- Calendars answer browsers: `alice.btc.calendar.opentimestamps.org`, `a.pool.opentimestamps.org` and
  `finney.calendar.eternitywall.com` all send `access-control-allow-origin: *` and
  `access-control-allow-methods: POST GET`. — own probe, [alice](https://alice.btc.calendar.opentimestamps.org/),
  [a.pool](https://a.pool.opentimestamps.org/), [finney](https://finney.calendar.eternitywall.com/)
- Calendars aggregate submitted digests in one-second intervals into a merkle tree and return a "pending attestation":
  a promise by that calendar to anchor the batch in Bitcoin and keep the proof retrievable.
  — [Peter Todd, 2017](https://petertodd.org/2017/misleading-and-inaccurate-tierion-ico-claims)
- Time to a Bitcoin attestation is typically hours, depending on the calendar and the chain.
  — [auto-archiver docs](https://auto-archiver.readthedocs.io/en/latest/_sources/modules/autogen/enricher/opentimestamps_enricher.md),
  [IETF draft-fassbender-scitt-time-anchor](https://datatracker.ietf.org/doc/html/draft-fassbender-scitt-time-anchor-07)
- A public calendar has been down for maintenance before, causing long delays (2017).
  — [Eternity Wall blog](https://blog.eternitywall.com/2017/06/22/opentimestamp-performances/)

**Bitcoin headers as a clock**
- `https://mempool.space/api/blocks/tip/height` (returned 976006) and `https://blockstream.info/api/blocks/tip/hash`
  both send `access-control-allow-origin: *`. — own probe, [mempool.space](https://mempool.space/api/blocks/tip/height),
  [blockstream.info](https://blockstream.info/api/blocks/tip/hash)

**Sigstore Rekor**
- Rekor v1 (`https://rekor.sigstore.dev/api/v1/log`) is still serving on 2026-11-15 and sends
  `access-control-allow-origin: *`; the v2 shard `https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint` also answers
  with CORS `*`. — own probe, [rekor v1](https://rekor.sigstore.dev/api/v1/log),
  [rekor v2 2025 shard](https://log2025-1.rekor.sigstore.dev/api/v2/checkpoint)
- Rekor v2 went GA on 2025-10-10 (tile-backed, on Tessera). Only two entry types remain: `hashedrekord` and `dsse`
  (`intoto`, `rekord`, `rfc3161`, etc. removed). Removed: the search index, attestation storage, get-by-index and
  get-by-leaf-hash; reads are C2SP tlog-tiles. The log no longer returns signed timestamps: clients get time from a
  separate timestamp authority (Sigstore runs a public RFC 3161 TSA). Writes are batched, taking a few seconds. One
  write endpoint: `/api/v2/log/entries`. Witnessing "will be implemented soon". Shards are per-year URLs
  (`logYEAR-rev.rekor.sigstore.dev`); the old shard is frozen shortly after the new one starts; v1's freeze is to be
  announced a year ahead. — [Rekor v2 GA](https://blog.sigstore.dev/rekor-v2-ga/)
- The community instance URL changes roughly every 6 months and should not be hardcoded.
  — [rekor-tiles](https://awesome.ecosyste.ms/projects/github.com%2Fsigstore%2Frekor-tiles)
- Rekor v1's public instance caps attestation uploads at 100 KB. — [rekor v1 package docs](https://pkg.go.dev/github.com/sigstore/rekor@v1.5.1)

**Sigsum and the witness network**
- Sigsum logs accept only a signed checksum per leaf; submission to public logs is rate-limited per domain: the
  submitter proves control of a DNS name whose TXT record holds a rate-limit public key and signs submit tokens with
  it. — [sigsum-token-create(1)](https://dyn.manpages.debian.org/unstable/sigsum-go/sigsum-token-create.1),
  [sigsum-submit(1)](https://dyn.manpages.debian.org/testing/sigsum-go/sigsum-submit.1.en.html)
- Witnesses cosign a log's checkpoints after checking a consistency proof; a log publishes once its policy's quorum
  (e.g. 3 of 10) has cosigned. — [sigsum-general list](https://lists.sigsum.org/mailman3/hyperkitty/list/sigsum-general@lists.sigsum.org/thread/NBVH4PEIAAWWQUBHNX2KQ32MBPQQEJJL)
- `https://seasalp.glasklar.is/get-tree-head` answers 200 `text/plain` with no `access-control-allow-origin` header in
  the probe. — own probe, [seasalp](https://seasalp.glasklar.is/get-tree-head)
- The Witness Network (witness-network.org) matches logs with witnesses: a log operator registers its log in the
  network's lists (refreshed every 15 minutes) and participating witnesses (omniwitness auto-provisions from the
  lists) decide what to cosign; 15 ArmoredWitness devices are deployed with custodians; logs witnessed include Go
  SumDB, Sigsum, Sigstore, Android Binary Transparency. — [transparency.dev blog](https://blog.transparency.dev/can-i-get-a-witness-network),
  [Geomys Navigli witness](https://geomys.org/witness/navigli), [omniwitness](https://godoc.org/github.com/transparency-dev/witness/cmd/omniwitness)

**Certificate Transparency**
- A CT log's signed tree head is fetchable from a browser: `https://ct.googleapis.com/logs/us1/argon2026h2/ct/v1/get-sth`
  returns 200 with `access-control-allow-origin: *`. — own probe, [argon2026h2](https://ct.googleapis.com/logs/us1/argon2026h2/ct/v1/get-sth)

### Inferences
- **drand = "not before".** Round R's signature cannot exist before time `genesis + (R−1)·3 s` (check: round
  33,989,118 → 1,794,770,718 = 2026-11-15 19:25 UTC, matching the probe's wall clock), and because quicknet is
  unchained a single round verifies against the fixed public key with one BLS pairing check (feasible in WASM; ~150
  bytes of proof incl. round number). A record that embeds a recent round's signature provably was made after it. It
  proves nothing about how long after: a writer can hold a record back. It also gives every browser the same trusted
  coarse time without trusting the local clock, at 3 s granularity, from two independent CORS-open hosts (drand.sh,
  Cloudflare). Trust: a threshold of League members.
- **OpenTimestamps = "not after", eventually.** A record hash submitted to calendars gets a pending receipt within about
  a second (a promise from that calendar operator, forgeable only by the operator) and a Bitcoin-anchored proof hours
  later. The anchored proof bounds the record's existence to before a block; it is the only free primitive here that
  defeats backdating without trusting an operator. Costs: the upgraded proof is several hundred bytes to a few KB per
  record (or one per batch if the room merkle-batches), verifying needs the block header (80 bytes, PoW-checkable; from
  mempool.space/blockstream.info, CORS `*`), resolution is a block (~10 min, with miners' timestamps loose by up to ~2 h),
  and somebody must come back hours later to upgrade and store the proof. Calendars are four hosts run by two
  parties (Peter Todd's alice/bob, Eternity Wall's finney, plus Catallaxy [unverified]).
- **drand + OTS bracket a record** (after round R, before block B). The bracket's width is what a first-come rule can
  resolve; within it, two claims are unordered. This is the tightest operator-independent ordering available to a
  serverless page without fees; it is hours wide unless pending attestations are trusted (then ~seconds, trusting the
  calendar).
- **drand timelock (tlock)** lets a browser encrypt to a future round (commit now, reveal later); it relies on the same
  threshold assumption and is usable for commit-reveal schemes without any server.
- **Rekor as arbiter:** v1 returns an `integratedTime` and log index signed by the log for a `hashedrekord` (digest +
  signature + public key), free and without an account, from a browser (CORS `*`): effectively a trusted third-party
  first-come stamp with a global order. But it is one operator (Sigstore/OpenSSF, Google-run), intended for software
  supply chain, v1 is headed for freeze, v2 removes integrated time and lookup by hash, shard URLs rotate, and volume
  abuse can get an IP limited. Storing 100k room records there is misuse; the log holds a hash and key, not the record.
  (b): technically yes with single-operator trust and questionable legitimacy; (a)/(c): no.
- **Sigstore's RFC 3161 TSA** would be a cleaner free signed-time source than the log (signed time over a hash, no
  permanent public entry), with the same single-operator trust.
- **Sigsum:** public logs need a DNS domain for rate-limit tokens (one domain could serve the whole app: effectively an
  app-wide shared quota key shipped in the page, hence abusable), store only checksums, carry no timestamps in leaves,
  and at least seasalp does not send CORS headers, so a page cannot call it directly. Not usable serverlessly.
- **Witness network:** it cosigns checkpoints of registered tlog-style logs; it does not accept data. Using it would
  mean operating a log (a server), which the project does not have.
- **CT:** arbitrary data cannot be logged except by getting a publicly trusted certificate issued (domain control, CA
  rate limits, public and permanent): impractical. But a classic RFC 6962 log's STH carries a signed millisecond
  timestamp and is CORS-readable, so it can serve as one more operator-signed clock (static-CT checkpoints do not carry
  a timestamp [unverified]).
- **Roughtime:** UDP-only protocol, so unreachable from page JavaScript; the HTTPS probe of roughtime.cloudflare.com
  was reset. Not usable.
- **Bitcoin headers alone** give a ~10-minute, PoW-backed "not before" beacon (a record naming block hash H was made
  after H), verifiable by header chain; explorers are trusted only for liveness if PoW and chain work are checked
  against a second source.

### Gaps
- drand's current member count and signing threshold for quicknet (sources say 11 or 15 organizations; threshold not
  found), and any 2025-2026 liveness incidents: not confirmed.
- [unverified] `tlock-js` / `drand-client` (github.com/drand) run in browsers and verify quicknet with
  `@noble/curves`; not re-checked this session.
- OpenTimestamps: exact current time-to-anchor per calendar, calendars' rate limits, and whether the JavaScript client
  is maintained in 2026 were not established; the "hours" figure is from secondary sources.
- Rekor: no official rate-limit numbers found for v1 or v2; whether v1 has an announced freeze date by Nov 2026, whether
  a 2026 v2 shard is live and the 2025 one frozen, which key algorithms v2's `hashedrekord` accepts (believed ECDSA
  P-256 and Ed25519 [unverified]), and whether POSTs pass CORS preflight from arbitrary origins were not verified
  (only GET headers were read).
- Sigstore TSA's CORS behaviour and limits were not probed.
- `api.witness.dev` and `tlog.sigsum.org` were unreachable through the session's proxy (502), so nothing first-hand on
  the witness network's or Sigsum's public endpoints beyond seasalp.

## 5. Per-substrate verdict on the three roles

### Takeaway
For a serverless, fee-free page, the only open-write multi-operator store is the set of public Nostr relays (good for
(a) and (c), best effort); nothing free and decentralized is a native first-come arbiter, and the closest substitutes
are a drand lower bound plus an OpenTimestamps/Bitcoin upper bound (hours wide), or a single trusted stamper (Rekor v1,
an RFC 3161 TSA, a calendar's pending attestation).

### Cited Findings
- Nostr relays store unknown addressable/regular kinds from fresh keys without fee, AUTH or PoW on 13 of 15 relays
  tried, but accept `created_at` a year in the past. — own probe (section 1), [strfry.conf](https://raw.githubusercontent.com/hoytech/strfry/master/strfry.conf)
- BEP44 items expire in about 2 hours without republishing and are capped near 1000 bytes.
  — [BEP44](https://www.bittorrent.org/beps/bep_0044.html)
- drand quicknet, OpenTimestamps calendars, mempool.space, blockstream.info, Rekor v1/v2 and a Google CT log all send
  `access-control-allow-origin: *`. — own probe (section 4)
- Iroh in a browser is relay-only and its public relays are rate-limited and tied to version support windows.
  — [iroh wasm docs](https://docs.iroh.computer/deployment/wasm-browser-support), [iroh 1.0](https://iroh.computer/blog/v1)

### Inferences
| Substrate | Browser reach | (a) durable store | (b) first-come arbiter | (c) empty-room snapshot |
|---|---|---|---|---|
| Nostr relays (regular/addressable kinds) | WebSocket, open write | Yes, best effort; no retention promise; replicate to several, repair by Negentropy/REQ | No: `created_at` writer-set, no receive time, withholding possible | Yes: events up to ~64 KB (strfry default), same caveats |
| Nostr ephemeral kinds | WebSocket | No (not stored; strfry drops after 300 s) | No | No |
| BEP44 via Pkarr relays | HTTPS, CORS reflect | Only while republished hourly | No (highest `seq` by key holder) | 1000-byte pointer, same liveness |
| IPFS/IPNS (Helia) | WebRTC-direct/WebTransport, delegated routing over HTTPS | Only if someone pins/provides | No | Weak (~48 h IPNS DHT life, republishable by anyone) |
| Iroh (gossip/docs) | WASM, relay-only | Needs an always-on peer | No | No |
| Waku store | WebSocket/libp2p; RLN membership | Short cache; membership is on-chain | No | No |
| atproto PDS repo | HTTPS XRPC; account | Yes for an account holder (5,000 pts/h); operator can remove | Operator-ordered `rev` only | Yes, owned by one account |
| Matrix room | HTTPS; account | Yes for account holders | Homeserver DAG order; server-claimed time | Yes, account-bound |
| drand quicknet | HTTPS, CORS `*` | No (beacon only) | Lower bound on time, 3 s grain, threshold trust | No |
| OpenTimestamps | HTTPS, CORS `*` | No (proofs only; pending proofs kept by calendars) | Upper bound on time, hours to anchor; seconds if calendar trusted | No |
| Bitcoin headers (explorers) | HTTPS, CORS `*` | No | ~10 min "not before" beacon; needed to verify OTS | No |
| Rekor v1 / v2 | HTTPS, CORS `*` on GET | No (hash+key only; v2 has no search) | v1: operator-signed integratedTime + index; v2: needs separate TSA | No |
| Sigsum / witness network | Sigsum: no CORS seen, DNS-token rate limit | No | Not from a page | No |
| CT logs | Read-only for a page | No | STH as an operator-signed clock only | No |
| Roughtime | None (UDP) | No | No | No |

- Durability of the registry on Nostr depends on re-publication by whoever is online (owners or any member holding the
  signed events: Nostr events, like BEP44 items, can be re-sent by anyone), since no relay promises retention and
  per-key write limits (30-60/min seen) slow mass repair.
- If all members are offline for months, survival is exactly the relays' unpublished pruning behaviour: unmeasured.

### Gaps
- No substrate was found that is simultaneously open-write, fee-free, account-free, browser-reachable and offers an
  operator-independent total order. Whether one exists outside the candidate list was not searched exhaustively.
- Long-horizon retention on the specific default relays needs an empirical canary; nothing published answers it.
