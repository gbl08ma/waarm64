# Clipboard sharing between the host and the guest (a plan; not scheduled)

**Status:** written 2026-11-05 from a brainstorm with the user. Nothing here is built and nothing is decided. The
user's brief: share the clipboard both ways. On the guest side, use a no-disk-writes route like the network's settings
(a systemd credential). On the host side, manage the browser's permission prompts and detect when a browser hands
back placeholder data instead of the clipboard. This plan revises one decision in [agent.md](agent.md), which starts
from the stock agents (spice-vdagent): see "Against the stock agents" below. The user must agree to that first. The
questions for the user are at the end.

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

1. **A channel:** virtio-console's multiport feature, with a named port and the receive path. This is the
   same first slice as [agent.md](agent.md) step 1 and serves every later agent.
2. **The guest's agent:** a small static aarch64 binary of ours (Rust, musl). The page delivers it with no
   install and no disk writes.
3. **The host side:** when the page reads and writes the browser's clipboard, how it avoids prompts, and how
   it recognises empty or placeholder data.

## 2. The channel: virtio-console multiport

Today, `web/devices.ts` `console_` sends TX to the host and holds every receive buffer for good
([devices.md](../devices.md) "console and rng"). The clipboard needs the following:

- **`VIRTIO_CONSOLE_F_MULTIPORT`:** the control queues (c_ivq/c_ovq) and the port messages (DEVICE_READY,
  PORT_ADD, PORT_NAME, PORT_OPEN). Port 0 stays the console as it is now. Port 1 is named
  `org.webpc.agent.0`. udev links it as `/dev/virtio-ports/org.webpc.agent.0` (`virtio_console`, in every
  distribution kernel).
- **The receive path:** the backend fills held RX buffers from a queue of host bytes, and the guest's
  PORT_OPEN tells the host that an agent is listening. That is how the page knows to offer clipboard
  sharing, rather than assuming it.
- **Framing:** length-prefixed messages, `u32 len, u8 type, payload`. Types: `HELLO` (version, capabilities),
  `OFFER` (a serial number and MIME types), `REQUEST` (serial number, type), `DATA` (serial number, type,
  bytes, in chunks of 64 KiB or less), `TYPE` (text to paste on the console). Offers are lazy: a side
  announces only what it has, and the other side asks for the bytes. A 20 MB screenshot then crosses the
  channel only if someone pastes it. A small text offer can carry its bytes inline (below 4 KiB) to save a
  round trip.
- **Echo suppression:** each side remembers the hash of the last thing it received. When the other side
  offers it back (for example, the host writes the guest's text, and the next focus reads the same text),
  nothing is sent.
- **Guest-visible:** this is a new feature bit in every machine's console. Step counts move once, in the
  channel's commit, and this needs the user's OK. A machine without the setting could keep the feature off,
  so its shape stays the same. To decide in the channel's loop: the feature is cheap, but adding it to
  every machine changes their snapshots' shape.

**Alternatives considered:**

- **virtio-vsock:** every user could reach the host without a root process. However, it is a new device
  with a connection state machine and credit flow control. Also, someone still has to pick the active
  session, so a root process is needed anyway.
- **A 9p share:** files as a channel means polling, and not every machine has the device.
- **The PL011:** that is the user's serial console.

## 3. The guest: our agent, with no install

### 3.1 Delivery: a credential unit and an fw_cfg file

The route works like `web/app/guest-unit.ts` `guestUnit` (SMBIOS type 11 credentials, systemd 256+). The
binary itself is too big for SMBIOS strings (hundreds of KiB as base64 in one structure table), so it goes
in as an **fw_cfg file of its own**, `opt/webpc/agent`. `core/src/fw_cfg.rs` already serves named files
from the host. The unit's script does this:

```sh
modprobe qemu_fw_cfg 2>/dev/null
f=/sys/firmware/qemu_fw_cfg/by_name/opt/webpc/agent/raw
[ -r "$f" ] || exit 0
install -d -m 0700 /run/webpc && cat "$f" >/run/webpc/agent && chmod 0500 /run/webpc/agent
exec /run/webpc/agent
```

`/run` is tmpfs, so a boot without the setting has no unit and no binary. It is a `Type=simple` service,
wanted by `multi-user.target`, unlike the network's oneshot. Things to measure:

- **The read's cost.** The fw_cfg data register takes 8-byte reads, but Linux's `qemu_fw_cfg` reads one
  byte at a time (`ioread8_rep`), so there is one MMIO exit per byte. Measure the time for 1 MiB under the
  JIT. If it's too slow, gzip the binary (`gzip -dc` is on every guest that has systemd 256).
- **Arch's kernel.** Debian loads `qemu_fw_cfg` (agent.md). Check that Arch's kernel loads it from the DT's
  `qemu,fw-cfg-mmio` too.
- **`noexec` on `/run`.** systemd mounts `/run` without `noexec`. If a guest does mount it `noexec`, fall
  back to `memfd_create` and `fexecve` in a tiny loader. That is unlikely to be needed.

Machines without firmware (Buildroot, direct kernel boot) have no fw_cfg and no systemd 256. They get no
agent, and the page says so ("needs systemd 256 and the UEFI firmware").

### 3.2 What the agent does

- **One root process** owns the port. It follows the active session on seat0 through logind's state files
  (`/run/systemd/seats/seat0`: `ACTIVE=`, and `/run/systemd/sessions/<id>`: `UID=`, `TYPE=`, `DISPLAY=`),
  watched with inotify. That avoids a D-Bus client in the binary. If those files prove too unstable, fall
  back to sd-bus over `/run/dbus/system_bus_socket`, which takes a small D-Bus crate.
- **For a graphical session**, it forks a child that drops to the session's uid and gid (`setresgid`,
  `setgroups`, `setresuid`) before parsing anything a client hands it. The child talks to the parent over
  a socketpair. It finds the session's display itself:
  - **Wayland:** `$XDG_RUNTIME_DIR/wayland-*` (`/run/user/<uid>`), watched with inotify, because the user
    starts sway from a tty long after the agent starts. It binds `ext_data_control_manager_v1` (wlroots 0.19
    and later, KWin), falling back to `zwlr_data_control_manager_v1` (sway since long ago, KWin). These
    protocols let a client that has no focus own and read the clipboard, which is exactly what an agent
    needs. Optionally the PRIMARY selection too (`set_primary_selection`); off at first.
  - **X11:** for an X11 session, and for Xwayland under a compositor without data-control. XFixes
    `SelectionNotify` on CLIPBOARD, `ConvertSelection` to read it, and owning the selection to set it. The
    hard part is finding `DISPLAY` and the cookie (`XAUTHORITY` under the user's home or
    `$XDG_RUNTIME_DIR`, or Xwayland's `-auth` file). The child reads `/proc/<leader>/environ` of the
    session's processes, which it may do as the same uid.
  - **GNOME (Mutter) has no data-control.** Its routes are the X11 one (Mutter syncs Xwayland's
    selections with its own, but whether a client without focus can read them there is unmeasured), or the
    portal's Clipboard interface (a RemoteDesktop session, which asks the user to consent). GNOME isn't one
    of our guests. It gets a row in the docs' table and is measured if the user wants it.
- **For a text console**, there is no clipboard to read (fbcon has no selection without gpm). Pasting goes
  to the foreground VT through `TIOCSTI`. Root keeps that even where `dev.tty.legacy_tiocsti=0`, because
  the check passes with `CAP_SYS_ADMIN`. Unlike typing through virtio-input (backlog "Clipboard for the
  screen": paced, its queue drops past 1024 events, and the keyboard layout limits what can be typed), it
  is instant and takes any UTF-8 text. Copying from the console stays out of scope; the serial terminal
  already has both directions.
- **MIME types:** `text/plain;charset=utf-8` (and its aliases `UTF8_STRING`, `TEXT`, `STRING` on X11)
  first; `image/png` and `text/html` in a later step. A size cap is enforced on both sides (16 MiB to start).

### 3.3 The binary

Rust, `aarch64-unknown-linux-musl`, static, `opt-level="z"`, `panic=abort`, stripped. It is built in
rootless Podman through `images/` (`images/build.sh agent`), never on the host. **New dependencies, each
needing the user's OK:**

- `wayland-client` with `wayland-backend`'s pure-Rust implementation (no libwayland), plus
  `wayland-protocols` / `wayland-protocols-wlr` (MIT).
- `x11rb` (MIT/Apache-2.0, pure Rust).
- `rustix` or `nix` for the syscalls.

The goal is under 1 MiB. Its size, and the fw_cfg read time, decide whether it is gzipped. The binary ships
with the page (`web/public/` or a build output Vite copies) and is fetched only when a machine has the
setting on. It gets a row in `THIRD_PARTY.json` for each crate that ships (`about`).

### 3.4 Against the stock agents

[agent.md](agent.md) (the user, 2026-10-01) starts from spice-vdagent and qemu-guest-agent, so that distro
packages work unmodified. For the clipboard, an agent of our own first is better:

- **spice-vdagent doesn't cover our desktop guest.** Under sway, a Wayland compositor with no X11 session,
  it has no clipboard. It does X11, and GNOME on Wayland only in recent versions.
- **It must be installed.** The no-disk-writes route the user asks for can't deliver a GPL distro binary
  linked against the guest's libraries; ours is static.
- **It needs a protocol** (VDAgent, with its own clipboard grab and request dance) whose host side we would
  write from the specification anyway.

**spice-vdagent stays a possible later step:** a second named port (`com.redhat.spice.0`) for guests that
already have it (Xorg or GNOME desktops), behind the same host side. If this plan is taken, agent.md's
order changes: step 3 (spice-vdagent's clipboard) gives way to this plan, and its "own agent only for the
gaps" becomes the clipboard's agent. Other agent jobs (time after a resume, a ready signal, sway's
resize) can then join the same binary and port.

## 4. The host: the browser's clipboard

Chromium is the target. Firefox and Safari behave differently and must at least degrade cleanly. The facts
that shape the design (MDN's Clipboard API page, "Security considerations"):

| | Chromium | Firefox, Safari |
|---|---|---|
| `writeText`/`write` | `clipboard-write` permission (granted to a focused page without a prompt) or transient activation; the document must have focus | transient activation |
| `readText`/`read` | `clipboard-read` permission: **a prompt** on the first read; afterwards silent while the document has focus | transient activation, then **a "Paste" button the user must click** (enabled after 1 s), except for content the same origin wrote |
| `paste` / `copy` events | the user's own paste or copy: `clipboardData` with no permission or prompt | the same |
| `clipboardchange` | origin trial in 140–142, intent to ship 2025-10; types only, needs sticky activation or the read permission | not shipped |

### 4.1 Host to guest: three ways, from no prompt to full sync

1. **The paste chord (the default; no prompt, every browser).** When the user presses a paste chord on the
   screen (Ctrl+V, Ctrl+Shift+V, Shift+Insert; Cmd+V on a Mac, if the
   screen's keys pass Meta to the guest: check `web/input.ts`), `web/input.ts` holds the key and **doesn't call `preventDefault`**. The browser
   then fires `paste`, with `clipboardData` holding the host clipboard: the browser's own user-initiated
   paste, so there's no permission check and no Paste button. The page offers the data to the guest, waits
   for the agent's acknowledgement (bounded, about 300 ms), then sends the held key. The guest's program
   pastes what the user just copied on the host. Privacy is good: the host's clipboard reaches the guest
   only when the user pastes in it.
   - **To measure first:** whether Chromium (and Firefox) fire `paste` at a focused `<canvas tabindex=0>`
     that isn't editable. If they don't, the screen's key sink becomes a hidden, focused `contenteditable`
     or `<textarea>` over the canvas, as web VNC clients do (it would also carry composition input later).
   - **What is lost:** a paste from the guest's own menus (right-click, Paste) sees the guest's clipboard,
     not the host's last copy. That is what option 2 fixes.
2. **Sync on focus (opt-in, Chromium, one prompt).** While `clipboard-read` is `granted`
   (`navigator.permissions.query`), each time the page gets focus back (`focus`, `visibilitychange`), it
   reads the clipboard and offers it to the guest if it changed. Where `clipboardchange` exists, the page
   reads only when it fires, not on every focus. **The page never calls `read()` while the permission is
   `prompt`**, except from the user's own click on the setting that turns it on. That way the prompt
   appears once, as the answer to that click, and never in the middle of a boot or on a focus. On
   `denied`, it says so on the setting and falls back to option 1.
3. **Menu items** under the machine's menu (in its words, from the catalog): "Paste to the guest's
   clipboard" (reads with the click's activation: Chromium's permission, or Firefox's Paste button) and
   "Type the clipboard" (to the console through the agent's `TYPE`, or through virtio-input without an
   agent, for the firmware's menus and guests without the agent).

### 4.2 Guest to host

When the guest's clipboard changes, the agent sends an `OFFER`. The page then:

- **If the document has focus:** it writes at once. For text it uses `writeText`. For other types it uses
  `write([new ClipboardItem({type: promise})])`, so the bytes are fetched from the guest only when the
  browser asks: Chromium and Safari accept promises in `ClipboardItem`. In Chromium the write needs only
  focus. In Firefox and Safari it needs transient activation. The guest's copy follows the user's Ctrl+C
  within a round trip (well under the activation window of about 5 s), so it usually still has it.
- **Otherwise,** or if the write was refused (`NotAllowedError`): the offer is kept as pending, and the page
  writes it on the next focus (Chromium) or the next `keydown` or `pointerdown` on the page, which gives
  activation (Firefox, Safari). Only the newest pending offer is kept.
- **Never in the background:** a guest that changes its clipboard while the page has no focus doesn't
  overwrite whatever the user copied since; the page writes only when the user returns. One open question
  is whether a guest change made while the user is away should overwrite a host copy made after it. The
  plan says no: on focus, the page compares with what it last read, and the host's newer content wins.

### 4.3 Placeholders, empties and refusals

A read can succeed and still not be the clipboard. Cases to recognise, and what the page does:

- **`readText()` gives `""`** when the clipboard holds no text (an image, files) and also when a platform
  hides the content. Rule: **an empty or whitespace-only read is never offered to the guest.** It means
  "nothing to sync", not "clear the guest's clipboard". `read()` with its `types` tells the two cases apart
  where it matters.
- **The OS hides or asks:** macOS 15.4 and later alerts the user, or lets them deny, when an app reads the
  pasteboard programmatically without a paste-related UI action ("Paste from Other Apps" in Privacy &
  Security). A focus read (option 2) is exactly that kind of read. What Chromium then returns (an error,
  `""`, or stale content) is **to measure on the Mac host** (`macmini.lan`, the user's Chrome; not
  automatable). Option 1, a real paste, isn't affected. If focus reads on a Mac look like placeholders, the
  page turns option 2 off there and says why.
- **Stale reads:** Chromium on a Linux Wayland host (and some remote-desktop hosts) can answer a read with
  an old clipboard when the window isn't focused at the OS level. The page reads only while
  `document.hasFocus()`, and dedupes by hash, so a stale read at worst repeats an old offer, which echo
  suppression drops.
- **Concealed content:** password managers mark copies as concealed (`org.nspasteboard.ConcealedType` on
  macOS, `ExcludeClipboardContentFromMonitorProcessing` on Windows, `x-kde-passwordManagerHint` on Linux).
  The browser may or may not expose them. The page can't tell, which is one more reason option 1 (sharing
  only on paste) is the default.
- **Sanitising:** Chromium re-encodes images as PNG and sanitises `text/html` on `read()`, so what reaches
  the guest isn't byte-identical to what was copied. That is fine for a clipboard. `unsanitized: ['text/html']`
  isn't needed.
- **Refusals** (`NotAllowedError`, `DataError`) are never shown as errors in the middle of work. The setting
  shows the state ("Allowed in this browser", "Blocked: allow it in the site's settings"), from the
  permission's `change` event, the way USB and folders show "Allow…".

The user has seen placeholder data in practice. **Which browser and platform it was** decides which of
these cases matter most (question 4 below).

## 5. The page

- **A machine setting** (Settings or its own small section): **Share the clipboard with the guest**, off by
  default (privacy: a guest is software the user may not trust). When on, the machine boots with the
  agent's credentials and fw_cfg file, and the console's second port. Under it is a per-browser preference
  (Preferences, not the machine, since permissions belong to the browser): **Send the clipboard to the
  guest when you return to this page**, which triggers Chromium's prompt with the click (option 2). Words
  come from the catalog ([copy.md](../copy.md)); for example the requirement "systemd version 256 or above",
  without naming distributions.
- **Status:** the toolbar shows that clipboard sharing is on once the agent's `HELLO` arrives (and "waiting
  for the guest" until then). It shows nothing while the setting is off.
- **Snapshots:** the agent lives in guest memory, so a restore brings it back. The host side keeps no state
  beyond the last hashes. After a restore, the port's PORT_OPEN state comes back with the backend's
  `save()`/`restore()`.
- **Several tabs:** each tab runs its own machine. The host clipboard is shared between them, and only the
  focused tab reads or writes it, so nothing more is needed.

## 6. Order, when it is scheduled

Each step is one loop with its own tests at the cheapest layer:

1. **The channel:** multiport, named ports, RX, with the framing in a shared TypeScript module. Unit tests on
   hand-built rings, and a Buildroot echo through `/dev/vport0p1` in every runner. Step counts move once,
   with the user's OK.
2. **The agent, console only:** the binary's build in Podman, delivery through fw_cfg and the credential
   unit, `HELLO`, `TYPE` through TIOCSTI. The Debian page test types a string through the menu item and
   reads it back from the VT. This measures the fw_cfg read time and the binary's size.
3. **Wayland:** `ext`/`wlr` data-control in the session's child, and logind tracking. The test image gains
   a headless sway (`WLR_BACKENDS=headless`) and `wl-clipboard`, test-only. The tests: `wl-copy` in the
   guest gives the host clipboard (Playwright with `clipboard-read`/`clipboard-write` granted), and the host
   clipboard plus the paste chord gives `wl-paste` in the guest. On the Arch desktop: by hand, between foot
   and Firefox in the guest and the host.
4. **The host's three ways and the placeholder rules,** with the measurements from §4.1 and §4.3 (the
   canvas's `paste` event, Firefox in the dev VM, the Mac by the user).
5. **X11** (Xwayland and Xorg sessions), then `image/png` and `text/html`.
6. **Optional:** spice-vdagent's port, GNOME through the portal, a ready signal and time after a resume
   from the same agent (agent.md).

When it ends: [docs/devices.md](../devices.md) (the console), [frontend.md](../frontend.md) "What the page
sets in the guest", a new `docs/clipboard.md`, [testing.md](../testing.md), and agent.md updated.

## 7. Questions for the user

1. **Our own agent instead of spice-vdagent** for the clipboard (§3.4). This changes agent.md's 2026-10-01
   decision.
2. **Dependencies:** `wayland-client` (pure-Rust backend), the protocols crates, `x11rb`, and `rustix` for
   the agent (§3.3).
3. **The defaults:** sharing off per machine; host to guest only on a paste chord unless the browser
   preference is on. Or should "on" mean full sync in both directions?
4. **The placeholder data you've seen:** which browser, which OS (host and, if remote, the desktop it ran
   in), and what the page got (`""`, an old value, a fixed string)?
5. **The multiport console:** on every machine (one step-count move and the same shape everywhere), or only
   on machines with the setting?
