# DOMAINS: a page for each connection, and a place of their own for its domains — kickoff

Drafted 2026-11-21 from the user's briefs of that day, and **confirmed by them that day** with the changes their
last answer asked for (the outside services' sentence, "other people", the wizard's first choice, Back to where one
came from, the machines a connection is attached to).

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

And, on seeing the first draft (which kept the details and the editing as dialogs, with links to the domains):

> Since we'll be doing so much work to support the multiple levels, I think it's best if we go ahead and collapse the
> connection details + connection editing screens into the connection's subsection in this go too. This avoids the
> work of adding links to the domains section to the modals in question.

## Goal

Every connection has **a page of its own on the Home page, one level under Connections**, with what the details
dialog showed, what the wizard's editing changed, and, for a room connection, **its domains in a pane of their own**:
registered, watched and managed there, whether or not the connection is connected, with the system explained.
Everywhere else a room connection appears there is **one status link** to its domains and nothing more. The details
dialog and the wizard's edit mode go.

## Decisions taken

1. **A page per connection** under Connections, one level down, with sections: **Details** (what the adapter's
   details dialog shows), **Settings** (what the wizard's edit mode changes) and, for a room connection, **Domains**.
   Domains don't become a top-level section. `NetDetails.svelte`'s dialog and the wizard's `edit` mode are removed;
   the wizard keeps making and attaching connections.
2. **Home gets levels.** The left column shows one level at a time: the root (as today) or a **context** (here, a
   connection). Entering a context replaces all of the column's entries with that context's; leaving restores them.
3. **Back is the column's first entry, at every level.** At the root it is
   [Back to the machine](ui:machines:MachinesNav.back) (moved up from the foot, shown as today only while a machine is
   on the page). In a context it leads **back to where the user came from**: Connections (from a card, an address or a
   reload), a machine's Network tab (from its adapter's card or the wizard opened there: "Back to <machine>"), or
   the machine's screen (from the toolbar's menu or the wizard opened there: "Back to the machine"). One Back at a
   time; the toolbar's Home and wordmark still lead to the machine from any level. **Esc does what the column's Back
   does**, under the same conditions as today.
4. **Snappy Svelte transitions** show the movement: going down, the column's entries and the pane leave to the left
   and the new ones come from the right; going up, the reverse; 150 ms, `cubicOut`; a plain fade with
   `prefers-reduced-motion` (as `ui/crossfade.ts` does). Choosing between panes of one level stays instant, as today.
5. **A context's column** holds, top to bottom: Back; the context's name with a line under it (the connection's name;
   its kind, and who has it now); its sections (**Details**, **Settings**, and a room's **Domains** with its count);
   its commands (a room's **Back up key and domains…**, a tailcat server's **New address**, **Log out** where a node
   is kept, **Delete**). A pane's own primary action stays in the pane's head (Register a domain…), as New connection
   is.
6. **The address says the level**: `#home/connections/<connection id>` (its Details), `…/settings`, `…/domains`, so a
   reload, a link and the message bar's action land there. `#home` and the older `#machines` keep working; an id that is gone opens Connections.
   Going down a level pushes an entry of the browser's history (its Back leaves the level, Forward enters it again,
   where it was entered from kept in the entry's state); moving between a level's sections replaces, as moving between
   the root's panes does (the user, 2026-11-21).
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
11. **The toolbar's Details… leaves the machine's screen** for the connection's page (the machine runs on behind
    Home; Back and Esc return to it): so does the menu's warning about a room's relayed members.
12. **Change connection… asks which change is meant** (the user, 2026-11-21): on an adapter that has a connection, the
    wizard opens on a first step with two choices, **edit the attached connection** (the wizard closes and the
    connection's Settings open, Back leading to where the wizard was opened) or **attach a different connection**
    (the wizard's steps as today). An adapter with no connection opens on the steps as today. The pick step loses
    its Edit… on each connection.
13. **A connection's Details say which machines have it attached**, each a link to that machine's Network tab, or
    that none has, with a line on where connections are attached. Attaching and detaching stay there.
14. **Not in this track**: importing a key into an existing connection (a pasted key still makes a new connection, in
    the wizard); a file for the backup (it is copied, as the key is today); connecting or attaching from the
    connection's page; any change to the registry, the agent's schedule or the dialog's check.

## The design

### Navigation (`areas/machines-nav.svelte.ts`, `MachinesNav.svelte`, `MachinesPage.svelte`, `areas/page-window.ts`)

- `machinesNav` gains the context: none, or `{ kind: 'connection', id, section: 'details' | 'settings' | 'domains',
  from }` (`from`: Connections, a machine's Network tab by its id, or the machine's screen; not in the address).
  `selected` stays `CONNECTIONS` in it. Moving between a context's sections is instant, as between the root's panes. `enter(context)` and `leave()` set a direction the transitions read.
- `MachinesNav.svelte` becomes the root's entries and a context's (a component each),
  keyed by level inside one `nav`; the outgoing and incoming blocks overlap during the transition (grid-stacked), the
  column's width fixed.
- `MachinesPage.svelte` shows the context's section (`ConnectionDetails`, `ConnectionSettings`, `DomainsPane`) when
  the context is a connection's; the pane region is keyed the same
  way. Under 720 px the column and the pane stack as today and both still slide.
- `page.openMachines` learns the context (`page.openConnection(connectionId, section)` for the links); `page-window.ts` parses
  and writes the address.
- Focus moves to the pane's title on entering and back to the card's link on leaving.

### Connections, and a connection's Details and Settings

- **Connections' cards** (`ConnectionsPane.svelte`) keep the name to rename and the line (kind, who has it, the
  machines that use it), and have two buttons: **Details**, which enters the connection's page, and Delete. Edit…, New
  address and Log out move to the page (`ConnectionEditButton.svelte` goes). A room connection's line ends with its
  domains' status link.
- **Details** (`ConnectionDetails.svelte`, from `NetDetails.svelte`'s body, its words kept): the connection's values to
  copy and what they let in, by kind, as the dialog has them, and first **the machines it is attached to** (the
  card's `usedBy`), each a link to that machine's Network tab, or that there are none, with where to attach one. It reads the stored connection, and the adapter's live
  view while the connection is connected on this page (`net.runs(id)`): then the adapter's line, the guest's address,
  a tailcat address or key, a room's warnings about relayed members and the registry line show too. While it isn't,
  one line says what is missing and why. A room connection's own name in the room shows either way (the module's
  `member`, below). The local helper's install lines are open unless it is connected, as now.
- **Settings** (`ConnectionSettings.svelte`): the connection's name, then what the wizard's edit mode offered for its
  kind (a tailnet's hostname; tailcat's server and relay, and who is let in; the helper's and the demo network's
  address; a room's two switches and, under Advanced, its key to copy and a new key), with Save and Revert in the
  machine pane's row (`SaveRow.svelte`), saved through `page.netEdit`. The steps' components host it where that is the
  smaller change (their `flow.editing` branches), or their edit branches move out: the implementer's choice, said in
  the handover. The wizard loses `mode: 'edit'`, `EDIT_STEP`, `roomEdit` and the pick step's Edit…, and gains a first
  step (`NetChangeStep.svelte`, two `ui/Choice`s as the kind step has) shown when it is opened to attach on an adapter
  that has a connection: edit that connection (closes the wizard, `page.openConnection(id, 'settings', from)`) or
  attach a different one (the pick step, or the kind step where there is nothing to pick; Back returns to the choice).
- **The toolbar's Network menu**: Details… and the room's warning open the connection's Details
  (`page.openConnection`); `network.details` and `network.openDetails` go.
- An **ephemeral** connection has a page as the stored ones do (it is one of the page's connections); with a key of
  its own, its Domains section says why it can't hold a domain and offers nothing else.

### The Domains pane (`DomainsPane.svelte`, with `DomainCard.svelte` from `NameEntry.svelte`)

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
- **An ephemeral connection with a key of its own**: the pane holds the dialog's sentence on why it can't hold a
  domain (`NameDialog.ephemeral`, moved) and nothing else; its menu and card have no status link.
- **The registry line** (names-view.ts `namesLine`) is under the explainer, shown while the connection is connected on
  this page (Details has it too, as the dialog did).
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
| A machine's Network tab (`AdapterCard`) | "Domains in the room: …" | the link |
| Connections (`ConnectionsPane`), a room connection's card | nothing | the link, at the end of the card's line |
| The message bar at load (names in their last week) | words | the same words and a **Domains** action |

The details and the editing need none: Domains is beside them in the column. `NetNames.svelte` goes; its effect that relinks a connection's titles moves to where the adapter's view is read.

### The module and the agent (the pane while disconnected)

- **One new operation** of the names agent's (`net/ts/src/room/names/agent.rs` `call`): `member`, from a room's ID
  and a node's secret key, gives the node's public key, its name in the room and the room's domains (`Room::domain`,
  `Room::domains`). No network, no state. tailnet.md "The module" gets its line first (the interface's design note).
- `NamesAgent.member(conn)` (web/names.ts), `pageNames.member(conn)`: the stored key read from `waarm64-room` under
  the connection's `identityKey` (made there if the connection never started: `roomIdentity`). The pane, the dialog
  and the cards take the key and the domain from it, and no longer from the adapter's view.
- The agent's pass at load and hourly is as it is: an open pane is a visit.

## The words

New entries in `web/messages/en/network.json` (the Domains pane, the link, the backup) and `machines.json` (the column,
the card, Details' and Settings' own lines). `{{domain}}` is the room's suffix (`gabriel-lan.p2p.internal`), `{{member}}` the connection's own
name in the room, `<name>` and `<ui>` the catalog's markers. Existing entries are kept unless listed under "Changed".

**The column (a connection's context)**

| | |
|---|---|
| Back | Back to Connections / Back to <name>{{machine}}</name> / Back to the machine (the root's words) |
| the line under the connection's name | {{kind}} · {{state}} (the card's words: `kindText`, and connected here, in another tab, or not in use) |
| the sections | Details / Settings / Domains |
| a command | Back up key and domains… |
| its tooltip | Copy this connection's key together with its domains, to keep them if this browser's data is lost or to move them to another browser. |
| the other commands | New address / Log out / Delete (the card's words and tooltips today, moved) |

**Connections' cards, Details and Settings**

| | |
|---|---|
| the card's button | Details |
| its tooltip | See what this connection gives out and how to use it, and change its settings. |
| Details, the machines, some | Attached to <name>{{machines}}</name>. (each name a link) |
| Details, the machines, none | Not attached to any machine. |
| Details, under either | To attach a connection to a machine, open the machine's <ui-network>Network</ui-network> tab on the <ui-home>Home</ui-home> page. |
| the wizard's first step, title | Change connection |
| its first choice | Edit <name>{{name}}</name> |
| under it | Change the settings of the connection attached to this adapter. This opens the connection's page. |
| its second choice | Attach a different connection |
| under it | Choose another connection for this adapter, or create one. <name>{{name}}</name> stays in this browser. |
| Details, not connected in this tab | This connection isn't connected in this tab. The addresses it gives out are shown here while a machine in this tab is connected through it. |
| Details, connected in another tab | This connection is in use in another tab. The addresses it gives out are shown in that tab. |
| Settings, the name's label | Name |
| Settings, under Save, while connected here | Changes apply the next time the connection connects. (unless `page.netEdit` applies them live: then no line) |
| the rest | `NetDetails.*`, the steps' and the wizard's Save's entries as they are; their notes say "a connection's Details (or Settings) on the Home page" in place of the dialog and the wizard |

**The pane's head**

| | |
|---|---|
| title | Domains |
| meta | Domains that the connection <name>{{name}}</name> holds in the room <name>{{room}}</name>. They end in .{{domain}}, which guests can usually leave out. |
| button | Register a domain… |

**The first explainer (no domains yet)**

Heading: **Give this connection a name other people can remember**

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
> - Domains rely on decentralized infrastructure. To use them, the browsers of the room's members may contact Nostr
>   relays, OpenTimestamps servers, and Bitcoin block explorers. No payment or wallet is involved.
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
> them to another browser, use <ui>Back up key and domains…</ui>. Domains rely on decentralized infrastructure. To use
> them, the browsers of the room's members may contact Nostr relays, OpenTimestamps servers, and Bitcoin block
> explorers.

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
| the message bar's action | Domains |
| an ephemeral key's connection, in the pane | (the dialog's `NameDialog.ephemeral`, moved) |

**Changed**

| Entry | Now | Then |
|---|---|---|
| `NameDialog.*` notes | "a dialog opened from a room adapter's section of the toolbar's Network menu" | "a dialog opened from a room connection's Domains pane on the Home page" |
| `names-view.reserved_*` | …; it already works on this machine. | …; it already works in machines that use this connection. |
| `names-view.reservedLate` | (the same clause) | (the same change) |
| `NameEntry.note` | Each points at a member's name in the room, this connection's or another's: paste one to point there. A subdomain adds a domain under <name>{{name}}</name>. | Each points at a member's name in the room, which can be this connection's or another's. Paste a member's name to point there. A subdomain adds a domain under <name>{{name}}</name>. |
| `AdapterCard.adapter.names_*` | Domains in the room: {{names}} | (removed: the link) |
| `NetAdapter.details`, `NetDetails.edit`, `NetDetails.close`, `ConnectionEditButton.*`, `NetWizard.title.edit` | the dialog's and the edit mode's | Details… stays (it now opens the page); the others are removed |

## Loops

One slice, one commit and a short report each; `scripts/ci-fast.sh` after every change; the handover
(`DOMAINS-HANDOVER.md`) says which tier each commit passed. Implemented by Opus subagents, one loop at a time (they
share files), supervised here.

1. **Levels in Home, and a connection's Details.** The context in `machinesNav`, the column's two levels, Back first
   at every level, Esc, the transitions, the address; Connections' cards; `ConnectionDetails` from the dialog, the
   toolbar's Details… and warning leading to it, the dialog removed. Tests: the nav's state and the address's parse
   (unit); the column's swap, Back, Esc and a reload, and the details' values through the page (the page tests that
   read `#net-details-*`).
2. **Settings.** `ConnectionSettings`, Save and Revert, the commands in the column; the wizard's edit mode and the
   pick step's Edit… removed, its first choice added (Back from the page to where the wizard was opened). Tests: each kind's edit through the page, where the wizard's were.
3. **The Domains pane while disconnected.** tailnet.md's line, the module's `member`, the agent's and the area's
   `member`, their tests (Rust for the operation, the names agent's tests for the stored key); Details shows a room
   connection's name from it.
4. **The Domains pane.** Cards, dates, the upkeep line, both explainers, Register from the pane, the registry line,
   the backup dialog; the catalog's entries. Tests: names-view's new words and tones (unit), the pane on the page with
   the connection disconnected (register, point, let go), the `wording:` cases.
5. **One link everywhere else.** The table above; `NetNames` removed; the message bar's action. The tests that reach
   names through the menu and the details (`tests/page-room.test.ts`, `tests/names-page.test.ts`) go through the link
   and the pane.
6. **Docs and the end.** names.md ("Decisions": the two hot paths; "What the user sees"; the files), frontend.md
   ("The Home page": levels, Back, the address, a connection's page; "Network": the menu, no details dialog, the
   wizard without its edit mode), adapters.md §3, copy.md (an explainer's shape, if the user keeps these), tailnet.md,
   `tools/screens.ts`, the backlog (importing a key into a connection, a file for the backup, other dialogs that could
   become pages); `tests/areas.ts` for the new files; an out-of-context review of the Home navigation, the
   connection's page and the Domains pane, its findings triaged; PLAN.md's row done; this file and the handover
   deleted.

## What needs the user's OK

- Given 2026-11-21: this brief and its words; the module's interface growing by `member` (tailnet.md "The module");
  names.md's decision "The two hot paths" reworded (decision 7 here).
- Anything guest-visible or a step count: none expected. A dependency: none expected (Svelte's own transitions).

## Validation

- Push tier: `scripts/ci.sh`, `scripts/ci-net.sh` (the network), `scripts/ci-debian.sh` and `scripts/ci-machines.sh`
  (the page, the Home page), as far as a cloud session runs them (docs/cloud.md says what it skips; the handover
  lists what is left for the dev VM).
- By hand, in headless Chromium with screenshots sent to the user: the column going down and up (both widths, and
  with reduced motion), each kind's Details (connected here and not) and Settings, the Domains pane with none, one
  and several domains, each state, the backup dialog, each link.

## The end

Every layer above green (or listed for the dev VM), the docs updated, the loose ends in the backlog, the row in
PLAN.md done, the kickoff and handover deleted in that commit.
