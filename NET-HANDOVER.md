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

## State

**L0 is done** (2026-11-01): the helper in `net/webpc-net/`, `tests/net-local.test.ts` in `scripts/ci-net.sh`, and L0's
questions answered in bench/net/REPORT.md "The local helper". **L1 is done** (2026-11-01, cloud) but for the second
host's build check, and **L2** but for what needs a person or the dev VM: the plan's "Done" and "Left" under each.

## The user's answers (2026-11-01, for L2)

- **A link flap** (virtio-net's `STATUS`, down and up) is allowed, guest-visible as it is, for **any kind**: whenever
  what an adapter's guest holds would change (the path between the page's gateway and the helper, or the gateway's
  lease address differing from the one the guest was given), never for a reconnect to the same address (networkd drops
  an adapter's addresses on carrier loss, which cuts its TCP connections).
- The move to its own repository: after L2, at L3's start (the user's OK to that timing).

## Next

1. **L2's left, the user's:** the helper's default `--mtu`, which stays
   1500: 65520 is measured, about 1.7× down and 1.6× up (bench/net/REPORT.md "The stalled uploads"), and the guest's UDP
   does reach the internet at that size (the plan's "The MTU"). L2's CI passed in the dev VM on 2026-11-02, and the
   helper's build matches the x86_64 sums on aarch64.
2. **L3** (the move to `gbl08ma/webpc-net` first): a test from a public origin (`--ip-address-space-overrides=127.0.0.1:<port>=public` and CDP's
   `Browser.setPermission` for `loopback-network`; Playwright 1.63's `grantPermissions` doesn't know the name), then the plan's list. L4 as the plan says.

## Found (worth not re-discovering)

- **systemd-networkd ignores a carrier loss under 5 s** when the DHCP lease's MTU isn't the link's original one
  (`link_carrier_lost`, systemd 257: against drivers that reset on an MTU change, systemd#18738), as the page's leases'
  1280 isn't virtio's 1500: a 1 s flap, then a 5 s one (back in 4.95 s), changed nothing at the boot's first lease,
  while after a `systemctl restart systemd-networkd` (the original MTU is then 1280) a 1 s one worked. The kernel saw
  each (`carrier_changes`, networkd's "Lost carrier"). `FLAP_MS` is 7 s. `tests/browser/netguest.html?debugnet=1`
  logs networkd at debug from the boot.

- **A page's message past the helper's 1 MiB closes the socket**, and the card stays up on frames to nothing: to a guest that's
  a stall, then new connections failing in 2-3 s. The page's error and the helper's log say so at once (`bench/net/local.ts` prints them).
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
- gVisor's neighbor advertisements carry the Router flag only on a forwarding stack: Linux then drops the default route 5.4 s after traffic
  pauses. `markRouter` fixes it; a default route that vanishes with nothing logged on either side is this kind of thing.
- `go test -race`: an idle gVisor stack spins on every core under the race detector (0 CPU without it), and `VirtualNetwork.Close` doesn't
  stop the stack, so the tests destroy it themselves. Performance of anything under `-race` means nothing here.
- Lima forwards the VM's loopback ports to the Mac's: a tunnel's local port and a helper on the Mac need different ports.
- A dummy interface in `unshare -Urn` holding the probe's address makes "the internet" removable under a running guest.
