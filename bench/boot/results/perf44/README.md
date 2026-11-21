# PERF loop 44: the core's heap over 15 minutes of real sites (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 44". One session a browser, on the dev VM (Chromium 155.0.8059.84
headless on the host), main's core at 732f9498 (ff64159774cea367), booted from `target/arch/desktop.qcow2` (Arch Linux
aarch64 with sway: Chromium 156.0.8078.79, Firefox 160.0), 4 vCPUs, 2.5 GiB, the 320 MiB JIT budget, the guest online
through `tests/net/tailcat.sh`'s exit node:

    tests/net/tailcat.sh up
    TAILCAT=rig PHASES=sites [GUEST_BROWSER=chromium] DWELL_S=30 CYCLES=5 MEMLOG=5 MEMLOG_UASM=0 \
      IMAGE=target/arch/desktop.qcow2 WAARM64_GUEST_USER=arch SESSION_S=1500 TIMELINE_ALL= \
      bash bench/gpu/ab.sh <out> 1 main=target/wasm32-unknown-unknown/release/waarm64_core.wasm

The default six sites (a YouTube watch page, the Guardian, CNN, the BBC's news, Excalidraw, Google Maps), 30 s each,
five times through: 900 s.

- `chromium-mem.json`, `firefox-mem.json`: `node sum.ts <mem.jsonl>` (the heap's live maximum and mark, the block
  map's keys and table, prunes, flushes, rescues, and per 60 s window the heap, the keys and the JIT's live bytes).
- `chromium-session.json`, `firefox-session.json`: the session's results (the guest browser, the sites, the JIT's
  counters at the end) without the per-visit rows.
