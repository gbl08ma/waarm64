# waarm64

A whole-system AArch64 (arm64) emulator for the browser. It JIT-compiles guest code to
WebAssembly and runs unmodified arm64 Linux from a disk image you open, with its screen in the page
and a serial terminal beside it. Everything runs in the page; nothing is emulated on a
server.

## Start

You need **Node 26** or newer and **[rustup](https://rustup.rs)** (with a C compiler for Rust's
build scripts: Xcode's command line tools on macOS, gcc or clang on Linux). Then, in a clone:

```sh
npm start
```

It checks those, installs the npm packages, builds the emulator core (Rust to WebAssembly, with the
nightly pinned in `rust-toolchain.toml`, which rustup installs the first time: ~700 MB; the build
takes ~10 s on an M4, longer on slower machines), builds the UEFI firmware (EDK2, in a rootless
Podman container, ~1 min the first time), builds the page (Vite, ~1 s) and serves it on `http://127.0.0.1:8080/`. Open
that URL in **Chromium or Chrome** (other browsers aren't supported yet), then **[Open disk…](ui:machine:power-actions.openDisk)** (or
drop a file on the page): an arm64 Linux disk image that boots through UEFI, as qcow2, raw or an ISO,
such as a distribution's generic cloud image or its installer. What the machine writes is kept in the browser's storage,
per file, across reloads; **Save disk** takes it out (a changes file or a whole disk), **Reset
disk** goes back to the image as it was.
Run `npm start` again after pulling: it redoes only what changed (with nothing to do it serves in about a second).

`PORT=8081 npm start` picks another port (what the page keeps belongs to the address, so another
port starts without it).

**In a VM or on another machine:** the server listens on 127.0.0.1 only, and the page needs a
secure context (localhost or HTTPS) for its shared memory. Forward the port and open the URL on
your side:

```sh
ssh -L 8080:127.0.0.1:8080 <the machine running npm start>
```

## More

[`docs/`](docs/README.md) says how it works (start with [the page](docs/frontend.md)),
[`PLAN.md`](PLAN.md) where it's going. Developing: [`CLAUDE.md`](CLAUDE.md) has the commands and
conventions; `scripts/ci.sh` runs every test. MIT licensed ([`LICENSE`](LICENSE),
[`THIRD_PARTY.json`](THIRD_PARTY.json)).
