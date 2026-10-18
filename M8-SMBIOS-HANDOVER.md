# SMBIOS over fw_cfg: the dev VM's pass

Built in a cloud session (2026-10-18): the firmware configuration serves SMBIOS tables over fw_cfg
(`core/src/smbios.rs`, docs/platform.md "The firmware configuration's devices"). EDK2's
SmbiosPlatformDxe, already in `QEMU_EFI.fd`, installs them; no firmware rebuild. Checked in the
cloud: the unit tests, and the page's Debian test reading `/sys/class/dmi/id` back (with the
deployed `QEMU_EFI.fd`).

What the cloud couldn't do (no `shell.img`, so the deterministic firmware tests skip there):

1. **Record `edk2-shell` and `edk2-shell-again`** in `tests/steps.txt`: the firmware now installs
   the tables, so both counts move. Run `cargo test --release --test firmware` and the Node
   `edk2-shell` test, take the new counts, and say why in the commit (a guest-visible change the
   user OK'd: SMBIOS).
2. `scripts/ci-debian.sh` and `scripts/ci-machines.sh` once on the VM.
3. Optional, cosmetic: whether EDK2's setup screen now shows the RAM (docs/backlog.md "After
   phase B"); fix that backlog line either way.

Delete this file in the commit that does 1.
