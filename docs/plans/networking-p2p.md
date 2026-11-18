# Peer-to-peer rooms: left open (explore later, not planned)

Rooms are built (the P2P track, 2026-11-10 to 2026-11-12): how they work, the decisions that bind them, their numbers
and findings are [networking/rooms.md](../networking/rooms.md); their loose ends are [backlog.md](../backlog.md)
"Rooms' loose ends". This page holds only the ideas past them, none of them scheduled.

- **Other suffixes for registered names**: names are built (the NAMES track: [networking/names.md](../networking/names.md))
  under a room's own domains (`<tag>.p2p.internal`, and the room's name when its ID is a label of its own); which
  other suffixes names may use is undecided.
- **Onion routing**, so that neither peers nor relays see who talks to whom from where: circuits through other
  members (or volunteer nodes), the address still the key's, as only the outer path changes. A track of its own if
  wanted; relay only covers hiding from peers until then.
- **Broadcast and multicast** between guests (mDNS for service discovery), fanned out only to peers already
  connected.
- **IPv4 between guests.** Key-derived IPv4 addresses would collide (32 bits); a per-node mapping would need state
  nobody keeps.
- **Spam** in public rooms, the global one most of all: any member (in a public room, anyone) can flood a node's
  lookups through every relay of the link (128 a second each) or fill its trial budget with fresh keys (16 a second),
  keeping other members' lookups and unasked handshakes out while it goes on (rooms.md "Finding a peer", "The tunnel
  and the guest's side"; an outsider with only a node's name can't: lookups carry the room's MAC, initiations its
  proof). Proof of work on lookups and fresh keys (NIP-13's form) and relays' own rate limits are the directions.
- **Who's here on the page**: a directory stays the participants' own (they operate it and agree on its identity,
  which can't come from the room's ID, or every member would hold its private key); the page could list it if the
  user gives it that identity's name, through a small protocol such directories would speak.
- **A GPU key miner** (OpenCL), beside `net/ts/examples/room-key-mine.rs`'s CPU one: discussed 2026-11-12, not asked
  for.
- **Firefox and Safari**: whether they have `RTCPeerConnection` in workers or transfer data channels as Chromium does
  is unchecked.
