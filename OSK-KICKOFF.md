# OSK: an on-screen keyboard (the user's brief, 2026-11-02)

The keys dropdown needs more special keys (notably, keys like Ctrl+W that normally close the tab or the window) and Esc
(this one in particular should also have a "Hold" option to leave browser fullscreen modes in the guest). Maybe we can
go straight into a better solution: offering a complete 103 keys, US-layout OSK that's overlaid on the page and can be
dragged around and resized, instead of just a selection of key combos. It's the ultimate solution, even solves the
problem for devices that typically have simplified keyboards (like tablets). Clicking on modifier keys on this
keyboard should hold them; holding a single key down, modifier or not, should hold it in the guest too; pressing
multiple keys (on a touchscreen) should behave like a real keyboard would, passing the keydown and keyup events
exactly as the equivalent touch events happen. First try to see if there's already a dependency that would fit these
requirements so we don't have to maintain as much bespoke code ourselves.

## Answers to the session's questions

- **Dependency**: if one fits (touch and multi-touch, a full layout, maintained, permissive), add it after vetting it
  and writing up why; otherwise build it.
- **Modifiers**: a click on a modifier holds it until the next non-modifier key is pressed: for Ctrl+Alt+F1, Ctrl and
  Alt release only once F1 is pressed; clicking Ctrl or Alt again before F1 deselects them. The most familiar
  behavior, and it saves a click or two. A preference (the Machines page's global Preferences) switches it to "held
  until clicked again".
- **The Keys dropdown** stays, gains Ctrl+W, Ctrl+T, Ctrl+Q, Esc and Hold Esc, and gets a toggle that shows or hides the
  on-screen keyboard.
