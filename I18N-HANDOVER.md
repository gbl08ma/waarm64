# I18N handover

The brief: [I18N-KICKOFF.md](I18N-KICKOFF.md). How it works: [docs/i18n.md](docs/i18n.md).

## State

- **Foundation (done):** i18next 26.4.7; `web/msg.ts` (Msg, MsgError, toWire/fromWire), `web/i18n.ts` (t, text, plain,
  parts, describe, said), `web/app/T.svelte` (markers), the catalog `web/messages/en/*.json` with notes,
  `tools/i18n-check.ts` and `tests/i18n.test.ts`; the message bar's headline and details (`ui.messageDetails`,
  `#message-details`); `ask`'s defaults; the guest units' descriptions rendered by the page (`guest-words.ts`, the start's
  `guest`).
- **The move, by area (phase A, in parallel; phase B after):** A: machines settings; toolbar, status bar, sound, the page
  frame; disks; snapshots; network (with the Rust tailnet client's error codes); USB and folders. B: `main.ts`,
  `worker.ts` and `protocol.ts`'s errors, `vm.ts`, `devices.ts` and the rest of `web/`. C: the tests that read words.
  D: the docs' UI quotes as `[words](ui:key)`. Then `tools/i18n-check.ts` joins `scripts/ci.sh`, and the CI runs.
