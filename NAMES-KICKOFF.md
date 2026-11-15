# NAMES: registered names in a room — kickoff

**The user's brief (2026-11-15), drafted by the session that researched and specified it; confirmed by the user
handing it over.** Give a room human-chosen names (`test123` beside `<key>.<tag>.p2p.internal`): registered first come
by a key, for a term, renewed by the page, with no server of ours, no room administrator and nothing stored on a
relay. **The design is [docs/plans/room-names.md](docs/plans/room-names.md): read it first, whole** (it was revised after an
out-of-context review of its first draft; its last section says what that draft got wrong). How it was
chosen: [docs/plans/room-names-options.md](docs/plans/room-names-options.md) (seven options weighed) and the notes
under `docs/plans/room-names-research/`;
neither needs reading to build it. What it extends: [docs/networking/rooms.md](docs/networking/rooms.md).

## Decisions (binding; the user's, 2026-11-15)

The spec's "Decisions taken" and "What changes that needed the user's OK" are the list; the ones a loop is most likely
to brush against:

1. **A name's owner is the oldest unbroken chain of timestamped claims alive now.** A claim stamped earlier and held
   back can take a name; a room that empties loses its registry and owners' nodes put it back. Both accepted: don't
   engineer against them (no witnesses, no pinning of names a node has seen, no stored relay state).
2. **Nothing about a name stays on a Nostr relay**; "who serves the registry?" is an ephemeral message, and nothing
   about a member goes in a room's link.
3. **Name owners hold the whole registry and serve it; everyone else asks a server for the one name it wants.** A
   node's registry traffic runs under a key made new each session, relay only: no server learns which node asked, and
   registry traffic never opens a WebRTC connection. Members that only use names reveal nothing new to other members.
4. **Bitcoin is the clock, through OpenTimestamps**: no coin, fee or wallet, and no drand. Times are block headers'
   own timestamps; members ask no block explorer. The outside services are the three calendars and two explorers the
   spec names, used only by a page that registers or renews (and calendars by servers finishing a renewal); another
   service, or another user of these, is asked.
5. **Names are never in the registry in words**: looked up by a keyed hash, where they point sealed under the name, an
   owner key per name. Which names are acceptable is the resolver's and the dialog's rule.
6. **The two hot paths**: reaching someone's name takes no switch, notice or reading; naming a machine is one dialog
   with two notices (discoverable; visit every N days) and no key shown. A design that adds a step to either is asked.
7. **Short terms** (~30 days, a week's grace, renewed past a third of the term); the exact numbers may move with N0's
   measurements, inside "a month or shorter".
8. **The page may reach a room without a guest** to publish names (through a names client, which needs no machine
   and no key of the node's); a room connection of the guest's that stays up without a machine isn't in this track.
9. **Dependencies**: none new, except `argon2` (RustCrypto) if N0's numbers pick it over BLAKE2s (the user's OK is
   given for that case; its `THIRD_PARTY.json` row with `about`). The OpenTimestamps libraries are LGPL: the verifier
   is written from the format, nothing copied (a reference row). Anything else is asked.
10. **Guest-visible**: the resolver answers registered names (OK given). `tests/steps.txt` doesn't move; if it does,
    stop and ask.
11. **The module's interface** (docs/networking/tailnet.md "The module"; not docs/abi.md's, no version number) may
    grow as the spec says. Wire changes that stop older pages from serving or syncing names are fine (rooms are
    pre-release); one that stops them meeting in a room at all is asked.
12. Not decided, and not this track's: which suffixes names may use. Names live under the room's existing
    `<tag>.p2p.internal`.

Where the spec and this file differ, this file wins. Where a measurement or the code contradicts the spec, the
supervisor changes the spec inside these decisions and says why in the handover; a change to a decision is asked.

## How the track runs

**The session is a supervisor**, as PERF-HANDOVER.md "How the track is worked" describes (read it; the same rules hold
unless this file says otherwise). It starts by setting PLAN.md's row to "In progress since <date>" and writing
`NAMES-HANDOVER.md` (lean: state, the queue, open questions; CLAUDE.md), committed and pushed. Then it runs **one
general-purpose subagent at a time, one loop each**, in the main checkout (no worktrees), waits for it to finish,
checks its report against the repo (`git log`, the pushed commit, `git status` clean, `ps` for leftovers), updates the
handover's queue, and starts the next. It works through to the end without check-ins: choices are settled by
measurement; it asks the user only what the decisions above send to them, and anything that changes what a member
reveals or which outside service a page talks to. The user is often watching: a short status line between loops.

**A loop's brief** (the subagent knows only what's in it; written fresh, neutral, never the supervisor's theory):
- Read CLAUDE.md and follow it exactly, **except for which tests it runs (below)**: bounded runs with `timeout`;
  `systemd-run` memory caps on every node, cargo and Chromium run; no self-matching `pkill`. Then this file,
  NAMES-HANDOVER.md, docs/plans/room-names.md, docs/networking/rooms.md, and its area's pages:
  docs/networking/tailnet.md "The module" and adapters.md §2.1 from N2; docs/frontend.md "Network",
  docs/frontend-code.md and docs/i18n.md from N4.
- The loop's goal and its done (below), the files it touches, what earlier loops changed that bears on it.
- Correctness: tests at the cheapest layer, most of them Rust unit tests in `net/ts` against the pretend Bitcoin,
  calendar and explorer (no test touches a public service); **a planted bug for each new rule** a test must catch (an
  anchor past `REF_WINDOW` taken, a renewal by another key, a later claim beating an earlier one, a zone opened with
  another name's key, a pending anchor counted, a worse chain replacing a better one, a header under the floor taken,
  a member's kept name replaced by a younger chain), source restored afterwards and
  the module rebuilt. Tests never `assert.deepEqual` large buffers.
- **Public services** (the calendars, the explorers, public relays and DERP) are touched only by N0 and N6, a few
  hundred small requests at most each, never a load test; tailcat's relays for one transfer a size.
- The finish: the spec's section brought in line with what was built; loose ends in docs/backlog.md; the handover's
  queue row updated; the loop's checks green (below); `git fetch`, rebase onto origin/main, commit, push to origin
  main. The reply: a short report with what was built or why not, the numbers where there are any, tests and planted
  bugs, which checks ran with their results, the commit hash.

**Which tests a loop runs** (the user, 2026-11-15: the full CI has become slow; a loop runs the most targeted checks,
and the full scripts wait for the reviews. This replaces CLAUDE.md's "`scripts/ci.sh` must pass before any piece of
work is considered done" for this track's loops, and only for them):
- **Every loop that changes code**: `cargo fmt --all --check`; `cargo clippy -p waarm64_ts --all-targets -q -- -D
  warnings`; `cargo test -q -p waarm64_ts`; `net/ts/build.sh`.
- **When TypeScript changed**: `npx tsc --noEmit`, and the test files of what changed, named one by one to
  `node --disable-warning=ExperimentalWarning --test` (the loops below say which).
- **When the page changed** (`web/app/`, the catalog): also `npm run -s svelte-check`, `npm run -s lint`,
  `tools/i18n-check.ts`; `tools/third-party.ts` when `THIRD_PARTY.json` did; `tools/harness-imports.ts` when a test
  or harness file was added.
- **A Debian page test** (tests/page-room.test.ts and what a loop adds beside it) runs alone, with scripts/ci-net.sh's
  environment (read the script for it), only in the loops that name it.
- A check outside this list that a loop's change plainly could break (it touched a shared file: `web/ts-client.ts`,
  `web/gateway.ts`, `connections.ts`) is run too, by name: the supervisor adds it to the brief.
- **The full scripts run twice**, alone, in the background, as CLAUDE.md says: at the **mid-track review** (after N3)
  `scripts/ci.sh` and `scripts/ci-net.sh`; at **the end** those two, `scripts/ci-debian.sh` and
  `scripts/ci-machines.sh`. A failure there is fixed before the next loop starts, and the check that would have caught
  it is added to the loops' list above.

**Out-of-context reviews** (CLAUDE.md): after N3 (the registry and its rules: a new subsystem, and what an attacker
aims at) and at the track's end, a fresh agent with only the area (`net/ts/src/room/names/`, later `web/names*.ts`)
and "find real defects" reviews statically, findings on a `review/names-<n>` branch; the next loop fixes them first,
each with its confirming test failing first.

## The loops (in order; the supervisor may reorder by measurement, saying why in the handover)

0. **Measure** (no product code; the spec's "Measure first", six items): start the calendars' time to anchor first
   (it runs for a week beside the later loops, a script under `bench/net/` that keeps its state in
   `bench/results/local/`). *Done:* a "NAMES loop 0" entry in bench/net/REPORT.md with its JSON under
   `bench/net/results/`; `REF_WINDOW`, the proof-of-work function and `POW_BITS` set in the spec from the numbers (the
   anchor's figure provisional until the week is in), the size table replaced, and the spec's "where it stops" either
   confirmed or corrected.
1. **Records and rules**, pure Rust in `net/ts/src/room/names/`: entries, anchors and their verifier, headers and the
   floor, zones and their sealing, name ids, the order of chains. The clock's parameters are a struct, so tests run a
   pretend Bitcoin of easy headers. *Done:* `cargo test` with vectors (one real anchored proof and its header,
   committed) and property tests (any order of merging the same chains, with any subsets of their anchors, gives the
   same owner; forks, releases and their stale copies); the planted bugs.
2. **The names client and the servers' side**: a second room client under a session key, "who serves the registry?"
   and its answer rule, `serve`, the store, range sync, `get`, `put`, `have`, the bound. *Done:* in room/tests.rs's
   fake DERP and relay: two and twenty servers converge; a reset recovers from one owner's title; a server that leaves
   names out; a worse chain refused; forged anchors, headers and signatures refused; the answer rule's counts at 1, 20
   and 500 servers; a flood of questions leaving the node's own lookups and call backs alone; nothing on port 2 under
   the node's key, and no WebRTC connection from it.
3. **The member's side and the resolver**: `get`, `history`, what a member keeps, `resolve()`'s new cases with their
   waits and negative answers, the reserved names, persistence for members and servers, and the tests' pretend
   calendar and explorer (`tests/net/ots-calendar.ts`, no dependency, as `tests/net/nostr-relay.ts` is). *Done:* its
   own Node test; tests/page-room.test.ts grown by a name (titles made by the test's own tool until N4): by full name
   and by the short one through the search domain, a label under it, a zone change, a reserved name, a room with no
   server, and what Debian asks the search domain unprompted. Then **the mid-track review and the full scripts**.
4. **The review's findings fixed**, then **the names agent**: owners' secrets, titles, the worker and its `ts_names_*`
   exports, stamping, collecting, renewing on load, publishing through a names client with no machine running.
   *Done:* Node and Chromium tests with the pretend calendar: a claim held back until anchored, a renewal with the
   machine off that a second member then resolves, a title renewed in two browsers (a fork settled), a lost name, a
   title surviving a connection's export and import (tests/connections.test.ts's neighbours).
5. **The page**: Name this machine…, the adapter's states and details, the Machines page's dates, the catalog,
   docs/frontend.md. *Done:* a page test of the dialog through to a name another machine reaches
   (tests/page-room.test.ts or beside it), the wording cases, both hot paths as decision 6 says.
6. **Scale and abuse**: bench/net/room-scale.ts with 1,000 members, 20 servers and 5,000 names (a server's load and
   memory, a cold lookup, 500 members joining in a minute, junk registered in bulk against the bound); a few days on
   the public calendars, explorers and default relays with real stamps, between two pages. *Done:* a "NAMES loop 6"
   REPORT entry; what the numbers break is fixed or, if out of proportion, filed with them.

## The end

The final review's findings fixed or filed; the full scripts green (above); the numbers in bench/net/REPORT.md;
`docs/networking/names.md` written from the spec as what exists (and listed in docs/README.md); rooms.md's "Decisions"
and "What a room needs from a Nostr relay" updated, and its opening lines, which say the only names are keys;
docs/frontend.md and docs/testing.md saying what's new; loose ends in docs/backlog.md (servers that hold a share of the ids
each, old history in chains, transfer and recovery keys); PLAN.md's row set to
done with its links; docs/plans/room-names.md, plans/networking-p2p.md's bullet, this file and NAMES-HANDOVER.md
deleted in that commit. docs/plans/room-names-options.md and `room-names-research/` go with them, what they found
that explains the design (why first come needs an orderer, what each option cost, why a chain on Bitcoin's clock
won) rewritten into names.md as its "Why it is this way".
