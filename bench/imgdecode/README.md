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

## A CPU feature's A/B (2026-11-01)

`codecs.ts <feature> <codecs|js> [rounds] [repeats]`: the Arch desktop disk on 4 vCPUs, a root shell, alternating
`?<feature>=0` and on, a boot per arm and round, writing `bench/boot/results/<feature>/` and printing medians by arm.
`codecs.sh` on the second disk (`codecs-disk.sh`, needs images/arch/media.sh's clips and gen.py's JPEGs) runs each codec
one-threaded (dav1d, libvpx, ffvp9, h264, x264, libvpx and libaom encoding, djpeg, tjbench) with `q8dot.c`, an int8 dot
product as ggml writes it; `js.html` runs ToInt32 kernels in Chromium and Firefox. A round takes 2 to 2.5 minutes.
`QUERY='&dotprod=0' profile.ts` gives the browsers' side; a boot of its four cases takes 10 minutes.

## On the desktop guest (2026-10-22)

What a user sees: Firefox in sway on a 3D machine, images decoded, scaled, uploaded by WebRender through virgl and
drawn on the page's canvas. Mozilla's own linux-aarch64 build, because its symbols are on symbols.mozilla.org (the
Arch port publishes no debug packages); the findings are in docs/jit.md ("Fast completions", "What an exit to the
run loop costs").

- `desktop-disk.sh <photos dir>`: the second disk, `target/imgpipe/disk.ext4`: Mozilla's Firefox (Terms of Use
  skipped by policy, bench/gpu/firefox's autoconfig plus `profiler.cfg`), `desktop.html`, `photos.py`'s images (each
  photo cropped to 16:9 at 320, 480 and 1024 px in JPEG, WebP, PNG and AVIF), perf and the decoders' tools as
  packages (`target/imgpipe/pkg*`), `decoders.sh` and anything in `target/imgpipe/bin`; and `libxul.funcs` (the
  symbols as `addr size name`). The photos used were the 16 of BBC News' front page in `target/ffpages` (local only:
  other people's). Needs Pillow (a venv).
- `desktop.ts [fmt:size:width:n ...]`: boots `target/arch/desktop.qcow2`, starts sway and Firefox on `desktop.html`.
  The host presses `0` (the page changes a number: the key-to-screen baseline) and `n` (a round: n images from fresh
  URLs) on the screen and times each to the last frame the screen presents. Every time is the page's
  `performance.timeOrigin + now()` and its workers': the dev VM's wall clock drifts ~1% from it, and the first
  rounds timed against `Date.now()` grew 11 ms a second of session. `?displaystats` gives each present's time
  (`__presents`) and the device's events (`__devEvents`: keys injected, control commands, held replies). Options in
  its header: the PC sampler (`PROFILE`, slows the guest 3.5×), `PERF=1` (`perf record -a -g` in the guest, fetched
  through the serial console), `GECKO=1` (Firefox's own profiler: markers per thread), `GUEST_CMD`.
- `perfsym.py`, `compare.py`, `gecko.py`: perf's data with libxul named, guest against native per function, and
  Firefox's markers by round. Perf in the guest over-counts code near exits (a timer tick in a compiled loop is
  delivered at the next exit), and the PC sampler can't name libxul's PCs: its processes map it at bases up to 8 MB
  apart and a PC carries no process. Uprobes killed the process while the core had no single step (it has since 2026-10-23, docs/cpu.md
  "Self-hosted debug"; not retried).
- `decoders.sh <img dir> [R]`: Arch's `dwebp`, `djpeg`, `avifdec` and `tjbench` on the 1024 px images, per image, in
  the guest (`GUEST_CMD`) and natively (the arch-base container).

**What it showed** (4 vCPUs, the dev VM, SwiftShader): the key-to-screen baseline is ~160 ms; 16 photos at 1024 px
shown at 320 add ~270 ms (JPEG), ~380 (WebP), ~430 (PNG), ~800 (AVIF). Firefox's own markers put a WebP round's
decodes done by ~0.5 s and its last texture upload right after; the host renderer is busy ~3 ms a second. The
decoders run 6.9× native in a warm process (tjbench) and 12-17× as one-shot tools (`djpeg` 14×, `dwebp` 12×,
`avifdec` 17×, start-up subtracted: fresh buffers' page faults, ~10× native, and cold process state); a 4 KiB page
fault costs 4.4 µs (0.42 natively), memcpy 10 GB/s (52). Nothing image-specific stood out; the guest's clock reads
(660 ns a `clock_gettime`, 49× native) and context synchronization exits did, and are what changed.
