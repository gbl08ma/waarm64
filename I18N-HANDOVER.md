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
- **Phase B (in progress):** `main.ts`, `worker.ts` and the protocol's errors (the worker sends `WireError`s and `Msg`s),
  `vm.ts`, `devices.ts`, `ram.ts`'s split codes.
- **Then:** C, the Chromium tests that read words (the cause is now under the headline, `#message-details`); D, the
  docs' remaining UI quotes as `[words](ui:key)` (`node tools/i18n-check.ts` lists them); `tools/i18n-check.ts` joins
  `scripts/ci.sh`; `scripts/ci.sh`, `ci-debian.sh`, `ci-machines.sh` and `ci-graphics.sh`.
- Small guest-visible change: the keyboard unit's script names the layout by its id in a comment, not its English name.
