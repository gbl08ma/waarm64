# DOMAINS: a place of their own for a room connection's domains — kickoff

Drafted 2026-11-21 from the user's two briefs of that day; **not started until the user confirms it**.

The user's brief, in their words:

> the current UI/UX for registering and managing domains in p2p rooms (docs/networking/names.md) is quite bad. the
> domain management surface is barely discoverable, and it can eventually only be found shoehorned into the connection
> details modal, that becomes way too busy with the addition of that domain management UI. [...] I feel that domains
> are complex enough that they deserve a less cramped UI, potentially through [...] an inner full pane within the
> connections subsection, scoped to a single room/single connection [...]. I'm also not a fan of how the domains
> registered in a room end up bloating the connection's toolbar popup - I would rather have no more than a single
> button or status link, something like "Register a domain" / "X domains registered" that take users to that fuller
> domain management UI, and a similar thing in the connection modals too. This would also give us space to properly
> explain the system, rather than the user having to build their "big picture understanding" through breadcrumbs in
> individual modals.

On the navigation, the path, the pane while disconnected, the backup and the explainers:

> when moving one level deeper into a connection (in this case, for the domain management surface), let's do it by
> replacing all of the sidebar's entries with the actions that make sense for them. The sidebar and/or the panes should
> have snappy animations (svelte's) to represent this movement into nested panes. There is already a precedent for
> "going back" in this sidebar: the MachinesNav.back message at the bottom of the sidebar when a machine is running.
> I'm thinking we should move that to the top of the sidebar, and make it a more general pattern for navigating back
> within the Home screen's subsections. This paves the way for the A+ redesign and perhaps to turn even more modals
> into full-page affairs. The sidebar can then offer more contextual options for these subsections, like exporting or
> importing e.g. the connection's keys, similar to what we offer for machine definitions.

> The registration path becoming longer seems fine, even desirable, to me: the users should learn about what
> registering a domain means, and how it will work after that, prior to doing it. Please take care of the copy for
> these explanations [...] taking into account the docs/copy.md guidelines.

> Ideally the pane should work when the connection isn't connected to a running machine [...]. A user may want to
> visit the page to let one of their domains renew without booting a machine.

> Yes, put a connection backup/export option in the pane, possibly as a sidebar option [...].

> I'd show one kind of explainer when there are no domains, and a different explainer once there are domains. [...]
> Once there are domains, the explainer may be collapsed by default.

## Goal

A room connection's domains are registered, watched and managed in **one pane of the Home page, inside Connections,
scoped to that connection**, which works whether or not the connection is connected. Everywhere else a room
connection appears there is **one status link** to it and nothing more. The pane explains the system.

## Decisions taken

1. **Option A**: the pane lives under Connections, one level down, for one connection. Domains don't become a
   top-level section. ("A+", a whole page per connection that absorbs the details dialog, is not this track; the
   navigation built here is what it would use.)
2. **Home gets levels.** The left column shows one level at a time: the root (as today) or a **context** (here, a
   connection). Entering a context replaces all of the column's entries with that context's; leaving restores them.
3. **Back is the column's first entry, at every level.** At the root it is
   [Back to the machine](ui:machines:MachinesNav.back) (moved up from the foot, shown as today only while a machine is
   on the page). In a context it leads one level up ("Back to Connections"). One Back at a time; the toolbar's Home
   and wordmark still lead to the machine from any level. **Esc does what the column's Back does** (one level up,
   then the machine), under the same conditions as today.
4. **Snappy Svelte transitions** show the movement: going down, the column's entries and the pane leave to the left
   and the new ones come from the right; going up, the reverse; 150 ms, `cubicOut`; a plain fade with
   `prefers-reduced-motion` (as `ui/crossfade.ts` does). Choosing between panes of one level stays instant, as today.
5. **A context's column** holds, top to bottom: Back; the context's name with a line under it (the connection's name;
   its kind and room); its sections (now one: **Domains**, with its count); its commands (now one: **Back up key and
   domains…**). A pane's own primary action stays in the pane's head (Register a domain…), as New connection is.
6. **The address says the level**: `#home/connections/<connection id>/domains`, so a reload, a link and the message
   bar's action land there. `#home` and the older `#machines` keep working; an id that is gone opens Connections.
7. **The registration path is one step longer** and that is wanted (the user, 2026-11-21): the pane explains before
   the dialog asks. names.md's decision "The two hot paths" changes accordingly (reaching a name: still nothing;
   registering: the pane, then one dialog with its two notices, no key shown).
8. **The pane works with the connection disconnected**: states, register, where a domain points, let it go, backup.
   The agent gets the connection's node key and the room's domain from the stored key and link, through one new
   operation of the module (below). Nothing in the pane is disabled for want of a running machine.
9. **Two explainers**: one for a connection with no domains (what a domain is, what registering involves, what to
   know first), always open; another once it has some (keeping them, the states, who sees what, backup), collapsed.
10. **The copy is written here** ("The words"), by docs/copy.md. Implementers add the entries with notes; they change
    a message only where it turns out false, and say so in the handover.
11. **Not in this track**: importing a key into an existing connection (a pasted key still makes a new connection, in
    the wizard); a file for the backup (it is copied, as the key is today); A+; any change to the registry, the agent's
    schedule or the dialog's check.

## The design

### Navigation (`areas/machines-nav.svelte.ts`, `MachinesNav.svelte`, `MachinesPage.svelte`, `areas/page-window.ts`)

- `machinesNav` gains the context: none, or `{ kind: 'connection', id, section: 'domains' }`. `selected` stays
  `CONNECTIONS` in it. `enter(context)` and `leave()` set a direction the transitions read.
- `MachinesNav.svelte` becomes the root's entries and a context's (a component each, so A+ adds entries in one place),
  keyed by level inside one `nav`; the outgoing and incoming blocks overlap during the transition (grid-stacked), the
  column's width fixed.
- `MachinesPage.svelte` shows `DomainsPane` when the context is a connection's; the pane region is keyed the same
  way. Under 720 px the column and the pane stack as today and both still slide.
- `page.openMachines` learns the context (`page.openDomains(connectionId)` for the links); `page-window.ts` parses
  and writes the address.
- Focus moves to the pane's title on entering and back to the card's link on leaving.

### The pane (`DomainsPane.svelte`, with `DomainCard.svelte` from `NameEntry.svelte`)

`ui/Pane.svelte`, title **Domains**, the meta line naming the room and the suffix, **Register a domain…** in its head.

```
Domains                                              [Register a domain…]
Domains of the connection gabriel-lan, in the room gabriel-lan. …
┌ Reopen this web app by about December 5 to keep these domains. ───────┐
┌ ● test123.gabriel-lan.p2p.internal        Active ─────────────────────┐
│   Registered Nov 4 · Next renewal from Nov 19 · Works until Dec 5      │
│   test123      → [this connection                              ]       │
│   git.test123  → [mybox…                                       ]  🗑   │
│   [Add a subdomain] [Point all at this connection] [Save]  [Let it go] │
└────────────────────────────────────────────────────────────────────────┘
┌ ◐ blog.gabriel-lan.p2p.internal           Reserved, public in about 2 hours
▸ How domains work
This web app serves the room's domains for this connection: …   (while connected)
```

- **A card a domain**: the whole domain (the name strong, the suffix dim), a status light (`ui/StatusDot`: ok for
  active, busy for preparing and reserved, warn for grace, off for lapsed and let go, error for lost) with the state's
  words (names-view.ts `titleState`, kept), three dates where the title has them (`claimedAt`, `renewAt`,
  `keptUntil`), then the points editor and its buttons as `NameEntry` has them. A domain let go, lost or lapsed shows
  its state, a sentence on what it means, and nothing to edit.
- **The upkeep line** above the cards, from the titles' earliest `keptUntil`; in the warning tone when a domain is in
  its last week or its grace.
- **No domains**: the first explainer in the cards' place, with a second Register a domain… under it.
- **An ephemeral key's connection** never reaches the pane (it isn't one of the browser's connections); its adapter's
  details say why it can't hold a domain (the dialog's words today), and its menu has no link.
- **The registry line** (names-view.ts `namesLine`) moves here from the details, shown while the connection is
  connected on this page.
- `NameDialog` opens from the pane for a connection (not an adapter's index): `network.naming` takes the connection's
  id. Its field, check, notices and second-press rule don't change.

### The backup (`ConnectionBackup.svelte`, a dialog from the context's column)

The connection's export (`room-export.ts` `roomExportOf`) in a secret `ValueField` to copy, with what it is, that it
must stay secret, and how to restore it. The wizard's Advanced keeps its own field. The delete question is unchanged.

### One status link everywhere else (`DomainsLink.svelte`)

"Register a domain…" with none; "N domains registered" with some; "…, 1 needs attention" in the warning tone when one
is in its grace, lost, or in its last week. It opens the pane (closing the menu or dialog it is in). It replaces:

| Where | Today | Then |
|---|---|---|
| The toolbar's Network menu, a room adapter (`NetAdapter` → `NetNames`) | every domain with its state, and the button | the link (stored connections only) |
| The adapter's details (`NetDetails`) | the registry line and a `NameEntry` a domain | the link |
| The Network wizard's room step, editing (`NetRoomStep`) | nothing | the link, under the room's name |
| A machine's Network tab (`AdapterCard`) | "Domains in the room: …" | the link |
| Connections (`ConnectionsPane`), a room connection's card | nothing | a **Domains** button with its count, and the attention words in the card's line |
| The message bar at load (names in their last week) | words | the same words and a **Domains** action |

`NetNames.svelte` goes; its effect that relinks a connection's titles moves to where the adapter's view is read.

### The module and the agent (the pane while disconnected)

- **One new operation** of the names agent's (`net/ts/src/room/names/agent.rs` `call`): `member`, from a room's ID
  and a node's secret key, gives the node's public key, its name in the room and the room's domains (`Room::domain`,
  `Room::domains`). No network, no state. tailnet.md "The module" gets its line first (the interface's design note).
- `NamesAgent.member(conn)` (web/names.ts), `pageNames.member(conn)`: the stored key read from `waarm64-room` under
  the connection's `identityKey` (made there if the connection never started: `roomIdentity`). The pane, the dialog
  and the cards take the key and the domain from it, and no longer from the adapter's view.
- The agent's pass at load and hourly is as it is: an open pane is a visit.

## The words

New entries in `web/messages/en/network.json` (the pane, the link, the backup) and `machines.json` (the column, the
card's button). `{{domain}}` is the room's suffix (`gabriel-lan.p2p.internal`), `{{member}}` the connection's own
name in the room, `<name>` and `<ui>` the catalog's markers. Existing entries are kept unless listed under "Changed".

**The column (a connection's context)**

| | |
|---|---|
| Back | Back to Connections |
| the line under the connection's name | Peer-to-peer room <name>{{room}}</name> |
| the section | Domains |
| the command | Back up key and domains… |
| its tooltip | Copy this connection's key together with its domains, to keep them if this browser's data is lost or to move them to another browser. |

**The pane's head**

| | |
|---|---|
| title | Domains |
| meta | Domains that the connection <name>{{name}}</name> holds in the room <name>{{room}}</name>. They end in .{{domain}}, which guests can usually leave out. |
| button | Register a domain… |

**The first explainer (no domains yet)**

Heading: **Give this connection a name people can remember**

> A domain is a short name of your choice, such as mybox, that the room's members can use to reach this connection.
> Without one, they need its own name in the room, which is {{member}}. A domain can also have subdomains, and each
> can point at this connection or at another member.
>
> Registering is free and needs no account. No central server keeps the room's domains. The members who hold domains
> keep the records and answer lookups for everyone else.

Heading: **What registering involves**

1. > **Choose a domain.** A domain belongs to whoever registered it first and has renewed it ever since.
2. > **Wait about 2 hours.** Until then the domain is reserved. It already works in machines that use this
   > connection, but other members can't look it up yet. The wait is the time it takes to prove publicly when you
   > registered.
3. > **Reopen this web app at least every 2 weeks.** It renews your domains while it's open, and no machine needs to
   > be running. A domain that goes 30 days without a renewal stops working, and a week after that anyone can
   > register it.

Heading: **Before you register**

> - Members who know a domain can reach the connection it points at and see when that connection is online. Nobody
>   can list the room's domains, but any member can check whether a name they guess is registered.
> - While this connection is connected, this web app keeps the room's domain records and helps other members look
>   domains up.
> - This browser holds the only copy of your domains. If its data is cleared, they are lost. To keep a copy, use
>   <ui>Back up key and domains…</ui>.
> - To prove when a domain was registered or renewed, this web app contacts public OpenTimestamps servers and Bitcoin
>   block explorers. No payment or wallet is involved.
> - Rarely, a domain that looked free turns out to have an earlier registration, for example by a member who was away
>   when you registered. The earlier registration wins, and this web app tells you when that happens.

**The upkeep line (some domains)**

| | |
|---|---|
| one | Reopen this web app by about {{when, date}} to keep this domain. |
| several | Reopen this web app by about {{when, date}} to keep these domains. |
| one in its last week or grace (warning) | <name>{{names}}</name> needs renewing. Leave this web app open for a few hours to keep it. |
| several (warning) | <name>{{names}}</name> need renewing. Leave this web app open for a few hours to keep them. |
| none live (all let go, lapsed or lost) | (no line) |

**A card**

| | |
|---|---|
| dates | Registered {{when, date}} · Next renewal from {{when, date}} · Works until about {{when, date}} |
| tooltip of "Next renewal" | This web app renews the domain the first time it's open on or after this date. |
| lapsed, under its state | It wasn't renewed for 30 days and the week that followed. You can register it again if nobody else has. |
| let go, under its state | You let this domain go. Anyone can register it once the release is public, which takes about 2 hours. |
| lost, under its state | Another member registered this domain before you, or registered it while yours had lapsed. This web app no longer renews it. |

**The second explainer (some domains)**, collapsed, summary **How domains work**

Heading: **Keeping your domains**

> This web app renews each domain about every 2 weeks, while it's open. No machine needs to be running, and a short
> visit is enough. A domain that goes 30 days without a renewal stops working for the room's members. You can still
> renew it for a week after that by reopening this web app. Then it lapses, and anyone can register it.

Heading: **What the states mean**

> - **Preparing.** This web app is doing the work a registration requires, which takes up to a minute or two.
> - **Reserved.** The domain is registered but not public yet. It already works in machines that use this
>   connection. Other members can look it up about 2 hours after you registered it.
> - **Active.** Members can look the domain up.
> - **Not renewed in time.** Members can't look the domain up until this web app renews it.
> - **Lapsed, let go, or lost.** The domain is no longer yours.

Heading: **Who can see them**

> Members who know a domain can reach the connection it points at and see when that connection is online. Nobody can
> list the room's domains, but any member can check whether a name they guess is registered. Domains can be looked up
> only while at least one member that holds a domain is connected to the room.

Heading: **Where they are kept**

> This browser holds the only copy of your domains. If its data is cleared, they are lost. To keep a copy, or to move
> them to another browser, use <ui>Back up key and domains…</ui>. To prove when a domain was registered or renewed,
> this web app contacts public OpenTimestamps servers and Bitcoin block explorers.

**The backup dialog**

| | |
|---|---|
| title | Back up key and domains |
| above the field | This is the key of the connection <name>{{name}}</name>, followed by its domains. Copy it and keep it somewhere safe. |
| the field's label | Key and domains |
| warning | Keep it secret. Whoever has it can take this connection's name and address in the room, and its domains. |
| restoring | To restore it, create or join the room in a new connection, open <ui>Advanced</ui>, choose <ui>A key to paste</ui>, and paste it there. Don't connect two connections with the same key at the same time. |
| no domains yet | This is the key of the connection <name>{{name}}</name>. It has no domains yet. Copy it and keep it somewhere safe. |
| button | Close |

**The status link**

| | |
|---|---|
| none | Register a domain… |
| one / several | 1 domain registered / {{count}} domains registered |
| attention, one / several | 1 domain registered, {{attention}} needs attention / {{count}} domains registered, {{attention}} need attention |
| Connections' card, the button | Domains |
| its tooltip | Register domains in this connection's room, and manage the ones it holds. |
| the message bar's action | Domains |
| an ephemeral key's connection, in its details | (the dialog's `NameDialog.ephemeral`, moved) |

**Changed**

| Entry | Now | Then |
|---|---|---|
| `NameDialog.*` notes | "a dialog opened from a room adapter's section of the toolbar's Network menu" | "a dialog opened from a room connection's Domains pane on the Home page" |
| `names-view.reserved_*` | …; it already works on this machine. | …; it already works in machines that use this connection. |
| `names-view.reservedLate` | (the same clause) | (the same change) |
| `NameEntry.note` | Each points at a member's name in the room, this connection's or another's: paste one to point there. A subdomain adds a domain under <name>{{name}}</name>. | Each points at a member's name in the room, which can be this connection's or another's. Paste a member's name to point there. A subdomain adds a domain under <name>{{name}}</name>. |
| `AdapterCard.adapter.names_*` | Domains in the room: {{names}} | (removed: the link) |

## Loops

One slice, one commit and a short report each; `scripts/ci-fast.sh` after every change; the handover
(`DOMAINS-HANDOVER.md`) says which tier each commit passed. Implemented by Opus subagents, one loop at a time (they
share files), supervised here.

1. **Levels in Home.** The context in `machinesNav`, the column's two levels, Back first at every level, Esc, the
   transitions, the address. `DomainsPane` exists with its head only. Tests: the nav's state and the address's parse
   (unit), the column's swap, Back, Esc and a reload (the page tests).
2. **The pane while disconnected.** tailnet.md's line, the module's `member`, the agent's and the area's `member`,
   their tests (Rust for the operation, the names agent's tests for the stored key).
3. **The pane.** Cards, dates, the upkeep line, both explainers, Register from the pane, the registry line, the
   backup dialog; the catalog's entries. Tests: names-view's new words and tones (unit), the pane on the page with the
   connection disconnected (register, point, let go), the `wording:` cases.
4. **One link everywhere else.** The table above; `NetNames` and the details' cards removed; the message bar's
   action. The tests that reach names through the menu and the details (`tests/page-room.test.ts`,
   `tests/names-page.test.ts`) go through the link and the pane.
5. **Docs and the end.** names.md ("Decisions": the two hot paths; "What the user sees"; the files), frontend.md
   ("The Home page": levels, Back, the address; "Network": the menu, the details), adapters.md §3.1, copy.md (an
   explainer's shape, if the user keeps these), tailnet.md, the backlog (A+, importing a key into a connection, a file
   for the backup); `tests/areas.ts` for the new files; an out-of-context review of the Home navigation and the pane,
   its findings triaged; PLAN.md's row done; this file and the handover deleted.

## What needs the user's OK

- This brief, and **the words** above.
- **The module's interface grows by `member`** (tailnet.md "The module").
- **names.md's decision "The two hot paths"** is reworded (decision 7 here).
- Anything guest-visible or a step count: none expected. A dependency: none expected (Svelte's own transitions).

## Validation

- Push tier: `scripts/ci.sh`, `scripts/ci-net.sh` (the network), `scripts/ci-debian.sh` and `scripts/ci-machines.sh`
  (the page, the Home page), as far as a cloud session runs them (docs/cloud.md says what it skips; the handover
  lists what is left for the dev VM).
- By hand, in headless Chromium with screenshots sent to the user: the column going down and up (both widths, and
  with reduced motion), the pane with none, one and several domains, each state, the backup dialog, each link.

## The end

Every layer above green (or listed for the dev VM), the docs updated, the loose ends in the backlog, the row in
PLAN.md done, the kickoff and handover deleted in that commit.
