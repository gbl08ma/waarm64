# Clipboard sharing

A machine with **[Share the clipboard with the guest](ui:machines:DeviceSwitches.clipboard)** shares the clipboard both
ways between the user's computer and the guest: text, images and HTML, between the browser's Clipboard API and the
guest's Wayland or X11 desktop, and text typed at a text console. The guest's side is the guest agent, a small program
of ours that the page starts at every boot with nothing written to the guest's disk (it also sets the guest's clock:
frontend.md "The guest's clock"). This page is the topic's overview. The details are
in [devices.md](devices.md) "vsock" (the channel), devices.md "The guest's agent" (the agent and its frames) and
[frontend.md](frontend.md) "The toolbar", Clipboard (the page's rules). The design and the user's choices are in
[plans/clipboard.md](plans/clipboard.md) (§7).

## The shape

```
 host clipboard ── Clipboard API / paste event ── page (main thread) ── worker ── virtio-vsock
                                                                                   host CID 2, port 8574
                                                                                        │
 guest: waarm64-agent.service (root; from fw_cfg into a tmpfs of its own, started by a credential unit)
        └─ a session child for the active session on seat0 (its uid): Wayland data-control, else X11's CLIPBOARD
        └─ text consoles: TYPE through TIOCSTI on the foreground VT
```

| Piece | Where | |
|---|---|---|
| The channel | `web/vsock-device.ts` (the device), `web/app/agent-link.ts` (`AgentLink`), `web/app/areas/agent-actions.ts` (a run's link), `web/agent-frame.ts` (the frames) | the agent's stream connection on the vsock every `firmware` machine has (so no setting changes a machine's shape) |
| The page's side | `web/app/clipboard.ts` (`ClipboardShare`), `web/app/ClipboardMenu.svelte`, `web/input.ts` (the held paste chord), `web/app/png-worker.ts` (conversions to PNG) | the browser's clipboard, the permission, the rules below |
| The agent | `agent/` (Rust, its own crate and stable toolchain, `rustix` its one dependency), `images/build.sh agent` | a static aarch64 musl binary: the root loop (`main.rs`, `logind.rs`, `console.rs`), the session child (`session.rs`), Wayland (`wire.rs`), X11 (`x11.rs`), the frames (`frame.rs`, the twin of `web/agent-frame.ts`) |
| Its delivery | `web/app/guest-agent.ts` | the binary as the fw_cfg files `opt/waarm64/agent.000`, `.001`, … (the build's zopfli gzip in pieces of 4 KiB; the page gzips the ELF itself only where a server decoded it), the unit as SMBIOS credentials (systemd 256+) |

The frames are length-prefixed (`u32` length, `u8` type, a payload of at most 64 KiB). Offers are lazy: a side says
what types it has, and the other side REQUESTs the bytes, which come as DATA in 64 KiB chunks under a credit (4
frames, then one for each MORE), so neither side holds more than a few chunks of a transfer. Text under 4 KiB goes
inline in its OFFER. The table of frames (HELLO, SESSION, OFFER, REQUEST, DATA, ACK, MORE, TYPE, TYPED, PAUSE,
RESUME, TIME) is in devices.md "The guest's agent".

## The setting and the toolbar

- **The setting** is per machine, off by default, on the Machines page's Settings tab (`MachineRecord.clipboard`;
  a transient machine has it only from `?clipboard=1`, which, like `?clipboard=0`, is over a stored machine's too),
  under [Run the guest agent](ui:machines:DeviceSwitches.agent) (on by default, `MachineRecord.agent`, `?agent=`),
  which it needs: off with it. Neither is in the machine's shape (the agent talks over the vsock every firmware
  machine has, and the page's HELLO says whether the clipboard is shared), so neither orphans snapshots; both apply
  from the next boot (the page's HELLO at each connection says the clipboard's). Ticking it is the click that asks for
  Chromium's `clipboard-read` permission. Its note says what the guest needs (systemd 256+, a Wayland desktop
  with data-control or an X11 session) and that the toolbar's menu pauses it.
- **The toolbar's clipboard button** is shown while the running machine has the setting on. Its states are
  *sharing*, *paused* (for the run: the next start shares again) and *waiting* (before the agent's HELLO, or after
  its connection ended). It has a mark while the read permission is `prompt` or `denied`, or after the focus reads have
  stopped. Its menu has [Allow seeing the clipboard…](ui:clipboard:ClipboardMenu.allow) (while `prompt`), the
  switch [Share the clipboard](ui:clipboard:ClipboardMenu.share),
  [Send the clipboard to the guest](ui:clipboard:ClipboardMenu.send),
  [Type the clipboard](ui:clipboard:ClipboardMenu.type), [Copy the screen](ui:clipboard:ClipboardMenu.screen) and
  [Copy the console's text](ui:clipboard:ClipboardMenu.console).
  The menu stays open while Send, Type or a copy runs: it closes when the action succeeds (for Type, when
  the agent's TYPED says it was typed whole), and a failure keeps it open with its note, where the click was.
  frontend.md "The toolbar" has each item's behavior.

## The host's ways

1. **Sync on focus** (Chromium with `clipboard-read` granted: the main way). The page reads the host's clipboard when
   it gets the focus back (`focus`, `visibilitychange`, only while `document.hasFocus()`), at the agent's HELLO and
   SESSION, and when the permission becomes `granted`. It offers what changed. Where `clipboardchange` exists
   (Chromium 155), a focus reads only after one, and the event reads at once. Because the host's copy is already the
   guest's clipboard when the user comes back, every way of pasting in the guest gets it, including its own menus.
   The page never reads while the permission is `prompt`, except on the user's clicks (the setting, Allow…).
2. **The paste chord** (every browser, no permission). Ctrl+V, Ctrl+Shift+V or Shift+Insert on the screen (on a Mac,
   Cmd+V and Cmd+Shift+V only, since Ctrl+V is the guest's own key) is held without `preventDefault`, and the keys
   that follow wait behind it. The browser's own `paste` event (listened for on the document, while the screen's
   canvas has the focus) carries the clipboard. The page offers it, and sends the held key at the agent's ACK or
   after 300 ms (`ACK_WAIT`; another 300 ms if no paste event comes, `PASTE_WAIT`). A paste from the guest's own menus
   gives the browser no event, so without way 1 it gets whatever the guest's clipboard had.
3. **The menu's items.** Send reads with the click's activation (`read()`, so an image goes too). Type sends the text
   as TYPE to the foreground text console. Copy the screen writes a PNG of the display, and needs no agent: a 3D
   machine's picture comes from the GPU worker's read-back, a 2D machine's from whoever draws its scanout.

**Guest to host:** the agent OFFERs each change of the guest's clipboard. While the document has focus, the page
writes it at once: `writeText` for text alone, and otherwise one `ClipboardItem` of promises whose bytes are
requested from the guest at the write. Without focus, or when the write is refused (Firefox wants activation), the
newest offer is kept pending. It is written on a focus whose read finds the host's clipboard unchanged (the host's
newer copy wins, so a changed clipboard drops it), or on the next key or pointer down on the screen. A paste chord or
the pause drops it.

## The rules

- **Placeholders.** An empty read is never offered and never stands for the host's clipboard. An empty `readText`
  asks `read()` for the types. Three empties in a row while the types say text (`EMPTY_RUN`) stop the focus reads for
  the run, and the menu says why. A read whose types have no text breaks a run. Refusals are silent.
- **Echoes.** Each side keeps a hash of what it last received, so that the other side doesn't offer it back. The hash
  stands for "the clipboard still has it", so it is forgotten whenever that stops being known: the clipboard moving
  on the other way, a refusal, the connection's coming or going, HELLO, SESSION, the pause. The page's hashes cover text
  and image together (`contentHash`). After writing a guest's image, the page reads the clipboard back once, because
  Chromium re-encodes the PNG it writes, and keeps the read-back's hash as the guest's.
- **Caps.** 16 MiB for text and HTML and 64 MiB for an image, on both sides. The page's offers carry their sizes,
  which the agent checks before any bytes cross (ACK `TOO_LARGE`). A guest program's offer has no size (Wayland says
  none), so its bytes are counted as they cross, and both sides stop the transfer past the cap.
- **Images.** The host's side is `image/png` only: Chromium reads every image as PNG and refuses to write
  `image/jpeg`. The agent prefers a program's `image/png`. Otherwise it offers the program's own type (JPEG, WebP,
  BMP, GIF, AVIF), which the page converts to PNG in a worker. The agent never keeps or hashes an image: it streams it
  for each request. The page holds one image of its own (its newest offer's bytes). Images need `CAP.IMAGE` from both
  sides.
- **HTML** goes both ways beside the text or the image, in the same OFFER and the same `ClipboardItem`, and is never
  hashed (the text stands for the content). HTML from the guest that doesn't come is written as the text, escaped.
  The page offers HTML only beside its text or image, as Chromium sanitised it.
- **The pause** stops everything in both directions at once. The agent drops its ownership of the guest's clipboard
  if the host's data was in it, ends the transfers, and ignores the guest's changes until RESUME, which sends
  nothing. The link says PAUSE or RESUME at each connection, since a restored agent is as its snapshot was.
- **Restores and new pages.** A restore resets the guest's vsock transport, so the restored agent connects again and
  its stream begins at a frame. The new page's HELLO ends the session child's transfers in flight, drops the host's
  offer unless its text is whole in the agent's cache, and offers the guest's selection again.
- **Concealed copies** (password managers) can't be told apart by the page. The pause is for those.
- **Several tabs** each run their own machine. Only the focused tab reads or writes the shared host clipboard.
- **A text console's text** isn't shared as a selection (a console has none the agent can see): the menu's
  [Copy the console's text](ui:clipboard:ClipboardMenu.console) copies the foreground console's whole screen as text
  (devices.md "A text console's text"). A console that shows graphics says "[The guest's console shows graphics, not text. Copy the screen takes a picture of it instead.](ui:clipboard:ClipboardMenu.console.graphics)".
- **Not shared:** PRIMARY (the middle-click selection). The serial terminal has its own copy and paste (xterm.js).

## The guest's agent

**Delivery.** `waarm64-agent.service` (`Type=simple`, wanted by `multi-user.target`) runs
`modprobe -q qemu_fw_cfg` outside its sandbox, then its script gunzips
`/sys/firmware/qemu_fw_cfg/by_name/opt/waarm64/agent.*/raw` (its pieces, in order) into `/run/waarm64` (a `TemporaryFileSystem=` of its own,
mode 0700, `exec`) and `exec`s it; it connects to the page over vsock, and again whenever the connection ends. A boot
with the agent off has no unit and no binary. Machines without firmware (direct kernel boots) have no fw_cfg file,
credentials or vsock, and don't get the agent. The unit restarts on failure, 5 s apart, at most 5 starts in 10 minutes.

**What it does** (devices.md "The guest's agent" has it all):

- **The root process** holds the connection. On a machine that shares the clipboard (and on every other for the
  desktop's state, devices.md "The desktop's state"), it follows the active session on seat0 through logind's state files
  (`/run/systemd/seats/seat0`, `/run/systemd/sessions/<id>`, watched with inotify), and through
  `/proc/self/mountinfo` for the user's runtime directory. It forks a **session child** (no exec) for that session,
  which drops to the user's uid and gid before it reads anything from a display, and talks to the parent over a
  socketpair in the connection's own frames.
- **Wayland:** the child connects to `$XDG_RUNTIME_DIR/wayland-<n>` and binds `ext_data_control_manager_v1`, else
  `zwlr_data_control_manager_v1`, with a client written by hand. Sway and KDE Plasma have one of them. GNOME (Mutter)
  has neither.
- **X11:** where there is no compositor, or one without data-control (Xorg sessions, Xwayland under such a
  compositor), the child uses CLIPBOARD through XFixes, with a client written by hand. The display comes from the
  session file or the user's processes, and the cookie from the server's `-auth`, `XAUTHORITY` or `~/.Xauthority`.
  INCR works both ways. `STRING` is answered in UTF-8.
- **Text consoles:** TYPE goes into the foreground VT's input by TIOCSTI, a byte at a time, with line ends as Enter,
  paced by the terminal's unread input. This happens only while the VT shows text (`KDGETMODE`): on a VT that a
  compositor holds in graphics mode, the agent refuses and says so (TYPED `NOT_TEXT`), and the menu tells the user. A
  headless compositor (the Debian test image's sway, with no DRM) leaves tty1 in text mode, so TYPE is typed into
  tty1's input like any typeahead. A paste the agent's 1 MiB queue can't hold is typed as a prefix and ends `DROPPED`.

**What it costs** (Debian 13 under the JIT, 2026-11-06; the `no_std` build's rows 2026-11-07):

| | Measured |
|---|---|
| The binary | **179,672 bytes** (the Podman build, 2026-11-13: with the screen's size under Wayland and X11, a template's renewal, the leases, the desktop's state, the trim, the keyboard layout (~10 KB: sway's IPC, the tool runner) and the console's text (~1.5 KB), devices.md "The guest's agent"; 132,696 with vsock and the clock, 130,064 on the console); its gzip, 105,912 bytes (zopfli's, `images/build.sh agent`: `CompressionStream`'s level 6 was 113,872), is what the guest reads out of fw_cfg (below). It is `no_std` (`agent/src/rt.rs`): `core` and `alloc` on musl's `main`, `malloc`, `fork` and `exit`, an insertion sort for its few names (`core`'s sorts are ~3 KiB a type), and the unwind tables, which `panic=abort` never reads, dropped at the link (`agent/no-unwind.ld`, ~27 KiB). With `std` it was 449,264 bytes (~245 KB gzipped), ~320 KiB of it `std`'s (an empty `fn main` builds to 327,048). What's left: the agent's own code ~65 KiB, musl ~10 KiB, `core`'s formatting ~12 KiB (docs/backlog.md) |
| The boot's fw_cfg read | **74 ms for the 105,912-byte gzip in 26 pieces of 4 KiB** (0.70 µs a byte), plus 19 ms of `gzip -dc` (`tests/page-agent.test.ts` logs both; Debian, 2026-11-13). Linux's `qemu_fw_cfg` reads the data register a byte at a time (`ioread8_rep`, an MMIO read each, ~0.29 µs under the JIT; its DMA is for writes only), and sysfs hands a file out a page per read call, for each of which the driver selects the file again and reads past the `pos` bytes before it: one file of n bytes costs ~n²/8 KiB reads. As one file the same gzip took 414 ms (1.44 million reads), the page's level-6 gzip of 114,025 bytes 481 ms (1.66 million); pieces of a page are read once each. The unit is `Type=simple` after the login prompt, so the boot doesn't wait for it, but it is a vCPU's time at every boot and every restart |
| Idle | 0 ticks of CPU and 0 voluntary context switches over 20–60 s, for the agent and its session child, with sway and with Xvfb. One thread each, blocked in `ppoll` with no timeout. The two bounded exceptions are a paste being typed (1 ms steps) and a compositor's socket that refuses (25 tries, 200 ms apart) |
| Memory | VmRSS **168 KiB** (the console agent); **328 KiB and 264 KiB** (the agent and its child with sway); **320 KiB and 424 KiB** (with X11). With `std`: 300, 572 and 516, 604 and 704. The unit's `MemoryMax=32M` is a cap for a bug, not a budget |
| Throughput | ~0.8 MB/s on the virtio-console, the channel's rate under the credit: a 1.58 MB PNG from the host to `wl-paste` in 1.9–2.0 s, to xclip by INCR in 2.2 s. Not measured again over vsock (4 KiB packets, as the console's buffers were) |
| Sandbox | `systemd-analyze security` 3.8, "OK" (3.7 before X11's socket directory was bound in), on the console; not measured since the clock (`CAP_SYS_TIME`) and vsock (no `PrivateNetwork`) |

## The machine's state

The agent's HELLO is a sign that the machine is up, beside its serial `ready` marker (web/app/machine.ts, agetty's
`login: ` on Debian) and systemd's READY=1 on the notify socket (devices.md "vsock"): whichever comes first moves the
page from `booting` to `running` (the page posts `up` to the machine worker, which says `running` once). On Debian the
HELLO usually comes after the prompt (the unit starts with `multi-user.target`, then reads the binary over fw_cfg,
~0.4 s), but nothing orders the two, so the tests that log in on the serial terminal wait for the prompt themselves.
`?ready=guest` watches for no marker (the Buildroot clipboard test's check that HELLO alone does it).

## What each browser does

Measured on 2026-11-05 and 2026-11-06, headless on the dev VM (`bench/results/local/clip-ways.ts`,
`clip-images.ts`), and by the user in their Chrome and Firefox and in Chrome on the Mac:

| | Chromium | Firefox |
|---|---|---|
| The read permission | `clipboard-read`: `prompt` until granted. Headless has no prompt to show, so a read while `prompt` is denied at once and the state becomes `denied` (the tests' denied path) | `permissions.query({ name: 'clipboard-read' })` throws a `TypeError` (157), so there are no focus reads, only ways 2 and 3 |
| `clipboardchange` | There (155). It fires for the page's own writes and for another page's, the latter once the page is in front again | Not there (157) |
| Reads | Silent with the permission and focus | Reads what the same page wrote. Another page's copy needs activation and waits on the Paste button. From a timer 6 s after input, `NotAllowedError` |
| Writes | Need focus only (granted `clipboard-write`). From a timer 6 s after input without a grant, refused. `image/jpeg` refused ("not supported on write"). A promise in a `ClipboardItem` is awaited by the write | Need activation, so the guest's copy is kept pending until a key or pointer |
| An image written | Re-encoded: 3142 bytes written, 2630 read, the same at each read. The paste event's `File` has the same bytes as `read()` | Not measured |
| The paste event at a focused, non-editable `<canvas>` | At the canvas, with the text and no grant; a copied image as one `file image/png`; on the Mac (TextEdit's text) `text/plain`, `text/html` and `text/rtf`, with no prompt from Chrome or macOS | At `<body>`, not the canvas, with the data (text, and `file image/png`), so the page listens on the document |
| Writing `""` | `read()` gives an item with no types | `read()` gives an item whose types say `text/plain` |

**On the Arch desktop** (2026-11-07, the user, on their Linux desktop's Chromium in a Wayland session; the guest's
sway, so `ext_data_control_manager_v1`): text both ways between the guest's foot and the host; an image copied in
the guest's Firefox reached the host, its file name too; the host's image pasted into a web app (Photopea) in the
guest's Firefox; the menu's switch paused both ways and resumed them; Type the clipboard was refused with its note
(sway owns the VT).

**On the Mac** (2026-11-07, the user, macOS 26.6.2 with default settings, Chrome, the Debian sway test image), with
the read permission granted: a word copied in TextEdit reached the guest's `wl-paste` once the page's screen was
clicked, with no alert or prompt from macOS (its "Paste from Other Apps" guard didn't step in for these reads). So
focus reads get the real content there, and `EMPTY_RUN` never trips: it stays a guard for systems that do hide the
clipboard. The guest's `wl-copy` reached TextEdit at once while Chrome was in front. Made while Chrome was in the
background, it wasn't on the Mac's clipboard until Chrome got the focus back, which wrote it (the pending copy).

In headless Chromium, `bringToFront` fires no `focus` event, so the tests dispatch one. Playwright's `evaluate`
gives activation in Firefox's BiDi, so Firefox's activation rules were measured only from timers.

## Findings

- **Debian 13 mounts `/run` `noexec`** (`rw,nosuid,nodev,noexec`): `exec` of a binary in a `RuntimeDirectory` fails
  with EACCES. That is why the unit has a `TemporaryFileSystem=` of its own mounted `exec`, and needs no
  `memfd_create` loader.
- **The agent was on a virtio-console of its own until 2026-11-13** (a named port, `org.waarm64.agent.0`, a transport
  kind that changed the machine's shape with the setting, and SYNC to begin a restored stream at a frame). vsock took
  its place with the clock (AGENT track): no shape, no udev wait, a restore's connection begun afresh. spice-vdagent's
  port (plans/clipboard.md §6) would need virtio-serial again.
- **The unit's capabilities** are only `CAP_SYS_TIME` (the clock), `CAP_SYS_ADMIN` (TIOCSTI, which root keeps under
  `dev.tty.legacy_tiocsti=0` through this check), `CAP_SETUID` and `CAP_SETGID` (the session children, hence no
  `NoNewPrivileges`), and `CAP_KILL` (stopping a child, which is the user's process by then). There is no DAC
  override, so whatever the agent reads of a user's it must reach by `stat` or as the child: root can't open the
  user's 0700 runtime directory, so it learns that it is mounted from its owner. X11's sockets reach the private
  /tmp through `BindReadOnlyPaths=-/tmp/.X11-unix` (a path socket connects through a read-only bind).
- **Stopping a child closes its socket first** (the child ends by itself), then SIGKILL. The first build killed first,
  without `CAP_KILL`. The kill was refused and the agent's `waitpid` hung at sway's restart (found by the page test).
- **Debian's xclip 0.13 drops requests that come during an INCR**, so a conversion waits while the owner is busy with
  one of ours (the dev VM's newer xclip doesn't, so only the page test sees it). **xclip keeps one INCR per requestor
  window**, so the child has six conversion windows. An owner that never answers is given 10 s (`OWNER_WAIT`) before
  the conversion ends as refused.
- **The serial tests' `run(cmd)`** matches `<<N:…>>` in the terminal for the command's output. A command with `>>` in
  it matches its own echo while it is typed (page-agent's slow reader did, and its long paste raced the reader's
  start). Keep `>>` out of such commands (use `tee -a`).

## The tests

| Where | What |
|---|---|
| `agent/` (`cargo test`, in `scripts/ci.sh`'s `agent` step with clippy and the build) | the frames, Wayland's and X11's wire formats, logind's files, the types and echo rules, the Typist on a fake n_tty; `serve_test.rs` (the root loop on a socketpair), `sway_test.rs` (the session child against a headless sway 1.12 with wl-clipboard: ext data-control), `x11_test.rs` (against an Xvfb of its own with xclip); each skipped without its programs |
| `tests/agent.test.ts`, `tests/vsock.test.ts` (Node, `npm test`) | the link, the clock's TIME, the unit's lines and script, `ClipboardShare` on a faked link and browser (every rule above), the held paste chord; the vsock device's agent connection on hand-built queues |
| `tests/page-clipboard-ui.test.ts` (Chromium on Buildroot, `npm test`) | the button's states and menu, the permission (headless: denied), the Machines page's switches, the PNG worker, Copy the screen on the framebuffer; the test plays the agent's device end (`?agentstub`) |
| `tests/page-agent.test.ts` (Debian, `scripts/ci-debian.sh`) | the agent over fw_cfg, its HELLO and unit, the fw_cfg read's time, idle CPU and RSS, TYPE onto tty1 (fast and slow readers, graphics mode refused), PAUSE, the connection echoed by perl |
| `tests/page-clipboard.test.ts`, `tests/page-clipboard-x11.test.ts` (`images/debian-sway/build.sh`'s Debian, `scripts/ci-debian.sh --platform`; skipped without the image) | sway 1.10 through `zwlr`, and Xvfb from a tty login: text, images and HTML both ways, the paste chord, echoes, the pause, idle costs, the session's end and a new one; Copy the screen on the default 3D path, and on virtio-gpu 2D's scanout with `WAARM64_DISTROS=debian WAARM64_PAGE_QUERY=gpu=2d` (passes, ~150 s) |

Each step's cases and planted bugs are in [testing.md](testing.md)'s clipboard rows.

## Not measured

- **On the Mac:** concealed copies (password managers) and images on the pasteboard. The focus reads and both
  directions of text are measured ("On the Mac" above).
- **Firefox's and Safari's image writes** (activation, the promise form of `ClipboardItem`), and Safari altogether.
- **X11 outside Xvfb:** a display manager's session (`TYPE=x11`, its cookie written late), Xorg through startx, and
  Xwayland under a compositor without data-control (natively, a fake compositor without data-control gives way to
  Xvfb).
- **GNOME and KDE:** GNOME has no data-control and isn't supported (only X11 apps under its Xwayland might be, which
  is unmeasured). KDE Plasma has data-control and hasn't been run.
