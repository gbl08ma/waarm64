# EVENT_IDX: the step counts, for the dev VM

The virtio transport offers `EVENT_IDX` (commit "virtio: offer EVENT_IDX"; docs/devices.md). It was
built in a cloud session, which has no guest images, so **`tests/steps.txt` still holds the counts
from before it**: every Linux guest with a virtio device negotiates the feature, so `scripts/ci.sh`
on the dev VM fails on their step counts until they're recorded again. EDK2 doesn't negotiate it,
so `edk2-shell` and `edk2-shell-again` shouldn't move.

## What to do

1. Run the native boots and read the new counts from the mismatches (`cargo test --release --test
   boot -- --ignored --nocapture`, and the distros, ltp, litmus, gpu and snd guests), record them in
   `tests/steps.txt` in one commit whose message says why (docs/testing.md "Step counts"), and
   check Node and Chromium agree (`scripts/ci.sh`, all images).
2. `alpine-user-snapshots` should still equal `alpine-user`: a restored transport keeps no extra
   state for it (the old used index is the used index at the start of each drain). If it doesn't,
   that is a bug, not a count to record.
3. `scripts/ci-debian.sh` and `scripts/ci-machines.sh` (the cloud ran the Debian tests that don't
   need linux-snd, and a machine's kept snapshots, and they passed).
4. Delete this file in that commit.

## Measured in the cloud (Debian on the page, 2 vCPUs, 4 rounds alternating)

Interrupts don't depend on timing: ~3,130 virtio interrupts to the login prompt with it against
~3,260 without (~4% fewer), and the same within 1% over a direct-I/O `dd` workload (virtio-blk asks
for an interrupt per completion either way). Notifies can't drop: the core posts every chain at the
notify, so `avail_event` always equals the driver's index. Times were noise in the cloud, as expected.
