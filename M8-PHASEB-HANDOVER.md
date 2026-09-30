**Handover, 2026-09-30: M8 phase B (your own disk) has started. Loop 0 (the QEMU oracle) is done;
next is loop 1 (EDK2 as a guest workload).** The brief is `M8-PHASEB-KICKOFF.md` (confirmed by the
user 2026-09-30: the outline is OK, **images in scope are Debian and Alpine only**). Phase A's
handover, loop 8 and the stability detour are in git history (this file before this commit);
networking has its own handover (`M8-PHASEC-NETWORKING-HANDOVER.md`).

**Read, in order:** CLAUDE.md, the kickoff, [docs/plans/uefi.md](docs/plans/uefi.md) (loop 0's
findings, DT vs ACPI, and the design for loops 1–3), PLAN.md §3 "M8" phase B, then
`docs/platform.md` ("Boot"), `docs/devices.md` (the device worker, the overlay, the
framebuffer), `docs/abi.md` (a change needs a design note first), `docs/images.md`,
`docs/frontend.md`, `docs/testing.md`.

## Loop 0 (done, docs only)
Everything is in docs/plans/uefi.md. In short:
- All three images boot unmodified through EDK2 on QEMU: Debian 13 nocloud (shim + GRUB 2.12),
  Alpine 3.24.2 tiny (Limine), Alpine 3.24.1 generic UEFI tiny (GRUB 2.14).
- **The design changed from the kickoff's suggestion** (its loops 1–2 were "a suggestion"; the
  kickoff text itself is the user's and unchanged): **ArmVirtQemuKernel** entered like a kernel
  through our direct boot, instead of ArmVirtQemu executing from a code flash at 0 after a reset.
  Stock ArmVirtQemu needs fw_cfg; the Kernel variant needs neither fw_cfg nor a code flash, but
  does need **one CFI flash bank for variables** (it crashes without). Its firmware stage was
  3.3 s vs 5.3 s under TCG.
- **The DT stays** (the user asked whether to keep device trees): DT and ACPI behaved the same
  for all three images; ACPI would mean two descriptions, AML for virtio-mmio, and a GOP for the
  screen. The ACPI path, if an ACPI-only guest ever matters, is in docs/backlog.md.
- **EDK2 ignores `/reserved-memory`** and allocates from RAM's top, over our framebuffer: the
  framebuffer moves above `/memory` (same wasm memory, same offset). QEMU rewrites `/memory`, so
  that layout gets checked on our machine in loop 2.
- **Debian's first boot stops at `systemd-firstboot`** and skipping its password locks root
  (`root:!unprovisioned`); GRUB drops the page's command-line credentials. **systemd credentials
  through fw_cfg** (`opt/io.systemd.credentials/…`) fix it on the unmodified image (checked on
  QEMU): hence a minimal fw_cfg in the core.
- **Alpine's cloud images lock root** too; a generated `CIDATA` FAT seed disk works (checked).
- The user added **RNDR** to the backlog (from `crypto.getRandomValues()`; a seeded PRNG in
  deterministic mode): docs/backlog.md "CPU and ISA".

## Next: loop 1 (the firmware as a guest workload)
- `images/build.sh edk2`: clone `edk2-stable202608` with its submodules (pin the commit), build
  ArmVirtQemuKernel RELEASE (`build -a AARCH64 -t GCC -b RELEASE -p
  ArmVirtPkg/ArmVirtQemuKernel.dsc`), output `target/images/edk2/QEMU_EFI.fd` (3 MiB), hash in
  `images/SHA256SUMS`, `--check edk2` reproducible. **Build it in a native arm64 container**
  (`docker.io/library/debian:trixie`, pinned by digest, apt from snapshot.debian.org like
  `images/Containerfile`); packages: build-essential uuid-dev acpica-tools python3
  python-is-python3 git. `edksetup.sh` fails under `set -u`; export `PYTHON_COMMAND=python3`.
- THIRD_PARTY.md row (BSD-2-Clause-Patent; a binary we build and run; its submodules' licenses
  for what's linked in: OpenSSL is Apache-2.0, brotli MIT, libfdt BSD-2-Clause/GPL dual).
- A committed QEMU oracle script from `bench/results/local/m8b-loop0/` (`drive.py` answers
  prompts on the serial console; `run.sh`): our EDK2 build booting Debian and Alpine on QEMU with
  a DT like ours, so later loops compare against it.
- Then loop 2 (the platform: CFI flash bank, fw_cfg, the firmware machine configuration, the
  framebuffer's placement, the PL031 in deterministic mode; ABI design notes first), loop 3
  (the page's Debian through UEFI: **ask the user** the open questions at the end of
  plans/uefi.md before changing what the page shows).

## Gotchas found in loop 0
- `localhost/webpc-images` (images/Containerfile) is **amd64** and runs under qemu-user on this
  arm64 VM: fine for what it does, but an EDK2 build in it produced x86 dependency files that
  broke the next native build (`git clean -fdx` in every submodule fixed it).
- `/tmp` is a 6.9 GB tmpfs: don't `dd` whole partitions out of a raw image there (a 3 GiB
  `root.img` filled it); read files with `web/qcow2.ts` + `web/bootfs.ts` from Node
  (`bench/results/local/m8b-loop0/rd.ts`) or `mtools` on an offset (`mdir -i img@@<bytes>`).
- QEMU: `-fw_cfg name=…,string=` rejects an empty string (use `file=` on an empty file); `-dtb`
  works with `-kernel`, and QEMU still rewrites `/memory` and `/chosen` in it.
- The QEMU TCG boots take ~40 s to a login with `-smp 2`; four at once are fine on this VM.

## Carried over (still true)
- The Debian page tests take turns (`tests/debian-lock.ts`); `npm test`'s long pole is the Node
  boots. Every heavy run under `systemd-run --user --scope -q -p MemoryMax=10G -p
  MemorySwapMax=0 -- timeout N <cmd>`.
- The dev VM has no `diff` or `cmp`. `../webpc-base` is at `9e0209b` for A/B runs.
- Looking at the page from the desktop: `ssh -t -L 8080:127.0.0.1:8080 macmini.lan "ssh -t -F
  ~/.lima/dev/ssh.config -L 8080:127.0.0.1:8080 lima-dev 'cd ~/Development/webpc && npm start'"`,
  then `http://127.0.0.1:8080/`.
- Phase B notes from phase A: the overlay's Web Lock (`webpc-overlay:<name>`) is its ownership:
  importing a changes file that replaces the overlay takes the same lock. Keep the page's VM
  config (machine.ts) separate from the tests' guests. The worker protocol grows a disk (URL or
  `File`) in `start`, and export and import messages.
