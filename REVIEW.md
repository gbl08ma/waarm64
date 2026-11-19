# Review: demo machines, templates, the demo network (review/demo-page)

A static review of the code at efc502ed: web/app/template.ts, demo-store.ts, definition-check.ts, definitions.ts,
snapshots.ts (first-start restore), shape.ts, web/chunked.ts, net-demo.ts, web/demo-net.ts (+ worker), demo-view.ts,
connections.ts, tools/publish-demos.ts, demo-site.ts, chunk-image.ts, agent/src/lease.rs, power.rs, guest-agent.ts,
firmware-files.ts. Findings ranked most severe first. Proof tests: `tests/review-demo-page.test.ts` (each one fails on
this code; run with `node --test tests/review-demo-page.test.ts`).

## 1. Another store's demo can choose where an official demo reads its disk (High; confidence high; proved: R1)

`web/app/definitions.ts:384` (`diskFor`) reuses any disk record whose identity matches by `canonical`, and a chunked
image's identity is `{kind:'url', chunked, bytes}`: an id the *definition* asserts. Nothing checks it against the
content: `definition-check.ts:94` checks only that `identity.kind` is set, and `web/chunked.ts:63-90`
(`chunkedSource`) never compares the manifest's `id` with the disk's identity, never checks `id` against the hashes, and
never checks a piece against its hash.

Scenario: the user opens a demo from a hostile store (or imports a definition file) whose disk says
`identity.chunked = <the project's Alpine image id>` and `url = https://evil.example/…/manifest.json`. A disk record
with that URL is stored. Later the user starts the project's demo from `vmdisks.tny.im`: `diskFor` finds the planted
record as `same`, so the project's machine boots from the attacker's bytes. Its template snapshot still restores (the
shape hash covers the identity, not the content), so it looks like the real demo. A harmless version of the same thing:
an image once added from a mirror or `localhost` gets reused, and the demo breaks when that host goes away.

Fix: when a URL disk opens, check that the manifest's `id` equals the disk's `identity.chunked` and that
`id === sha256(hashes.join('\n'))`. Check pieces against `hashes` in `chunkedSource` (at least the async reads and the
first read of each piece). And/or reuse a disk across stores only when its URL's origin is the same.

## 2. A template snapshot that fails to import leaves a broken, orphaned machine (Medium; confidence high; proved: R4)

`web/app/template.ts:39-42`: `machineFromTemplate` stores the machine (`importDefinition`, with its disks and grown
overlays) *before* `importSnapshot`. When `importSnapshot` throws, the machine stays, with no `restoreFirst` and no
`fromDemo`. It throws on a snapshot file the header reader refuses, and above all on `QuotaExceededError` while it
copies tens of MiB into OPFS (it retries once after `makeRoom`, then throws). The same happens when `attachDemoNetwork`
fails after the machine was made (`template.ts:87`). The doc comment ("a failed download leaves no machine") holds only
for the fetch.

Scenario: the storage is full. The user clicks the demo and gets an error. A machine named "Alpine" is now on the
Machines page. It isn't "started before" for the demo (no `fromDemo`), so every retry makes another one. Opened, it
cold-boots instead of restoring the template, and without the demo network.

Fix: import the snapshot first, or on any failure after `importDefinition` delete the machine, its new disks and
overlays. Write `fromDemo` and `restoreFirst` in the same `put` that creates the record.

## 3. A blank/ramdisk identity's id becomes the record id and overwrites an existing disk (Medium; confidence high; proved: R2)

`web/app/definitions.ts:389-392`: a blank or ramdisk disk that isn't `same` is stored under `id: x.identity.id`, a
string taken from the definition. It isn't checked to be an `isId` or to be free, and `store.put('disks', d)` (`:450`)
replaces whatever record has that id. A definition whose blank identity has the same id but another `bytes` (a
publisher who resized a scratch disk in a demo's next version and kept the definition's identity; or any store, since
the project's store publishes its demos' identities) overwrites the disk record of a machine the user already has.
That machine's disk changes size under its overlay, and its shape changes, which orphans all its snapshots and its
`restoreFirst`. An id equal to one of the user's stored disks (ids leak through exported definitions) replaces that
record's kind and identity, and the sweep may then treat its files as unowned.

Fix: give the record a new `newId()` always (the identity, which keeps its own `id`, is what the shape hashes), or
refuse/rename when a record with that id exists. Validate `identity` per kind in `DISK_CHECKS`
(`isId(identity.id)`, `bytes` an integer, kind consistent with `x.kind`).

## 4. The template snapshot's content id is not verified; the manifest is fetched twice (Medium-low; confidence high; proved: R3a, R3b)

`web/app/template.ts:54-62` checks the definition's `snapshot.id` against a first fetch of the manifest, then
`fetchChunked` (`web/chunked.ts:177`) fetches the manifest *again* and uses that one unchecked. Its returned `manifest`
is thrown away. Neither checks `id === sha256(hashes.join('\n'))`, so the id is only the manifest's claim.

Scenario: (a) a manifest carrying the right id over other pieces passes; (b) a site republished between the two fetches
(or a cache serving the two requests differently) gives a snapshot other than the definition names, which the check
was written to refuse. Also, `checkManifest` doesn't check that `hashes` are 64-hex strings. They are spliced into
`pieces` URLs (`{hash}` → `../../anything`), so a manifest can make the page fetch any path relative to it.

Fix: in `fetchSnapshot`, compare `id` with the manifest `fetchChunked` returns (or pass the checked manifest in). In
`checkManifest`, require `/^[0-9a-f]{64}$/` hashes and `id === sha256(hashes.join('\n'))` (the tool writes exactly
that: `tools/chunk-image.ts:62`).

## 5. publish-demos `--apply` writes the store before it has the pieces; a failure wedges the next publish (Medium-low; confidence high)

`tools/demo-site.ts:404-427` writes `plan.files` in Map order, which `layout` builds as: kept files, then each live
demo's `<id>/manifest.json`, `snapshot.json`, `definition.json`, then `store.json`, and the pieces last. A piece's
hash check (`:414`) or a copy error therefore throws after `store.json` and the manifests are written, and before the
removals and the ledger (`:426`).

Scenario: a build's piece is corrupt. `--apply` fails halfway, and `target/disks` has a store naming pieces that aren't
there. A deploy of it would publish broken demos. The next `publish-demos` refuses every new id with "the site has a
directory <id>/ that isn't a demo's" (`:325`), because the ledger was never written. The publisher has to clean up by
hand.

Fix: copy and check every piece first, then the per-demo files, then `store.json`, then the ledger and the removals.
Or write into a staging directory and rename.

## 6. LEASE runs `dhcpcd -n` on cards dhcpcd doesn't manage (Low-medium; confidence medium)

`agent/src/lease.rs:257-275`: when any process is named `dhcpcd`, every connected card without a udhcpc gets
`dhcpcd -n <card>`. In dhcpcd's per-interface mode (`dhcpcd eth0`), or for a card configured statically, `-n <card>`
on an interface no dhcpcd runs for starts dhcpcd on it ("If dhcpcd is not running, then it starts up as normal").

Scenario: an Alpine guest with dhcpcd on eth0 and a static address on eth1 (a second adapter on a room or LAN),
restored. The agent starts a DHCP client on eth1, which adds a lease and a default route the user didn't configure.

Fix: run `dhcpcd -n <card>` only where dhcpcd manages the card. Check its control socket
`/run/dhcpcd/<card>.sock` (per-interface mode), or that a master `/run/dhcpcd/sock` exists and the card has a
dhcpcd lease or pid file. Otherwise skip it (NO_CLIENT, so the page flaps the link).

## 7. Demo network client: a server that drops right after `hello` gets a ~1 s reconnect loop, and the status goes stale (Low; confidence high)

`web/demo-net.ts:336` resets `attempt` at every `hello`, and `:457` resets it again on a lost connected socket. A server
or reverse proxy that completes the handshake, sends `hello` and then drops the socket (a crash loop, a proxy timeout,
an upstream reset) gets a reconnect every 0.5–1 s with no growth. Each one also raises a `lost` notice, a `warn` that
stays in the message bar. Only the server's own `connections_per_minute` (4008) ends the loop. Separately, `open()`
(`:275-279`) sets the phase to `connecting` without calling `change()`. After a backoff the status keeps saying
"waiting, trying again at <time past>", and after 4012 it keeps saying "idle" while it reconnects, until something else
reports.

Fix: reset the backoff only once a socket has lived some time (say 30 s) past `hello`. Say `lost` once per outage, not
per attempt. Call `change()` in `open()`.

## 8. An untrusted store's definition can turn on clipboard sharing (Low; confidence medium)

`definition-check.ts:83` and `definitions.ts:424` take `machine.clipboard` (and `shares`) from any definition, and a
store makes the machine in one click. The guest, an image and template of the store's choosing on a network the store
names, then gets the host clipboard through the agent wherever the browser grants the permission (it may already have
it from the user's own machines).

Fix: drop `clipboard` from definitions that come from a store (or from any import), and let the user turn it on.

## 9. A copy of a demo machine is "started before" the demo (Low; confidence high)

`web/app/machines.ts:100` (`duplicateMachine`) spreads the record, `fromDemo` included (it clears only `restoreFirst`).
`demoMachines` then lists the copy as the demo's own. If the copy's original hadn't started yet, the demo's card opens
a copy that cold-boots and isn't on the demo network (copies drop connections). Fix: clear `fromDemo` on a copy, as
`restoreFirst` is.

## Looked at, nothing found

- The first-start restore path (`snapshot-restore.ts first`, `planRestore` with `fresh`/`pristine`/`into`): forks go
  into the right attachment by slot. A fork never reuses another machine's (the key is the kept snapshot's own id).
- demo-store parsing: limits on list size and name, ids validated, URLs only http(s). The page renders store text
  through Svelte (no `{@html}`).
- The demo client's frame handling: frames are copies (`framesOf`), so transferring each buffer is safe. Batches stay
  in order and under 1 MiB, held frames are capped, timers are cleared on `close`/`end`, and close codes 4001/4003/1002/1009 are
  final.
- The OpenRC service and installer (quoting, heredoc, the fw_cfg glob within `agentFiles`' 1000-piece cap), and
  power.rs's fallbacks.
