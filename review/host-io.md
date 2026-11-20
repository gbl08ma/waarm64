# Static review: networking, USB, input, sound, guest agent (web/*.ts)

Scope: web/net.ts, ip6.ts, reach6.ts, gateway.ts, room*.ts, tailscale*.ts, tailnet-worker.ts, tailcat*.ts,
ts-client.ts, ts-wasi.ts, demo-net*.ts, local-net*.ts, names*.ts, usb*.ts, webusb.ts, webhid.ts, hid-descriptor.ts,
input.ts, snd.ts, audio*.ts, vsock-device.ts, agent-frame.ts. I read the code only: nothing was run. Where a finding
depends on code outside the slice (web/app/usb-live.ts, web/devices.ts), I read that code too and say so.

Confidence labels: **confirmed** means I traced the code path and the defect follows from the code as written.
**plausible** means the code path is real, but whether it fires depends on timing or on a peer's or the browser's
behavior that I can't see from the code.

---

## 1. Real defects (ranked)

### D1. Asking for the microphone holds up playback until the user answers the permission prompt (confirmed)
`web/audio.ts:346-348` (`queue`), `:351-389` (`openMic`), `:404` (`play`).
`PageAudio` runs every context change on one promise chain (`this.chain`). `openMic` awaits
`navigator.mediaDevices.getUserMedia` (line 365), and that call doesn't settle until the user answers the browser's
prompt. Each `play(rate)` queued after it (from a `start` message), `closeMic` from `attach`/`detach`, and `setMic` all
wait behind it.
**Scenario:** the guest opens capture and playback together: a call app, `arecord | aplay`, or Firefox in the guest
asking for the microphone while a page plays sound. The first time, the prompt appears and the guest's sound stays
silent until the user clicks. The device worker's own clock keeps the guest running, so the guest doesn't notice.
If the user ignores the prompt, there is no sound at all. Restarting the machine meanwhile (`attach`) is queued behind
the prompt as well.
**Fix:** give playback and the microphone separate chains (`playChain` and `micChain`). Only `closeMic`/`openMic`
need ordering with each other, and the playback context never needs to wait for the microphone.

### D2. A USB detach while a WebUSB or WebHID attach is still opening is lost; the device then plugs in behind the page's back (confirmed in the worker; the page path was read in app/usb-live.ts)
`web/usb.ts:156-171` (`attach`), `:185-197` (`detach`). On the page: `web/app/usb-live.ts:235-246` (`request`) and
`:290-300` (`detach`).
While `open(device, …)` is awaited (WebUSB opening, reading the descriptors and claiming interfaces can take seconds),
`plugged[connector]` is still empty. A `usb-detach` that arrives then finds nothing to unplug: it doesn't bump `gens`
and it posts `detached`. When the open resolves, the check at line 167 (`this.closed || this.plugged[connector]`)
passes, so the device is plugged and `attached` is posted.
On the page, the detach's `request` replaces the attach's `pending` entry without clearing the attach's timer. The
`detached` answer frees the connector and drops the WebUSB lock. The later `attached` finds no `p` and no `c` and is
ignored. 30 s later the attach's orphaned timer fires, runs `this.pending.delete(connector)` and `free(connector)`
(which can delete a *newer* pending request on that connector), and rejects with "no answer".
**Result:** the guest has the device, the page shows the connector as free with the lock released, and the next attach
on that connector fails with "connector N has a device".
**Fix (worker):** in `detach`, when `opening.has(connector)`, bump `gens[connector]`. In `attach`, after the await,
also fail when `this.gens[connector] !== gen`, detaching the device and answering `wentAway`.
**Fix (page):** in `request`, have the timer delete the entry only if it is still its own (`pending.get(c)?.timer === timer`),
and clear an existing pending entry before replacing it.

### D3. When a network worker fails after `Running`, the page never hears of it (confirmed)
`web/room.ts:212`, `web/tailscale.ts:200`, `web/tailcat.ts:171`, `web/local-net.ts:257`.
Each handle sets `worker.onerror = (e) => reject(...)` on the `running` promise. Once `running` has resolved, that
reject does nothing, and nothing else listens. room.ts documents `onError` as "the worker failed (after `Running` too)",
but `onError` is only called for posted `error` messages.
**Scenario:** an uncaught exception in the worker, such as a wasm trap (a panic in net/ts) inside the timer callback
`ts_tick` (ts-client.ts:476) or inside a WebSocket or data-channel `onmessage` → `pump`, or a `JSON.parse` of a
malformed event (ts-client.ts:446). The client is dead, but the Network menu still says Running and the guest's
network silently stops.
**Fix:** in each handle, after start, turn `worker.onerror` into the same path as a posted `error` (`onEvent({type:'error', …})`
/ `onError`). Better, have one shared handle helper do it (see Q2).

### D4. Detaching a WebUSB or WebHID device leaks its `disconnect` listener; after 256 detaches a stale listener can unplug the wrong device (confirmed leak; the wrong-device unplug is plausible but rare)
`web/webusb.ts:761-782`, `web/webhid.ts:238-257`.
The opener adds a `navigator.usb` / `navigator.hid` `disconnect` listener. It removes it only when that device
disconnects or when the open fails, never when the page detaches the device (`WebUsbPassthrough.detach`,
`WebHidDevice.detach`). Every attach/detach cycle leaves a listener that holds the device, the context and the `Usb`
glue. `ctx.gone` → `Usb.gone(connector, gen)` is guarded by `gens`, but `gens` wraps at 256 (`& 0xff`, usb.ts:189), so
a stale listener whose `gen` matches again would detach whatever is on that connector when its old device unplugs.
**Fix:** have the opener return a device whose `detach()` also removes the listener (wrap `detach`, or pass an
`onDetach` in the options).

### D5. Detaching and quickly re-attaching the same WebUSB device lets the old close shut the new session (plausible, timing)
`web/webusb.ts:280` (`if (!dev.opened) await dev.open()`), `:591-601` (`detach`).
`detach()` queues `releaseInterface` and then `dev.close()` on the old passthrough's chain. A new `openWebUsb` on the
same `USBDevice` (the user detaches and attaches it again, or moves it to another connector) can run while the old
close is still pending. It sees `dev.opened === true`, skips `open()`, reads the descriptors and claims the interfaces,
and then the old `close()` lands. Every transfer after that fails with `InvalidStateError`, which `lost()` doesn't
count as gone, so the guest sees a device that only errors.
**Fix:** keep a per-device closing promise in the opener (`WeakMap<WebUsbDeviceLike, Promise<void>>`) and await it before
`openWebUsb`. Do the same in the WebHID opener.

### D6. Uploads relayed over DERP have no bound on the WebSocket's send buffer (plausible)
`web/ts-client.ts:428-433` (action 2).
WireGuard/DERP frames go to `ws.send` with no check of `ws.bufferedAmount`. The WebRTC path has exactly that bound
(`RTC_BUFFER`, `rtcSend`), and its comment explains why: without it, a guest sending faster than the path carries builds
seconds of latency. For a socket that carries packets, Chromium queues without limit, so a guest's bulk upload through
a tailnet or tailcat relay (DERP is the default path) inflates the guest TCP's RTT. Interactive traffic (ssh, DNS,
keepalives) then sits behind megabytes of queue, and the worker's memory grows.
**Fix:** for binary (DERP) sockets, drop the packet when `bufferedAmount` passes a bound (as `rtcSend` does; TCP inside
recovers from the loss). Keep the text (Nostr) sockets lossless.

### D7. `NamesAgent.stop()` can be undone by a pass that is still running (confirmed by reading; plausible in use)
`web/names.ts:529-536` (`start`'s `next`) and `stop`.
`next()` awaits `this.pass()` (which can take a minute: proof of work) and then the titles, and only then sets
`this.timer`. `stop()` clears only the current timer and terminates the worker backend. A pass in flight re-arms the
timer after `stop()`, and the next pass sends requests to a terminated worker. Those never get an answer
(`workerBackend` has no `onerror` and no timeout), so that pass and every later `pass()` chained on `this.passing` hang
forever.
Related: if `this.store.titles()` throws (a transient IndexedDB error), `next` rejects unhandled (`void next()`) and the
agent stops looking after the titles until the page reloads.
**Fix:** add a `stopped` flag checked before re-arming. Wrap the post-pass part in try/finally so that the timer is
always re-armed with `RETRY_MS`. In `workerBackend`, reject waiting asks on `worker.onerror` and on `close()`.

### D8. A stuck DERP-map fetch hangs a tailcat server's start (plausible)
`web/tailcat.ts:127`.
`nearestRegion` probes each region with `AbortSignal.timeout`, but the fetch of the DERP map itself has no timeout.
The tailcat worker awaits it (tailcat-worker.ts:243, wrapped in `.catch(() => 0)`, which only catches failures, not
hangs). A captive portal or a stalled connection leaves the connection at "Connecting" until the browser gives up
(minutes).
**Fix:** `fetch(derpMapURL, { signal: AbortSignal.timeout(timeoutMs) })`.

### D9. Gateway: overlapping `again` timers leak and can fire after close (confirmed; rare)
`web/gateway.ts:271`, `:485-489`.
`again = setTimeout(advertise, 1000)` doesn't clear an earlier `again`, and `close()` clears only the last one. Two
lease changes within a second (default router, then not, then default, then not; for example a reconnect) leave a
timer that calls `advertise()` → `receive(...)` and `backend.lease()` after the gateway closed.
**Fix:** `clearTimeout(again)` before setting it, and a `closed` flag in `advertise`.

### D10. tailscale-state reads its keys and values in two transactions, so they can pair up wrongly (plausible, two tabs)
`web/tailscale-state.ts:24-25`.
`getAllKeys(range)` and `getAll(range)` run in separate read transactions, and the code pairs the results by index. A
write between them from another tab or worker using the same profile (the Go store's keys are written through:
`setState`) shifts the indices, and the node starts with mismatched state entries. `forgetProfile` (line 65) also
opens a database connection that it never closes.
**Fix:** read both in one transaction (or one cursor), and close the database in `forgetProfile`.

### D11. Lower-severity defects (confirmed by reading)
- `web/usb.ts:250-256`: a device that calls `done()` synchronously and then throws gets a second completion
  (`inflight.has(tag)` is false by then, so the `else` branch posts an error record for the same tag). This needs a
  buggy device. Fix: track "completed" separately from "in flight".
- `web/tailcat.ts:110-116`: `tailcatIdentity` reads and then puts in two transactions, so two starts at once make two
  identities and the last write wins. room.ts:312-317 solved the same race with `add`. Use `add` here too.
- `web/audio.ts:268-274, :431`: `detach()` never clears `latencyTimer` and never suspends or closes the `AudioContext`,
  so the audio thread keeps rendering silence (CPU and battery) after the machine stops. Fix: `ctx.suspend()` on
  detach (resume in `play`), and clear the interval.
- `web/audio.ts:382`: if `addModule` throws in `openMic`, `micStream` stays set with its tracks live (the browser's
  microphone indicator stays on) and `micState` stays `asking` until a later `closeMic`. Wrap it and stop the tracks.
- `web/input.ts:442-443`: `blur` on the element and `blur` on the window both run `releaseAll`, so each focus loss
  sends `usb-key ''` and runs the `onRelease` callbacks twice. This is harmless today; guard on "anything held".
- `web/usb-keyboard.ts` `send`: completes with `actual: 8` even when the TD is shorter. `transfer()` uses
  `Math.min(8, t.length)`. The glue clamps it, but the two paths should match.
- `web/local-net.ts:221-224`: `close()` sets `frames.onmessage = null` but never closes the frame port, and the socket's
  late `onmessage` can still post frames into it. Close the port.
- `web/room-worker.ts:107-110`: `namesFetch` captures `client` when it's called. A fetch the module asks for during the
  `TsClient` constructor's first `pump()` (before `client` is assigned) has its answer dropped. This is unlikely today
  (servers fetch later), but the capture is fragile. Assign through a `let self` that the handler reads when the answer
  comes.

---

## 2. Performance (ranked)

### P1. Each packet to the guest is copied twice more than it needs to be on every tailnet backend (confirmed; the per-packet hot path)
`web/ts-client.ts:419, :442-443` → `web/net.ts:115` → `web/gateway.ts:243-244`.
`pump()` copies each action out (`this.m.buf(n)` slices) and hands `rest = a.subarray(5)` to `on.packet`. In
`batchSender`, `p.buffer.byteLength === p.length && p.byteOffset === 0` is false (the offset is 5), so it slices again
to transfer. On the device side, `gateway`'s deliver calls `eth()`, which allocates a new frame and copies the packet
again. That is three copies plus three allocations per packet (up to 1500 B) before virtio-net copies it into the
guest's RAM. For a download at tens of thousands of packets per second, this is the largest avoidable allocation churn
in the network path.
**Fix:**
- (a) For action 5, copy directly: `new Uint8Array(memory.buffer, ptr + 5, n - 5).slice()`, which yields an exact-size
  buffer that transfers with no copy. This saves one copy and one allocation per packet, with no protocol change.
- (b) Further, allocate the packet with 14 bytes of headroom (`out = new Uint8Array(14 + len)`, packet at 14) and let
  the IP port carry `{buffer, offset 14}`, so that the gateway writes the Ethernet header in place and `eth()`'s copy
  goes away. This needs a small protocol change on the IP port.

Expected gain: a measurable drop in GC and device-worker time on bulk downloads (one or two fewer 1.5 KB allocations
per packet). Measure with bench/net before claiming a number.

### P2. Gateway: `eq` allocates an array on each call, on every guest packet (confirmed)
`web/gateway.ts:107` (`Array.from(b).every(...)`).
It runs 2 times per IPv4 packet the guest sends (`eq(dst,0,gw)`, `eq(ipPacket,12,lease.address)`, lines 473 and 476)
and 2 times per IPv6 packet (lines 417 and 430, 16-element copies), plus once per ARP. Also, `guestMac = f.slice(6, 12)`
(line 445) allocates for every guest frame.
**Fix:** use an index loop for `eq`, and copy the MAC only when it changes. These are trivial changes that remove
3-4 small allocations per packet. The gain is small but free.

### P3. USB glue: each doorbell and each TD rebuilds arrays, views, sets and closures (confirmed; the per-TD path)
`web/usb.ts:205-281` (`poll`), `:312-314` (`ram()`), `:105-107` (`u32()`).
Each poll creates a `Uint32Array`, an object plus a `words` array per record (`Array.from({length:n}, word)`), two
`Set`s, an entries iterator, and a `guarded` closure per record. Each transfer and each completion calls `ram()`, which
builds a new array and a new `Uint8Array` view of guest RAM, plus a map over the spill memories. A WebHID gaming
mouse or controller (1000 reports/s), a USB serial or storage passthrough, or Gadget Zero's tests run this thousands of
times per second.
**Fix:**
- Cache the `u32` and `ram` views and rebuild them only when `memory.buffer` changes (growth).
- Parse records into reused scratch arrays.
- Hoist `guarded`.
- Skip the cancel pre-pass when the batch has no `REQ_CANCEL` (a common case: one scan of `w1 >>> 16`).

Gain: a few µs per TD and much less GC churn. This is latency-relevant for HID input.

### P4. WebHID input reports: several allocations per report, including a string key (confirmed; up to ~1000/s)
`web/webhid.ts:103, :118-134`.
Per report: `bytesOf` slices, `framed()` allocates another buffer when IDs are used, and a template-string key
`` `input:${id}` `` is built and stored in a `Map`. Plus P3's per-TD cost.
**Fix:** keep `last` as one `Map<number, Uint8Array>` per kind, and frame directly into one allocation (copy the
`DataView` bytes into a `length+1` buffer once). This halves the allocations per report.

### P5. `FrameReader.push` re-copies the whole buffer for each piece, which is quadratic for frames that arrive in small pieces (confirmed; cold path: clipboard and files)
`web/agent-frame.ts:574-591`.
Each `push` runs `concat(this.buf, bytes)` (copying everything buffered so far), then `all.slice(at)` copies the
remainder again, and each frame's `payload` is a further `slice`. A 64 KiB DATA frame arriving in 4 KiB vsock packets
copies about 0.5 MB, and an image clipboard of several MB moves 10-20 times its size.
**Fix:** keep a list of chunks plus their total, assembling only when a frame is complete (or use a growable buffer with
read and write offsets), and use `subarray` for payloads cut from a buffer that the reader owns.

### P6. Agent vsock path: two copies per packet each way (confirmed; agent traffic)
`web/vsock-device.ts:185-192` (page → guest: `take()` copies, then `packet` copies the header and the chunk, then
`scatter` copies into RAM) and `:267-268` (guest → page: `gather` copies, then `payload.slice()` copies again before the
transfer).
**Fix:** guest → page: post `packet.subarray(HDR, …)` and transfer `packet.buffer` (gather already made a fresh
buffer). Page → guest: scatter the header and the chunk(s) straight into the descriptor's segments without building
`packet`. Also, `decodeHeader` builds two BigInts per packet (lines 124-125); `getUint32` of the low words is enough for
CIDs.

### P7. Frames from the local helper and the demo network: one `postMessage` per frame (confirmed; per frame on downloads)
`web/local-net.ts:188-205`, `web/demo-net.ts:341-359`.
Each WebSocket message holds many frames. `framesOf` slices each one, and each is posted separately. A postMessage
plus transfer costs microseconds, so for a 1 MB batch that is about 700 posts.
**Fix:** let frame ports take a batch (an array of ArrayBuffers, as IP ports already do through `packetsOf`). That
needs `portAdapter` in web/net.ts to accept arrays. Post one batch per socket message.

### P8. Sound: allocations on each period and each pump (confirmed; ~100-200 Hz; small)
`web/snd.ts:437-447` (`toF32` plus a second array for mono, per message), `:941` (`done` filters and reallocates
`running[sid]` per completion, though completions arrive in order), `:638-646` (micSource: a `Float32Array` plus
`fromF32` per message), `:417` (a promise per `waitAsync`, about 200/s).
These are kilobytes per period, so the GC pressure is low. The useful fix is cheap: make `done` a `shift()` (with a
fallback for out-of-order completions), and convert straight into the ring in `fill()` from the raw guest bytes so the
intermediate f32 goes away. The gain is small; do it only alongside other sound work.

### P9. The AudioWorklet's `process` allocates on its rare paths, despite its comment (confirmed; audio thread)
`web/audio-worklet.ts:102, :120` (`[this.epoch, this.played, …] = [...]` builds an array literal).
These run only at a stream's start and at the end of each gap, so they are rare. But this is the realtime audio
thread, and the file says "Nothing is allocated in `process`". Use plain assignments.

### P10. Pointer events: a layout read and several arrays per move (confirmed; 60-240 Hz; small)
`web/input.ts:253-257, :270-277, :283-297, :303-333`.
Each `pointermove` calls `getBoundingClientRect()`, which forces a layout if anything dirtied it (the status bar
updating each frame can make this a recurring forced layout). It also builds 2-4 arrays and spreads
`[...events, [EV_SYN…]]`, and the nested arrays are structured-cloned to the device worker.
**Fix:** cache the rectangle (a ResizeObserver plus scroll/resize listeners), push SYN in place instead of spreading,
and post a flat `Int32Array` (transfer it) if the device side accepts it. Expect a small gain: the main value is
avoiding forced layouts, not the allocations.

### P11. Cold paths: noted, no action needed
DHCP and DHCPv6 replies built with `push(...spread)` (gateway.ts:292-305, 376-404); `TextEncoder` per control-info item
(snd.ts:832); `readStrings` making sequential control transfers at attach (webusb.ts:383-389); a new IndexedDB
connection per call in tailcat.ts and room.ts `idb`. All of these run once per lease, attach or start.

---

## 3. Code quality and architecture (ranked)

### Q1. Three IP-port workers repeat the same scaffolding and have drifted apart
`web/tailnet-worker.ts`, `web/tailcat-worker.ts`, `web/room-worker.ts`.
Each has `ip`, `send`, `lease`, `primary`, `primary6`, `rank`, an `attach(port)` that rebinds `onmessage` and posts the
lease, a `primary` handler and a `detach` that posts `lease: null` and hands the port back. The copies already differ:
- Only tailnet dedupes lease posts (`posted` JSON), so tailcat and room re-post identical leases. Each post triggers a
  router advertisement in the gateway (`leaseChanged` → `advertise`).
- tailnet keeps its client across `detach`, while tailcat and room close theirs.

**Extract:** an `ipPortHost({ offered: () => Lease | null })` module that owns `attach`/`primary`/`detach`/`postLease`
(with the dedupe) and exposes `send`. Each worker keeps only its client-specific start.

### Q2. The page-side handles repeat the worker-handle pattern four times
`web/tailscale.ts:187-245`, `web/tailcat.ts:161-203`, `web/room.ts:211-276`, `web/local-net.ts:250-286`
(`framedClient`).
Each has the same `running` promise built from `worker.onmessage`, `timings`, a 3 s `detach()` promise with a
`detached` callback, `close = terminate`, and the same `onerror` gap (D3).
**Extract:** a `workerClient(worker, start, onEvent)` that implements `running`, timings, `detach` and error routing
once, and fixes D3 everywhere.

### Q3. The local helper and the demo network duplicate the frame socket
`web/local-net.ts:156-206` and `web/demo-net.ts:249-360`.
Both duplicate the same tx batching (`pending`/`batch`, `setTimeout(flush, 0)`, the `MAX_MESSAGE` early flush), the
MAC sniff from the first unicast source, and the rx loop (`framesOf` → `dhcpAck` → a post per frame).
**Extract:** a `frameSocket(ws, port, maxMessage)` that the demo network's reconnecting state machine wraps. P7's
batching would then be fixed in one place.

### Q4. IPv6 and address helpers are implemented several times
- Text to bytes: `reach6.ts:260` `parse6`, `tailscale.ts:108` `ip6`.
- Bytes to text: `room.ts` `v6text` (line ~547), `tailcat.ts` `v6text` (line ~50).
- `eq` helpers: `net.ts:17`, `reach6.ts:280`, `gateway.ts:107` (the slow one, P2).
- `hex` and `hex32` helpers: `room.ts:306`, `tailcat.ts:101`, `names.ts:152`.

Move them into `ip6.ts` and a small `bytes.ts`, and test them once.

### Q5. vsock-device.ts carries its own `gather`/`scatter`
`web/vsock-device.ts:412-434` copy `devices.ts:432-454` almost exactly (only the return value differs), while snd.ts
imports the shared ones. Use the shared ones, returning the count from `devices.ts`'s `scatter`.

### Q6. snd.ts (1069 lines) has clear seams
- `snd-proto.ts`: the protocol (`Snd`: control requests, the state machine, the controls, lines ~696-890).
- `snd-test.ts`: the deterministic sink and source (`checksumSink`, `patternSource`, `pattern`, `fnv1a`).
- `snd-realtime.ts`: the realtime ends (`completionBound`, `ringSink`, `micSource`, `toF32`/`fromF32`, the stats).
- `snd.ts`: only the queue backend `sndBackend`.

The deterministic pieces then stay out of the realtime bundle's reading path, and core/tests/common/snd.rs's twin maps
to one file.

### Q7. names.ts (1077 lines) mixes five concerns
The stores (`memoryNamesStore`, `idbNamesStore`, the `req`/`tx` helpers), the worker backend (`workerBackend`), service
fetching (`isService`/`get`/`serviceFetch`), the agent (`NamesAgent`, about 650 lines) and export/import
(`exportNames`/`importNames`/`b64url`).
**Split:** `names-store.ts`, `names-fetch.ts`, `names-agent.ts`, `names-export.ts`. room-worker.ts imports `names.ts`
only for `idbNamesStore`, `NAMES_CHANNEL`, `roomTitles` and `serviceFetch`, so it would stop pulling in the agent.

### Q8. Four styles of IndexedDB helper with different race handling
room.ts `openIdb`/`idb` (with `add` for identity), tailcat.ts `idb` (get-then-put: D11), tailscale-state.ts (two
transactions: D10), names.ts `tx`/`req`. One `idb.ts` with `withStore(db, store, mode, f)` and an `addOrGet` would fix
D10 and D11 and remove about 60 lines.

### Q9. input.ts `attachInput` is one 330-line closure
`web/input.ts:152-484`. It holds four independent machines:
- keys: `holders`, `deliver`, the `hold` queue;
- the pointer and the mouse lock: `motion`, `buttons`, `ignored`, `takeMouse`;
- touch: `fingers`, `stray`;
- the wheel: `wheels`.

Each can be a small factory taking `(post, rect)` and returning its listeners, which `attachInput` wires and tears down.
The event arrays are typed `number[][]` although `EvdevEvent` exists. Using `EvdevEvent[]` states the
`[type, code, value]` shape that the ports carry.

### Q10. The USB opener's resources have no owner
The `disconnect` listener (D4) and the device's open/close lifetime (D5) live in the opener closure, while the
lifetime is the passthrough's (`detach`). Give `UsbOpenerContext` an `onDetach(cleanup)` (or return `{device, release}`)
so the glue (`Usb.detach`/`close`) releases them. That fixes D4 and D5 structurally.

### Q11. `Usb.poll` does four jobs
`web/usb.ts:205-281`: it reads the ring, runs a cancel pre-pass, dispatches by kind, and has the realtime cancel kick.
Split out `readRecords()` (into scratch storage: P3) and `dispatch(record)`. The `guarded` closure and the
transfer-specific try/catch duplicate error handling (D11's double completion lives in that duplication).

### Q12. Smaller items
- `web/usb-device.ts:421`: `packets` is filled (usb.ts:307) for isochronous TDs that no device takes. Either drop it
  or mark it as for the future in the type.
- `web/hid-descriptor.ts:246` `parseReportDescriptor` is used only by tests (tests/usb-*.test.ts). Say so in its doc,
  or move it to a test helper, so the device worker's module stays small. A production bundle tree-shakes it, but the
  dev server doesn't.
- `web/snd.ts:300` ringSink and `:599` micSource take a shared `port` (devices.ts:1328): the sink, the source and the
  mixer all post to it, and only `sndBackend` sets `onmessage`. Typing the port as
  `Pick<MessagePort, 'postMessage'>` for the sink and source would make clear that they never own it.
- `web/gateway.ts:236-255`: the `leaseNow` indirection exists only because `backend` isn't assigned during
  `makeBackend`. A `let backend!: IpBackend` with `deliver` reading `backend?.lease()` says the same with less code.
- `web/demo-net.ts:205-227`: the hand-written JSON field validators (`str`/`num`/`budgetOf`/`slowOf`/`refusalOf`) are
  fine, but they are the only validation of the server's control messages. Grouping them into one
  `parseControl(m): Control | undefined` with a discriminated union type would let `control()` switch on typed values
  instead of `Record<string, unknown>` casts.
