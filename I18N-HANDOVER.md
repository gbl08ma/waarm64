# I18N handover

The brief: [I18N-KICKOFF.md](I18N-KICKOFF.md). How it works: [docs/i18n.md](docs/i18n.md).

## State

- **Foundation (done):** i18next 26.4.7; `web/msg.ts` (Msg, MsgError, toWire/fromWire), `web/i18n.ts` (t, text, plain,
  parts, describe, said), `web/app/T.svelte` (markers), the catalog `web/messages/en/*.json` with notes,
  `tools/i18n-check.ts` and `tests/i18n.test.ts`; the message bar's headline and details (`ui.messageDetails`,
  `#message-details`); `ask`'s defaults; the guest units' descriptions rendered by the page (`guest-words.ts`, the start's
  `guest`).
- **Phase A (done, 2026-11-02):** six areas moved by agents in parallel, words unchanged: the page's frame
  (toolbar, status bar, sound, message bar: `common`/`toolbar`/`statusbar`/`sound`), the Machines page (`machines`),
  disks, snapshots and the display's refusals, network (the Rust tailnet client now sends codes, `net/ts`), USB and
  folders. One deviation undone: "Add a disk: from a url" keeps its lower case.
- **Phase B (done):** `main.ts`, `worker.ts` and the protocol (the worker sends `WireError`s and `Msg`s), `vm.ts`,
  `devices.ts`, `ram.ts`'s split codes. **Phase D (done):** the docs quote the page as `[words](ui:key)`; the checks are in
  `scripts/ci.sh` and the convention in CLAUDE.md. **Review (done):** `review/i18n`'s findings fixed (the emulator's
  headline over an error's words instead of its key and stack, a failed connection's reason in one-line places, line
  breaks, stacks across workers, markers in parameters, the worklet in the checks), the rest in the backlog.
- **Runs in the cloud session (2026-11-02):** `scripts/ci.sh` all but two: the known x86_64 video case (docs/cloud.md)
  and one test that failed only under the full run's load and passes alone three times (once
  `page-connections` "power off lets a connection go", once `page-usb` "the USB tab"; both read the page right
  after an action, and only words changed in their code). `ci-machines.sh` passes; `ci-debian.sh`'s tests pass with
  `WEBPC_DISTROS=debian`, but its main Debian test skipped (no `linux-snd` image here); `ci-graphics.sh` ran one of three.
- **Tests take the words from the catalog (done, 2026-11-02, after the merge into main):** `tools/i18n-check.ts` reads
  `tests/` too, `tests/words.ts` gives a message as a pattern, ~45 test files converted (docs/i18n.md "Tests"). In the
  dev VM on that tree: `scripts/ci.sh`,
  `ci-debian.sh`, `ci-machines.sh`, `ci-net.sh`, `ci-audio.sh` pass.
- **The copy rewritten to a style guide (2026-11-02):** docs/copy.md from the user's own edits and choices (the
  voice, no colon chains, "this web app"/"this emulator", "your computer", "base image"), applied to every catalog by
  area; setup screens steps first (the tailcat choice as the user sketched it, the local helper, tailnet, Add a USB
  device, the folder wizard). The user reviews it next and the guide is refined from there.
- **Left for the dev VM, before the track ends:** `scripts/ci-debian.sh --platform`, `ci-graphics.sh`, `ci-usb.sh`,
  `ci-deqp-vk.sh`'s page (the Venus refusals). Then the track ends: its outcome is docs/i18n.md and the
  PLAN row; this file and the kickoff go.
- **For the user's review:** the copy itself (`web/messages/en/`, a note per entry); two choices made: "Mouse lock" in
  docs/frontend.md quotes the status bar element's name (the toolbar menu has no message with those words); the guidance
  lines now sit in the headline and the cause under it (e.g. "The snapshot couldn't be loaded\nNothing was changed…",
  then why).
