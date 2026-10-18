# Image decoding in the guest's browsers

The workload behind the integer NEON work in the JIT (docs/jit.md "NEON lane by lane", "Structures"):
Chromium and Firefox ESR on the page's Debian decoding images in a loop. First run in a cloud session
on 2026-10-18 (counts only, no timings). Its findings: decoders' NEON ran as helper calls, 9% of
Firefox's guest instructions on a JPEG page, and Skia's downscaler (`convolve_horizontally_neon`, SMLAL
by element) was Firefox's hottest function in every format.

- `loop.html?fmt=jpg|pjpg|png|webp|avif`: decodes 24 photo-like 1024×683 images, shows them at 256×171
  for two frames, drops them and repeats with fresh URLs (new decodes). It logs `DECODED <n> <ms>` (the
  page's clock) on the console and puts `n` in the title.
- `gen.py <dir>`: makes the images with Pillow (a dev tool, not a repo dependency; on the dev VM pip's Pillow 13 in
  a venv, which reads and writes AVIF, with the venv's `bin` first in `PATH` for `disk.sh`): baseline and
  progressive JPEG, PNG, lossy WebP, 8-bit 4:2:0 AVIF.
- `disk.sh`: the two disks. One is `target/images/debian-browsers/disk.qcow2`, the page's Debian with
  both browsers (needs `node tools/debian.ts` and `images/build.sh edk2` first, ~10 min). The other is
  `target/imgdecode/disk2.img`, an ext4 image of `loop.html` and the images.
- `profile.ts [browser:fmt ...]`: boots the page in Chromium (4 vCPUs, 3 GiB, `disk2` as `/dev/vdb`)
  and runs each case. It waits for three rounds and `WARM` more seconds (45), then samples guest PCs
  for `WINDOW` seconds (30) with the page's PC sampler. It writes `target/imgdecode/out/<case>.json`:
  - the guest instructions and the images decoded in the window (`decodedBefore`, `decodedAfter`);
  - the helper calls by instruction, with `helper-log.patch` applied (`git apply`; it adds a console
    line per vCPU every 5 s, so don't commit it);
  - user PCs attributed to the busiest browser process's mappings (guest ASLR is turned off);
  - kernel PCs symbolized through `/proc/kallsyms`.
- `sym.py <bin dir> <case>.json`: symbolizes the user PCs with the guest's binaries and debug files
  copied into `<bin dir>`. debuginfod.debian.net has them for Firefox's libxul, libjpeg, dav1d and libc,
  not for Chromium's binary.

For an A/B, the rate is the measure (`rate` in the JSON): images a second between the first and the last round
that end in the window. The count alone moves by a round of 24 images, 25-33% of a 30 s window's count; use
`WINDOW=60` (6-10 rounds) for a rate good to about 1%, and `WARM=15` is enough after the three rounds. Run both sides in one session,
alternating, on the dev VM, with the PC sampler on for both (it runs during the window).
