# Review: the guest agent and its channel (as of 910d81d2)

Static, out-of-context review of `web/vsock-device.ts` (the agent's connection), `web/app/agent-link.ts`,
`web/agent-frame.ts`, `web/app/areas/agent-actions.ts`, `web/app/areas/snapshot-actions.ts`,
`web/app/worker-snapshot.ts`, the run wiring, `web/app/guest-agent.ts` (and `guest-unit.ts`), and `agent/src/{main,vsock,frame}.rs`.
Linux's `net/vmw_vsock/virtio_transport_common.c` is the reference for the guest's side. Ranked by severity.
Finding 1 was confirmed with a small Node script on the device (below). The others come from reading the code.

The frame formats match between TypeScript and Rust (lengths, HELLO, TIME as u64 ns LE, OFFER, REQUEST, DATA, MORE,
ACK, the capability bits, MAX_PAYLOAD, the reader's bounds). The unit's sandbox matches what the agent does.

---

## 1. Medium: CREDIT_REQUEST / CREDIT_UPDATE ping-pong while the guest's receive credit is 0

**Where:** `web/vsock-device.ts:182-186` (the ask), `:265` (`a.asked = false` on *every* guest packet), `:275-277`, `:283`.

**What happens:** when the page has bytes pending and the guest's credit for the agent's socket is 0 (`credit(agent) === 0`),
`flush()` sends CREDIT_REQUEST and sets `asked`. Linux answers every CREDIT_REQUEST at once from its receive path
(`virtio_transport_recv_connected`: `case VIRTIO_VSOCK_OP_CREDIT_REQUEST: virtio_transport_send_credit_update(vsk)`),
carrying the same `fwd_cnt` while the agent hasn't read. `onAgent` then sets `asked = false` for that packet (line 265),
calls `flush()` (line 283), still finds credit 0, and asks again. The device and the guest kernel bounce packets until
the agent process reads from its socket. Each round costs an RX buffer, a TX descriptor and two interrupts. The loop
runs entirely in the guest kernel's vsock workers and the device, so the agent, at `Nice=10`, is the one that loses CPU
to it.

**When:** any page-to-guest bulk transfer where the device fills the guest's whole `buf_alloc` (256 KiB default; the
RX queue holds 64 × 4 KiB, about the same) faster than the agent drains it. Examples: a clipboard image of more than
~256 KiB pasted into the guest, or a TYPE paste of that size, on a busy or single-vCPU guest. Every guest RW from the
agent in that state also restarts the cycle.

**Confirmed:** a script (hand-built queues as `tests/vsock.test.ts` builds them: buf_alloc 8192, 20,000 page bytes)
gives `[RESPONSE, RW, RW, RW, CREDIT_REQUEST]`, and then each CREDIT_UPDATE with an unchanged `fwdCnt` gets another
CREDIT_REQUEST (`round 0/1/2 device answered [7]`). The existing test only covers an update that does grow the credit.

**Fix direction:** either never send CREDIT_REQUEST (Linux sends CREDIT_UPDATE by itself as the reader frees space,
`virtio_transport_stream_do_dequeue`/`free_space < VIRTIO_VSOCK_MAX_PKT_BUF_SIZE`), or clear `asked` only when
the guest's `fwd_cnt`/`buf_alloc` actually changed. Add a test where the answer to the request doesn't grow the credit.

**Confidence:** high on the mechanism (reproduced on the device; Linux's answer is unconditional). Medium on how much
it costs in a real guest.

---

## 2. Medium-low: page↔device messages carry no connection identity, so stale messages cross into the next connection

**Where:** `web/vsock-device.ts:331-342` (`fromPage` applies `data`/`reset` to whatever `agent` is current),
`:246-259`; `web/app/agent-link.ts:116-123` (pump), `:126-137`, `:140-147` (`opened` zeroes `inflight`), `:169`
(a `reset` posted for *every* data message while broken).

**What happens:** the page's `data` and `reset` messages and the device's `open`/`data`/`taken` messages cross in
flight. The agent reconnects at once (`agent/src/main.rs:207`, `wait = 0`), possibly inside one run slice of the
worker. Messages the page posted for connection N can therefore be handled by the device after it has accepted
connection N+1:

- **Stale bytes go ahead of the new HELLO.** The page posts frames (a TYPE paste in progress, a clipboard OFFER/MORE,
  the sleep timer's TIME) on connection N. The agent's connection ends (the agent restarted, `Stop::Broken`, the
  page's own reset) and reconnects. The device puts those frames in N+1's `pending` before the page has even seen
  `open:false`. Frames are whole messages, so the stream stays in step, but the agent acts on them. The rest of a paste
  that the page dropped (its queue cleared in `opened`) gets typed: `serve()` resets the typist *before* these
  arrive. The session child gets an OFFER or MORE from a page state that the following HELLO declares gone. With an
  inline text offer the child keeps it as the guest's selection (`session.rs` `hello()` keeps a text-only cached host
  offer).
- **The window miscounts.** The device then posts `taken` for those stale bytes on N+1. The page has already reset
  `inflight = 0` for the new connection, so it subtracts bytes it never counted (clamped at 0). From then on `inflight`
  under-counts and the page can have more than `WINDOW` outstanding.
- **Stale resets.** While the page's reader is `broken`, every further `data` message posts another `reset`. Once the
  first one dropped connection N and the agent reconnected, a later one resets the fresh N+1 too. That churns
  open/close (it settles, but each round is a reconnect and a HELLO/TIME/clipboard re-sync).

**Fix direction:** a connection number in `open` (device→page) echoed in `data`/`reset` (page→device), with the device
dropping messages for another connection. Post `reset` once per connection in `AgentLink.received`.

**Confidence:** medium. The ordering is real: MessagePort delivery is asynchronous to the guest's run loop and the
agent reconnects with no wait. How often it bites depends on how the worker interleaves messages with run slices.

---

## 3. Low: a REQUEST from the agent's current port reinitializes the connection without telling the page

**Where:** `web/vsock-device.ts:251-258`.

**What happens:** if `agent` exists and a REQUEST comes from the *same* guest port, `fresh` is false. The device
replaces the state (`txCnt`, `fwdCnt`, `pending` all zeroed, the page's pending bytes discarded) and sends RESPONSE, but
it posts no `open`. The page therefore sends no HELLO on what is, for the guest, a new socket, and the agent waits for
HELLO. Meanwhile the page's `FrameReader` may hold half a frame from the old stream, and `inflight` keeps the
discarded bytes forever, which shrinks the window permanently. For the guest this means no clipboard and no TIME until
the next reconnect.

**When:** only if the guest reuses the port while the device still thinks the old connection is open. That can happen
when the RST/SHUTDOWN that closed it never reached the device, for example after a connect timeout (Linux closes a
SYN_SENT socket silently) or a dropped control packet (`MAX_OUT`). Linux's autobind increments ports, so this is rare.

**Fix direction:** treat any REQUEST while `agent` exists as a new connection. Post `open:false` and then `open:true`
(as the different-port branch does).

**Confidence:** high that the code behaves so; low likelihood.

---

## 4. Low: TIME is stamped when queued, not when sent, so the agent can set the clock back by the queue's delay

**Where:** `web/app/agent-link.ts:79-81` (`encodeTime(Date.now())` at `send`), `:116-123` (the queue is drained only as
the guest takes bytes); `agent/src/main.rs:486-503` (sets CLOCK_REALTIME to the stamp when it is more than 50 ms off).

**What happens:** if TIME is queued behind other frames (up to `WINDOW` in flight plus an unbounded `queue`: DATA
paced by MORE grants up to 4 × 64 KiB, or a long TYPE paste), it reaches the agent late. The agent then sets the
guest's clock to an instant that is already past, by exactly the queue's delay. Any delay over `CLOCK_SLACK_NS`
(50 ms) produces a real step backwards. At the ~0.8 MB/s the channel was measured at, 256 KiB of backlog is about
300 ms. The sleep timer's and the post-save TIME can coincide with a clipboard transfer. The one at HELLO goes first,
because `onHello` runs before the clipboard's handler.

**Fix direction:** put TIME at the head of the queue, or stamp it in `pump()` when it is posted.

**Confidence:** high on the mechanism; it is small in practice.

---

## 5. Low: the sleep check's interval and the old link outlive the run

**Where:** `web/app/areas/agent-actions.ts:138-154`.

**What happens:** `begin` clears the previous run's interval and link only when the *next* run begins. After a stop
(power off, a crash, Suspend), the 10 s `setInterval` keeps firing for the life of the page and holds the closed
`AgentLink`. The link's `open` and `agent` stay true, because no `open:false` comes after the worker is gone.
`syncClock()` then "succeeds" (it posts on a closed port, `time()` returns true) for a machine that doesn't run. This
is harmless today, but anything that keys off `syncClock()`'s return or `link.open` after a stop gets a wrong answer.

**Fix direction:** an `end()` called from the run's stop that clears the timer and closes the link (and marks it closed).

**Confidence:** high; the effect is minor.

---

## 6. Low (docs/comments): stale numbers for the agent's size and fw_cfg read

**Where:** `web/app/guest-agent.ts:11-13` ("4.1 s for the 333 KiB binary, 1.3 s gzipped") and `:108-110` ("each
reading the binary out of fw_cfg again (1.3 s of a vCPU)").

**What disagrees:** docs/clipboard.md's table gives the current no_std build at 132,696 bytes and 81,680 gzipped, read
in 332 ms. docs/devices.md says "~0.3 s of a vCPU". The comments still describe the old `std` console build, which was
the reason for the start-limit numbers.

**Confidence:** high.

---

## Checked and found consistent (no finding)

- Frame layouts, constants and reader bounds: TS ↔ Rust match (`web/agent-frame.ts`, `agent/src/frame.rs`).
- Credit toward the device: the device takes the agent's bytes at once and gives back credit every `AGENT_BUF/4`
  (`CREDIT_STEP`). The guest's tx credit can't run dry, so the agent's blocking `write` in `Session::flush` can't
  deadlock against the device.
- Credit toward the guest: `bufAlloc - (txCnt - peerFwd)` matches Linux's `buf_used`/`fwd_cnt` accounting, which drops
  over-credit packets. The device never sends past it.
- Restore: a fresh device, `TRANSPORT_RESET` on the event queue. Linux resets the agent's connected socket
  (`virtio_vsock_reset_sock`, ECONNRESET), the agent's `ppoll` wakes on POLLERR, its read fails, and it reconnects at
  once. A connect that was in flight (SYN_SENT) times out after 2 s and is retried after 0.5 s.
- The session child closes the connection's fd after fork, so the page sees the close when the parent dies.
- The unit: `ProtectSystem=strict` with the `TemporaryFileSystem=…:exec` for the binary, no `ProtectClock`
  (CAP_SYS_TIME kept), CAP_SYS_ADMIN for TIOCSTI under `legacy_tiocsti=0`, `+modprobe` outside the sandbox, and the
  start limit in `[Unit]`. A Unix socket connects through a read-only bind (sockets are exempt from EROFS).
- `asRun`/`resolveDevices`/`channels()`: clipboard only with the agent; the agent's port only on `firmware` machines;
  `agentStub` keeps the device end out of the worker.
