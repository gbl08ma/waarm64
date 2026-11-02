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
| Node `fetch` reaches the internet directly | it bypasses `HTTPS_PROXY` and gets a 403 | `NODE_USE_ENV_PROXY=1` (set by the script); needed by `tools/debian.ts` (`images/build.sh debian`, the tests' Debian) |
| `/usr/bin/chromium` (153) | none; Playwright's Chromium is in `/opt/pw-browsers` (`chromium-*/chrome-linux64/chrome`, 153.0.8010.12 on 2026-10-26; it was `chrome-linux/` at 141) | `CHROMIUM` points at it (the tests and `bench/run.ts` already honor it) |
| `dtc` from zypper (1.7.2) | apt has 1.7.0, which prints strings as `"a\0b"` instead of `"a", "b"`, failing `dtb_round_trips_through_dtc` | the script builds dtc v1.7.2 into `/opt/dtc` |
| qemu-user, qemu-img, fonts | absent | apt (`qemu-user`, `qemu-utils`, `fonts-dejavu-core`) |
| `systemd-run --user --scope -p MemoryMax=10G` around heavy runs | "Failed to connect to bus" | run without it, under `timeout`; the container has 15 GiB and nothing else on it, but a leaking test can still take the session down |
| testfloat's tarballs from github.com | the redirect to `codeload.github.com` is refused (403) | `scripts/testfloat.sh` falls back to `git fetch` of the pinned commit |
| Guest images in rootless Podman (`images/build.sh`) | not practical: most images are built in arm64 containers that run natively on the arm64 VM, here they'd run under qemu-user for hours (`buildroot` and `ltp` would build natively: their container is multi-arch), and nested Podman is untested | not attempted; see below |
| macOS-side oracles (`--oracle m4`, `oracle.sh --hvf`, `ssh macmini.lan`) | unreachable | the QEMU oracles (`qemu-aarch64`) work; real-hardware comparisons stay local |
| Chromium 153 decodes H.264 (OpenH264) | Playwright's Chromium has no proprietary codecs | the H.264 cases of `tests/virgl-browser.test.ts` skip; VP9 and AV1 run |
| The damaged-chunk video test writes 8–10 pictures before the error | Playwright's x86_64 Chromium writes 5 of VP9's 10 (2026-10-27, every run, on a commit that touched no `web/`) | `video on WebGL2: a damaged chunk …` (`tests/virgl-browser.test.ts`) skips when `CLAUDE_CODE_REMOTE` is set (2026-11-02); its bound is the dev VM's decoder's, and why this decoder stops earlier is not known |
| The M4's SwiftShader | x86_64 SwiftShader (Vulkan) has 6 color attachments, not 8, and x86's default NaN is negative | nothing to handle: both found real bugs (the renderer's attachments loop, the JIT's FMA) the arm64 VM didn't show |
| `perf`, `wasm-tools`, `../webpc-exp` worktrees | not installed | dev-only; install if needed |
| Benchmarks | x86_64 runner of unknown, shared hardware: a run's samples spread ±20%, `bench/interp/ab.sh`'s A/A rounds up to 3% | absolute numbers are not comparable with the VM's; don't record any. An A/B of builds that the user asks for here (x86_64 is the point) goes through `bench/interp/paired.ts`: arms side by side in one process, paired samples, an A/A arm (docs/benchmarking.md); `bench/interp/yardstick.sh` drops its memory cap without a systemd bus |

## Venus (vk/)

`vk/build.sh native` works here (2026-10-27: a few minutes from nothing; wasi-sdk, Mesa and virglrenderer download
through the proxy), with what `cloud-setup.sh` installs (glslc, glslang, spirv-tools, the Vulkan, zstd and DRM headers,
Mako, meson). Two things the dev VM never showed, handled in `vk/build.sh` and `vk/gen.ts`: meson 1.12 builds
`libvirgl.a` without `libmesa.a`'s objects (built by name), and an x86_64 host's native flags (`-mtls-dialect=gnu2`,
SSE, CET, valgrind, OpenMP) and BLAKE3's x86 assembly are dropped from the wasm compile. Headless Chromium's
SwiftShader gives WebGPU, so `tests/venus-driver.test.ts`, `tests/wgsl.test.ts` and `tests/venus-renderer.test.ts`
run (31 tests, ~20 s). dEQP-VK (`scripts/ci-deqp-vk.sh`) needs `images/deqp/build.sh vk`'s disk and guest, which can't be built here
(arm64 Podman, "Images" below); the user keeps them prebuilt (2026-11-01, built in the dev VM) at
`https://static.gbl08ma.com/diskimages/deqp-vk.ext4` (448 MiB) and `https://static.gbl08ma.com/diskimages/guest-vk.qcow2`
(858 MiB), reachable through the proxy (HTTP redirects to HTTPS; ranges served, so the page can boot them from there
too). Fetch them into `target/deqp/` (`curl -sS --fail -C - -o target/deqp/deqp-vk.ext4 <url>`, the same for the guest; on
2026-11-01 the guest came at ~0.5 MB/s, so ~30 min: run it in the background, and `-C -` resumes one cut by a timeout) and
`bench/gpu/deqp-run.ts vk target/deqp/guest-vk.qcow2` runs on them; `scripts/ci-deqp-vk.sh` as a whole also wants
`images/debian-vulkan` and `images/vkframes`' disks for the programs' replays, which aren't hosted.

## Networking work (net/, tests/net/)

Go modules download through the proxy (Go 1.26 is fetched on demand by `go.mod`'s toolchain line),
and `dockerd` starts (`dockerd &`, root) and pulls Docker Hub images, so the tailnet of
`tests/net/tailnet.sh` can run here. The script calls `podman` (the project never uses Docker); in
a cloud session put a shim named `podman` that execs `docker "$@"` first on `PATH`, outside the
repo. GitHub release downloads (`github.com/.../releases`) are refused by the proxy.

Without a container daemon at all the tailnet runs natively: **`tests/net/tailnet-native.sh`**
(`up|env|key [lasting]|nodes|peer …|register <id>|down`, like `tailnet.sh`; Go builds headscale and
tailscale once into `target/net/tailnet-bin`, `tests/net/tls-proxy.ts` is its Caddy), and
`WEBPC_TAILNET_SCRIPT=tests/net/tailnet-native.sh` points the tests at it (the Rust client's T4 and
T5 were tested that way: `tests/ts-tailnet.test.ts`, `tests/tailscale-browser.test.ts`). The tests
that call `podman exec webpc-peer` directly (`tests/net-tailnet.test.ts`) still need the shim below.
Before that script existed the exit-node work was tested by hand the same way: `go install github.com/juanfont/headscale/cmd/headscale@v0.29.4` and, from an empty
directory, `go install tailscale.com/cmd/tailscaled@v1.102.5 tailscale.com/cmd/tailscale@v1.102.5`
(the versions `tests/net/tailnet.sh` pins), headscale with the config that script writes (paths
changed) behind any TLS proxy that adds `Access-Control-Allow-Origin` on `/key` and passes
WebSocket upgrades (a 20-line Node script will do; there is no Caddy), a userspace `tailscaled` with
`--advertise-exit-node`, and `headscale nodes approve-routes -i 1 -r 0.0.0.0/0,::/0`. Point
`WEBPC_TAILNET_SCRIPT` at a script that prints `tailnet.sh`'s `up` output, and put a `podman` shim
first on `PATH` that answers `exec webpc-peer tailscale ...` with the native `tailscale`.

**The local helper** (`net/webpc-net`, docs/plans/networking-local.md) builds and tests here (Go fetches its
pinned toolchain and the fork through the proxy), and `tests/net-local.test.ts` passed in Chromium (2026-11-01: DNS,
`apt-get update` and TCP straight out, which the container allows). The container has **no IPv6 at all** (no
`AF_INET6` sockets): the helper's probe and the guest's IPv6 out are tested only for being off here. It also hangs `tests/net-tailcat.test.ts`, whose server listens on `::` (`EAFNOSUPPORT`, unhandled, so its `before` never ends; 2026-11-01); the rest of `scripts/ci-net.sh`'s list passes here.

## Images

`images/build.sh` needs Podman and native arm64, so the cloud can't build Alpine, Buildroot, the
Linux kernels, LTP, kvm-unit-tests or litmus. **Debian works**: `node tools/debian.ts` (Node only)
downloads the pinned qcow2 (403 MB, ~10 s) and unpacks its kernel and initrd, and
`WEBPC_DISTROS=debian` then selects the Debian tests. `images/build.sh debian` runs the same on the host (no Podman)
and also writes `.inputs`, which `scripts/ci-debian.sh` and `scripts/ci-machines.sh` check first: use it for those.
`scripts/ci-debian.sh` also checks `linux-snd` (Podman, so not here) and stops; its test list runs without it
(`WEBPC_DISTROS=debian WEBPC_DEBIAN_SLOTS=2 node --test` on the files it names), with `page-debian`, the main page
test, skipped for want of `snd-play` (2026-11-02: the other nine passed). So in a cloud session `scripts/ci.sh` runs
everything except the image-based native tests (`boot`, `kvm-unit-tests`, `litmus`, `ltp`, the
Alpine boots), which it already skips with a message when `images/build.sh --check` fails. Work
that needs those (Buildroot/Alpine step counts, kernel changes) belongs in the local VM; a done
milestone loop still needs a local `scripts/ci.sh` with all images.

**The UEFI firmware** (`images/build.sh edk2`, Podman on arm64) can't be built here either, but its
build is pinned and reproducible, so `scripts/cloud-setup.sh` fetches the deployed page's copy
(`https://vm.tny.im`: the firmware under its hashed name in `assets/`, found in the page's bundled
code, and `EDK2-LICENSES.txt`, as `npm run dist` writes them; `target/images/edk2/` first, where an
older deploy had them), keeps both only if they match `images/SHA256SUMS`, and writes `images/build.sh
--inputs edk2`'s key to `.inputs` (so `--check edk2` passes). The hashed names broke the old fetch
until 2026-10-25. With it, Debian boots on the page (`?machine=debian`). `shell.img` (the Node
firmware test's disk) isn't deployed: that test skips.

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
