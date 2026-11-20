# waarm64 against the other in-browser Linux systems: speed (docs/comparison.md §3)

One CPU workload run inside each project's own guest, timed the same way. The harness is `bench/compare/run.ts` (its
header says how a run is timed), the workload `bench/compare/work.pl`. The page's speed figures
(`web/app/intro/speed.ts`) come from here.

## Perl, six kernels: waarm64, unkernel, v86 (2026-11-20)

**What.** `work.pl`: six small kernels in plain Perl, no module (a sieve over an array; words counted in a hash; a
numeric and a string sort; regular expressions matched and substituted; a recursive function; a floating-point
escape-time picture), at size 8. The script is typed into the guest's shell and run with the guest's own `perl`, three
times a boot. A run is the host's time from the script's first line to its last on the guest's console (polled every
20 ms). Each kernel prints a checksum.

**Why Perl, and what is compared.** A program that every guest has as shipped (nothing installed, no network), and a
language's interpreter rather than a C kernel whose speed follows its compiler (the user, 2026-11-20: not CoreMark;
WebVM left out, closed and hard to run a fixed workload in).
- **waarm64 and unkernel run the same binary**: both guests are Debian 13 (trixie) on aarch64 with perl 5.40.1, since
  unkernel's user space became aarch64 on 2026-11-19. Like for like.
- **v86 is another architecture**: Arch Linux 32 (i686), perl 5.36.0, whose integers are 32 bits (the script's numbers
  stay under 2^46, exact in its doubles too, but its interpreter does other work for them). The same source, not the
  same program: a cross-ISA row.
- Every run on every system printed the same six checksums (`311712 5000/345 491430/k1000403260 4881792 458512
  918071`).

**Setup.** The dev VM (Lima vz on the M4 Mac mini, 8 vCPUs, Linux arm64), Chromium 155.0.8059.84 headless, a fresh
browser and boot per round, the three systems one after another in each of 3 rounds, 3 runs a boot. waarm64: this
checkout (af419c2a) on the dev server, Debian 13's published nocloud image through UEFI (`?machine=debian`, 4 vCPUs,
1 GiB). unkernel: https://unkernel.dev/ as shipped (4 CPUs, 512 MiB). v86: https://copy.sh/v86/?profile=archlinux as
shipped (one CPU, 512 MiB, resumed from its saved state). JSON: `results/perl-1-devvm.json` (every run, each kernel's
guest CPU seconds and checksum).

| | Seconds, median of 9 (IQR) | Each boot's three runs | waarm64 is |
|---|---|---|---|
| **waarm64** | **11.34** (1.25) | 11.20 10.90 13.23 · 11.34 11.26 11.02 · **21.55** 11.57 12.45 | |
| unkernel | 20.99 (1.00) | 22.64 21.84 23.52 · 20.99 21.53 20.59 · 20.73 20.97 20.84 | **1.85×** as fast |
| v86 | 45.84 (0.59) | 47.60 45.84 46.89 · 45.43 45.28 45.50 · 46.02 45.09 45.97 | **4.04×** as fast |

- **One run of ours took 21.55 s**, the first after the third boot (the next two took 11.57 and 12.45): Debian was
  still starting services behind the login it had just given. It is in the median (which it doesn't move: leaving
  each boot's first run out, 11.41 s against 21.25 and 45.67). Our other eight runs (10.90–13.23 s) don't overlap
  unkernel's nine (20.59–23.52 s).
- **By kernel** (the guest's own CPU seconds from `times`, medians of the later runs; waarm64 / unkernel / v86): the
  sieve 2.48 / 3.73 / 8.64; words in a hash 1.91 / 3.78 / 11.70; sorting 2.13 / 4.74 / 8.65; regular expressions 1.54 /
  4.22 / 5.44; recursion 1.19 / 2.14 / 3.38; floating point 1.61 / 3.04 / 7.55. We lead in each: 1.5× (the sieve) to
  2.7× (regular expressions) over unkernel, 2.8× to 6.1× over v86. A guest's clock is its emulator's: these are for
  the shape, the host's time above for the claim.
- **This host is the unfavourable one for us.** V8 on Linux arm64 bounds-checks stores in compiled code (docs/v8.md
  "Bounds checks": up to 27% of an integer guest), which our JIT's code pays and an interpreter's doesn't; Chrome on a
  Mac and on x86-64 doesn't emit them. Not measured there: the first thing to do next.

**What the page says** (`web/app/intro/speed.ts`): 1.9× as fast as unkernel, the next fastest, and 4.0× as fast as
v86, from the medians (1.851 and 4.042), dated, with the workload and that v86's Perl is another build.

**Not measured, most useful first.**
1. **The same run on the Mac host** (Chrome for Testing, `bench/run-mac.sh`'s host) and on an x86-64 computer: what
   most visitors have.
2. **Python** (the user's first thought): unkernel installs it as it's typed, v86's Arch has 3.10, our Debian image has
   none without a network. A second workload would say whether Perl's ratios hold.
3. **Compiled code** (CoreMark, `xz`): a C compiler per guest, so a compiler's and an ISA's difference in the result.
4. **Several cores**: unkernel boots 4 CPUs and we 4 to 8; v86 has one.
5. **System calls and process churn** (fork + exec), where unkernel's native kernel should lead (comparison.md §4).
