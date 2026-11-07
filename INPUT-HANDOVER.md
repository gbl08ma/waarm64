# INPUT: the horizontal and high-resolution wheels — handover

The user's OK (2026-11-07) for the guest-visible half of the backlog's input item: the tablet and the mouse now offer
`REL_HWHEEL` (6), `REL_WHEEL_HI_RES` (11) and `REL_HWHEEL_HI_RES` (12) besides `REL_WHEEL` (8) (web/devices.ts
`inputConfig`, its native twin `core/tests/common/mod.rs` `input_config`), and the page sends them (web/input.ts, the
`wheel` listener; docs/frontend.md "Input"). The page-only half (the touchscreen's single-touch `ABS_X/Y` following the
oldest finger down) went in with it. Done in a cloud session, which can't boot the image guests.

## Left for the dev VM

**The step counts.** The kernel's probe walks the new bits, so every image guest with a tablet takes more steps:
expected `devices` and `alpine` (the guests that moved when the tablet got `BTN_SIDE`/`BTN_EXTRA`), maybe others with
`testDevices`. Until they're recorded those guests fail their step check everywhere (natively, Node, Chromium).
1. `scripts/ci.sh` (alone, in the background); note each guest whose count it reports.
2. Record the new counts in `tests/steps.txt`, with a comment line above each moved guest ("the tablet and the mouse
   have the horizontal and high-resolution wheels"), as the `BTN_SIDE` line does.
3. Check `input_events_reach_the_guest` (core/tests/boot.rs) and `tests/browser.test.ts`'s input guest now see
   `B: REL=1940` (worked out, not yet seen from a guest).
4. `scripts/ci.sh` again, then `scripts/ci-debian.sh` (devices and the page; guest-visible).
5. Commit the counts and delete this file in that commit.

What passed in the cloud session: `tests/devices.test.ts`, `tests/page-pointers.test.ts` (9 of 9; the new wheel and
touch cases fail on the old web/input.ts) and `scripts/ci.sh`'s steps that don't need the image guests.

Worth a look once the counts are in, not required: in the Arch desktop guest, that sway and Firefox scroll a touchpad
smoothly and sideways (`libinput debug-events` shows `POINTER_SCROLL_WHEEL` with `v120` values off 120).
