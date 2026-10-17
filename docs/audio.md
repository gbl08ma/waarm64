# Audio

How a guest's sound reaches the page's speakers, and the page's microphone reaches the guest, **with the guest's own
unmodified drivers**, in time with what the guest shows, without the main thread in the path. Done (milestone M8's audio
track, 2026-10-10 to 2026-10-12); the loose ends are in [backlog.md](backlog.md). Where the parts are described in detail:
the device in [devices.md](devices.md) "snd", the page's side and the Sound menu in [frontend.md](frontend.md) "Sound",
the guest images in [images.md](images.md), the tests in [testing.md](testing.md) "virtio-snd".

## Decisions

- **The device is virtio-snd** (virtio 1.2 §5.14, device ID 25) on our virtio-mmio transport like every other device.
  It's the only sound device a virtio-mmio machine can offer without new buses (no PCI: HDA and USB audio are out), and
  Linux has had its driver (`CONFIG_SND_VIRTIO`, `sound/virtio/`) since 5.13. Written from the spec with Linux's driver
  read for behavior; nothing was ported (crosvm's and vhost-device-sound's permissive implementations were the
  references to read, QEMU's GPL `hw/audio/virtio-snd.c` an oracle only).
- **The output is an AudioWorklet** on the page's `AudioContext`, fed from **a `SharedArrayBuffer` ring** the device
  worker writes and the worklet reads: the data never crosses the main thread (its jank can't glitch the sound), no
  message is sent per buffer. The page creates the context, the node and the ring and hands the ring to the device
  worker with the device spec.
- **The guest's clock is the worklet's.** Linux's driver sends a period per message and counts a period played when its
  message completes, so a transmit buffer completes **when the worklet has consumed it**, not when it's copied. That
  keeps the guest's ALSA position (and its A/V sync) honest and gives the backpressure.
- **The browser resamples, not us.** The context runs at the rate the guest's stream chose (a new context when it
  changes). Formats S16_LE, S32_LE and FLOAT_LE (converted to f32 in the device worker), 1 or 2 channels.
- **Sound is on by default:** every page machine has the device; sound starts at the first click or key on the page
  (the browser's autoplay rule); mute and volume are in the page's Sound menu.
- **The page's volume is the guest's Master** (2026-10-17, the user): on the page's machines the device offers
  `VIRTIO_SND_F_CTLS` with a `Master Playback Volume` (with a dB scale) and `Master Playback Switch`, which the guest's
  ALSA (and PipeWire's ACP, the card's hardware volume) sees as the card's, and they are the Sound menu's volume and
  Sound on, both ways. **The guest is followed** (the user's choice): WirePlumber gives every new output its
  `device.routes.default-sink-volume`, 0.064 (shown as 40%), whatever the hardware is at, so a fresh disk starts at
  40% and the slider shows it; raised once, WirePlumber keeps the level on that disk. The page doesn't override the
  guest's setting, and doesn't keep the guest's changes (the next machine starts at what the user chose). The slider's
  gain is its cube, as PipeWire's and PulseAudio's sliders, so the two show the same percentage. The test guests'
  machines have no controls (QEMU's device, the oracle, has none).
- **The microphone opens on the guest's demand:** the device always has an input stream; the page asks for the
  microphone (`getUserMedia`, the browser's prompt) the first time the guest starts capturing, and the guest records
  silence, in real time, until it's granted (or if it's denied or turned off). The browser's processing (echo
  cancellation, noise suppression, auto gain) is on, since the guest's own sound would otherwise be in a call; **Raw
  microphone** turns it off, for music.
- **No guest-side software.** The guest's own driver and sound stack (ALSA alone, PipeWire, PulseAudio) run unmodified;
  mixing and resampling of several guest streams stay the guest's.
- **The guests' own kernels carry the driver**: Debian's, Alpine's and the desktop guest's Arch (arch.bens.haus's
  aarch64 port) build `CONFIG_SND_VIRTIO=m`. Arch Linux ARM's `linux-aarch64`, the desktop guest's distribution until
  2026-10-16, didn't: we built it out of tree then (a DKMS package in the repo, not published, dropped with the move;
  git history has it).
- **Step counts moved twice for audio** (the snd guest's tone length, then the input stream), each once in its commit.

## How it fits together

- **Device** (`web/snd.ts`, native twin `core/tests/common/snd.rs`): an output stream (0) and an input stream (1), no
  jacks, no channel maps, no stream events; on the page's machines the Master volume and switch (`VIRTIO_SND_F_CTLS`,
  the spec's `mixer`; the twin has none), their changes said on the port both ways and the guest notified on the
  event queue; four queues of 64. Control
  requests are answered promptly in every mode (Linux's time out after 1 s). The **sink** (`SndSink`) takes a
  transmit message's frames and completes it when they were played; the **source** (`SndSource`) fills receive
  messages. Both are interfaces with a deterministic and a realtime implementation each (below). Details:
  devices.md "snd".
- **Ring** (`web/audio-ring.ts`): 65,536 f32 stereo frames (1.37 s at 48 kHz; a mono stream is written to both
  channels) behind a header of i32 words, Atomics only: write index (the device worker's), read index, RUN, the
  worklet's heartbeat, underruns and their silent frames, the output latency (the page's), the stream's rate, a start
  epoch and a wake word. Indices count frames and wrap at 2^32. A new ring per machine start (`PageAudio.attach`),
  passed in the start message (`sound`) and on the device spec (`ring`, `port`).
- **Who moves the read index:** the worklet while it plays (its heartbeat moved in the last 50 ms); else the sink's own
  clock, at the stream's rate by `performance.now()` (no page, a context not running yet, a context at another rate),
  from the worklet's last quantum when it takes over. When the ring runs dry that clock waits for the guest, and the
  wait counts as an underrun when sound comes again. Both move it by compare-and-exchange, so a hand-over can't move
  it backwards. Hence a guest never stalls on a suspended context.
- **Worklet** (`web/audio-worklet.ts`, `webpc-snd`): copies up to 128 frames per render quantum out of the ring, silence
  for what's missing, counts a gap in a started stream's sound as an underrun when sound returns, plays only while RUN
  is set and its context runs at the stream's rate, and allocates nothing in `process`. It bumps and `Atomics.notify`s
  the wake word every 2 quanta (5.3 ms at 48 kHz); the sink's loop waits on it with `Atomics.waitAsync` (5 ms timeout).
  `?snd=timer` uses a 5 ms `setInterval` instead (kept for comparison).
- **Latency the guest sees:** each completion's `latency_bytes` is the browser's output latency (`baseLatency +
  outputLatency`, refreshed once a second into the ring's header). Linux makes it ALSA's `runtime->delay`, which a
  player's A/V sync adds; what is in the ring is already counted, since those messages haven't completed.
- **Microphone:** a second ring of the same layout, which the page's `webpc-mic` worklet fills from `getUserMedia`
  (through a context at the input stream's rate) while the device asks (`capture-start`, `capture-stop` on the port),
  and the device worker's `micSource` reads, at most a buffer behind; without it, silence on the source's clock.
  Closed when the guest stops recording (the browser's indicator goes off).
- **Time and determinism.** Deterministic mode (tests, native runners) has no wall clock: the sink (`checksumSink`,
  FNV-1a of the frames) completes a message at the end of the `DEVICE` exit that posted it, and the source
  (`patternSource`: integer triangle waves, 1 kHz left, 1.5 kHz right) fills at the end of the exit, so a guest plays a
  file as fast as it can and boots keep exact step counts; the twin does the same. Realtime mode paces by the worklet
  as above; a machine without a page (Node, the bench pages) has a ring nothing plays, paced by the sink's clock.
- **Snapshots:** the streams' parameters and states are the backend's `save`/`restore` JSON; the ring's content is
  dropped and the held messages are posted again by the core, so what was in the ring plays again on load (up to a
  buffer). Older snapshots without the input stream still load.

## The guests

| Guest | virtio-snd | Notes |
|---|---|---|
| Debian 13 (6.12.107+deb13-arm64) | a module (`virtio_snd.ko.xz`), autoloaded | card 0 `VirtIO SoundCard`, `pcmC0D0p` and `pcmC0D0c`, the Master volume and switch (read, written and notified, checked with perl's `ioctl`s: the page test); the nocloud image has no `alsa-utils` (the tests play and record with our static `snd-play` and `snd-rec` from a second disk: `images/snd/`) |
| Alpine 3.24 `linux-virt` | a module (`CONFIG_SND_VIRTIO=m`, with `snd`, `snd-pcm`, `snd-timer`) | binds after `modprobe virtio_snd` (no device manager: nothing autoloads); playback not exercised (no `alsa-utils`) |
| Arch Linux (arch.bens.haus) `linux` 7.2.9.arch1 | a module (`virtio_snd.ko.zst`, `CONFIG_SND_VIRTIO=m`), autoloaded | the desktop guest (sway, foot, Firefox, PipeWire) |
| Arch Linux ARM `linux-aarch64` 7.2.9 | **not built** (`# CONFIG_SND_VIRTIO is not set`) | the desktop guest until 2026-10-16, with our DKMS module (since dropped) |
| Our test kernels | `linux-snd`: allnoconfig + the fragment + `SND_VIRTIO` built in | the snd guest ([images.md](images.md)) |

- **The desktop guest** (`images/arch/desktop.sh`, `media.sh`, `desktop-setup.sh`; Arch Linux from arch.bens.haus, kernel
  7.2.9, sway, Firefox 157, PipeWire 1.6.9, WirePlumber 0.5.18; measured on Arch Linux ARM with the same versions):
  PipeWire drives the card through ALSA in mmap mode, FLOAT_LE 48 kHz
  stereo, periods of 512 frames, a buffer of 8192 (170 ms); every Firefox stream goes through `pipewire-pulse`.
  WirePlumber makes the virtio card's capture a source too.
- **The oracle:** QEMU (`qemu-system-aarch64`, TCG, through our EDK2 as `tools/uefi-oracle.ts` sets it up) with
  `-device virtio-sound-device,audiodev=snd0 -audiodev wav,...` **and `-global virtio-mmio.force-legacy=false`**: QEMU's
  virtio-mmio is legacy by default and `virtio_snd` refuses a legacy device (our transport is modern). The `wav` backend
  leaves its RIFF lengths 0 when the guest powers off (read the samples after the 44-byte header, by the file's size),
  has no input, and **loses the stream's tail** (it completes a message when it's copied into its mixing buffer, not
  played). The same kernel and init get the same control requests in the same order as from ours.

## Linux driver behavior

Read from `sound/virtio/` (GPL: behavior only) and confirmed against the guests. These are why the sink and source
are shaped as they are.

- **Messages:** one per period, whole periods only (a stream's last partial period is never sent); a buffer's worth is
  queued before `START` (the start threshold), so the device holds messages while prepared.
- **`PCM_RELEASE` must return every held message** (Linux's `sync_stop` waits for them; the spec says so), **but
  `PCM_STOP` keeps them**: it is also Linux's pause, resumed with `START` without posting anything again.
- **Linux counts its position in completions, modulo the buffer** (`virtsnd_pcm_msg_complete` adds each message's length
  to `hw_ptr` and wraps; the pointer callback reports the difference since its last look, from a work item one run of
  which serves any number of completions). A whole buffer completed before ALSA looks again reads as no progress, and
  the guest's next write waits out its timeout with `EIO`. So **a sink never completes more than a buffer less a period
  since the guest's last message** (counted across pumps; the rest completes after its next message, or at a stream's
  end half a buffer's time and 30 ms after the core was seen to have taken the batch's first completion
  (`completionBound`, `Ctx.untaken`), by which time the guest's clock ran past what ALSA's jiffies check needs to take a
  whole buffer for a wrap, even if its work runs late). A drain's last period comes about that late anyway.
- **After a restore** the bound counts as if the guest had a whole buffer in flight (the backend tells the sink and
  source the re-posted bytes at the restore's first poll): a snapshot is taken with every completion the core had, so
  a period completed just before the save is in the used ring but not yet in ALSA's position, and only the messages
  still in flight are posted again.
- **A restored clock must not run before the guest does.** The VM's clock now stands at its saved reading until a vCPU
  first runs (`Clock::start`), and taking a snapshot holds it at the reading it saves (`Clock::hold`): on the page the
  vCPU workers start ~130 ms after the restore, which ALSA's 100 ms wait for a period found expired at the first
  instruction. The vCPU workers also start together (each waits on a start word until all are instantiated). Any guest
  timeout shorter than the setup was exposed the same way ([platform.md](platform.md) "Snapshots").
- **`ALSA drain` on an already empty stream fails** (`snd_pcm_drain` waits for a period to elapse without looking at the
  position first, then `EIO` after max(100 ms, 1.1 × the buffer)). The snd guest asks `STATUS` first and drops when
  nothing is queued; real players use realtime sinks, which don't empty the buffer early. Deterministic mode is for
  the test guests only.
- **Capture:** Linux posts a capture period again as soon as ALSA counts it, before the reader has it (the driver's
  messages point into ALSA's own buffer), so the device writes the buffer cyclically as hardware does. The
  deterministic source runs ahead of real time and overwrites the first buffer before the guest's first read: the snd
  guest reads the pattern from frame 4096 (pinned in both runners; harmless since real sources go at the stream's
  rate). Capture needs the same buffer-less-a-period bound as playback.
- **Limits come from `PCM_INFO`:** periods 2–16 of 160–122,880 bytes, a buffer up to 245,760; zero jacks and channel
  maps are fine; formats S16_LE, S32_LE, FLOAT_LE (ALSA mask `0x4404`); QEMU's device offers more (5,512–384,000 Hz).
- **The test kernel's build number** (`#N` in the version string) moves a guest's step count (469 steps from `#2` to
  `#1`): `linux-snd` pins `KBUILD_BUILD_VERSION=1`. (`linux-gpu` doesn't: [backlog.md](backlog.md).)

## Measurements

The dev VM unless noted, headless Chromium 153. JSON in `bench/audio/results/`; drivers in `bench/audio/`.

- **Playback over a minute** (`snd-page.ts`, `s2-exit.json`; the page's `snd` machine, 60 s tone, S16 48 kHz stereo, 4
  periods of 1024, an 85 ms buffer): the guest's own clock says 60,011-60,029 ms for 60,010.7 ms of sound; no underrun,
  no gap frame. The completions' jitter is the output's render callback: `baseLatency` is 10 ms, so the worklet renders
  ~4 quanta every 10 ms. Worklet notify p50 1.4 ms, p99 10 ms, max 13 ms; timer p50 1.5, p99 10-13, max 15; the device
  worker's time in the pumps ~2.8 ms a second either way. **The notify is kept** (tighter tail, doesn't depend on timers
  a hidden page might throttle). The latency the guest gets: 2017 frames (42 ms headless), refreshed once a second.
- **Time lost on the sink's clock (found under load):** taking over from the worklet used to restart the sink's clock
  when it noticed (up to 50 ms after the last quantum), and a dry ring restarted it silently. Now it starts from the
  last quantum and counts its dry spells. Under CI's load the guest's own computing of its first periods before `START`
  adds another 70-107 ms of its time with no gap in the ring; the Chromium test therefore times the stream on the device
  (START to its stop), within 40 ms of the length plus the counted gaps.
- **Debian (ALSA alone):** a 3 s WAV at 44.1 kHz with aplay's buffer (500 ms in 4 periods): 3,110 ms of its own time
  for 3,125 ms of sound; the page hears 440 and 660 Hz. ALSA's delay half-way is the buffer plus 1,852 frames (the
  output latency). Under QEMU's device the file's samples come out exactly. An MP3 with `mpg123` played start to end by
  hand without a glitch.
- **A/V sync** (`avsync.ts`, `results/s3/`; Mac host's GPU through `bench/gpu/sway-mac.sh` with
  `SCRIPT=../audio/avsync.ts`: ANGLE on Metal, M4, `--mute-audio`, the guest on 4 vCPUs with 3D): a synthetic clip (a
  white flash and a 1 kHz beep each second, made with ffmpeg in Podman) in Firefox on the desktop guest, flash timed on
  the page's scanout (`?avprobe`) and the beep on an `AnalyserNode` tap with the output latency accounted. After a
  start-up transient of 4 s (the sound first while Firefox's video catches up) **every offset is within -17 to +20 ms**
  (two clusters ~17 ms apart: a 60 Hz frame), inside ±45 ms (ITU-R BT.1359's detectability threshold). The dev VM's
  SwiftShader saturates the guest, so A/V sync is measured on a real GPU only. The user judged a video by ear "good
  enough": the decode is too slow to judge sync by ear ([backlog.md](backlog.md) "Hardware video decoding").
- **Cost:** mpv on Sintel's sound alone, `--ao=pipewire` against `--ao=null`: the guest's 4 vCPUs 10% busy against 9%
  (PipeWire's data loop 34 ms of CPU a second). **The sound costs the guest under 1% of its CPU.** The video's decode is
  the cost: Firefox's VP9 decoder takes 1.7-1.8 s of CPU a second for 480p and still shows ~10% of its frames.
- **The sound never broke:** no underrun and no gap frame in any phase of any run, even with the guest saturated.
- **Snapshots while sound plays** (three Chromium runs; Node with 0, 150 and 400 ms before the first run on 4 vCPUs;
  under six to ten busy-looping processes): the loaded machine is heard at 440 and 660 Hz and plays to its end with a
  normal drain; its new ring holds exactly what the guest hadn't had completed at the save; one counted underrun of
  20-35 ms while the vCPUs start (136-192 ms under heavy load), then none.
- **Capture, the device:** 16 periods recorded in 342 ms of the guest's own time under QEMU (`none` backend) and 348 ms
  on the page's clock source. With the microphone opening at the recording's start, the first periods come from the
  clock's silence until the worklet runs, and the switch starts the period in progress again: 343-373 ms.
- **Capture, the page's microphone** (Chromium's fake capture device, a 500 Hz WAV): the guest hears **505 Hz** with Raw
  microphone, 3 s in 3,033-3,038 ms, nothing dropped; 495 Hz with the browser's processing. Debian's `snd-rec` (ci-debian):
  144,000 frames in 3,020 ms, 497 Hz on both channels. The desktop guest's `pw-record` (`bench/audio/mic-desktop.ts`,
  `results/s4/`): 491-493 Hz, peak 16,079 of 32,767. Chromium resamples the microphone to a capture context at the
  stream's rate; a worklet with no outputs is processed because it has an input.

## Tests

See testing.md "virtio-snd" for the commands. By layer: `tests/snd.test.ts` (every control request and error, a
stream's lifecycle, each format's conversion, held messages, the sources on a fake clock, save and restore);
`tests/audio.test.ts` (the ring sink on a fake clock and the worklet's `process` under stubs); the snd guest
(`linux-snd`: opens `/dev/snd/pcmC0D0p`, sets parameters through ioctls, plays a known waveform, drains, records 16
periods, prints the hashes) natively, in Node and in Chromium in the same steps, 49,152 frames arriving byte for byte
(FNV-1a `5652c745`); `tests/audio-browser.test.ts` (`scripts/ci-audio.sh`, alone: it times the sound; Chromium: the tone heard at 440 and 660 Hz through an
`AnalyserNode`, mute, a context that isn't running leaving the guest playing on the sink's clock, a snapshot taken
mid-tone and loaded in a fresh profile, the fake microphone heard at its pitch); Debian on the page in `ci-debian.sh`
(`snd-play` and `snd-rec`).

Not covered headless: the real autoplay prompt and a hidden tab (headless Chromium starts an `AudioContext` without a
gesture and never hides a page; the test suspends the context itself to reach the same state), and the real microphone
prompt, indicator and hardware ([backlog.md](backlog.md) "Sound by hand only").
