# Review: the guest agent crate (BETTERAGENT), out of context

Scope: `git diff d054e59b~1 HEAD -- agent/` (DISPLAY through wlr-output-management and RandR, RENEW, LEASE, DESKTOP,
TRIM, KEYMAP, COPY, `rt::close_inherited`), read against docs/devices.md "The guest's agent" and `web/agent-frame.ts`.
Static reading only; nothing was run. Findings ranked by severity. Line numbers are at `b6a29139`.

Summary: 0 high, 3 medium, 9 low (some of the low ones are only suspicions, and say so).

---

## Medium

### M1. An X server that takes the setup but fails the clipboard's setup is reconnected in a tight loop

`agent/src/session.rs:866-882` (`x_disconnect`), changed in this range.

Before the range, a connection that ended without being `ready` (the clipboard's watch not up) went into
`x_refused` and got the bounded retries. Now `if x.ready || x.is_set_up() { self.x_try(true, false) }` reconnects
**at once** whenever the setup reply was a success. `X::input` returns `Err` after a successful setup in several
cases that repeat on every connection to the same server:
- `Want::Extension` with `r[8] == 0` ("the X server has no XFIXES", `x11.rs` `reply`),
- an X error to any of `Want::Atom | Extension | Version | Owner` ("the X server's error … at the setup"),
- "the X server's stream went out of step".

**Trigger:** an X server of the user's that lacks XFIXES, or that returns an error to one of the setup's requests
(the X server is the user's process: a fake or broken one, or a build without XFIXES), in a session with the
clipboard shared. Each round trip is: connect (nonblocking, succeeds), setup reply, the error, `x_disconnect`,
`x_try` connects again. No backoff, no retry count, and a journal line (`session: … (:N)`) per round: the child and
the X server spin on a vCPU and the journal floods for as long as the session lasts.

**Fix direction:** reconnect at once only after a connection that was `ready` (or set up for the size/state alone,
`!clip`), and treat a setup-time error like a refusal (`x_refused` plus the bounded retries).

**Test:** in `x11.rs`'s tests, a `listener` that answers the setup with success and every QueryExtension with
"not present"; run `serve_at` with `clip: true` for one second and count the accepted connections (expect a few at
most; today it grows without bound).

**Confidence:** high on the logic (the old branch is gone for set-up connections); medium that a real guest has
such a server.

### M2. Partial SSH key renewal leaves the running sshd serving the template's keys

`agent/src/renew.rs:296-309` (the helper) and `:363-382` (`keygen_done`).

The helper renews every `ssh_host_<type>_key` it finds and exits 1 if **any** of them failed (`ok &= made`). The
ones that succeeded are already renamed into place. `keygen_done` then sends SIGHUP to sshd's listeners only `if ok`.
So when one key fails, the others are new on disk but the listener (OpenSSH >= 9.8 loads host keys only at start and
SIGHUP, as the module's own comment says) keeps serving the **template's** keys for every type, until sshd restarts.
RENEWED reports `SSH` as failed, but the page has no further action for that.

**Trigger:** a template with a host key of a type its `ssh-keygen` no longer makes, e.g. a leftover
`ssh_host_dsa_key` on a guest upgraded to OpenSSH 10 (DSA removed: `ssh-keygen -t dsa` fails), or any key file named
`ssh_host_<word>_key` that isn't a key type. Every visitor's copy then serves the same ed25519/RSA host keys, which
is exactly what RENEW exists to prevent.

**Fix direction:** SIGHUP the listeners whenever at least one key was renamed (have the helper report per key, or
exit with a distinct status for "some made"), and/or skip types `ssh-keygen` can't make.

**Test:** `serve_test.rs` `renews_ssh_host_keys_with_the_real_ssh_keygen` with an extra `ssh_host_bogus_key` in the
directory: the sshd it starts must serve the new ed25519 key (today it serves the old one).

**Confidence:** high.

### M3. LEASE stops at the first card whose command fails; the cards after it aren't renewed

`agent/src/lease.rs:157` — `let ok = argvs.iter().all(|a| run(a));`

`Iterator::all` short-circuits: after the first non-zero exit, no further command runs. The comment and docs say
"Runs `cmds` one after the other" and "for each card".

**Trigger:** two cards, the first (sorted by name) one networkd doesn't manage or that has no DHCP client, or one
NetworkManager has as unmanaged / with no connection profile (`nmcli device connect` fails): the second card's lease
is never renewed. LEASED says FAILED, so the page falls back to flapping every connected card, which drops the open
connections the agent's renewal was meant to keep alive (docs: "A renewal keeps an address that is still right
(open connections live on)").

**Fix direction:** run all of them (`fold`/a loop that ANDs without short-circuit); arguably skip links the manager
doesn't manage rather than fail the whole LEASE.

**Test:** `serve_test.rs` `renews_the_leases_with_the_network_manager_that_runs` with a fake busctl that fails for
index 2 and records calls: today `calls()` has only the index-2 line.

**Confidence:** high on the code; the consequence (a flap instead of a renewal) is the documented fallback, so the
damage is the lost connections, not a broken network.

Related suspicion (not confirmed): `nmcli device connect <dev>` on a device that is already connected re-activates its
connection (a down/up of its IP configuration), and on one the user deliberately disconnected activates it. Neither is
a "renewal that keeps the address"; `nmcli device reapply` or a D-Bus `RenewDHCP`-style call may be closer. Worth
measuring on a NetworkManager guest before relying on it.

---

## Low

### L1. The session child inherits the trim job's and loadkeys' pidfds

`agent/src/main.rs:394-399`: the forked session child closes `port`, `mine`, inotify, the mount table, the typist's
console, `keygen`'s and `leasing`'s pidfds, but not `self.trimming`'s nor `self.loadkeys`'s (both added in this
range). A user's process thus holds a pidfd to a root helper. It can't signal it (no permission) but can poll it
(learning when a trim ends), and the fds outlive their purpose in a long-lived process. `close_inherited` (or
`close_range` from 3 skipping `theirs`) would make the list unnecessary.

**Test:** the tests' child is a thread, so this needs the forked path: start a TRIM whose fake FITRIM sleeps, then
a session, and look for an `anon_inode:[pidfd]` link in `/proc/<child>/fd`. **Confidence:** high.

### L2. A KEYMAP that arrives while `loadkeys` runs never reaches the consoles

`agent/src/main.rs:465-468` (`load_console`): `if … || self.loadkeys.is_some() { return; }`. `Current::take` has
already recorded the new layout as the session's (`has`), so a later KEYMAP of the same layout does nothing either.

**Trigger:** the setting saved twice within one `loadkeys` run (or a HELLO's KEYMAP right after a save): the
compositor gets the second layout, the text consoles keep the first until the next change or boot.

**Fix direction:** keep the last wanted vc and run it when the running one ends. **Test:** in
`applies_the_pages_layout_where_the_session_hasnt_it`, a fake loadkeys that sleeps 300 ms and two KEYMAPs back to
back: today `loaded()` has only the first. **Confidence:** high.

### L3. KEYMAP's name filter lets through sway's other command separator and option-like names

`agent/src/keymap.rs:28-32` (`plain`): the comment says nothing else "may reach a command line (a `;` would be another
sway command)", but `,` is allowed and sway's IPC `execute_command` splits on `,` as well as `;`. A layout such as
`us,de` (XKB's multi-layout form) becomes `… xkb_layout us` followed by a command `de`; `us,exit` would run `exit`.
Separately, a `vc` starting with `-` is passed to `loadkeys -q <vc>` as an option. The page's list (web/app/keyboard.ts)
has no such names, and the page is the trusted end, so this is hardening and a latent correctness bug for multi-layout
settings rather than an attack. Fix: quote the values for sway (`xkb_layout "us,de"`) or reject `,`; pass `--` before
the vc. **Confidence:** high on the parsing; low impact today.

### L4. `sway_run` connects blocking; the session child can hang on a stuck compositor

`agent/src/keymap.rs:167-173`: the IPC socket is made without `NONBLOCK` and `connect` blocks while sway's listen
backlog is full (sway hung, or stopped with clients queued). docs/devices.md states the child connects nonblocking
precisely so that "a compositor stopped with its backlog full refuses rather than holding the child's one thread".
While blocked, the child's clipboard and DISPLAY work stop too. `keymap::run` (setxkbmap) likewise holds the loop for
up to 5 s, and each `sway_run` wait for up to 2 s. **Confidence:** high on the blocking; the trigger (a hung sway) is
rare and the root's SIGKILL still ends the child.

### L5. `pidfd_open` failing blocks the root loop on a running helper

`agent/src/lease.rs:161-163`, `renew.rs:312-314`, `trim.rs:184-186`: if `pidfd_open` fails (EMFILE), the parent does a
blocking `waitpid` on a helper that has just started: up to an RSA keygen, a whole FITRIM pass, or busctl/nmcli's
timeouts, with the page's connection unserved meanwhile. Kill the child first (SIGKILL, then reap) instead.
**Confidence:** high on the code; the trigger needs fd exhaustion.

### L6. Out-of-range DISPLAY sizes: truncation, overflow, a reconnect loop

The page is trusted, so only absurd sizes trigger these, but `decode_display` only rejects 0:
- `agent/src/x11/randr.rs:464` truncates with `as u16` where `randr_plan` (`:382-385`) clamps: a width of 70000 makes
  a mode of 65535 and sets the CRTC config/screen at 4464.
- `randr.rs:121-125` `timings`: `w + 160` overflows `u16` for widths above 65375 (a panic under debug assertions, a
  wrapped mode in release).
- `agent/src/outputs.rs:200,236`: a size above `i32::MAX` becomes a negative `set_custom_mode`, a protocol error
  (`invalid_custom_mode`) that makes the compositor drop the connection; the child reconnects with fresh `Outputs`
  (`asked` none), asks again and is dropped again, for as long as that size stands.
Clamp once in `decode_display` (e.g. to 16384). **Confidence:** high on the arithmetic.

### L7. A later run's RandR state can take an earlier run's late replies (suspicion)

`agent/src/x11/randr.rs:189-193, 333-358`: `Want::Randr(Step::Output(id))`/`Geometry` carry no run identity. When a
run ends early on an error (`randr_end` from `randr_error`) while its other GetOutputInfo/GetGeometry replies are
still due, and a new size has come meanwhile, `randr_go` starts a new run at once, and those late replies fill the new
run's `output`/`screen` before its own GetScreenResources reply arrives (`outputs_left` saturates at 0, so they are not
counted, but `run.output`/`run.screen` are set from the old configuration). Mostly harmless (same outputs), but the
screen size it plans from can be stale. **Confidence:** low (needs an error mid-run and a size change at once).

### L8. The layout isn't given to a compositor that replaces an X server without a "none" in between (suspicion)

`agent/src/session.rs` `key_step`: `keyed` is reset only when `desktop_now()` is NONE. If an X connection is set up
(X11) and a Wayland compositor appears and inits while it is still up (a nested compositor started from an X11
session), the state goes X11 to WAYLAND directly and sway never gets the layout. **Confidence:** low; rare setup.

### L9. `/etc/machine-id` is truncated before the new id is written

`agent/src/renew.rs:151-178` (`overwrite`): `O_TRUNC` then `write`; a write error (ENOSPC on a full root filesystem,
EIO) leaves an empty machine id, which systemd treats as an uninitialised machine at the next boot (first-boot
semantics, a new id, presets re-applied). Writing without `O_TRUNC` and then `ftruncate` to the new length keeps the
old id on a failed write (an atomic rename isn't possible on a bind-mounted file). **Confidence:** high on the code;
the trigger needs a full or failing disk.

---

## Checked and found fine

- `frame.rs` against `web/agent-frame.ts`: every frame number, capability bit, status (ACK, TYPED, DESKTOP, LEASED,
  TRIMMED, COPIED, RENEWED bits), the HELLO/OFFER/REQUEST/DATA/MORE/DISPLAY/KEYMAP layouts, `MAX_PAYLOAD` and the
  readers' length rule agree. COPIED's payload is at most 1 + 64 KiB, inside `MAX_PAYLOAD`.
- wlr-output-management v1 opcodes (manager, head, mode, configuration, configuration head) and the configuration
  naming every head (enabled or disabled), so no `unconfigured_head` error.
- RandR 1.2 request and reply layouts used (GetScreenResources, GetOutputInfo, CreateMode's ModeInfo, SetCrtcConfig,
  SetScreenSize, GetGeometry) and the grow / set / shrink order of the screen around SetCrtcConfig.
- `close_range` number (436, asm-generic) and its use in every helper forked from the root (lease, trim, keygen,
  loadkeys) and before setxkbmap's exec.
- The root's handling of the child's frames (DESKTOP accepted only as 0..=2, nothing else of the child's but the
  clipboard's), and DESKTOP's per-connection `told`/HELLO gating.
- `screen.rs`'s row trimming and its UTF-8 cut; the vcsu/vcs fallback on ENODATA.
- `trim.rs`'s mountinfo parsing (optional fields, octal escapes, read-only superblocks, one trim per source).
- One renewal / lease / trim / loadkeys at a time, with the running one's answer serving a repeated request, as
  documented.
