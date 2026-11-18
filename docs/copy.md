# The page's words: a style guide

How the words the user reads are written: the catalog's messages (`web/messages/en/`, [i18n.md](i18n.md)) and the
screens they sit in. Drawn from the user's own edits (2026-11-02: the boot card and the Disks tab, ~30 messages)
and the choices they made then; it grows as the user reviews more of the copy.

## The voice

- **Plain and conventional.** The words a user expects from other software: Create, Delete, Power off, Restore. No
  invented phrasing ("Make it"), no wordplay.
- **The effect first.** Say what happens or what something does before why or how: [No video output. The guest may
  be sending boot menus and setup instructions to the serial console.](ui:common:BootCard.serial); "Automatically configure the guest to use
  this ramdisk as swap."
- **Full sentences**, ending with a period, tooltips and notes included. A button, a label, a title and an error's
  headline aren't sentences and take no period.
- **One topic per sentence.** A new topic gets a new sentence, not a colon. A colon only introduces what it
  announces: a list, an example, a field to fill in ("Enter a name for the new overlay:"). A semicolon joins two
  clauses of the *same* topic within a sentence. "The sky is blue; roses are red. Yesterday was a nice day.", never
  "The sky is blue. Roses are red; yesterday was a nice day." nor a chain of colons.
- **Tense.** The present for what something is or does ("The guest's writes go into the stored disk itself."); `will`
  for what an action the user is about to take causes ("This will delete the 12 MiB of changes…", "the machine will
  be started again").
- **The user is "you"**, in descriptions and instructions ("You will not be asked to select a file again."); steps and
  prompts are imperatives ([Paste the address it prints, below:](ui:network:NetTailcatStep.tailcat.exit.paste)).
- **Contractions are fine** (can't, isn't, doesn't), as in speech.
- **Parentheses sparingly**: for a unit, an abbreviation or a command (`fstrim`), not for a second thought; a second
  thought is a sentence.
- **'Immediately,' not 'at once'.** Say what happens right away with 'immediately' ('This will power it off
  immediately'), never 'at once'. 'At once' only means simultaneously ('several keys held at once').
- **Passive for recipients.** When a sentence gives something to people, say 'those who are given X' or 'only those
  who are given X can join,' not 'those you give X to can join.'
- **American spelling.** American English spellings: center, color, gray, analyze, realize, organize, program (never centre, colour, grey, analyse, realise, organise, programme).

## Detail

- Name the components and standards a user may need to know or look up: systemd, Linux, Mesa, OpenGL ES, Vulkan,
  VA-API, qcow2, a version when it is a real requirement ("systemd version 254 or above").
- **No distributions as examples** (Debian, Arch, …): what they ship changes, and naming them suggests only they work.
  State the requirement instead.
- **No internals** the user can't act on: workers, OPFS, buffers, chunks, budgets, generations, pins. A limit or a
  number appears when it changes what the user does or expects ("for the first 4 GiB of the disk").
- **Accuracy over brevity**, though: a simplification must still be true. If the exact rule is too long, say the part
  that matters and stop; never replace it with a simpler rule that is false.
- Don't repeat what the same screen already says elsewhere (a section of its own, a heading, a nearby note).

## Words

| Word | Means | Not |
|---|---|---|
| **this web app** | the emulator as a thing in the browser: its storage, the browser's permissions, files and tabs ("stored in this web app", "This web app needs cross-origin isolation") | "the page", "this page", the product's name |
| **waarm64** | the emulator as the machine's maker, by its name: what it does to and offers the guest, starting, stopping, devices, what it counts ("At every boot, waarm64 changes the guest's keyboard settings…", "as waarm64 counts it"). Lower case, even at a sentence's start. In the catalog it's always the reference `$t(common:product.name)`, never written out ([i18n.md](i18n.md) "The catalog") | "this emulator", "the page" |
| **the emulator** | the program as a component that can fail or that a file belongs to, where the name would read oddly ([The emulator stopped unexpectedly](ui:machine:runner.workerFailed), "the emulator's core") | |
| **this browser** | where things are stored and what asks for permission ("remains stored in this browser") | "the browser's storage" when "this browser" says it |
| **a browser limitation** | something the browser didn't allow or give this web app, when nothing is stored and no permission can change it ("or this web app ran into a browser limitation"): "this browser" is for storage and permissions, and a sentence about what failed reads better with this web app as its subject | "this browser didn't let this web app…" |
| **reopen this web app** | the user coming back to its tab or window ("when you reopen this web app") | "come back to this page" |
| **your computer** | the user's physical device: its memory, its files, a USB device plugged into it | "this computer", "the host" |
| **a computer**, **the computer running tailcat** | another physical device, by its role (a tailcat or helper end); "exit node" only where it's the tool's own term (`tailcat serve exit-node`, a tailnet's exit node setting) | "the exit node" as a general name, "the host" |
| **machine**, **virtual machine** | a virtual machine as the user keeps it: its settings and disks; "virtual machine" where it must be explicit | "VM" in copy, "computer" |
| **guest** | the operating system running in a machine | "the OS" |
| **connection** | a way onto a network kept in this browser (a tailnet, tailcat, this computer's helper, a room) and what goes with it: its settings, a room connection's key and so its name and address in the room. A machine has it attached; detached, it keeps all of that for the next machine | "this machine's key", "this machine's name in the room", "let members connect to this machine" where the connection holds it |
| **domain**, **subdomain** | a name registered in a room (`<name>.<tag>.p2p.internal`, which guests usually reach as `<name>` alone), held by a room connection's key, and a label under it (`git.<name>…`): a term people can look up, which can't be taken for a connection's, an adapter's or the room's own name ([Register a domain…](ui:network:NetNames.name)) | "name", "this machine's name", "label" |
| **member** | another room connection in the same room (whichever machine it's attached to) | "machine" for the other end |
| **image**, **base image** | a disk's normally unchanging contents: a file, a URL, a copy stored in this browser; a blank disk's base image is all zeros | |
| **overlay** | where a machine's writes to a disk go, over its base image; a disk can have several | "variant", "changes file" (that's an export) |
| **disk** | a base image and the overlay a machine uses, as the machine has them paired; a disk written in place has no overlay and no base image | |
| **changes** | what an overlay holds: the writes over the base image | |
| **start** | the user's action and the button: a boot, or a resume from suspend | |
| **boot** | the guest coming up from scratch (firmware, kernel); "at every boot" | "start" when only a boot does it |
| **power off** | stopping a machine at once, like pulling the plug; "forcibly power off" where it matters | "stop", "kill" |
| **shut down** | the guest stopping itself cleanly | |
| **suspend**, **resume** | keeping a machine's memory in this browser, and going on from it | |
| **snapshot** | a machine's whole state at a moment, kept or saved to a file | |

**Never ambiguous**: each layer has its own words, never used for another. The emulated hardware is the **machine**
(never "computer"), what runs in it the **guest**, the browser side **this browser** and **this web app**, the
physical device **your computer** (never "machine"). "Host" isn't used in the copy: here it could mean the browser
or the physical computer.

**Self-reference**: when neither "this web app" nor "waarm64" fits, the sentence is usually better without an
actor ("The ramdisk is formatted as swap at every boot"); when it isn't, ask.

## The elements

- **Buttons**: sentence case, a verb, short ("Create", [Show serial console](ui:common:BootCard.serial.show), "Detach"). An ellipsis when the button
  opens a further step that asks something ([Connect…](ui:network:NetAdapter.setup), [Add a disk…](ui:disks:Disks.add)), none when it acts at once.
- **Busy text** (while an action runs): the verb's -ing form and its object, no period ([Creating the overlay](ui:disks:Disks.busy.newOverlay)).
- **Titles and headings**: sentence case, no period.
- **Tooltips**: full sentences, a period. Say what the control does, then what it affects ([Take the disk off this
  machine. It remains stored in this browser.](ui:disks:Disks.detach.button.title)).
- **Confirmations**: the question first ("Delete the overlay Work?"), then what it will cause, with `will` ("This will
  delete the 12.0 MiB of changes made on top of the base image."). The OK button names the action ("Delete"), never
  "OK" for something destructive.
- **Errors**: a headline that says what failed, active and without a subject or period: [Couldn't load the snapshot](ui:snapshots:snapshot-restore.notSnapshot.title).
  Then the details, full sentences: what happened or why, then what the user can do. A message that is a cause
  (the details' line) is a full sentence too.
- **Menu paths**: the items' own words joined with ›, each item its own element: "<ui>Add a disk…</ui> › <ui>A disk
  already in this browser</ui>" (i18n.md "Markers").
- **Names someone gave** (a machine's, a disk's, an overlay's, a folder's…) are marked, never quoted: "Resize
  <name>{{name}}</name>", "Delete the overlay <name>{{name}}</name>?" (i18n.md "Markers"); the page draws them as
  names.
- **The page's elements named in a sentence** (a button, a menu's item, a tab, a pane) are marked with their words as
  the element says them: "use <ui>Edit connection…</ui> to paste it"; with their icon before them where they have
  one: "on its <ui-network>Network</ui-network> tab or in the toolbar's <ui-network>Network</ui-network> menu", "on the
  <ui-home>Home</ui-home> page". Only the element's own words are marked ("the toolbar's", "menu", "tab" stay
  outside). The note on the clipboard sharing names the toolbar's clipboard menu with its icon after the words (its own
  `<icon>` marker, written before these).
- **Setup screens and wizards**: steps first, then the field they lead to. A choice the user makes is followed by
  numbered steps that end at its input, and a short note after only for consequences and warnings ("Keep the address
  to yourself, as it lets anyone use the connection."). No long explainer after a field.
- **Lists in a sentence**: commas, with a serial comma ("qcow2, raw, or an installer or live ISO").
- **Numbers and units**: digits, a space before the unit (4 GiB, 160 MiB); sizes as the page formats them
  (`{{size, bytes}}`).

## Examples (the user's edits)

| Before | After |
|---|---|
| The boot menus, and a first boot's questions, are on the serial console. · Show it | No video output. The guest may be sending boot menus and setup instructions to the serial console. · Show serial console |
| Name of the new, empty overlay (the disk as the image has it): · Make it | With an empty overlay, the disk's contents will reflect its image. Enter a name for the new overlay: · Create |
| Delete the overlay {{name}}? What the machines wrote to the disk in it ({{size}}) is deleted for good. | Delete the overlay {{name}}? This will delete the {{size}} of changes made on top of the base image. |
| {{max}} disks: a machine takes no more. | A machine can't have more than {{max}} disks. |
| The guest's swap, turned on at every boot with nothing to do inside: the page formats the ramdisk as swap and tells systemd (254+: Debian 13, Arch; not Debian 12). It takes memory as the guest swaps and gives it back as the guest frees it. | Automatically configure the guest to use this ramdisk as swap. The guest must be running systemd version 254 or above. The memory usage of this ramdisk on the host will fluctuate as the guest uses the swap space. |
| The image is copied into this browser's storage: no picking again, and it can take an overlay's changes into itself or be written in place. … | The image is copied into this browser's storage. You will not be asked to select a file or authorize access to it again. You will be able to merge overlays into the image, and optionally enable writing in place instead of using overlays. … |
| Take the disk off this machine (it stays in this browser) | Take the disk off this machine. It remains stored in this browser. |
| What you copy on your computer reaches the guest when you come back to this page. | What you copy on your computer reaches the guest when you reopen this web app. |
| The guest's screen shows a graphical desktop, not its text console, so nothing was typed. | Nothing was typed, because the guest is showing a graphical desktop rather than a text console. |
| The guest's text console didn't take all of the text, so some of it wasn't typed. | Some of the text wasn't typed, as the guest's console didn't consume all of it. |
| There was no picture of the screen to copy, or this browser didn't let this web app put it on the clipboard. | The screen wasn't copied. There may have been no video output yet, or this web app ran into a browser limitation. |
| This browser gave this web app no text from the clipboard. | Nothing was typed, because this web app couldn't get text from the clipboard. |
| A switch in the toolbar pauses the sharing while the machine runs. | The clipboard menu [icon] in the toolbar can pause the sharing while the machine runs. |
| The clipboard menu [icon] in the toolbar can pause the sharing, and type what you copied into a text console. | You can pause the sharing, or type the clipboard into a text console, from the clipboard menu [icon] in the toolbar. |

## Open

To settle as the user reviews more: how the emulator names itself inside the guest (its units' descriptions say "the emulator's machine settings"); how terse labels in dense places (the status bar, the Machines list) may be; the
words for the network's kinds (tailnet, tailcat, local helper); whether long notes become collapsible help.
