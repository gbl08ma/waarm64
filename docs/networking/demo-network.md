# The demo network

The fourth kind of connection beside a tailnet, tailcat and the local helper ([adapters.md](adapters.md) §1): **`demo`**,
a public server that gives each page's machine a network of its own whose way out reaches only the hosts its owner's
allowlist names (for the Alpine demo, `dl-cdn.alpinelinux.org` on port 443, so `apk add` works out of the box). It is
DEMO-KICKOFF.md's decisions 1–10 (the user's, 2026-11-18); the plan is [plans/first-demo.md](../plans/first-demo.md) §3.2.

The server is its own repository, [`github.com/gbl08ma/waarm64-demonet`](https://github.com/gbl08ma/waarm64-demonet)
(private for now), a fork of the local helper ([local-helper.md](local-helper.md)) with its history: Go over
gvisor-tap-vsock, a network per WebSocket, per-visitor budgets, the allowlist at the resolver, the dial and the first
bytes, egress direct, through SOCKS5 or WireGuard. Its README says how it runs and what it's configured with (one TOML
file), and its **PROTOCOL.md** specifies `waarm64-demonet.v1`, which the page's client is written from. This page is
waarm64's side.

## The kind

- **`demo`** (web/app/connections.ts): its record holds the server's URL, `demo.url`, `wss://…` (`parseDemoURL`;
  `ws://` only on this computer, for testing a server of one's own). Not a secret: no token, no pairing, and no Local
  Network Access prompt (the server is public). The default is `DEMO_URL` in web/demo-net.ts, **`wss://demonet.tny.im/`,
  a placeholder** until the user hosts the fork (DEMO-HANDOVER.md).
- **No lock** (`exclusive`: false): any number of machines, in any tabs, and several adapters of one, run it at once,
  each with a socket of its own and so a network of its own on the server (adapters.md §1 rule 4's exception).
  `NetClaims.claim` takes no Web Lock for it and `PageNetwork`'s "on another adapter" refusal doesn't apply.
- **Made by the page itself** (adapters.md §1 rule 2's exception): `demoConnection` (web/app/net-demo.ts) finds the
  browser's stored demo connection to a URL or makes one ([Demo network](ui:network:connections.demoNetwork)), and
  `attachDemoNetwork(store, machine, adapter = 0, url?)` attaches a stored machine's adapter to it: what a demo's
  definition asks for with `demo.network: "demo"` (DEMO loop 4's field). The Network wizard makes one too
  ([The demo network](ui:network:NetKindStep.kind.pickDemo), its server under [Another server](ui:network:NetDemoStep.demo.advanced)).
- **A primary as the local helper's is:** its DHCP is the server's, which always gives a default route, so a connected
  demo adapter ranks first (`primaryOf`). The server's guests are IPv4 only: no IPv6 default comes from it
  (`primary6Of` looks to the other adapters).

## The client

web/demo-net.ts `startDemoNet`, in a worker of its own (web/demo-net-worker.ts, started by `startDemo` through the
local helper's `framedClient`). Like the helper's client it moves the card's frames over the socket in QEMU's framing
(a batch per timer turn, under `DEMO_MAX_MESSAGE`, 1 MiB) with no gateway in the page (`FramePath`). Besides:

- **Control messages** (text, JSON, codes and numbers only) kept as the adapter's status (`DemoStatus`, in the network
  map's `demo`): `hello` (the lane, the gateway, its `/status` URL), `budget` (the day's bytes, `used`/`limit`/`resets`),
  `lane` (`none` when the budget is spent, `fast` when it's back), `refused` (the total and the last four), `notice`
  (`restart-at`, `none`). `closing` is read with the close that follows. Unknown types, fields and notices are ignored
  (v1's rule). Some are also **notices** for the message bar (`DemoNotice`, posted as `{type: 'notice'}`).
- **Frames wait for `hello`:** those the guest sends while a socket opens are held (at most `DEMO_HOLD`, 256 KiB) and go
  out after it, in order; while the client waits to try again they're dropped, as a link drops them.
- **`budget?`** every minute while the guest's traffic moves the budget (`BUDGET_ASK_MS`), so the status's numbers
  stay near the server's; never while idle (text doesn't keep a network from going idle on the server, but it costs).
- **A restarted machine keeps the socket** (`setFrames`): its network and the visitor's connections per minute aren't
  spent on a new one.

**Reconnecting**, by the close codes (PROTOCOL.md "Close codes"):

| Close | The client |
|---|---|
| 4012 `idle` | waits, holding no network, until the guest next sends a frame; then a new socket, that frame held for its `hello` |
| 4011 `maintenance`, 4013 `session`, 4008 `connections` | tries again at `reconnect_after` plus a random delay of up to 30 s (`DEMO_JITTER_MS`) |
| 4008 `guests`, `site`; 4009 `full` | backs off, at least 30 s (`CROWDED_MS`) |
| 4010 `bytes` | waits until `resets` (the next UTC midnight) plus the random delay |
| never opened (1006) | backs off: 1 s, doubling, to 2 min, the second half of each delay random; a socket that lived `HEALTHY_MS` (30 s) past its `hello` resets it |
| opened, closed without `closing` | the same backoff (from its start only after a socket healthy that long: a server that drops each socket right after `hello` is backed off); said in the message bar once per outage (a lost socket again before one was healthy isn't said again) |
| 4001, 4003, 1002, 1009, a malformed message | closed for good: the menu's [Couldn't connect](ui:network:network-view.couldntConnect) with the reason, and its Retry |

## On the page

The words are the catalog's (web/app/demo-view.ts; codes to keys, a note each):
- **The Network menu's status** (and the Network tab's, the status bar's item): connecting, connected with the guest's
  address, idle, connected but the day's allowance used up (until when), or waiting with why and when it tries again
  (unreachable, lost, too many from this address or its site, too often, full, the allowance spent, maintenance, the
  session's end). Under it: the day's budget used of its limit and when it resets; the destinations refused, as a count
  with the last few names, newest first; a restart announced.
- **The message bar** (`PageNetworkOptions.notify`, `Messages.notify`): 80 % of the day's budget crossed (a notice that
  closes itself), the budget spent (100 %, the lane `none`, or a new socket's 4010: a warning that stays), the
  allowance back, a restart announced (when, and when it's back), a connected socket lost.
- **The adapter's details**: what the connection is, the server's URL, and `curl http://<gateway>/status`, the same
  numbers inside the guest (the fork's `/status`; the alpine-demo image's motd says so).

## Tests

- `tests/demo-net.test.ts` (`npm test`, Node): the client against a fake server on a fake clock: the subprotocol, the
  frames held until `hello` (and the hold's bound), every control message kept and the notices it gives, 4012's
  reconnect at the guest's next frame, `reconnect_after` and its random delay for 4011/4013/4008, the 30 s floor of
  4008/4009, the backoff's steps and cap, a lost socket said once, 4010 until `resets`, the closes for good, `close()`
  leaving no timer, `budget?` only while traffic moves, a restart's new port on the same socket; and the words of the
  status, its details and the notices.
- `tests/net-live.test.ts`: two tabs and two adapters of one machine on one demo connection at once, no lock taken; the
  demo adapter the primary; its notices reaching `notify`.
- `tests/page-demonet.test.ts` (`scripts/ci-net.sh`, ~2 min): Alpine's cloud image on the page against the real server
  on loopback (no TLS, the test page's origin in its config), built with Go at the commit `tests/waarm64-demonet.ts`
  pins: the lease and `/status`; a name off the allowlist refused, counted and named in the menu; a restart announced by
  a config reload (the message bar), the server stopped (4011, the menu's wait) and started again (the page back by
  itself); a small budget spent by the guest's pings (80 % in the message bar, then used up, then 4010's wait in the
  menu).
- The server's own `go test -race ./...`, in its repository.

**The pinned commit:** `tests/waarm64-demonet.ts` (`WAARM64_DEMONET_COMMIT`), fetched with git into
`target/net/waarm64-demonet-src` over HTTPS or else SSH (tests/go-pinned.ts, shared with the helper's pin), built into
`target/net/waarm64-demonet`; `WAARM64_DEMONET_SRC=../waarm64-demonet` builds a checkout of yours instead. Where it
can't be fetched (a cloud session, while the repository is private) the test says SKIPPED. Move the pin with a change
of the server the page needs, after its tests passed.
