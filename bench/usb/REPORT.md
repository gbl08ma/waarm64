# USB: what WebUSB costs a transfer (U0)

> A dated journal (U0 of the USB work; [docs/usb.md](../../docs/usb.md) "Findings"). What exists now is in `bench/usb/` and [docs/usb.md](../../docs/usb.md).

**Setup (2026-10-18).** The dev VM: openSUSE Tumbleweed aarch64 under Lima `vz` on the M4 Mac mini, kernel
7.2.9-1-default, 8 vCPUs. Chromium 153.0.8010.52, headless through Playwright. The device is
`tests/usb/gadget.sh`'s Gadget Zero: configfs SourceSink and Loopback on dummy_hcd at high speed (512-byte bulk
packets, bulk buffers of 4,096 bytes, pattern 0 for these runs; the rig uses pattern 1 since). `node bench/usb/run.ts 5`:
five browser launches, each running a fresh dedicated worker that opens the device, 200 transfers of each kind
after 20 unmeasured ones, then bulk streams of 1.5 s per size and depth. Then `bench/usb/native.c` does the same
transfers through usbfs's synchronous ioctls, five times, with no browser. Three other lanes were working on the
VM (load ~1), so **this is a sizing, not a benchmark**. The JSON is in `results/2026-10-18-sizing.json`.

## One transfer's round trip (ms; medians of 1,000, with p99)

| Transfer | WebUSB in a worker | p99 | native usbfs | WebUSB's cost |
|---|---|---|---|---|
| control IN, GET_DESCRIPTOR (18 bytes) | 0.345 | 1.18 | 0.202 | +0.14 |
| control IN, vendor 0x5c (8 bytes) | 0.335 | 0.47 | 0.204 | +0.13 |
| control OUT, vendor 0x5b (8 bytes) | 0.335 | 0.49 | 0.204 | +0.13 |
| bulk IN, 512 bytes | 0.335 | 0.45 | 0.202 | +0.13 |
| bulk OUT, 512 bytes | 0.330 | 0.36 | 0.207 | +0.12 |
| loopback echo, 64 bytes OUT then IN | 0.665 | 0.82 | 0.405 | +0.26 |

- **The floor is dummy_hcd's own:** natively every transfer takes ~0.20 ms, whatever its kind or size up to
  4 KiB. dummy_hcd moves data from a timer, not when a URB is submitted. Real hardware is faster: a high-speed
  device answers within a microframe (0.125 ms).
- **WebUSB adds ~0.13 ms per transfer** on top: Mojo IPC from the worker's renderer to the browser's USB service,
  usbfs's asynchronous URB path, and the promise back. The run-to-run spread is small (run medians within 0.03 ms).
  The occasional slow control transfer (p99 1.2 ms) didn't show up natively.
- **What it means for a guest:** a driver that waits on each transfer, such as a debug probe's request and reply
  or a serial echo, gets about 3,000 transfers a second through WebUSB, before the guest's own xHCI path. That is
  enough for CDC-ACM consoles, adb and DFU. Chatty probes doing thousands of small control transfers per operation
  will feel it.

## Bulk throughput (MB/s; medians of 5 runs)

| Transfer size | in flight | WebUSB IN | WebUSB OUT | native IN (1 in flight) | native OUT |
|---|---|---|---|---|---|
| 4 KiB | 1 | 12.2 | 12.3 | 20.3 | 20.1 |
| 4 KiB | 4 | 12.2 | 12.2 | | |
| 4 KiB | 8 | 12.3 | 12.3 | | |
| 64 KiB | 1 | 111.9 | 109.2 | 158.6 | 152.1 |
| 64 KiB | 4 | 76.1 | 72.2 | | |
| 64 KiB | 8 | 36.7 | 34.3 | | |
| 1 MiB | 1 | 178.8 | 181.7 | 248.8 | 228.3 |
| 1 MiB | 4 | 72.2 | 64.9 | | |
| 1 MiB | 8 | 37.0 | 33.4 | | |

- Large transfers amortize the per-transfer cost: 1 MiB transfers move ~180 MB/s through WebUSB, 70–80% of the
  native rate, far above what a high-speed device delivers on a real bus (~40 MB/s). An RTL-SDR's 4.8 MB/s (U5's
  target) is not limited by this.
- **More transfers in flight were slower here, not faster.** That is likely dummy_hcd's scheduler (it walks every
  queued URB on each timer tick), but the run doesn't separate that from Chromium's side: there is no native
  asynchronous run to compare. On real hardware queued transfers keep the bus busy, so the passthrough keeps the
  guest's queueing as planned. U3 checks the depth on a real device.
- **usbfs caps a process's buffered transfers at 16 MiB** (`usbcore.usbfs_memory_mb`, default 16). Eight 1 MiB
  transfers in flight worked. Sixteen failed with a transfer error, and Chromium's USB service holds every open
  device's transfers in one process, so a guest queueing large bulk URBs on several devices could reach that. The
  passthrough reports the failure as a Transaction Error, as for any rejected transfer.
