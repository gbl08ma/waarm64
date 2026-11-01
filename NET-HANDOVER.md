# NET: the local network helper — handover

The plan and its decisions: [docs/plans/networking-local.md](docs/plans/networking-local.md) (§1 binds). The helper's
own docs: [net/webpc-net/README.md](net/webpc-net/README.md), [CLAUDE.md](net/webpc-net/CLAUDE.md),
[THIRD_PARTY.md](net/webpc-net/THIRD_PARTY.md). There's no kickoff file: the user's brief is the plan, with the changes
of 2026-11-01 below.

## The user's changes to the plan (2026-11-01)

- The helper lives in **`net/webpc-net/`** in this repository during early development, with its final module path
  `github.com/gbl08ma/webpc-net`, its own README, THIRD_PARTY.md and CLAUDE.md, so it moves out whole later. That
  move is also what unblocks releases, reproducible builds checked against them, and `go install`.
- **IPv6** through gvisor-tap-vsock's unmerged [#745](https://github.com/containers/gvisor-tap-vsock/pull/745),
  taken by a `replace` to evidolob's fork at one commit (the user chose this over a fork of ours or vendoring).
  **On by default, but never promised when the helper's host can't route it**, as tailcat and the tailnet do it
  (plan §5).

## Done (L0, first session, 2026-11-01, a cloud session)

- **The helper**, `net/webpc-net/`: about 650 lines of ours (`main.go` flags and the pairing link, `helper.go` the
  network's settings, origin/token/subprotocol checks with close codes 4001/4003/4004, `link.go` the WebSocket as the
  switch's `net.Conn` with frames batched per message and a bounded queue, `ra.go` and `reach6.go` IPv6 out, `token.go`).
  `go test -race ./...` (~10 s): a gVisor-netstack guest over a real WebSocket, the refusals, DHCP, the router
  advertisement's lifetime following the probe both ways (planted bugs caught), TCP 1 MiB each way to the host's
  loopback. `build.sh`: the six targets, 12.5–13.8 MB (4.7–5.3 MB gzipped), byte-identical over two clean builds on one
  host.
- **The spike on the page**: web/local-net.ts (the client: framing, the close codes as messages), `?localnet=` or
  `#net=` at a machine's start puts its first adapter's frames on the helper (web/app/main.ts, `frames` in the start
  message, web/app/worker.ts), `tests/browser/netguest.html?ws=` for tests. `tests/local-net.test.ts` (Node).
- **`tests/net-local.test.ts`** (in `scripts/ci-net.sh`) passed in the cloud's Chromium: Debian on the page took the
  helper's lease at boot (login at 79 s, the lease by 80 s), resolved through it, moved 8 MiB each way to a server on
  this machine (65 Mbit/s down, 48 up, JIT guest in the cloud container: not a benchmark), ran `apt-get update`, had
  its address in the /64 and pinged the gateway, no IPv6 default (the container has no IPv6), curl's IPv6 failing at
  once and deb.debian.org connecting over IPv4 in 0.06 s; a wrong token and another origin refused from Chromium.

## Next

1. **L0's remaining items, in the dev VM:** the plan's L0 "Left, in the dev VM" (ci-net.sh there, Local Network
   Access, the measurements against tailcat, IPv6 on the Mac). Its item 3 settles the batching below.
2. **The page's batching from the guest is 1.00 frames a message** (the device worker posts each frame as its own
   port message, so the client's microtask batch never holds two); the helper's side batches (2.62). Batch in the
   device worker or flush on the socket's `bufferedAmount`, after measuring.
3. Then L1 (the README's install lines, the release's license file: THIRD_PARTY.md says what it needs), L2 (the
   connection kind replacing `?localnet=`), L3, L4 as the plan says.

## Found (worth not re-discovering)

- The fork's `go.mod` keeps `module github.com/containers/gvisor-tap-vsock`, so only `replace` can use it; `go install
  module@version` refuses any module with a `replace`. The fork needs Go ≥ 1.26.
- #745's switch answers router solicitations only, with a 1000 s router lifetime, and never advertises unsolicited:
  without the helper's own solicitations on the guest's behalf (on a reach change, a new MAC on a link, every 5 min) the
  guest's IPv6 default would lapse after ~17 minutes.
- #745's ICMP forwarder is IPv4's only: the guest can't ping the internet over IPv6 (the gateway answers its own).
- The library's switch writes to every link under one lock (`txBuf`), so the link's `Write` never blocks on the page:
  a bounded queue that drops past 4 MiB. The first version of the writer's buffer swap aliased two buffers when a
  wake found nothing queued (caught by `-race` and a framing panic in the TCP test).
- The cloud container has no `AF_INET6` at all: the probe's "reached" side is tested over IPv4 loopback in Go.
