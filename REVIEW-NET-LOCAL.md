# Static review: the local network helper (webpc `local` kind + webpc-net)

Ranked by severity. I only read the code: nothing was built or run, and neither repo was changed.

## Medium

### 1. A version mismatch never reaches the page as 4001: Chromium fails the handshake, and the page says "couldn't reach the helper"
- **Where:** webpc-net `helper.go:123` (`Accept` with `Subprotocols: []string{Subprotocol}`), `helper.go:134-136` (the 4001 refusal); webpc `web/local-net.ts:135`, `:158-162`, `:185-192`.
- **What:** coder/websocket's `Accept` sends `Sec-WebSocket-Protocol` only when one of the client's offers matches (`accept.go:141-144`). When the page offers `webpc-net.v2` and the helper speaks only v1 (or the other way round), the response has no subprotocol header. Chromium then fails the handshake ("Sent non-empty 'Sec-WebSocket-Protocol' header but no response was received"). The socket closes with 1006 and never opens, so:
  - the helper's `CloseVersion` branch can't be reached by a browser;
  - the page's `ws.protocol !== LOCAL_SUBPROTOCOL` check in `onopen` is dead code;
  - `onclose` sees `state === 'connecting'` with code 1006 and reports `local-net.unreached` ("check that webpc-net is running"), or `local-net.refused` when the LNA permission was denied for other reasons.
- **Trigger:** the first subprotocol bump, with a user who has an older helper installed (or a newer helper with a cached older page). The user is told the helper isn't running while it is running and logging "refused … doesn't speak webpc-net.v1".
- **Fix direction:** the helper accepts any offered `webpc-net.*` protocol so the handshake completes, then closes with 4001. Or the page offers every version it knows.
- **Confidence:** high on the mechanism (coder/websocket source and Chromium's documented handshake check). The tests can't show it because both ends always match.

### 2. The page takes another guest's DHCPACK as its own lease when two machines share a helper
- **Where:** webpc `web/local-net.ts:95-111` (`dhcpAck`), `:177-181`; the netmap at `:210`, shown by `web/app/network.ts:144-145`.
- **What:** gvisor-tap-vsock's DHCP server (insomniacslk `server4/server.go:100-105`) answers a client that has no address yet at 255.255.255.255. The helper's switch floods that broadcast to every link. `dhcpAck` checks neither `chaddr` (`f[d+28..d+34]`), `xid`, nor the destination MAC, so every connected page records every guest's first ACK.
- **Trigger:** machine A is connected to the helper and machine B (another tab, or a second adapter) boots or flaps on the same helper. A's Network menu now shows B's address, and A's `localNetmap` carries it. The README and docs advertise this setup ("every page connected to one helper is on the same switch").
- **Fix:** match `chaddr` against the card's MAC (or the frame's destination against it), or remember the `xid` of the guest's own DISCOVER/REQUEST.
- **Confidence:** high.

## Low

### 3. The 4003 refusal is lost for origins over about 72 bytes
- **Where:** webpc-net `helper.go:130`.
- **What:** the close reason is `"origin not accepted: run the helper with --origin " + origin`. coder/websocket refuses reasons over 123 bytes (`close.go:309-312`). `writeClose` then returns an error, `Close` drops the TCP connection, and no 4003 frame is sent. The browser has already fired `onopen`, so the page shows the generic `helperClosed` instead of the origin message.
- **Trigger:** an origin of 73 bytes or more, such as a cloud dev environment's preview URL. A developer then can't see the one hint that tells them which `--origin` to pass.
- **Confidence:** high.

### 4. A pairing link opened in a tab that already shows the page does nothing, and the token stays in the address bar
- **Where:** webpc `web/app/main.ts:311-319`. There is no `hashchange` listener anywhere in `web/app`.
- **What:** `#net=` is read once, at startup. Pasting `https://vm.tny.im/#net=ws://…` into a tab already on `https://vm.tny.im/` is a same-document fragment navigation, with no reload. The wizard never opens and the token stays in the URL bar and in session history, contrary to the comment's "it leaves the address at once".
- **Confidence:** high.

### 5. `build.sh <version> <outdir>` runs `rm -rf` on whatever directory it is given
- **Where:** webpc-net `build.sh:73-75`.
- **What:** `out=${2:-…/dist}`, made absolute, then `rm -rf "$out"` with no check.
- **Trigger:** `./build.sh v0.2.0 ~` or `./build.sh v0.2.0 ..` deletes the home directory or the parent. A typo in a documented argument should not do this.
- **Fix:** refuse an existing non-empty directory that holds no previous build's `SHA256SUMS`, or build into `mktemp -d` and move the result.
- **Confidence:** high (a footgun, not a bug in normal use).

### 6. The release workflow publishes when run by hand on a tag, though its header says a manual run doesn't release
- **Where:** webpc-net `.github/workflows/release.yml:2-4` (the comment) against `:53` (`if: github.ref_type == 'tag'`).
- **What:** `workflow_dispatch` with a tag picked as the ref has `ref_type == 'tag'`, so "Publish" runs `gh release create`. Re-running to compare an existing tag's builds would create a release, or fail at the end because one already exists.
- **Fix:** add `github.event_name == 'push'` to the condition.
- **Confidence:** high.

### 7. Parallel test files race on fetching the helper's source and on writing its binary
- **Where:** webpc `tests/webpc-net.ts:30-51`, `:65-70`.
- **What:** `local-net.test.ts`, `local-release.test.ts` and `page-local.test.ts` all call `helperSource()`, and `npm test` runs them in parallel processes. Each one checks `fetched(DIR)`, then later does `rmSync(DIR)` and `renameSync(tmp, DIR)`. If process B checks `fetched(DIR)` (false) just before A renames its copy in, B then deletes A's freshly placed `DIR`. A's final `fetched(DIR)` can then fail, so its tests are wrongly SKIPPED, or A's `build.sh --install` or `go build` can be reading `DIR` while it is removed.
- **Also:** `buildHelper` writes `target/net/webpc-net` in place from both `page-local` and `net-local`. Go copies across filesystems (tmpfs work dir to disk), so the other process can `exec` a half-written binary.
- **Trigger:** the first run on a fresh clone, or after the pin moves.
- **Fix:** use an exclusive lock file, or rename only when `DIR` doesn't exist and treat `EEXIST`/`ENOTEMPTY` as success; build to a temp name and rename.
- **Confidence:** medium (the timing windows are narrow).

### 8. A raw MessagePort net adapter now drops every frame the guest sends
- **Where:** webpc `web/devices.ts:502`, `:529`.
- **What:** `let framesMode = a instanceof MessagePort;` while `framesTo` stays undefined. `out` then sends to `framesTo?.send(f)`, a no-op, so every frame the guest transmits is dropped. The adapter built for that case at `:518` (`portAdapter(a, receiveFrame)`) is never sent to. The `{type: 'net', adapter: port}` form is still in `NetSpec` and documented in `web/net.ts:7`.
- **Trigger:** no caller uses it today, so this is a latent break of a documented API. The fix is `framesMode = false` there, or `framesTo = adapter`.
- **Confidence:** high on the code path. The impact is latent.

### 9. Moving the card to the helper's frames doesn't clear the page gateway's lease, so its RA timer can keep advertising a default route
- **Where:** webpc `web/gateway.ts:553` (`'frames'` calls `path.frames(...)` and leaves `lease` as it was; compare `'gateway'` at `:554-557`, which nulls it) and `:267` (the `setInterval(advertise, 60 s)` keeps running in frames mode, delivering through `receiveFrame`).
- **What:** if the previous client's lease is still set when the local client takes the port, the gateway keeps sending its RA every 60 s. That would happen when its `detach` hit the 3 s timeout in `startLocal`/`startTailcat`, or a worker died before posting `lease: null`. The RA has lifetime 1800 and a default route via the page gateway's MAC, which doesn't exist on the helper's switch. The guest then gets a second IPv6 default route into a black hole.
- **Fix:** handle `'frames'` the way `'gateway'` is handled: null the lease and call `leaseChanged()`, so one lifetime-0 RA goes out and the timer stops.
- **Confidence:** medium (it needs a detach that didn't complete gracefully).

### 10. `parseLocalURL` can throw instead of returning `{error}`
- **Where:** webpc `web/local-net.ts:82`.
- **What:** `decodeURIComponent` throws `URIError` on a malformed `%` escape, as in `…#net=ws://127.0.0.1:8740/abc%`. In the wizard (`NetWizard.svelte:127`) it surfaces as a raw `URIError: URI malformed` instead of the catalog's `local-net.notLink`. The words-from-the-catalog rule is broken.
- **Confidence:** high.

### 11. A helper on a port Chromium blocks gives a raw constructor error, not a sentence
- **Where:** webpc `web/local-net.ts:135` (`new WebSocket(url, …)`), called from `web/local-net-worker.ts:23`.
- **What:** `parseLocalURL` accepts any port, and the helper's `--listen` accepts any port. Chromium's WebSocket constructor throws synchronously for its restricted ports (for example 6000, 6665-6669, 10080). The throw escapes the worker's `onmessage`, so `startLocal`'s `worker.onerror` rejects `running` with a plain `Error(e.message)`. The page shows a developer string where a `MsgError` should be.
- **Confidence:** medium (based on Chromium's bad-port behaviour for the WebSocket constructor).

### 12. Two machines on one helper can end up with the same IPv4 address after the helper restarts
- **Where:** webpc `web/devices.ts:504-509` (no flap on a reconnect to the same helper, by design; docs/local-helper.md "a reconnect … doesn't flap it"), together with gvisor-tap-vsock's in-memory `IPPool` (`services/dhcp/dhcp.go:35`, `GetOrAssign` by MAC, first come first served; the requested IP is ignored).
- **What:** after the helper restarts, its pool is empty while the guests keep their leases. Whichever guest renews first gets `.2` in its ACK, even if it held `.3`, while the guest that held `.2` keeps using it until its own renewal, up to the 30-minute T1. Both use `.2` in the meantime.
- **Confidence:** medium. It needs two machines, a helper restart, and renewals in the "wrong" order.

### 13. Possible bypass of the default "no host loopback" over UDP to 0.0.0.0 (not verified: worth one test)
- **Where:** webpc-net `helper.go:61-83` (the config: NAT only for `--host-loopback`), and gvisor-tap-vsock `services/forwarder/udp.go:17-37`, which refuses only link-local and 255.255.255.255 and then dials the destination as given.
- **What:** gVisor drops packets to 127/8 and ::1 arriving on the NIC (`ipv4.go:876-889`), and TCP to 0.0.0.0 (`transport_demuxer.go:587`). I found no such check for UDP to 0.0.0.0. Dialing `0.0.0.0:<port>` on Linux or macOS reaches the host's loopback. A guest with raw sockets, or any page on the same switch, might reach host loopback UDP services that the README says the guest can't reach without `--host-loopback`.
- **Confidence:** low. I couldn't confirm statically that gVisor's promiscuous NIC delivers a UDP packet to 0.0.0.0 to the forwarder. A helper test with a raw UDP packet to 0.0.0.0 settles it, and blocking 0.0.0.0/8 (and `::`) in the forwarder or a `link.learn` filter would close it.

### 14. `LICENSES.txt` depends on the host's architecture
- **Where:** webpc-net `licenses.sh:36`.
- **What:** `GOOS=$os go list -deps` sets neither `GOARCH` nor `CGO_ENABLED` (it inherits `CGO_ENABLED=0` only through `build.sh`). The module set is computed for the host's architecture, while the release ships amd64 and arm64 for each OS. A dependency imported under one architecture's build tags only would be listed on one runner and not the other. The release job's `diff -r` would refuse to publish, and its license would be missing from an x86-only build.
- **Fix:** loop over both architectures as well.
- **Confidence:** low (no such module today, as far as I can tell).

## Checked and found sound
- The helper's origin check comes before the token check, so a hostile origin can't probe tokens.
- The constant-time token compare.
- The loopback-only `--listen` check.
- `link.Write` never blocks the switch, and the 4 MiB cap drops whole frames only.
- The frames `markRouter`/`rewriteRA` return are the same length, so the length prefix stays right.
- The writer's double-buffer reuse.
- `SetReadLimit(1<<20)` and the page's batch limit agree: the library adds 1, so exactly 1 MiB passes.
- The `framesOf`/`learn` framing checks.
- `build.sh --install` argument order.
- The install lines in `local-release.ts` match `build.sh`.
- The hash-failure paths `rm` the download before it runs.
