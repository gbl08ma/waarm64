# The page's words: a style guide

How the words the user reads are written: the catalog's messages (`web/messages/en/`, [i18n.md](i18n.md)) and the
screens they sit in. Drawn from the user's own edits (2026-11-02: the boot card and the Disks tab, ~30 messages)
and the choices they made then; it grows as the user reviews more of the copy.

## The voice

- **Plain and conventional.** The words a user expects from other software: Create, Delete, Power off, Restore. No
  invented phrasing ("Make it"), no wordplay.
- **The effect first.** Say what happens or what something does before why or how: "No video output. The guest may
  be sending boot menus and setup instructions to the serial console."; "Automatically configure the guest to use
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
  prompts are imperatives ([Paste the address it prints, below:](ui:network:NetWizard.tailcat.exit.paste)).
- **Contractions are fine** (can't, isn't, doesn't), as in speech.
- **Parentheses sparingly**: for a unit, an abbreviation or a command (`fstrim`), not for a second thought; a second
  thought is a sentence.

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
| **this emulator** | the emulator as the machine's maker: what it offers the guest, starting, stopping, devices ("This emulator configures the guest's network at every boot") | "the page" |
| **this browser** | where things are stored and what asks for permission ("remains stored in this browser") | "the browser's storage" when "this browser" says it |
| **your computer** | the user's physical device: its memory, its files, a USB device plugged into it | "this computer", "the host" |
| **a computer**, **the computer running tailcat** | another physical device, by its role (a tailcat or helper end); "exit node" only where it's the tool's own term (`tailcat serve exit-node`, a tailnet's exit node setting) | "the exit node" as a general name, "the host" |
| **machine**, **virtual machine** | a virtual machine as the user keeps it: its settings and disks; "virtual machine" where it must be explicit | "VM" in copy, "computer" |
| **guest** | the operating system running in a machine | "the OS" |
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

**Self-reference**: when neither "this web app" nor "this emulator" fits, the sentence is usually better without an
actor ("The ramdisk is formatted as swap at every boot"); when it isn't, ask.

## The elements

- **Buttons**: sentence case, a verb, short ("Create", [Show serial console](ui:common:App.boot.serial.show), "Detach"). An ellipsis when the button
  opens a further step that asks something ([Connect…](ui:network:Network.setup), [Add a disk…](ui:disks:Disks.add)), none when it acts at once.
- **Busy text** (while an action runs): the verb's -ing form and its object, no period ([Creating the overlay](ui:disks:Disks.busy.newOverlay)).
- **Titles and headings**: sentence case, no period.
- **Tooltips**: full sentences, a period. Say what the control does, then what it affects ("Take the disk off this
  machine. It remains stored in this browser.").
- **Confirmations**: the question first ("Delete the overlay Work?"), then what it will cause, with `will` ("This will
  delete the 12.0 MiB of changes made on top of the base image."). The OK button names the action ("Delete"), never
  "OK" for something destructive.
- **Errors**: a headline that says what failed, active and without a subject or period: [Couldn't load the snapshot](ui:snapshots:main.notSnapshot.title).
  Then the details, full sentences: what happened or why, then what the user can do. A message that is a cause
  (the details' line) is a full sentence too.
- **Menu paths**: the items' own words joined with ›: "Add a disk… › A disk already in this browser".
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

## Open

To settle as the user reviews more: how terse labels in dense places (the status bar, the Machines list) may be; the
words for the network's kinds (tailnet, tailcat, local helper); whether long notes become collapsible help.
