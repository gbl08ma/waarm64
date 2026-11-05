# Clipboard sharing between the host and the guest (a plan; not scheduled)

**Status:** written 2026-11-05 from a brainstorm with the user, who settled its choices the same day (§7). Nothing
is built. The brief: share the clipboard both ways. On the guest side, use a no-disk-writes route like the network's
settings (a systemd credential). On the host side, manage the browser's permission prompts and detect when a browser
hands back placeholder data (empty strings, in the user's experience) instead of the clipboard. The guest side is an
**agent of our own**, which replaces [agent.md](agent.md)'s "stock agents first" for the clipboard (§3.4).

## 1. The shape

```
 host clipboard ── Clipboard API / paste event ── page (main thread) ── worker ── virtio-console port
                                                                                   "org.webpc.agent.0"
                                                                                        │
 guest: webpc-agent.service (root; loaded from fw_cfg into /run, started by a credential unit)
        └─ one child for each active graphical session (its uid): Wayland data-control, or X11 selections
        └─ text consoles: paste through TIOCSTI on the foreground VT
```

There are three pieces, and each can be tested on its own:

1. **A channel:** a virtio-console device with the multiport feature, one named port and the receive path.
   It is on a machine only while the setting is on.
2. **The guest's agent:** a small static aarch64 binary of ours (Rust, musl), frugal with the guest's memory
   and CPU (§3.3). The page delivers it with no install and no disk writes.
3. **The host side:** when the page reads and writes the browser's clipboard, how it avoids prompts, how it
   recognises empty or placeholder data, and the toolbar's switch that pauses it.

## 2. The channel: a virtio-console of its own

The page's machines have no virtio-console today. `web/devices.ts` `console_` is the tests' guests' (output
only: [devices.md](../devices.md) "console and rng"). **The clipboard gets a console device of its own, a new
transport kind (`agent`) that joins a machine only while its setting is on.** That is how the USB controller, the
mouse, the touchscreen, the clock and 9p join ([machines.md](../machines.md) §4.1 "Slots", "The shape"). Machines
without the setting keep their shape hash, their snapshots and their step counts. Turning the setting on or off is
a change of shape. Like those other switches, it asks first when it orphans snapshots.

- **`VIRTIO_CONSOLE_F_MULTIPORT`:** the control queues (c_ivq/c_ovq) and the port messages (DEVICE_READY,
  PORT_ADD, PORT_NAME, PORT_OPEN). Port 0 is a console port that nobody uses. Port 1 is named
  `org.webpc.agent.0`, and udev links it as `/dev/virtio-ports/org.webpc.agent.0` (`virtio_console`, in every
  distribution kernel). A device of its own leaves the tests' `console_` alone, so their steps don't move.
- **The receive path:** the backend fills held RX buffers from a queue of host bytes. The guest's PORT_OPEN
  tells the host that the agent is listening; the toolbar's state follows it (§5).
- **Framing:** length-prefixed messages, `u32 len, u8 type, payload`. Types: `HELLO` (version, capabilities),
  `OFFER` (a serial number and MIME types), `REQUEST` (serial number, type), `DATA` (serial number, type,
  bytes, in chunks of 64 KiB or less), `TYPE` (text to paste on the console), `PAUSE`/`RESUME` (the toolbar's
  switch). Offers are lazy: a side announces only what it has, and the other side asks for the bytes. A 20 MB
  screenshot then crosses the channel only if someone pastes it. A small text offer can carry its bytes inline
  (below 4 KiB) to save a round trip.
- **Echo suppression:** each side remembers the hash of the last thing it received. When the other side offers
  it back (for example, the host writes the guest's text, and the next focus reads the same text), nothing is
  sent.

**Alternatives considered:**

- **virtio-vsock:** every user could reach the host without a root process. However, it is a new device with a
  connection state machine and credit flow control. Also, someone still has to pick the active session, so a
  root process is needed anyway.
- **A 9p share:** files as a channel means polling, and not every machine has the device.
- **The PL011:** that is the user's serial console.

## 3. The guest: our agent, with no install

### 3.1 Delivery: a credential unit and an fw_cfg file

The route works like `web/app/guest-unit.ts` `guestUnit` (SMBIOS type 11 credentials, systemd 256+). The binary
itself is too big for SMBIOS strings, so it goes in as an **fw_cfg file of its own**, `opt/webpc/agent`.
`core/src/fw_cfg.rs` already serves named files from the host. The unit's script does this:

```sh
modprobe qemu_fw_cfg 2>/dev/null
f=/sys/firmware/qemu_fw_cfg/by_name/opt/webpc/agent/raw
[ -r "$f" ] || exit 0
install -d -m 0700 /run/webpc && cat "$f" >/run/webpc/agent && chmod 0500 /run/webpc/agent
exec /run/webpc/agent
```

`/run` is tmpfs, so a boot without the setting has no unit and no binary. The unit is a `Type=simple` service,
wanted by `multi-user.target`, unlike the network's oneshot. It also carries `Nice=10`, `MemoryMax=32M` (a cap
for a bug, not a budget: §3.3), `OOMScoreAdjust=500`, and the usual sandboxing that still allows what it needs
(`NoNewPrivileges=` doesn't apply, because it changes uid on purpose). Things to measure:

- **The read's cost.** The fw_cfg data register takes 8-byte reads, but Linux's `qemu_fw_cfg` reads one byte at
  a time (`ioread8_rep`), so there is one MMIO exit per byte. §3.3 aims for a binary of about 200 KiB, which
  makes this small; measure it anyway. If it matters, gzip the binary (`gzip -dc` is on every guest that has
  systemd 256).
- **Arch's kernel.** Debian loads `qemu_fw_cfg` (agent.md). Check that Arch's kernel loads it from the DT's
  `qemu,fw-cfg-mmio` too.
- **`noexec` on `/run`.** systemd mounts `/run` without `noexec`. If a guest does mount it `noexec`, fall back to
  `memfd_create` and `fexecve` in a tiny loader. That is unlikely to be needed.

Machines without firmware (Buildroot, direct kernel boot) have no fw_cfg and no systemd 256. The setting isn't
offered there.

### 3.2 What the agent does

- **One root process** owns the port. It follows the active session on seat0 through logind's state files
  (`/run/systemd/seats/seat0`: `ACTIVE=`, and `/run/systemd/sessions/<id>`: `UID=`, `TYPE=`, `DISPLAY=`), watched
  with inotify. That avoids a D-Bus client in the binary. If those files prove too unstable, fall back to a
  hand-written minimal D-Bus call over `/run/dbus/system_bus_socket` (one method, one signal).
- **For a graphical session**, it `fork`s a child (no `exec`: it shares the parent's pages, so it costs little
  memory) that drops to the session's uid and gid (`setgroups`, `setresgid`, `setresuid`) before it parses
  anything a client hands it. The child talks to the parent over a socketpair. It finds the session's display
  itself:
  - **Wayland:** `$XDG_RUNTIME_DIR/wayland-*` (`/run/user/<uid>`), watched with inotify, because the user starts
    sway from a tty long after the agent starts. It binds `ext_data_control_manager_v1` (wlroots 0.19 and later,
    KWin), falling back to `zwlr_data_control_manager_v1` (sway since long ago, KWin). These protocols let a
    client that has no focus own and read the clipboard, which is exactly what an agent needs. Optionally the
    PRIMARY selection too (`set_primary_selection`); off at first.
  - **X11:** for an X11 session, and for Xwayland under a compositor without data-control. XFixes
    `SelectionNotify` on CLIPBOARD, `ConvertSelection` to read it, and owning the selection to set it (with
    INCR for large transfers). The hard part is finding `DISPLAY` and the cookie (`XAUTHORITY` under the user's
    home or `$XDG_RUNTIME_DIR`, or Xwayland's `-auth` file). The child reads `/proc/<leader>/environ` of the
    session's processes, which it may do as the same uid.
  - **GNOME (Mutter) has no data-control.** Its routes are the X11 one (Mutter syncs Xwayland's selections with
    its own, but whether a client without focus can read them there is unmeasured), or the portal's Clipboard
    interface (a RemoteDesktop session, which asks the user to consent). GNOME isn't one of our guests. It gets
    a row in the docs' table and is measured if the user wants it.
- **For a text console**, there is no clipboard to read (fbcon has no selection without gpm). Pasting goes to
  the foreground VT through `TIOCSTI`. Root keeps that even where `dev.tty.legacy_tiocsti=0`, because the check
  passes with `CAP_SYS_ADMIN`. Unlike typing through virtio-input (backlog "Clipboard for the screen": paced,
  its queue drops past 1024 events, and the keyboard layout limits what can be typed), it is instant and takes
  any UTF-8 text. Copying from the console stays out of scope; the serial terminal already has both directions.
- **MIME types:** `text/plain;charset=utf-8` (and its aliases `UTF8_STRING`, `TEXT`, `STRING` on X11) first;
  then images (§4.4), then `text/html`. A size cap is enforced on both sides (16 MiB for text, 64 MiB for an
  image), against the offer's size, before any bytes cross.
- **Paused** (`PAUSE`, from the toolbar's switch): the agent stops answering and announcing. It drops its
  ownership of the guest's clipboard if the host's data was in it, so that a paste in the guest can't pull more
  from the host. It ignores the guest's changes until `RESUME`. Nothing is queued for later.

### 3.3 The binary, and what it costs the guest

The user's requirement: **as little RAM and CPU in the guest as possible**, reimplementing what dependencies
would bring if that is what it takes. So:

- **No idle cost.** One thread in each process, blocked in `ppoll` on its few descriptors: the port, the inotify
  descriptor and the children's socketpairs in the parent; the display's socket and the parent's socketpair in a
  child. No timers, no polling, no periodic wakeups. An idle guest sees no CPU time from the agent, and nothing
  wakes it up but a clipboard change, a session change or the host.
- **Streaming, not buffering.** Clipboard bytes go in 64 KiB chunks between the port and the Wayland or X11 pipe
  (`splice` where both ends allow it), so the agent never holds a whole clipboard. Host data a guest program
  pastes is requested from the host each time it is pasted. Only text under 64 KiB is cached, so that repeated
  pastes don't cross the channel.
- **Our own protocol code, no client libraries:**
  - **Wayland**'s wire format by hand. It is small: a header, integers, strings, arrays, and file descriptors over
    `SCM_RIGHTS`. We only need `wl_display`, `wl_registry`, `wl_seat`, and the data-control manager, device,
    source and offer: about twenty messages. `wayland-client` and its generated protocol code aren't needed.
  - **X11** the same way: connection setup with `MIT-MAGIC-COOKIE-1`, `InternAtom`, `CreateWindow`, XFixes'
    `QueryVersion` and `SelectSelectionInput`, `ConvertSelection`, `GetProperty`, `ChangeProperty`,
    `SetSelectionOwner`, `SendEvent`, and INCR. About fifteen requests; no `x11rb`.
- **The one dependency is `rustix`** (Apache-2.0/MIT; raw Linux syscalls, no libc wrapper), plus `std` on musl.
  This needs no async runtime, no allocator of our own, and no generated code. If even `std`'s share of the size
  matters (measured), `#![no_std]` with `rustix`'s runtime is the next step, but not the first.
- **Build:** `aarch64-unknown-linux-musl`, static, `opt-level="z"`, LTO, `codegen-units=1`, `panic=abort`,
  stripped. Built in rootless Podman through `images/` (`images/build.sh agent`), never on the host. The aim is
  about 200 KiB, compared with a wayland-client and x11rb build in the high hundreds of KiB.
- **Targets, measured in the Debian test guest and the Arch desktop** and kept in the plan's tests: idle CPU of 0
  ticks over a minute (`/proc/<pid>/stat`: utime and stime), no context switches while idle
  (`/proc/<pid>/status`: `voluntary_ctxt_switches`), and an idle RSS of about 1 MiB or less per process
  (`VmRSS`; the child shares the parent's text). A paste of 1 MiB of text costs a few milliseconds of guest CPU.
- **Shipped** with the page (a build output Vite copies), and fetched only when a machine has the setting on.
  Its row in `THIRD_PARTY.json` covers `rustix` (`about`).

### 3.4 Against the stock agents (the user's decision, 2026-11-05)

[agent.md](agent.md) (the user, 2026-10-01) starts from spice-vdagent and qemu-guest-agent, so that distro packages
work unmodified. For the clipboard, the user chose an agent of our own:

- **spice-vdagent doesn't cover our desktop guest.** Under sway, a Wayland compositor with no X11 session, it has
  no clipboard. It does X11, and GNOME on Wayland only in recent versions.
- **It must be installed.** The no-disk-writes route can't deliver a GPL distro binary linked against the guest's
  libraries; ours is static.
- **It needs a protocol** (VDAgent, with its own clipboard grab and request dance) whose host side we would write
  from the specification anyway.

So agent.md's step 3 (spice-vdagent's clipboard) gives way to this plan. spice-vdagent stays a possible later step:
a second named port (`com.redhat.spice.0`) on the same device, for guests that already have it (Xorg or GNOME
desktops), behind the same host side. Other agent jobs (time after a resume, a ready signal, sway's resize) can
join the same binary and port later. Each needs the user's OK.

## 4. The host: the browser's clipboard

Chromium is the target. Firefox and Safari behave differently and must at least degrade cleanly. The facts that
shape the design (MDN's Clipboard API page, "Security considerations"):

| | Chromium | Firefox, Safari |
|---|---|---|
| `writeText`/`write` | `clipboard-write` permission (granted to a focused page without a prompt) or transient activation; the document must have focus | transient activation |
| `readText`/`read` | `clipboard-read` permission: **a prompt** on the first read; afterwards silent while the document has focus | transient activation, then **a "Paste" button the user must click** (enabled after 1 s), except for content the same origin wrote |
| `paste` / `copy` events | the user's own paste or copy: `clipboardData` with no permission or prompt | the same |
| `clipboardchange` | origin trial in 140–142, intent to ship 2025-10; types only, needs sticky activation or the read permission | not shipped |

Everything in this section happens only while the machine has the setting on **and** the toolbar's switch (§5)
isn't paused.

### 4.1 Host to guest: three ways, from no prompt to full sync

The page **asks for Chromium's `clipboard-read` permission** (the user's choice, 2026-11-05: asking is fine,
even desirable), because only a page that may read the clipboard can have the guest's own menus paste the host's
copy. Firefox and Safari have no such permission, so they rely on ways 2 and 3.

1. **Sync on focus (Chromium, with the permission: the main way).** While `clipboard-read` is `granted`
   (`navigator.permissions.query`), each time the page gets focus back (`focus`, `visibilitychange`), it reads
   the clipboard and offers it to the guest if it changed. Where `clipboardchange` exists, the page reads only
   when it fires, not on every focus. By the time the user is back on the screen, the host's copy is the guest's
   clipboard. So every way of pasting in the guest gets it: a key, the guest's right-click menu, a middle click
   (once PRIMARY is shared), and a program's own Paste button.
   - **When it asks:** only in answer to the user's own click, so the prompt is never a surprise in the middle
     of a boot or on a focus. The page asks when the user turns the machine's setting on (the click on the
     switch), and, while the permission is still `prompt` (the prompt was dismissed, or the machine came from
     another browser), from the toolbar button. That button's state then says the page needs the permission,
     and its first menu item asks (§5). It never calls `read()` while the permission is `prompt` outside
     those clicks.
   - **Denied:** the toolbar button's state says so, and how to allow it in the site's settings. Sharing goes on
     with ways 2 and 3. The permission's `change` event updates the button the moment the user changes it.
2. **The paste chord (every browser, no permission).** When the user presses a paste chord on the screen
   (Ctrl+V, Ctrl+Shift+V, Shift+Insert; Cmd+V on a Mac, if the screen's keys pass Meta to the guest: check
   `web/input.ts`), `web/input.ts` holds the key and **doesn't call `preventDefault`**. The browser then fires
   `paste`, with `clipboardData` holding the host clipboard. This is the browser's own user-initiated paste, so
   there's no permission check and no Paste button. If the data differs from what the guest has, the page
   offers it and waits for the agent's acknowledgement (bounded, about 300 ms) before it sends the held key.
   Otherwise it sends the key at once. With way 1 working, the data hardly ever differs. Without way 1
   (Firefox, Safari, a denied permission), this is how a key paste in the guest gets the host's copy.
   - **Measured (the user's Chrome, 2026-11-05):** Chrome fires `paste`, with the text in `clipboardData`, at a
     focused `<canvas tabindex=0>` that isn't editable, as long as no handler calls `preventDefault` on the
     keydown. So the screen's canvas can take it, with no hidden text field. Firefox is still to check.
   - **What it can't do:** a paste from the guest's own menus gives no browser event. Without way 1, such a
     paste gets the guest's clipboard (the host's text from the last paste chord, or the guest's own last
     copy), unless the user sends the clipboard first with way 3.
3. **Items in the toolbar's clipboard menu** (§5): "Send the clipboard to the guest" (reads with the click's
   activation: Chromium's permission, or Firefox's Paste button) and "Type the clipboard" (to the console
   through the agent's `TYPE`).

### 4.2 Guest to host

When the guest's clipboard changes, the agent sends an `OFFER`. The page then:

- **If the document has focus:** it writes at once. For text it uses `writeText`. For other types it uses
  `write([new ClipboardItem({type: promise})])`, with the promise resolving to the bytes the page requests from
  the guest. Chromium waits for the promise at the write itself, so the bytes cross then, not when the user
  pastes (Chromium's delayed rendering is an experiment on Windows only). Safari needs the promise form to keep
  the click's activation across the wait (§4.4). In Chromium the write needs only focus. In
  Firefox and Safari it needs transient activation. The guest's copy follows the user's Ctrl+C within a round
  trip (well under the activation window of about 5 s), so it usually still has it.
- **Otherwise,** or if the write was refused (`NotAllowedError`): the offer is kept as pending, and the page
  writes it on the next focus (Chromium) or the next `keydown` or `pointerdown` on the page, which gives
  activation (Firefox, Safari). Only the newest pending offer is kept.
- **The host's newer copy wins.** A guest change made while the page had no focus doesn't overwrite what the
  user copied on the host since. On focus, the page reads the host clipboard first, where it may (way 1's
  permission). If that has changed since the page last wrote it, the pending offer is dropped. Without the
  permission, the page can't tell, so the pending offer is written only on a key or pointer event on the
  screen, not on focus alone.

### 4.3 Placeholders, empties and refusals

A read can succeed and still not be the clipboard. The user's experience is empty strings, so the first rule
covers it. Cases to recognise, and what the page does:

- **`readText()` gives `""`** when the clipboard holds no text (an image, files) and also when a platform or
  browser hides the content. Rule: **an empty read is never offered to the guest.** It means "nothing to sync",
  not "clear the guest's clipboard", and it doesn't update the hash that the next comparison uses. So a real
  copy made after a hidden read is still seen as new. `read()` with its `types` tells the two cases apart where
  it matters: there are types but no text (an image, which a later step may offer), or there are no types (hidden).
- **The OS hides or asks:** macOS 15.4 and later alerts the user, or lets them deny, when an app reads the
  pasteboard programmatically without a paste-related UI action ("Paste from Other Apps" in Privacy &
  Security). A focus read (way 1) is exactly that kind of read. What Chromium then returns (an error, `""`, or
  stale content) is **to measure on the Mac host** (`macmini.lan`, the user's Chrome; not automatable). Way 2,
  a real paste, isn't affected. If focus reads on a Mac come back empty while `read()`'s types say there is
  text, the page counts it. After a few in a row it stops focus reads for the run and says why in the
  toolbar button's menu, and the paste chord carries on.
- **Stale reads:** Chromium on a Linux Wayland host (and some remote-desktop hosts) can answer a read with an old
  clipboard when the window isn't focused at the OS level. The page reads only while `document.hasFocus()`, and
  dedupes by hash, so a stale read at worst repeats an old offer, which echo suppression drops.
- **Concealed content:** password managers mark copies as concealed (`org.nspasteboard.ConcealedType` on macOS,
  `ExcludeClipboardContentFromMonitorProcessing` on Windows, `x-kde-passwordManagerHint` on Linux). The browser
  may or may not expose them. The page can't tell, which is why the toolbar's switch exists: pause the sharing before
  copying a password on the host.
- **Sanitising:** Chromium re-encodes images as PNG and sanitises `text/html` on `read()`, so what reaches the
  guest isn't byte-identical to what was copied. That is fine for a clipboard. `unsanitized: ['text/html']`
  isn't needed.
- **Refusals** (`NotAllowedError`, `DataError`) are never shown as errors in the middle of work. The toolbar button
  shows the permission's state ("Allowed in this browser", "Blocked: allow it in the site's settings") from the
  permission's `change` event, the way USB and folders show "Allow…".

### 4.4 Images

Images are the same path as text with another type: lazy offers, streamed chunks, and the size cap. What differs:

- **One type on the host: `image/png`.** The Clipboard API reads and writes `image/png` in every browser that has
  it, and Chromium re-encodes any image it reads as PNG. Chromium's other image types are "web custom formats"
  (`web image/jpeg`), which other programs on the host don't read. So the page writes PNG, and reads PNG.
- **Guest to host:** the agent offers what the guest's program offers. Programs that copy images (Firefox,
  GIMP, grim and slurp, screenshot tools) offer `image/png` among their types, and the agent prefers it. If a
  program offers only another image type (`image/jpeg`, `image/bmp`, `image/webp`), the agent doesn't convert:
  that would cost the guest CPU and an image library. **The page converts:** `createImageBitmap` on the bytes,
  an `OffscreenCanvas`, and `convertToBlob({type: 'image/png'})`, in a worker. Text that comes with the image
  (an `<img>`'s URL, `text/html`) goes in the same `ClipboardItem`, so the host's program picks what it takes.
- **Host to guest:** way 1's `read()` gives a `Blob` of `image/png`. Way 2's `paste` event has it as a `File` in
  `clipboardData.items`, with no permission (measured in the user's Chrome, 2026-11-05: a copied image arrived at
  the focused canvas as one item, `file image/png`, 5561 B; Firefox is still to check). The page keeps the `Blob` and offers `image/png` to the guest. A guest program that asks
  for the bytes gets them streamed. A program that wants only another type gets nothing, as on a desktop
  where the copying program offered only PNG. The agent offers the type's usual aliases (`image/png` is the
  only name programs ask for).
- **Size:** a 4K screenshot as PNG is about 5–15 MB. The cap becomes **64 MiB** for images (16 MiB for text),
  checked against the offer's size before any bytes cross. The page holds at most one image `Blob` from each
  side, and the agent holds none (it streams).
- **Echo:** Chromium re-encodes what the page writes, so reading the host clipboard back gives other bytes, and
  a hash of the bytes would see "new" content and send the guest's own image back to it. So after it writes an
  image, the page reads the clipboard back once (way 1's permission; with focus, at once) and remembers *that*
  hash as its own. Where `clipboardchange` exists, an unchanged clipboard isn't read at all. Without the
  permission, nothing is read on focus, so there's no echo to suppress.
- **Firefox and Safari:** writing `image/png` needs activation, as text does. The guest's copy after a key press
  usually arrives within the activation window, as in §4.2. Safari needs the promise form of `ClipboardItem` for
  that.
- **The screen's own picture** (a "copy the screen" item in the toolbar's clipboard menu, from the display's
  canvas) needs no agent. Worth a line when the menu is built.

## 5. The page

- **The machine's setting** (the Machines page, next to the other devices' switches: `MachineRecord.clipboard`,
  **off by default**, in the shape when on, §2). A draft of its words, for the catalog ([copy.md](../copy.md)),
  to be settled when it is built:
  - Label: **Share the clipboard with the guest**
  - Note: "Copy text or an image on your computer and paste it in the guest, and the other way around. At every boot, this emulator
    starts a small program of its own in the guest, which passes the clipboard between the guest's desktop and
    this web app. In a Wayland session, the desktop must support the data-control protocol, as sway and KDE
    Plasma do. The guest must be running systemd version 256 or above. Nothing is written to the guest's disk,
    so the program is gone when the guest shuts down. This browser may ask for permission to see the clipboard,
    so that the guest can paste what you copy on your computer from its own menus too. A switch in the toolbar
    pauses the sharing while the machine runs."

  The X11 sentence joins when X11 is built (§6 step 5), and so does a "text console" sentence when `TYPE` is
  offered.
- **The toolbar's clipboard button:** next to the USB, network and folder buttons, **only while the running
  machine has the setting on**. It is a reminder that sharing is on, and a switch to pause it:
  - **States:** sharing (pressed); paused (not pressed, with a crossed-out icon); waiting for the guest's
    program (before `HELLO`, or since PORT_OPEN closed: the guest has no systemd 256, isn't booted yet, or the
    program stopped). The tooltip says which state it is in, in the catalog's words.
  - **Pause** stops everything in §4 at once, in both directions. Nothing is read, nothing is written, the paste
    chord goes to the guest as a plain key, the pending offer is dropped, and the agent gets `PAUSE` (§3.2).
    **Resume** sends nothing on its own: the next copy or paste does. A pause lasts for the run: the next start
    shares again, because the setting is what's remembered, and a forgotten pause would look like a bug.
  - **The permission:** in a browser with `clipboard-read`, while the permission is `prompt` or `denied`, the
    button has a mark and says so in its tooltip: sharing still works through the paste chord, but the guest's
    own menus don't get the host's copy. With `prompt`, the menu's first item is "Allow reading the
    clipboard…", whose click asks. With `denied`, the menu says how to allow it in the site's settings.
  - It is a menu, like USB's, with the permission's item when there is one, the switch, then "Send the
    clipboard to the guest" and "Type the clipboard" (§4.1, 3).
- **No preference of its own:** whether the page may read the clipboard is the browser's permission, kept per
  browser by the browser. The machine's setting asks for it when it is turned on (§4.1, 1), and the toolbar
  button asks while it is missing.
- **Snapshots:** the agent lives in guest memory, so a restore brings it back. The host side keeps no state beyond
  the last hashes. The port's open state comes back with the backend's `save()`/`restore()`. The pause doesn't go
  into a snapshot.
- **Several tabs:** each tab runs its own machine. The host clipboard is shared between them, and only the
  focused tab reads or writes it, so nothing more is needed.

## 6. Order, when it is scheduled

Each step is one loop with its own tests at the cheapest layer:

1. **The channel:** the `agent` transport (a multiport virtio-console with the named port), RX, the shape's
   `clipboard: true`, and the framing in a shared TypeScript module. Unit tests on hand-built rings, and a
   Buildroot echo through `/dev/virtio-ports/org.webpc.agent.0` in every runner. No step counts move: the
   device is only on machines that ask for it.
2. **The agent, console only:** the binary's build in Podman, delivery through fw_cfg and the credential unit,
   `HELLO`, `TYPE` through TIOCSTI, `PAUSE`. The Debian page test types a string through the menu item and reads
   it back from the VT. This measures the binary's size and the fw_cfg read time, and it checks §3.3's idle
   targets.
3. **Wayland:** our data-control client in the session's child, and logind tracking. The test image gains a
   headless sway (`WLR_BACKENDS=headless`) and `wl-clipboard`, test-only. The tests: `wl-copy` in the guest
   gives the host clipboard (Playwright with `clipboard-read`/`clipboard-write` granted), the host clipboard
   plus the paste chord gives `wl-paste` in the guest, the switch's pause stops both, and §3.3's targets hold
   while sway runs. On the Arch desktop, by hand: between foot and Firefox in the guest and the host.
4. **The host's three ways, the permission's asking, the toolbar button and the placeholder rules,** with the
   measurements from §4.1 and §4.3 (the canvas's `paste` event, Firefox in the dev VM, the Mac by the user).
5. **Images** (§4.4: the page's conversion to PNG, the read-back for echoes, a screenshot each way in the
   Wayland test), then **X11** (Xwayland and Xorg sessions, INCR for large images), then `text/html`.
6. **Optional:** spice-vdagent's port, GNOME through the portal, a ready signal and time after a resume from the
   same agent (agent.md).

When it ends: [docs/devices.md](../devices.md) (the device), [frontend.md](../frontend.md) "What the page sets in
the guest" and "The toolbar", [machines.md](../machines.md) (the shape), a new `docs/clipboard.md`,
[testing.md](../testing.md), and agent.md.

## 7. The user's choices (2026-11-05)

1. **Our own agent** for the clipboard, not spice-vdagent (§3.4).
2. **Rust dependencies are allowed, but the agent must cost the guest as little RAM and CPU as possible**, with
   dependencies' parts reimplemented where that helps. That led to hand-written Wayland and X11 and `rustix` only
   (§3.3).
3. **Off by default per machine.** On a machine that has it, a **toolbar button** pauses the sharing for the
   run, and it doubles as the reminder that sharing is on (§5).
4. **The placeholder data seen** is empty strings, which §4.3's first rule covers.
5. **The device only on machines with the setting**, as the clock, the USB controller and the touchscreen are
   (§2).
6. **The setting's note** says what the other guest settings say about systemd, and also that a small program
   of ours runs in the guest (§5's draft).
7. **Asking for the clipboard-read permission is fine, even desirable**, so that a paste from the guest's own
   menus gets the host's copy. Sync on focus is the main way in Chromium, asked for when the setting is turned
   on or from the toolbar button, never without a click. The paste chord serves the other browsers, or a denied
   permission (§4.1).
