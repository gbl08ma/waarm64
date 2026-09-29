# webpc

A whole-system AArch64 (arm64) emulator for the browser. It JIT-compiles guest code to
WebAssembly and runs unmodified arm64 Linux: here, Debian 13, with its console on a screen you
type into and a serial terminal beside it. Everything runs in the page; nothing is emulated on a
server.

## Start

You need **Node 26** or newer and **[rustup](https://rustup.rs)** (with a C compiler for Rust's
build scripts: Xcode's command line tools on macOS, gcc or clang on Linux). Then, in a clone:

```sh
npm start
```

It checks those, installs the npm packages, builds the emulator core (Rust to WebAssembly, with the
nightly pinned in `rust-toolchain.toml`, which rustup installs the first time: ~700 MB; the build
takes ~10 s on an M4, longer on slower machines), downloads Debian's
official nocloud image (400 MB, checked against its pinned SHA512), takes its kernel and initrd
out, and serves the page on `http://127.0.0.1:8080/`. Open that URL in **Chromium or Chrome**
(other browsers aren't supported yet). Log in as `root` (no password). The disk is kept in the
browser's storage across reloads; the page's **Reset disk** goes back to the image as published.
Run `npm start` again after pulling: it redoes only what changed (with nothing to do it serves in a fraction of a second).

`PORT=8081 npm start` picks another port (the saved disk belongs to the address, so another port
starts from a fresh disk). `WEBPC_DL=<dir>` shares the download between checkouts.

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
[`THIRD_PARTY.md`](THIRD_PARTY.md)).
