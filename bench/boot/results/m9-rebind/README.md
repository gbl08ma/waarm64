# Rebinding a module's tails once their blocks are compiled (2026-11-05)

`bench/boot/REPORT.md` "Rebinding a module's tails once their blocks are compiled: 5% slower"; not kept.

- `rebind.patch`: the change against main at `98ebbd9b` (branch `wip/rebind`, ABI 61): sites (an imported function,
  its length global, by VA a host-address global), the cache's waits and rebindings, `env.jit_rebind` in
  `web/vm.ts`, three tests in `tests/jit.test.ts`, the docs it had (docs/jit.md "Rebinding", docs/abi.md).
  `WEBPC_NO_REBIND=1` builds it without sites, `WEBPC_NO_BIND=1` with sites never bound.
- `mac/`: Firefox's pages session on the Mac host (`bench/gpu/sway-mac.sh` from `pages.webpcsnap`, Chrome for Testing
  157), `results.json` and `stalls.json` (busy MIPS) a session, the JIT's log; `rbmac-*` without sites (`off`) and
  with rebinding (`on`), 3 rounds alternated; `rbmac2-*` without sites and with sites never bound (`nobind`), 2 rounds;
  `summary.txt`.
