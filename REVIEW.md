# Review: the page's demo-machine code since 466efe19 (static, read-only)

Scope: `git diff 466efe19 main` over web/, tools/, bench/demo, agent/, deploy/, images/ — the clipboard starting
paused for a demo's machine, building demos and templates, templates under New machine, a demo's room (the second
adapter on the global public room), CARDS and the guest agent's card bring-up and DNS forwarder. Nothing was built or
run; the findings come from reading the code against itself, the docs named in the brief, and the external contracts
(musl's resolver, busybox udhcpc/udhcpc6, Alpine's default udhcpc script, OpenRC/supervise-daemon).

Findings are ranked most severe first. Confidence is given per finding.

---

## 1. A forwarder that dies leaves the whole guest without DNS until the next CARDS frame (Medium-High; confidence high)

**Where:** agent/src/resolve.rs:364-370 (`give_back`), 446-457 (the only callers: a poll error, the pipe closing);
agent/src/main.rs:550-562 (`ensure_resolver`), 564-565 and 783-794 (its only callers: a CARDS frame, a card job's end);
web/app/guest-agent.ts:199, 221 (the service's 32 MiB `memory.max` cgroup and `oom_score_adj` 500, which the forked
forwarder inherits).

**Defect:** while a room has resolvers, `/etc/resolv.conf` names only `127.0.53.53`. The file is given back only when
the forwarder itself sees the root's pipe close, or gets a poll error. If the forwarder process dies any other way, the
file stays pointing at an address where nothing listens:
- the OOM killer: the forwarder inherits `oom_score_adj` 500 ("first to go") and shares the service's 32 MiB cgroup
  with the agent, udhcpc6 and its own per-connection TCP children (see 5);
- `panic = "abort"` (see 4);
- a `kill -9` by the user.

The root doesn't watch the forwarder: no pidfd in `serve`'s poll set and no SIGCHLD handling. `resolve::alive` is
checked only inside `ensure_resolver`, which runs only when a CARDS frame arrives or a card job ends. CARDS is sent only
at the agent's HELLO and when the set of connected cards changes. On a machine that stays connected, that can be never,
so name resolution fails for every name. That includes `dl-cdn.alpinelinux.org`, which the Alpine demo's
command-not-found hook and apk depend on. The comment's upstreams would be found again by a restarted forwarder, but no
forwarder is restarted.

**Trigger:** the Alpine demo (512 MiB) under memory pressure, or a cgroup OOM inside the agent's 32 MiB. Or any abort,
then a lookup.

**Test:** a Rust unit test in the root loop's style (agent/src/main.rs tests): fork a fake resolver child that exits
at once; the root should notice within its poll and either respawn the forwarder or rewrite the file from the
comments. Or a Chromium page test on Alpine (`tests/page-demo-room.test.ts`): `kill -9 $(pidof …forwarder)` (it has
the agent's comm), wait 10 s, and `nslookup dl-cdn.alpinelinux.org` must still answer.

---

## 2. A failed or interrupted demo import leaks the room connection it created (Medium; confidence high)

**Where:** web/app/template.ts:62-66 (`marked` → `withDemoRoom`), called as `finish` from `machineFromTemplate` (47-54)
and `machineFromDemo` (166); web/app/definitions.ts:336 (`finish` runs first), 337-345 (the disk puts,
`withGrownOverlay` and the machine put come after it), 346-354 (the catch tidies the machine's files, the overlays and
the disks, but not connections); web/app/net-demo.ts:71-80 (`withDemoRoom` stores the connection at once through
`Connections.create`).

**Defect:** `withDemoRoom` writes a stored room connection with `forMachine: m.id` during `finish`. A failure after
`finish` leaves that record behind, and so does a tab closed before `store.put('machines')`. The failures that count:
`store.put('disks')`, `withGrownOverlay` (OPFS quota: "the storage full, most often"), or the machine's own put. The
catch removes everything else, and `deleteOwnConnections` runs only from MachinePane's Delete, so nothing ever removes
this record. Each retry ("trying again makes one") adds another `Alpine (2)`, `Alpine (3)`… connection to the user's
connections list. Each points at a machine that never existed. This breaks template.ts's contract ("a failure
anywhere leaves no machine") and definitions.ts's new doc comment (a tab closed mid-import "leaves no disk record
behind": true for disks, not for this record).

**Test:** a Node test beside tests/demo-store.test.ts's `forMachine` case: a store whose `put('machines')` (or the
second disk's put) rejects, then `machineFromDemo` on a `room: "global"` definition. Assert it throws, and that
`new Connections(store).list()` holds no connection with that `forMachine`.

---

## 3. A room whose resolver doesn't answer breaks every dotless lookup, not just the room's names (Medium-Low; confidence medium-high)

**Where:** agent/src/resolve.rs:131-143 (`ours`: the rooms' domains first in `search`), 232-242 (`route`), 487-500
(SERVFAIL on timeout); agent/src/card.rs:44-53 (the room's file stays until udhcpc6's `deconfig`).

**Defect:** the doc says the room's names go to the room and "anything else to the upstreams". But musl
(lookup_name.c `name_from_dns_search`) tries the search domains first for a name with fewer dots than `ndots`, and it
**returns at the first candidate that gives EAI_AGAIN** (a SERVFAIL or a timeout). It does not go on to the next domain
or to the bare name. While the room's resolver is unreachable, every dotless name (`foo`, a hostname) waits the
forwarder's 5 s and fails, even one that the upstream's search domain or `/etc/hosts`-less resolution would have
answered. This happens when the page disconnected the room's adapter, or the room client is reconnecting to its relays.
The room's file stays as long as udhcpc6 holds its lease: the agent "never takes a card down", and the lease runs out
only at its valid lifetime, `leaseSeconds`.

**Trigger:** a demo machine with the room connected once, then the room disconnected (the adapter's switch, or a
relay outage). Then `getent hosts somehost` where `somehost` resolves through the upstream's `search lan`.

**Test:** a Rust unit test on loopback (the `forwards_and_gives_back` harness): a room server that never answers, an
upstream that answers. A query for `x.global.p2p.internal` is routed to the room (expected). Then assert what the doc
promises for the search order. The fix is a design choice: put the rooms' domains after the upstream's, or answer
NXDOMAIN rather than SERVFAIL for a room name when the room times out. A page test on Alpine (ci-net) would confirm the
musl behavior end to end.

---

## 4. The forwarder aborts on a query shorter than 2 bytes when an upstream answers (Low; confidence high on the panic, low on the trigger)

**Where:** agent/src/resolve.rs:477 (`answer[..2] != q.query[..2]`), with 504-531 (any datagram, including a 0- or
1-byte one, is forwarded upstream: `qname` returns None, so it is routed to the upstreams).

**Defect:** `q.query[..2]` panics when the client's datagram was 0 or 1 bytes long and an upstream answers with 12
bytes or more. The agent is built with `panic = "abort"` (agent/Cargo.toml:21, 27), so the forwarder dies, which leads
to finding 1. Any local user can send the datagram. An answer to it needs an upstream that replies to garbage. That is
unusual for real servers, but the forwarder shouldn't depend on it. (Datagrams shorter than a DNS header are better
dropped before they are forwarded.)

**Test:** a Rust unit test: the loopback harness with an upstream that echoes 12 bytes to anything, a client that sends
`[0x12]`. The forwarder thread must still be running, and a normal query must still be answered.

---

## 5. Unbounded per-connection TCP children: a local user can take the agent's cgroup down (Low-Medium, security; confidence medium)

**Where:** agent/src/resolve.rs:535-550 (each `accept` forks a child, no cap), 567-613 (each child lives up to 5 s per
read: the timeouts are per call, so a client that trickles bytes holds it longer); web/app/guest-agent.ts:199 (the
cgroup cap these children share with root's agent).

**Defect:** the UDP path caps work at `MAX_PENDING` 64, but the TCP path forks without limit. Any unprivileged local
process can open connections to 127.0.53.53:53 faster than the children end. Each child is a fork of the agent, with its
page tables and kernel stacks charged to the 32 MiB `memory.max`. The cgroup's OOM killer then kills a member: the
agent, which supervise-daemon respawns at most 5 times in 10 minutes and then gives up, or the forwarder, which leads to
finding 1. On a multi-user guest that is a local denial of service against root's agent and against DNS for everyone.

**Test:** a Rust unit test: open 200 TCP connections to the loopback forwarder without sending. Count its children
(`/proc/<pid>/task/*/children`, or count `waitpid`s); at most N, the rest refused or queued.

---

## 6. The service's stop can find /run/waarm64 still busy with the forwarder (Low; confidence medium)

**Where:** web/app/guest-agent.ts:226-230 (`stop`: `default_stop`, then `umount /run/waarm64` at once);
agent/src/resolve.rs:654-665 (the forwarder is a `fork` of `/run/waarm64/agent`, not an exec, so it maps the binary on
that tmpfs) and 567-613 (its TCP children are forks too, living up to 5 s or more).

**Defect:** supervise-daemon's stop returns once the root agent's pid has exited. The forwarder exits only after it
wakes on the pipe's hangup and runs `give_back` (a read and a write of `/etc/resolv.conf`), and an in-flight TCP child
lives until its timeouts. While any of them maps `/run/waarm64/agent`, `umount` fails with EBUSY. `stop()` then returns
that failure: OpenRC reports the service failed to stop, and a `restart` doesn't start it again. The next `start` writes
`/run/waarm64/agent` again with `cat … >`, which can fail with ETXTBSY while one still runs. Depending on the kernel's
`deny_write_access` for a forked mm's exe file, that fails start as "Can't read the agent from the machine". The
session child had the same shape before, but it ends at once. The forwarder's exit now involves file I/O, and its TCP
children can outlive it.

**Test:** a Chromium page test on Alpine (tests/page-alpine-agent.test.ts): with a room card up and a TCP query held
open (`nc 127.0.53.53 53` sending two bytes of length), run `rc-service waarm64-agent restart`. It must succeed, and the
agent must say HELLO again.

---

## 7. A demo template's kept snapshot is unprotected for longer before its machine record exists (Low; confidence medium; pre-existing, widened)

**Where:** web/app/definitions.ts:336-345 (now `finish`, the template snapshot's import, runs before the disk records,
`withGrownOverlay` and `withDemoRoom`, and the machine record comes last); web/app/snapshots.ts:330 (`importSnapshot`
holds `store.writing` only around its own copy); web/app/store.ts:299-306 (`sweepMachine`: a `machines/<id>` with no
machine record is removed whole).

**Defect:** after `importSnapshot` releases the shared write lock, `machines/<id>/snapshots/<snap>` and its snapshot
record exist with no machine record. The disk puts, overlay growth and connection creation follow before the machine
put. A second tab opened in that window runs `sweep()` (exclusive lock, now free) and deletes `machines/<id>`. The
machine is then stored with `restoreFirst` naming a snapshot whose file is gone, and the snapshot record is orphaned, so
the first start fails. The window existed before the change (`withDemoNetwork` ran after the import). It now also
covers the disk records and `withGrownOverlay`.

**Test:** a Node test with a `Store` whose `put('disks')` awaits a hook that calls `store.sweep()` (Node has no Web
Locks, so the race is direct). Assert the template snapshot's file still exists after `machineFromTemplate`. Or wrap
the whole `importDefinition` body in `store.writing`.

---

## 8. A card the agent brought up is never tried again (Low; confidence high)

**Where:** agent/src/card.rs:142-148 (`unmanaged` skips any card that is up), 151-194 (the steps: sysctl, link up,
udhcpc6); agent/src/main.rs:783-797 (a failed job is only logged).

**Defect:** if `ip link set up` works but udhcpc6 doesn't start (exec fails, a missing applet that `found` misjudged)
or later dies, the card is up and has no client. Every later CARDS skips it ("anything that configured it brought it
up"), so the room never gets an address in that boot. The forwarder is spawned anyway (`ensure_resolver(true)`) but has
no room. The same holds when the sysctl write fails while the rest succeeds: the job is reported "failed", but the card
is up and is left alone. Minor, but the "up" rule can't tell the agent's own half-done bring-up from someone else's
card.

**Test:** a Rust unit test of `unmanaged` and the root's CARDS: eth1 up (0x1003), no udhcpc6 among the processes, and
`/run/waarm64-udhcpc6.script` present (the agent's mark). The card should be named again.

---

## 9. The clipboard menu treats a manual pause later in the run as the demo's starting pause (Very low; confidence high)

**Where:** web/app/areas/clipboard.svelte.ts (`startedPaused` is set once in `follow` and never cleared on resume);
web/app/ClipboardMenu.svelte:36-38, 83, 102.

**Defect:** after the visitor turns sharing on, `startedPaused` stays true. If they pause again in the same run, the
tooltip and note show `ClipboardMenu.title.pausedDemo` ("…A machine made from a demo starts with it off each time")
rather than `title.paused`, and Allow… stays hidden while the permission is `prompt`. docs/clipboard.md describes
Allow… as hidden for the run's start paused, not for a pause the user chose. The wording is wrong, nothing breaks.

**Test:** a Node/Chromium unit of ClipboardMenu: `follow(share, true)`, `resume()`, `pause()`. Expect the plain paused
title and the Allow… item.

---

## What was checked and found fine

**Guest agent**
- `rt::close_inherited`/`close_inherited_but` in every fork: spawn_steps, keygen, trim, drop, grow, keymap, the
  session child, the forwarder. No helper keeps the root's pipe write end, so the forwarder does end when the root
  does. udhcpc6, started from spawn_steps' child, holds none of the agent's descriptors. PDEATHSIG isn't inherited
  across fork, so the daemonized udhcpc6 survives the helper.
- `lease::decode` bounds the MAC count. CARDS with an empty or zero-count payload brings up nothing (`unmanaged`
  returns early: unlike LEASE, empty isn't "every card"). Card names come from sysfs, and the steps are argv vectors
  (no shell).
- `busybox udhcpc6 …` is recognized: `argv_of` names an applet run through busybox.
- udhcpc6's script against busybox's contract: `$interface`, `$ipv6` (IA_NA), `$dns` (option 23), `$search` (option
  24). `deconfig` at start and on a lost lease. Quoting is safe; the file is written as `.new` then renamed, and
  `rooms()` ignores `.new`.
- The forwarder: the inotify watches are added before the first `sync`, so a lease written before the forwarder
  started is seen. Its own writes cause one more `sync` that finds the file as wanted, so no loop. The marker and
  comment round-trip (a restarted forwarder finds its upstreams). `plain` reproduces udhcpc's file. Answers are
  matched by a connected socket per query and the client's ID, and musl's A/AAAA pair have distinct IDs. `servfail`
  keeps the ID and question. `qname` is bounded (no pointers, every slice checked). The TCP length prefix is read
  whole and checked to be at least 12. SO_SNDTIMEO also bounds the child's `connect`.
- resolv.conf against musl: one `search` line, one nameserver, `options` kept. A rename is atomic for readers.
  Alpine's udhcpc script writes `$RESOLV_CONF.$$` and `mv`s it (IN_MOVED_TO is watched).
- LEASE now signals the card's udhcpc6 with SIGUSR1 too. `udhcpc_of` is shared with the "a client runs for it" rule.

**Page**
- `AgentLink.cards`: `cardsSent` is reset at each HELLO, so a restored or restarted agent hears CARDS again; the
  send dedupes; nothing goes to an agent without `CAP.CARDS`. `NetSettled.listen` fires at every adapter change.
  `macs()` counts connected adapters only, matching what LEASE sends.
- The hold's new bound (web/devices.ts: `holding` until `{type:'connected'}`, then `HOLD_MS`) is cleared on every
  `LeaseActions.restored` exit: the `none`, `agent` and `flap` paths call `settled`, and `gone` means a newer restore
  or the run's end, which ends the card. A hold isn't started twice (`!hold`).
- `deleteOwnConnections` runs after `deleteMachine`'s `needsOff`, so the machine isn't running in any tab. It keeps a
  connection still attached to another machine and forgets the key through the page's state. `duplicateMachine` drops
  the connections and `fromDemo`, so a copy neither shares the room nor starts paused (as docs/clipboard.md and
  rooms.md say). `templateDefinition` drops `demo`, so New machine's template gets no room.
- `definition-check`: `demo.room` needs two adapters, and `macs` and `network` count as definitions.ts's
  `machineFrom` builds them.
- The clipboard starting paused: `pause()` comes before `follow`, so `setPermission('granted')` → `focused()` finds the
  share inactive. `send`/`typeIt` no longer read while inactive. The switch's resume reads inside the click (Chromium
  asks then), and a grant syncs through `setPermission`. The paste chord and HELLO reads are gated by `active`.
- `fetchChunked`: the first failure aborts the other workers and is the one thrown (Promise.all's first rejection). A
  caller's abort rethrows its reason, the response body of a non-OK piece is cancelled, and pieces are held as Blobs.
  `fetchSnapshot` maps a piece's 404 to "gone". DemoStart's abort and the one-start-at-a-time guard look right.
- demo-net.ts `wait`: the day-step re-arm keeps `timer` the live handle, so clearing it still cancels.
- tools/build-demos.ts and demo-site.ts: `isBuildPath` and `--name` stop a removal outside `target/<dir>/<name>`. The
  session's strings are limited to characters with no meaning inside the shell's double quotes. `imagePath` refuses
  `..`. `placedAll` reads demos that weren't rebuilt from their own build.
- images/alpine-demo/command-not-found.sh: the new `case` leaves anything past plain words to the visitor, so a
  `cmd; x` line isn't run twice.
