# NET: the local network helper — handover

The plan and its decisions: [docs/plans/networking-local.md](docs/plans/networking-local.md) (§1 binds). The helper's
own docs: README.md, CLAUDE.md and THIRD_PARTY.md in its repository, `github.com/gbl08ma/webpc-net` (private for now;
checked out at `../webpc-net` in the dev VM). There's no kickoff file: the user's brief is the plan, with the changes
of 2026-11-01 below.

## The user's changes to the plan (2026-11-01)

- The helper lived in `net/webpc-net/` here during early development; **it moved to `gbl08ma/webpc-net` on
  2026-11-02** (history kept). Its releases are its own GitHub Actions', separate from webpc's deploy (the user's,
  2026-11-02); webpc's tests build it at a pinned commit (`tests/webpc-net.ts`, the user's choice), and a release is
  published as soon as its two runners' builds match (no draft).
- **IPv6** through gvisor-tap-vsock's unmerged [#745](https://github.com/containers/gvisor-tap-vsock/pull/745),
  taken by a `replace` to evidolob's fork at one commit (the user chose this over a fork of ours or vendoring).
  **On by default, but never promised when the helper's host can't route it**, as tailcat and the tailnet do it
  (plan §5).

## State

**L0 is done** (2026-11-01): the helper, `tests/net-local.test.ts` in `scripts/ci-net.sh`, and L0's
questions answered in bench/net/REPORT.md "The local helper". **L1 is done** (2026-11-01, cloud; the second host's
check in the dev VM 2026-11-02). **L2 is done** (2026-11-02): the user kept the helper's default `--mtu` at 1500, for every
protocol's sake (65520 stays a flag: about 1.7× down and 1.6× up, bench/net/REPORT.md "The stalled uploads"); L2's CI
passed in the dev VM on 2026-11-02, and the helper's build matches the x86_64 sums on aarch64.

**The move is done** (2026-11-02): `github.com/gbl08ma/webpc-net` with `ci.yml` (vet and `-race` tests, ~2 min, on
pushes touching code) and `release.yml` (~3 min on each of two runners). **v0.1.0 was released** (from commit
`cf1c15b`) and the page's wizard offers its install
lines (`web/local-release.ts`). Not deployed. The lines download from a private repository until the user makes it
public: nobody has run them against the real release yet (the Linux line ran against a `file://` copy at L1).

**L3 is done** (2026-11-02): `tests/page-local.test.ts` from a public origin (granted through CDP, connected; refused,
the menu's words for it; a planted `loopbackRefused` that never says denied is caught), and how it works in its own
page, docs/networking/local-helper.md, with the loose ends in backlog.md "Network".

**The out-of-context review** (`review/net-local`, 2026-11-02): 14 findings, 13 fixed from failing tests (plan §4 "L3"),
the helper's in v0.1.1; one in the backlog. **v0.1.2** prints a pairing link for each `--origin` again (the
user's: v0.1.0 had dropped them).

**v0.2.0** (2026-11-03): two guests on two sockets tested (each its own lease, TCP between them), and each guest's
IPv4 address kept across a helper's restart (`leases-<address>` beside the token, from the library's pool, the 100
most recently connected MACs). Three out-of-context reviews before the release (the user's rule now: a release only
after one); the page offers it and the tests pin its code (`41ffc67`: a fix to its tests after the tag). New in the
backlog: every new machine has the same MAC, so two on one helper share an address; a connection shared by several
machines (the user's idea, low priority).

## The user's answers (2026-11-01, for L2)

- **A link flap** (virtio-net's `STATUS`, down and up) is allowed, guest-visible as it is, for **any kind**: whenever
  what an adapter's guest holds would change (the path between the page's gateway and the helper, or the gateway's
  lease address differing from the one the guest was given), never for a reconnect to the same address (networkd drops
  an adapter's addresses on carrier loss, which cuts its TCP connections).
- The move to its own repository: after L2, at L3's start (the user's OK to that timing).

## Next

1. **L4, with the user:** the deploy (the wizard offers v0.1.0's install lines) and making `gbl08ma/webpc-net` public;
   then run the install lines against the real release on Linux, the Mac and, if one is at hand, Windows
   (backlog.md "The local helper's loose ends").
2. At the track's end: the plan's outcome is docs/networking/local-helper.md already; delete this handover, mark the plan done.

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
