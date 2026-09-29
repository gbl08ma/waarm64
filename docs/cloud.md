# Claude Code cloud sessions

The project is developed in the Lima VM `dev` (CLAUDE.md); that stays the regular path. A Claude
Code cloud session is a different machine, and this page says what differs and what was done about
it. Nothing here changes the local workflow: `scripts/cloud-setup.sh` does nothing unless
`CLAUDE_CODE_REMOTE` is set, which only the cloud sets.

## The machine

Ubuntu 24.04 **x86_64** (Firecracker), root, 4 vCPUs, 15 GiB RAM, ~30 GiB free disk, a pinned
`/opt/node22` Node, rustup with a stable default, gcc, clang, lld. No systemd user bus, no Lima,
no `macmini.lan`, no oracle VM, no display. Outbound traffic goes through a proxy (`HTTPS_PROXY`)
with a per-environment egress policy (Network access in the environment's settings): with the
"full" level everything below was reachable except `codeload.github.com` (tarball URLs).

## What differs from the dev VM, and the handling

| Local assumption | In the cloud | Handling |
|---|---|---|
| Node >= 26 (`engines`) | Node 22 preinstalled | `cloud-setup.sh` unpacks Node 26 to `/opt/node26` and prepends it to `PATH` |
| Node `fetch` reaches the internet directly | it bypasses `HTTPS_PROXY` and gets a 403 | `NODE_USE_ENV_PROXY=1` (set by the script); needed by `tools/debian.ts` and so `npm start` |
| `/usr/bin/chromium` (153) | none; Playwright's Chromium is in `/opt/pw-browsers` (141 at the time of writing) | `CHROMIUM` points at it (the tests and `bench/run.ts` already honor it) |
| `dtc` from zypper (1.7.2) | apt has 1.7.0, which prints strings as `"a\0b"` instead of `"a", "b"`, failing `dtb_round_trips_through_dtc` | the script builds dtc v1.7.2 into `/opt/dtc` |
| qemu-user, qemu-img, fonts | absent | apt (`qemu-user`, `qemu-utils`, `fonts-dejavu-core`) |
| `systemd-run --user --scope -p MemoryMax=10G` around heavy runs | "Failed to connect to bus" | run without it, under `timeout`; the container has 15 GiB and nothing else on it, but a leaking test can still take the session down |
| testfloat's tarballs from github.com | the redirect to `codeload.github.com` is refused (403) | `scripts/testfloat.sh` falls back to `git fetch` of the pinned commit |
| Guest images in rootless Podman (`images/build.sh`) | not practical: the images are aarch64 builds that run natively on the arm64 VM, here they'd run under qemu-user for hours, and nested Podman is untested | not attempted; see below |
| macOS-side oracles (`--oracle m4`, `oracle.sh --hvf`, `ssh macmini.lan`) | unreachable | the QEMU oracles (`qemu-aarch64`) work; real-hardware comparisons stay local |
| `perf`, `wasm-tools`, `../webpc-exp` worktrees | not installed | dev-only; install if needed |
| Benchmarks | x86_64 runner of unknown, shared hardware | numbers are not comparable with the VM's; don't record any (CLAUDE.md's rules on benchmarks) |

## Images

`images/build.sh` needs Podman and native arm64, so the cloud can't build Alpine, Buildroot, the
Linux kernels, LTP, kvm-unit-tests or litmus. **Debian works**: `node tools/debian.ts` (Node only)
downloads the pinned qcow2 (403 MB, ~10 s) and unpacks its kernel and initrd, and
`WEBPC_DISTROS=debian` then selects the Debian tests. So in a cloud session `scripts/ci.sh` runs
everything except the image-based native tests (`boot`, `kvm-unit-tests`, `litmus`, `ltp`, the
Alpine boots), which it already skips with a message when `images/build.sh --check` fails. Work
that needs those (Buildroot/Alpine step counts, kernel changes) belongs in the local VM; a done
milestone loop still needs a local `scripts/ci.sh` with all images.

## What was measured in a fresh session

Toolchain install (`rustup` fetching the pinned nightly): ~1 min. `scripts/build-wasm.sh` from
scratch: 45 s. `cargo fmt`, `clippy`, `cargo test`: clean (138 unit tests, after dtc). TestFloat:
53 s including the build. `tsc`: clean. `npm test` (4.7 min): 177 pass, 0 fail, 89 skipped (all
for missing images or unselected distros). With `WEBPC_DISTROS=debian`, Debian boots in Chromium 141
under the JIT in ~147 s and the page test (login on screen and serial, disk persistence) passes in
~5 min: about 2.5x slower than the M4 VM's ~1 min, so budget for it under the 10-minute command cap.

## Setup

`.claude/settings.json` runs `scripts/cloud-setup.sh` on session start (idempotent; ~1 min the
first time, mostly apt and building dtc; it appends `PATH`, `NODE_USE_ENV_PROXY` and `CHROMIUM` to
`CLAUDE_ENV_FILE`). Putting the same script in the environment's setup script makes the result
part of the cached environment instead.
