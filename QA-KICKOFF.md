# QA: the user's findings from a round of QA (2026-11-18)

The user's notes, as given (not all confirmed). Work through all of them overnight: a supervisor and subagent lanes
grouped by area, targeted tests in the lanes, the full CI by the supervisor; review and fixup loops as needed. Add
nothing to docs/backlog.md unless an item is genuinely far larger than a night. Keep going past the ~10 h mark until
told to stop.

Decided before the start: the toolbar's "Machines" button and the page it opens are called **Home** (house icon);
"Machines" becomes the sidebar's heading above the machine list.

- tab with a suspended machine still uses a bit of CPU - why?
  - tab with powered off machine uses CPU too, and doesn't seem to let go of the memory either (this last part may be
    connected with it being an incognito window? or maybe I need to wait even longer for GC to kick in?)
- shared folders toolbar popup includes a command for manually mounting; as if it didn't look awkward enough inline
  with the rest of the text, it's also causing horizontal overflow within the popup. this should be moved to a
  help/details screen like what was done for the network adapters' setup steps. users can't even copy text from the
  popup, so it's a particularly bad place to show an example command.
- we're apparently missing the ability to merge an overlay, created through e.g. resizing a blank disk, into a
  browser-internal disk (at least, when both the disk and the overlay is still blank, which could still make sense to
  merge, see the resize case I mentioned)
- snapshots that can't be restored because a write-in-place disk attached to the machine has been modified (the
  situation that shows the snapshots.writtenInPlace message), should appear as orphaned (at least until the old version
  of the disk somehow comes back, e.g. via importing, assuming that we're even able track that - don't make it a goal
  to track it if we don't!). In fact, ideally the user would be warned about that limitation when creating a snapshot
  for such a machine. confirm also whether there are other situations that would prevent a snapshot from being
  restorable permanently, so they can get the same treatment. it makes little sense for the user to be wasting disk
  space on snapshots that they only find out that they can restore when they actively attempt it.
- when machine names, disk names, overlay names, shared folder names and other such human-given identifiers are
  mentioned as part of contiguous text, they should get a different styling. using a monospace font would be the easy
  way out; I'd rather you come up with something slightly nicer that is less jarring than a jump to monospace
  (especially for human-friendly identifiers, monospace shouldn't be needed. that doesn't mean they shouldn't be
  visually distinct anyway. A good example of a problematic name is an overlay called "Changes", which might even be
  our default overlay name, which reads weirdly in a modal titled "Resize Changes" - other modals, like the export one,
  avoid this by using quotes, but I think a different styling would look nicer and less awkward than quotation).
  fixing this requires going through our i18n messages, finding all places where such strings are interpolated, and
  adjusting them to the new system.
- we could be more consistent at showing an icon alongside UI element references in long UI messages, like we did for
  the note on the shared clipboard setting. For example, "No connections yet. Create one here, or from a machine's
  adapter, on its Network tab or in the toolbar's Network menu." could include the relevant Network icon before each
  Network mention. There are also messages like, "If the helper prints a different link, use Edit connection… to paste
  it." where I feel that "Edit connection…" (which references a button in the same modal) could have a different
  subtle styling. Another example of a frequently mentioned UI element is the "Machines" page (whose button, and
  perhaps the page as a whole, probably ought to be renamed, see next point).
- the "Machines" screen now holds quite a bit more than just machines; it is more of a general settings / main menu,
  and that's fine. But continuing to access it through a button called "Machines" is probably not. The "Machines"
  title, where it is right now, also doesn't make a lot of sense. I would move it from there to the sidebar, above the
  list of machines. While we're there, we can also improve what shows up in that corner while no machines exist (right
  now we just get a bit of a silly looking empty divider as the first element of the sidebar).
- monospace in all banner messages doesn't look great. we should use monospace only for the sections where it makes
  sense (IDs, error messages with "raw" technical data, etc.). consider also my point about references to human-given
  identifiers and UI elements (I know for a fact that at least some of our messages reference parts of the Machines
  page).
- there should be a way to get to the connection edit screen from a machine's Network tab, like one can press "Edit"
  on the top-level "Connections" section. because on the machine's Network tab we already have "Change connection..."
  (and it is confusing that from there one can't get to the place where we edit the settings for a connection), my
  suggestion is: within the selector that appears when that button is pressed, the card for each of the listed choices
  of existing connections should also have the same "Edit" button seen on the "Connections" section, that replaces the
  modal with the editor for that connection.
- we already have transitions for when the floating message banner moves to and from its place in the Machines page.
  We're still missing some tasteful, unobtrusive animations (ideally also 250ms long) for when the banner appears and
  disappears. My suggestion for the floating variant is to have it slide from "above the page" when appearing, and
  either fade out or disappear into above, from where it came from, going over the toolbar; this likely matches
  svelte's built-in "fly" or "slide" transitions. This is not an animation for the sake of having an animation, and
  going over the toolbar is specified for a reason: having the banner slide "from above" rather than immediately on
  top of the guest's display makes it clear that it is a message from waarm64, not from the guest. Use the Svelte
  animations/transitions system for this (remember that it can be used for custom CSS and JS transitions too). For
  when the banner is being displayed on the machines page, I'll leave up to you how to transition that, knowing that
  right now I'm ok with it just suddenly appearing and disappearing when it is located there.
