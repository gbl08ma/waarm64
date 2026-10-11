# webpc audio plan

**Status:** S0 done (the guests: §11), S1 done (the device, deterministic: §12) and S2 done (the page: §13),
2026-10-10; S3 done (real guests: §14), 2026-10-11 (the user's ear: "good enough", decision 12); S4 (snapshots and
capture) under way: snapshots while sound plays done (§15); capture's device (§16) and the page's microphone (§17)
done; Debian's recording and the desktop guest's source next, then the user's ear. The user's decisions are §10; the rest is the proposal, to be settled by measurement as it's built. It feeds M8's "Audio" item (PLAN.md, M8).

The question: how does a guest's sound reach the page's speakers (and, maybe, the page's microphone reach the
guest), **with the guest's own unmodified drivers**, in time with what it shows, without the main thread in the path?

## 1. Decisions (proposed)

- **The device is virtio-snd** (virtio 1.2 §5.14, device ID 25), on our virtio-mmio transport like every other
  device. It's the only sound device a virtio-mmio machine can offer without new buses (no PCI: HDA and USB audio
  are out), and Linux has had its driver (`CONFIG_SND_VIRTIO`, `sound/virtio/`) since 5.13.
- **The output is an AudioWorklet** on the page's `AudioContext`, fed from **a `SharedArrayBuffer` ring the device
  worker writes and the worklet reads**: the data never crosses the main thread (its jank, a long task or a GC, can't
  glitch the sound), and no message is sent per buffer. The page only creates the context, the node and the ring,
  and hands the ring to the device worker with the device spec (`specPorts`, as net and input do).
- **The guest's clock is the worklet's.** virtio-snd's Linux driver sends a period per message and counts a period
  played when its message completes, so a transmit buffer is completed **when the worklet has consumed it**, not when
  it's copied. That keeps the guest's ALSA position (and so its A/V sync) honest and gives the backpressure.
- **The browser resamples, not us.** The device offers the rates an `AudioContext` takes; the context runs at the
  rate the guest's stream chose (a new context when a stream's rate changes; rare in practice). Formats S16_LE,
  S32_LE and FLOAT_LE (to f32 in the device worker), 1–2 channels.
- **Playback first** (the user, §10). Capture (the page's microphone through `getUserMedia` into the receive
  queue) is the same machinery backwards plus a permission prompt: S4, after playback is solid.
- **Sound is on by default** (the user, §10): every page machine has the device, and sound starts at the first
  click or key on the page (the browser's autoplay rule), with mute and volume in the page's Sound menu.
- **No guest-side software.** The guest's own driver and its own sound stack (ALSA alone, PipeWire, PulseAudio)
  run unmodified; mixing and resampling of several guest streams stay the guest's.

## 2. What exists (to read before building)

- **The spec**, virtio 1.2 §5.14 (and 1.3's additions: `VIRTIO_SND_F_CTLS`, mixer controls). Four queues:
  controlq, eventq, txq, rxq. Configuration: the counts of jacks, streams and channel maps. Control requests:
  `JACK_INFO`/`JACK_REMAP`, `PCM_INFO`, `PCM_SET_PARAMS`, `PCM_PREPARE`, `PCM_RELEASE`, `PCM_START`, `PCM_STOP`,
  `CHMAP_INFO`. An I/O message is `virtio_snd_pcm_xfer` (the stream), the frames, then a device-writable
  `virtio_snd_pcm_status` (status, `latency_bytes`). Events: jack connected/disconnected, a period elapsed, an
  xrun. Of the stream features (shared-memory periods, polling, period and xrun events) Linux uses messages only.
- **Linux's driver** (`sound/virtio/`, GPL: read for behavior, nothing copied): one message per period, all of a
  buffer's periods queued at start and each completion re-queued; control requests time out (a module parameter,
  1 s by default), so the device answers them promptly in every mode; its `sync_stop` sends `PCM_RELEASE` and
  waits for every message to come back (the spec: "the device MUST complete all pending I/O messages"), so **the
  device returns every held message at `PCM_RELEASE`**; `PCM_STOP` is also its pause (resumed with `START`, the
  messages not posted again), so STOP keeps them (§12). Checked against the source in S1 (§12): zero jacks and
  channel maps are fine, the position is counted in completions only, the limits come from what `PCM_INFO` offers.
- **Permissive implementations to read:** crosvm's `devices/src/virtio/snd` (BSD-3) and rust-vmm's
  `vhost-device-sound` (Apache-2.0 or BSD-3): how they pace completions, and which corners of the spec they skip.
  QEMU's `hw/audio/virtio-snd.c` (GPL) is an oracle and a behavioral reference only; QEMU on the dev VM with
  `-device virtio-sound` and a `wav` audio backend is the oracle for what a guest sends (`THIRD_PARTY.md` rows when
  something is ported).
- **The guests' kernels:**

  | Guest | virtio-snd | Notes |
  |---|---|---|
  | Debian 13 (6.12.107+deb13-arm64) | **a module** (`kernel/sound/virtio/virtio_snd.ko.xz`), autoloaded | checked under QEMU's device (§11): binds, plays a 440 Hz tone; the nocloud image has no `alsa-utils` (`apt install` it) |
  | Alpine 3.24 `linux-virt` | **a module** (`CONFIG_SND_VIRTIO=m`; `snd`, `snd-pcm`, `snd-timer` modules too) | 6.18.53's config read from the boot tests' rootfs; the UEFI cloud image's 6.18.52 binds it under QEMU after `modprobe virtio_snd` (no device manager: nothing autoloads) |
  | Arch Linux ARM `linux-aarch64` 7.2.9 | **not built** (`# CONFIG_SND_VIRTIO is not set`; `snd`, `snd-pcm` built in) | the desktop guest (sway, Firefox, GTK4): our module, `images/archarm/virtio-snd.sh` (§11), autoloaded, plays under QEMU |
  | Our test kernels (`images/linux*`) | ours to enable | a `linux-snd` like `linux-gpu`: S1 |

## 3. The device (`web/snd.ts`, twin `core/tests/common/snd.rs`)

- `{type: 'snd', ring?, port?}`: an output stream and an input stream (since S4, always: decision 13), no jacks, no
  channel maps (Linux needs none: §12), no controls. Queues of 64.
- **Control:** `PCM_INFO` answers formats, rates, channels 1–2; `SET_PARAMS` checks them and the
  buffer/period sizes (a period a whole number of frames, the buffer a whole number of periods) and keeps them;
  `PREPARE` resets the stream's ring position; `START`/`STOP` start and pause consumption; `RELEASE` returns every
  held message (STOP pauses). Malformed or out of order: `BAD_MSG`; unsupported: `NOT_SUPP`, as the spec says.
  Built in S1 (devices.md "snd"), with the sink as an interface (`SndSink`) the ring implements in S2.
- **Transmit** (`ringSink`, built in S2): a message's frames are converted to f32 stereo and written into the ring
  when it has room; the message is held until the ring's read index passes its last frame, then completed with `OK`
  and `latency_bytes` = **the browser's output latency** (`baseLatency + outputLatency`, which the page writes into
  the ring's header). Linux makes `latency_bytes` ALSA's `runtime->delay` (`virtsnd_pcm_msg_complete`), the time
  between a period's completion and its sound reaching the ears, which is what a player's A/V sync adds; what's
  still in the ring is already counted, since those messages haven't completed. A message that doesn't fit the ring
  yet waits (the guest's buffer is the queue). At most a buffer less a period completes since the guest's last
  message (§12, §15, §16): the rest after its next message or, at a stream's end, half a buffer's time and 30 ms
  after the batch was taken.
- **Events:** an xrun when the worklet ran dry while the stream was started (the guest restarts the stream, as on
  hardware), if Linux takes them; otherwise silence fills in.
- **Snapshots:** the streams' parameters and states are the backend's `save`/`restore` JSON; the ring's content
  is dropped and held messages are posted again by the core, as for every device (devices.md "Chains in
  flight"), so what was in the ring plays again on load (up to a buffer; built in S4, §15).

## 4. The page and the worklet (`web/audio.ts`, `web/audio-worklet.ts`, `web/audio-ring.ts`)

- **The ring** (`web/audio-ring.ts`): a `SharedArrayBuffer` of 65,536 f32 stereo frames (1.37 s at 48 kHz: more
  than the guests' buffers at the rates they use; a mono stream is written to both channels) behind a header of
  i32 words, Atomics only: the write index (the device worker's), the read index, RUN (the stream is started),
  the worklet's heartbeat (QUANTA), underruns and their silent frames, the output latency (the page's), the
  stream's rate, a start epoch and a wake word. The indices count frames and wrap at 2^32. A new ring per machine
  start (`PageAudio.attach`), in the start message (`sound`), on the device spec (`ring`, `port`).
- **Who moves the read index:** the worklet while it plays (its heartbeat moved in the last 50 ms); else the
  device worker's sink, at the stream's rate by `performance.now()` (no page, a context not running yet, a
  context at another rate), from the worklet's last quantum when it takes over (so the 50 ms aren't lost time);
  when the ring runs dry its clock waits for the guest, and the wait is counted as an underrun (and its frames as
  gap frames) when sound comes again, as the worklet counts its gaps. Both by compare-and-exchange, so a
  hand-over can't move it backwards; a quantum that loses the exchange plays silence.
- **The worklet** copies up to 128 frames per render quantum out of the ring, plays silence for what's missing,
  and counts a gap in a started stream's sound as an underrun when the sound comes back (so a stream's end isn't
  one). It plays only while RUN is set and its context runs at the stream's rate. It allocates nothing in `process`.
- **Waking the device worker:** the worklet bumps and `Atomics.notify`s the wake word every 2 quanta (5.3 ms at
  48 kHz); the sink's loop waits on it with `Atomics.waitAsync` with a 5 ms timeout, beside the doorbell's wait,
  and completes what was played. `?snd=timer` uses a 5 ms `setInterval` instead; both measured in S2 (§13), the
  notify kept.
- **Autoplay:** an `AudioContext` starts suspended until a user gesture. The page creates it at the stream's
  `START` (the device's port says so, with the rate), at that rate, and resumes it at once (it runs if the page
  already had a gesture) or at the next click or key anywhere on the page; until then the sink's own clock plays
  the ring (the guest doesn't stall), and the Sound menu's summary reads "Sound: click to hear".
- **Mute and volume** in the page's **Sound** menu (a `GainNode`; not the Machine menu, whose settings apply by a
  restart), kept with the page's settings (`muted`, `volume`); guest-side controls (`VIRTIO_SND_F_CTLS`) later if
  wanted.
- **The tab in the background:** not measurable headless (§13): left to the user's manual check.
- **The microphone** (S4, decisions 13 and 14; frontend.md "Sound"): a second ring of the same layout, which the page's
  `webpc-mic` worklet fills from `getUserMedia` (through a context at the input stream's rate) while the device asks
  (`capture-start`, `capture-stop` on the port), and the device worker's `micSource` reads, at most a buffer behind;
  without it, silence on the source's clock. The Sound menu's Microphone and Raw microphone choices.

## 5. Time and determinism

- **Deterministic mode** (tests, native runners) has no wall clock to pace by: the device completes a message at
  the end of the `DEVICE` exit that posted it (`checksumSink`: FNV-1a of the frames, or the frames themselves), at
  most a buffer less a period per exit (§12), so a guest plays a file as fast as it can and boots keep exact step
  counts. The twin in `core/tests/common` does the same. In S1 every machine has this sink.
- **Realtime mode** paces by the worklet as above. A machine without a page (Node, the bench pages) has the same
  ring sink with a ring of its own that nothing plays: its own clock paces it at the stream's rate.

## 6. Tests (cheapest layer first)

- **Node, the device's bytes** (`tests/snd.test.ts`): every control request and its errors, a stream's lifecycle,
  conversion of each format, messages held until consumed and returned at stop and release, save and restore.
  **The ring** (`tests/audio.test.ts`): the realtime sink on a fake clock and the worklet's `process` under stubs:
  the ring's order across a wrap, completions by the worklet's index or the sink's own clock, the burst limit,
  pause and release, mono, underruns counted when a gap ends, a lost exchange playing silence.
- **A guest, deterministic** (`linux-snd`: allnoconfig + the fragment + `SND`, `SND_VIRTIO`, a static init that
  opens `/dev/snd/pcmC0D0p`, sets parameters through ioctls, writes a known waveform, drains, closes): the sink's
  checksum, natively, in Node and in Chromium, in the same steps. The control sequence checked against QEMU's
  device with the same kernel (the oracle).
- **Chromium, realtime** (`tests/audio-browser.test.ts`, built in S2): the `linux-snd` guest on the page's `snd`
  machine plays 4 s of its tone; the guest's own time is the sound's length, an `AnalyserNode` after the volume
  hears 440 and 660 Hz, mute silences it and is remembered; a context that isn't running leaves the guest playing on
  the sink's clock with the page saying so, and a click resumes it.
- **Debian on the page** (ci-debian.sh): `virtio_snd` binds to the page's device (S2); S3: a file played (`snd-play`
  from a second disk, decision 10) plays its length in real time (± a period) and the page's tap hears it.

## 7. Performance

- The device is cheap (a copy and a conversion per period). **The guest's decoding is the cost**: Opus, AAC or MP3
  decoding and resampling run on emulated vCPUs. Measured in S3: a vCPU's load while the guest plays a file with
  `mpg123` or `ffplay`, and Firefox playing a video's sound, against the frame rate without sound.
- **Latency:** the ring's length plus the guest's buffer (PipeWire's quantum, ALSA's buffer) plus the browser's
  output latency (`AudioContext.outputLatency`). Target to set by measurement: ~100 ms is fine for video (A/V sync
  uses the reported latency), interactive sound would want less.

## 8. Phases

- **S0, the guests** (no device code; **done**, §11): which kernels have the driver (Debian on our machine with QEMU's device;
  Alpine's `linux-virt`); for Arch, `virtio_snd` built out of tree against `linux-aarch64-headers` in rootless
  Podman (`images/archarm/`), loaded on the Arch image under QEMU's device.
- **S1, the device, deterministic** (**done**, §12): `web/snd.ts`, its twin, the `linux-snd` guest; Node and native
  tests; the oracle comparison. Exit: the guest's tone arrives byte for byte in every runner.
- **S2, the page** (**done**, §13): the ring, the worklet, the pacing, autoplay, mute and volume. Exit: a tone from
  the `linux-snd` guest on the page plays at the right speed with no underrun over a minute; the wake's jitter
  measured.
- **S3, real guests** (**done**, §14, but for the user's ear): Debian (ALSA), then the desktop guest (PipeWire under sway, Firefox, with the module from
  S0, then its PKGBUILD). **Exit (the user's bar): a video's sound in sync with its picture in Firefox on the
  desktop guest**, by ear and by the reported latency; the decode cost measured; ci-debian covers Debian's ALSA
  playback.
- **S4, snapshots and capture:** a snapshot taken while sound plays resumes playing; capture if §10 says so.

## 9. Risks

- **Pacing jitter** makes PipeWire's timer-based scheduling (it predicts the position between interrupts) drift or
  xrun; mitigations: a longer ring, reporting `latency_bytes` well, completing on a steadier clock.
- **The emulator's speed:** a guest that can't decode in real time underruns; the sound then stutters where video
  would only drop frames. Measured in S3 before anything is tuned.
- **Arch's kernel** has no driver: the out-of-tree module must follow every `linux-aarch64` update (the PKGBUILD,
  with DKMS if needed, is what keeps it current on a user's machine).
- **Autoplay** and a suspended context: a guest stalled waiting for completions would look hung, hence the
  free-running clock before the first gesture (§4).

## 10. The user's decisions (2026-10-10)

1. **Playback first;** capture (the microphone) comes after it, as S4.
2. **Arch's missing driver: we build the module** out of tree (S0), and eventually **a PKGBUILD** so it builds
   from within Arch Linux ARM in a native fashion (with DKMS if needed). **Nothing is asked of upstream.**
3. **Sound is on by default:** it starts at the first click or key on the machine; mute in the menu.
4. **The bar for done:** a video's sound in sync in Firefox on the desktop guest (PipeWire under sway), with
   Debian's ALSA playback covered by ci-debian.

At S2's start (2026-10-10):

5. **The minute-long tone:** the `linux-snd` init takes its length from the command line (`snd_seconds=N`, an
   environment variable to init; 1.024 s without), and its step count moves once for it.
6. **Debian on the page gets the device in S2** (sound on by default as soon as the page side works); S3 checks its
   playback.
7. **S2's exit is judged by measurement;** the user tests by hand at its end, and fixes from that go into an
   upcoming milestone.

At S3's start (2026-10-11):

8. **The desktop guest is a scripted image** (from `images/archarm/build.sh`: sway, foot, Firefox, PipeWire with
   WirePlumber, our module, a test clip), on demand like the rest of `images/archarm/`; the user's own images stay
   untouched.
9. **A/V sync is measured** as well as heard: a synthetic clip (a white flash and a 1 kHz beep each second, made with
   ffmpeg in Podman) played by the guest's Firefox, the flash timed on the page's scanout and the beep on an
   `AnalyserNode` tap (with the output latency accounted), **within ±45 ms** (ITU-R BT.1359's detectability
   threshold); a real video by ear.
10. **ci-debian plays through our own static player** (from `linux-snd`'s raw-ALSA init, playing a WAV), handed to
    the guest without the network; Debian's own driver does the playing.
11. **The PKGBUILD** (`virtio-snd-dkms`) lives in the repo, is built and installed in a Podman Arch container and in
    an image, DKMS building the module; it isn't published anywhere.

At S4's start (2026-10-11):

12. **S3's ear check is "good enough":** the video's decode is too slow to judge A/V sync by ear; that waits for
    hardware video decoding, a track of its own (backlog).
13. **The microphone opens on the guest's demand:** the device always has an input stream; the page asks for the
    microphone (`getUserMedia`, the browser's prompt) the first time the guest starts capturing, and the guest records
    silence, in real time, until it's granted (or if it's denied). A **Microphone** checkbox in the Sound menu turns it
    off, remembered like mute.
14. **The browser's processing is on** (echo cancellation, noise suppression, auto gain: the guest's own sound is
    cancelled out of the microphone in a call), with a **raw** choice in the Sound menu for recording music.
15. **The input stream moves step counts once,** in its commit.
16. **Capture's bar:** a known waveform recorded byte for byte in every runner (checked against QEMU's device), a fake
    microphone heard by the guest at its pitch and in real time in Chromium, Debian's `arecord` in ci-debian, a
    PipeWire source on the desktop guest; then the user records and plays back by ear.

## 11. S0 findings (2026-10-10)

How each guest was checked: booted under `qemu-system-aarch64` 11.1.1 (TCG, through our EDK2 as
`tools/uefi-oracle.ts` sets the machine up, the image under a qcow2 overlay) with `-device
virtio-sound-device,audiodev=snd0 -audiodev wav,id=snd0,path=…,out.frequency=48000,out.channels=2,out.format=s16`,
then `cat /proc/asound/cards`, `aplay -l` and `speaker-test -D hw:0,0 -t sine -f 440 -r 48000 -c 2 -F S16_LE -l 1`.

- **QEMU's virtio-mmio is legacy by default** (`force-legacy=true`), and `virtio_snd` refuses a legacy device
  (`device does not comply with spec version 1.x`, probe -22); virtio-blk and virtio-net don't care. The oracle needs
  **`-global virtio-mmio.force-legacy=false`**. Our transport is modern (version 2), so the page has no such issue.
- **QEMU's `wav` backend leaves the RIFF and `data` lengths at 0** when the guest powers off (it doesn't finalize the
  header on that exit): read the samples after the 44-byte header, by the file's size.
- **Debian 13** (6.12.107+deb13-arm64): `virtio_snd` is autoloaded (lsmod: `virtio_snd` 40960, `snd_pcm`, `snd_timer`,
  `snd`, `soundcore`), card 0 `VirtIO SoundCard`, `pcmC0D0p` and `pcmC0D0c`. With `alsa-utils` (apt, the
  snapshot.debian.org date of `images/debian-chromium/build.sh`, user networking) the tone played: the wav has
  287,748 frames at 48 kHz stereo S16 = 5.995 s, left channel 0–3.00 s then right 3.00–5.99 s, 440 Hz (zero
  crossings), peak 26226. speaker-test's own period count: 12000 frames, buffer 48000 (4 periods of 250 ms).
- **Alpine:** the boot tests' rootfs (linux-virt 6.18.53) has `CONFIG_SND_VIRTIO=m` with `snd`, `snd-pcm`,
  `snd-timer` as modules, `virtio_snd.ko.gz` in `kernel/sound/virtio`; module signing on but not forced. The UEFI
  cloud image (`images/alpine-uefi.json`, 6.18.52) binds it after `modprobe virtio_snd` (card 0, playback and capture
  PCMs). Not played (no `alsa-utils` there; Debian and Arch cover playback).
- **Arch Linux ARM:** ALARM's `linux-aarch64` 7.2.9-1 is upstream `linux-7.2` plus kernel.org's `patch-7.2.9` and five
  ALARM patches (Rockchip and RPi5 device trees, the PL011 RP1 binding, a pps hack), none in `sound/` (its PKGBUILD,
  archlinuxarm/PKGBUILDs `core/linux-aarch64`). Its config: `# CONFIG_SND_VIRTIO is not set`, `CONFIG_SND=y`,
  `CONFIG_SND_PCM=y`, `CONFIG_VIRTIO=y`, `CONFIG_SND_JACK=y`; no `MODULE_SIG`, no `MODVERSIONS`, no GCC plugins, no
  LTO, uncompressed modules. So an out-of-tree module needs only the exact release (vermagic `7.2.9-1-aarch64-ARCH
  SMP preempt mod_unload aarch64`); every import (65 symbols: `snd_card_*`, `snd_pcm_*`, `snd_jack_*`, `snd_ctl_*`,
  `virtqueue_*`, `virtio_*`) resolves against the headers' `Module.symvers` at modpost.
- **The build:** `images/archarm/virtio-snd.sh` (~1 min, plus a 153 MB kernel.org download once): in a container of
  `localhost/archarm-base`, `pacman -Sy linux-aarch64-headers gcc make` (the mirror's current, 7.2.9-1; gcc 16.1.1,
  the kernel's own compiler release), `sound/virtio/` (13 files) of `linux-7.2.9.tar.xz` (sha256 against kernel.org's
  `sha256sums.asc`), `make -C /usr/lib/modules/<release>/build M=… CONFIG_SND_VIRTIO=m modules`. Result
  `target/archarm/virtio-snd/7.2.9-1-aarch64-ARCH/virtio_snd.ko`, 48,448 bytes (lsmod: 32768). `images/archarm/build.sh
  --modules <dir>` puts it in `/usr/lib/modules/<release>/updates` and runs `depmod`, after checking the vermagic
  against the image's kernel (so with `--packages`, which upgrades the kernel on the same day as the headers).
- **Checked:** `images/archarm/build.sh --packages alsa-utils --modules target/archarm/virtio-snd/7.2.9-1-aarch64-ARCH`
  (1.3 GB qcow2): udev autoloads the module at boot (`loading out-of-tree module taints kernel`), card 0
  `VirtIO SoundCard`, and the same tone came out the same: 287,690 frames, 5.994 s at 48 kHz stereo, each channel's
  3 s of 440 Hz. Shell at ~29 s on 4 TCG vCPUs.
- **Keeping it current, the PKGBUILD** (§10.2; not built yet): a `virtio-snd-dkms` package is the natural form.
  `dkms` 3.4.4 is in ALARM's `extra`; its pacman hook rebuilds the module for every installed
  `linux-aarch64-headers`, so a kernel update doesn't leave the guest without sound. The package would carry
  `sound/virtio/` (GPL-2.0, fine in a guest package; it's downloaded at `makepkg` time, never in our repo: the
  PKGBUILD's `source` is kernel.org's tarball of one release, extracting only that directory, or the stable tree's
  `sound/virtio` files at a tag), a `Makefile` with `obj-m += virtio_snd.o` and the object list, a `dkms.conf`
  (`BUILT_MODULE_NAME=virtio_snd`, `DEST_MODULE_LOCATION=/updates`, `AUTOINSTALL=yes`), and `depends=(dkms)`
  (the headers are the user's). The risk is drift: one release's source built against later kernels; the driver
  changes rarely, and a kernel API change breaks the build loudly (DKMS reports it at upgrade), when the package's
  pinned release moves. Without DKMS the alternative is a module package pinned to one `linux-aarch64` release
  (`depends=(linux-aarch64=7.2.9-1)`), rebuilt at every kernel update: more upkeep for the same result. In webpc's own
  images `images/archarm/virtio-snd.sh` stays the simpler path (no toolchain in the image).

## 12. S1 findings (2026-10-10)

What was built: the device (`web/snd.ts`, devices.md "snd"), its native twin (`core/tests/common/snd.rs`), the
deterministic sink, `{type: 'snd'}` in the device specs (on no machine yet), the `linux-snd` guest (images.md) and
its tests in every runner (testing.md "virtio-snd"). Nothing was ported from crosvm or vhost-device-sound.

- **The guest:** 49,152 frames (48 periods of 1024, S16 48 kHz stereo, a 440 Hz sine left and 660 Hz right)
  arrive byte for byte: FNV-1a `5652c745` from the guest, the sink and the waveform made again in JS, in
  **35,879,381 steps** natively, in Node and in Chromium, interpreter and JIT. The control requests:
  `PCM_INFO 0+1`, `PCM_SET_PARAMS 2ch S16 48000 16384/4096`, `PCM_PREPARE`, `PCM_START`, `PCM_STOP`,
  `PCM_RELEASE` (`tests/snd/log.txt`). Linux 6.18 derives its limits from our `PCM_INFO`: periods 2–16 of
  160–122,880 bytes, a buffer of up to 245,760 (`pcm_period_ms_min` 10 at 8 kHz mono S16; 160 ms and 80 ms at
  192 kHz stereo 32-bit), formats S16_LE, S32_LE, FLOAT_LE (ALSA mask `0x4404`).
- **The oracle** (`qemu-system-aarch64` 11.1.1 `-M virt`, `-device virtio-sound-device`, a `wav` audiodev at 48 kHz
  stereo S16, `-global virtio-mmio.force-legacy=false`, `-trace 'virtio_snd_*'`; the same kernel and init): the
  same requests in the same order, but `PCM_INFO 0+2` (QEMU's device has an output and an input stream by default,
  and offers more: ALSA mask `0x5417`, 5,512–384,000 Hz, periods from 50 bytes). The wav's samples are the guest's
  exactly, from frame 0, for as many as it holds: **QEMU's wav loses the stream's tail** (125 frames short of 49,152
  in one run, 461 in another), though drain had returned: QEMU completes a message when it's copied into its own
  mixing buffer, not when it's played, and the backend isn't flushed at power-off. Its drain took 1,024 ms (the
  sound's length: QEMU paces by its audio timer) with 4096 frames still queued when the init asked.
- **Linux counts its position in completions, modulo the buffer** (`virtsnd_pcm_msg_complete` adds each message's
  length to `hw_ptr` and wraps it at the buffer; the pointer callback reports the difference since its last look).
  A whole buffer completed before ALSA looks again reads as no progress: the first deterministic sink, which
  completed every message at once, played the four periods queued before `START` (start threshold = the buffer,
  as `aplay` does) and the guest's next write waited for room until its timeout (`write: I/O error`). **The
  deterministic sink completes at most a buffer less a period per exit**, at the exit's end (`Backend.polled`); the
  rest completes at the next exit, which the guest makes as soon as it writes again. In S2 the ring paces
  completions anyway, but a sink must never return a buffer's worth at once (after a background tab's stall, say).
- **Linux sends whole periods only:** a message is queued when a period of the buffer is full
  (`virtsnd_pcm_msg_send`, through the `ack` callback since the driver moved to indirect copies), so a stream's
  last partial period is never sent. Messages are sent before `START` (the start threshold's worth), so the
  device holds them while prepared.
- **ALSA's drain on an already empty stream fails:** `snd_pcm_drain` sets DRAINING and waits for a period to
  elapse, never looking at the position first; with every message already completed (the deterministic sink
  empties the buffer within each write) it waits out its timeout (max(100 ms, 1.1 × the buffer's time) of guest
  time) and returns `EIO`. The init asks `STATUS` first and drops when nothing is queued (QEMU's run drains). A
  player that always drains (`aplay`) would see `EIO` at its end in deterministic mode; deterministic mode is for
  the test guests, and the realtime sinks of S2 don't empty the buffer early.
- **`PCM_STOP` is a pause too** (`SNDRV_PCM_TRIGGER_PAUSE_PUSH` sends it, `PAUSE_RELEASE` sends `START` without
  re-posting anything), so returning held messages at STOP would skip unplayed sound: STOP keeps them, RELEASE
  returns them.
- **The test kernel's build number** (`#N` in the version string) counts up with each rebuild in the same tree, and
  it moves the step count (469 steps from `#2` to `#1`, strings of the same length; likely because Linux mixes its
  version string into its early entropy, not verified): `linux-snd` pins it (`KBUILD_BUILD_VERSION=1`).
  `linux-gpu` doesn't (its image says `#2`), so a rebuild of it in the same tree would move `gpu`'s steps.

## 13. S2 findings (2026-10-10)

What was built: the ring (`web/audio-ring.ts`), the realtime sink (`ringSink` in `web/snd.ts`: realtime mode's sink on
every machine; deterministic mode keeps the checksum sink), the worklet (`web/audio-worklet.ts`), the page's side
(`web/audio.ts`, the Sound menu: frontend.md "Sound"), the device on every page machine (`snd` last in the device
kinds, so the others keep their slots; snapshots list it, older ones without it still load), and the page's `snd`
machine (the test guest, no disk; `?params=snd_seconds=N`). Tests: `tests/audio.test.ts` (Node) and
`tests/audio-browser.test.ts` (Chromium), testing.md "virtio-snd".

- **The exit** (`bench/audio/snd-page.ts`, `bench/audio/results/s2-exit.json`; the dev VM, headless Chromium 153,
  the page's `snd` machine at `snd_seconds=60`: S16 48 kHz stereo, 4 periods of 1024 frames, an 85 ms buffer):
  four one-minute runs, the two wakes alternating. The guest's own clock (its first write to the end of its drain)
  says **60,013 and 60,011 ms** (the worklet's notify) and 60,029 and 60,014 ms (the timer) for 60,010.7 ms of
  sound: within a period. **No underrun and no gap frame** in any of them; no capped batch.
- **The wake** (each run's seconds after the first; medians of the per-second percentiles of |interval between
  completions − a period|): worklet notify p50 1.41 and 1.42 ms, p99 10.2 and 10.1 ms, max 12.3 and 13.2 ms; timer
  p50 1.56 and 1.51, p99 9.9 and 12.8, max 15.4 and 15.8 (an earlier pair of runs, before the sink's clock fixes
  below, had the timer's max at 28.9). The p99 of ~10 ms is the output's render callback:
  the context's `baseLatency` is 10 ms, so the worklet renders ~4 quanta at a time every 10 ms and the read
  index moves in steps of that size. The device worker's time in the pumps: 2.8-2.9 ms a second either way (215
  and 201 pumps a second). **The worklet's notify is kept** (`?snd=timer` stays for comparison): tighter at the tail,
  and it doesn't depend on timers that a hidden page might throttle.
- **The latency the guest gets:** 2017 frames (42 ms: `baseLatency` 10 ms + `outputLatency` 32 ms headless),
  refreshed once a second, as `latency_bytes` on every completion.
- **Headless Chromium can't check two things:** it starts an `AudioContext` without a gesture even with
  `--autoplay-policy=user-gesture-required` (so the test suspends the context itself to reach the same state: the
  sink's own clock takes over within 50 ms, the guest's time stays the sound's, a click resumes it), and a page
  stays `visible` when another tab is in front or its window is minimized (also with Playwright's
  anti-throttling flags dropped). The real autoplay prompt and a hidden tab are the user's manual check.
- **Time lost on the sink's clock, found under load:** in `npm test` (seven test files at once on eight vCPUs) a
  4 s tone took 62-107 ms too long with no gap counted, and the worklet had played only 95% of it. Two leaks on the
  sink's own clock: taking over from the worklet restarted the clock when the sink noticed (up to 50 ms after the
  last quantum: the suspended test's 4,062 ms alone), and a dry ring restarted it silently (the guest late to refill:
  a real underrun, uncounted). Now it starts from the last quantum (the suspended test: 3,998 ms) and counts its dry
  spells. A third excess remained under CI's load (the native guest tests beside `npm test`): 71-107 ms more of the
  guest's own time with no gap anywhere, and the context's clock in step with the wall's (3,827 ms in 3,842): the
  guest's own computing of its first periods before START (its clock starts at its first write), not the ring. So the
  Chromium test times the stream on the device, START to its stop (the sink's `stop` message carries it), and asserts
  that is the length plus the counted gaps, within 40 ms (alone: 3,997 ms for 4,011; gaps under 10%: the guest's
  85 ms buffer can underrun there for real). The exit's figures, the guest's own time, come from runs alone. Real players use longer buffers (speaker-test's was 1 s, §11).

## 14. S3 findings (2026-10-11)

What was built: Debian's playback check on the page (`snd-play`, `images/snd/play.c`, on a second disk:
testing.md "virtio-snd"), the `virtio-snd-dkms` PKGBUILD and its check (`images/archarm/virtio-snd-dkms/`,
`virtio-snd-dkms.sh`), the desktop image (`images/archarm/desktop.sh`, `media.sh`, `desktop-setup.sh`; `build.sh`'s
`--files` and `--setup`), the page's `?avprobe` (frontend.md "Sound") and the harness `bench/audio/avsync.ts` (runs
on the Mac host's GPU through `bench/gpu/sway-mac.sh` with `SCRIPT=../audio/avsync.ts`). JSON in
`bench/audio/results/s3/`.

- **Debian (ALSA alone):** its own `virtio_snd` plays a 3 s WAV at 44.1 kHz with aplay's buffer (500 ms in 4
  periods) in 3,110 ms of its own time for 3,125 ms of sound, no underrun, no gap in the ring; the page (a context at
  44.1 kHz) hears 440 and 660 Hz. ALSA's delay half-way is 23,900 frames: the 22,048-frame buffer plus 1,852 (42 ms,
  the browser's output latency headless): `latency_bytes` reaches ALSA's delay. Under QEMU's `virtio-sound-device`
  the same player and file give its WAV the file's samples exactly (the last period's padding silent). The user also
  played an MP3 with `mpg123` on Debian by hand, start to end, without a glitch.
- **The PKGBUILD** builds and installs as a user's would: `makepkg` (one stable tag's 12 files from git.kernel.org,
  sha256 each, 21 KB package), `pacman -U`, and DKMS's hook builds `virtio_snd` for `7.2.9-1-aarch64-ARCH` (vermagic
  checked). DKMS 3.4 calls a `CLEAN` line deprecated (dropped). In the desktop image the module the hook built is
  autoloaded by udev at boot (the hook runs `depmod` after `dkms install --no-depmod`).
- **The desktop guest** (Arch Linux ARM, kernel 7.2.9, sway 1.12, Firefox 157.0.1, PipeWire 1.6.9, WirePlumber 0.5.18):
  PipeWire drives the card through ALSA in mmap mode, FLOAT_LE 48 kHz stereo, periods of 512 frames, a buffer of 8192
  (170 ms: WirePlumber's headroom); every Firefox stream goes through `pipewire-pulse`.
- **A/V sync, on the Mac host's GPU** (headless Chromium 153.0.8010.12, ANGLE on Metal, Apple M4, macOS 26.6.2,
  `--mute-audio`; the guest on 4 vCPUs, 3D; the output's latency 640 frames, 13 ms), the sync clip in Firefox,
  sound minus picture at each second (`mac-2.json`, 30 s, 30 of 30 flashes paired): **after a start-up transient of
  4 s** (-268, -71, -83, -65 ms: the sound first while Firefox's video catches up) **every offset is within -17 to
  +20 ms**, in two clusters ~17 ms apart (a 60 Hz frame: when the flash is drawn). The first run (`mac-1.json`, 20 s
  from the 5th second, 17 flashes) converged the same way: -63 ms at first, then -12 to +10. The picture's end is the
  page's draw; a real display shows it a frame or so later, which moves the offsets toward the sound by that much.
  **Within ±45 ms** (decision 9) in steady state; the ear's check is the user's (S3's bar).
- **The sound never broke:** no underrun and no gap frame in the ring in any phase of any run, even with the guest
  saturated on the dev VM.
- **The sound path's cost** (mpv on Sintel's sound alone, `--ao=pipewire` against `--ao=null`, 30 s): the guest's 4
  vCPUs 10% busy against 9%; PipeWire's data loop 34 ms of CPU a second, mpv's own ao thread the rest of the
  difference; Opus decoding ~150 ms a second either way. **The sound costs the guest under 1% of its CPU.**
- **The video's decode is the cost:** Firefox's VP9 decoder (two threads in its RDD process) takes **1.7-1.8 s of CPU
  a second** for the 480p Sintel trailer without sound and still shows ~10% of its frames (656 painted, 6,330
  dropped in 27 s); the 360p VP8 sync clip drops more than it paints too (1,456 painted, 2,670 dropped in 48 s). With
  sound, Firefox skips decoding late frames to keep to the audio clock, so its decoder works less (1.2 s a second)
  and its media threads' wakeups show (system time in its state machine, supervisor, IPC). Smooth video in the guest
  is a CPU problem beyond audio: the backlog's "Hardware video decoding".
- **The dev VM's SwiftShader** (`devvm-swiftshader.json`) saturates the guest (88-90% of 4 vCPUs) and Firefox paints
  too few frames to time: 4 flashes in 20 s (-36 to -148 ms). A/V sync is measured on a real GPU.

## 15. S4 findings: snapshots while sound plays (2026-10-11)

What was built: nothing new on the device; two fixes, found by a Chromium test that saves the page's `snd` machine 2 s
into a 12 s tone and loads the file in a fresh profile (`tests/audio-browser.test.ts`), and the snd guest through 4
snapshot files mid-tone in Node (`tests/snapshot.test.ts`, the unbroken run's steps and hash). Saving was fine from the
start (the machine plays on, in time, no gap); **the loaded machine played the re-posted buffer and its next `write`
failed with EIO** (ALSA's wait for a period: max(100 ms, 1.1 × the buffer), then `-EIO`). Two causes, both general:

- **The restored clock ran before the guest did.** A restored VM's clock continued from its saved reading at
  `vm_snapshot_restore`, but on the page the vCPU workers start (spawned, instantiated, their clocks measured) ~130 ms
  later (85-128 ms measured), and that time was the guest's: its 100 ms wait had expired by its first instruction.
  Node didn't show it (the workers start within milliseconds; a 150 ms sleep between the restore and the first run
  reproduced it there). **The clock now stands at its saved reading until a vCPU first runs** (`Clock::start` in the
  core's `run`/`run_cpu`; platform.md "Snapshots"). Any guest timeout shorter than the setup was exposed the same way.
- **A whole buffer completed before the guest looked.** With the clock fixed, the sink still played and completed the
  four re-posted periods (85 ms) before the first vCPU ran. Linux's driver (`virtsnd_pcm_msg_complete`) adds each
  completion's period to `hw_ptr` modulo the buffer and only schedules the elapsed-period work, which one run serves
  for any number of completions; ALSA's `snd_pcm_update_hw_ptr0` then sees the pointer where it was and takes it for a
  full wrap only if more than half a buffer of jiffies passed, which with the clock frozen they hadn't. (Through a
  save's pause the clock runs, so the same four completions were recovered by that check.) The sink's bound of a
  buffer less a period (§12) was per pump; **it now counts from the guest's last message**, across pumps, and the 10 ms
  fallback for a stream's end starts only once the core has taken every completion (`Ctx.untaken`), i.e. a vCPU runs.
  A first try, bounding by completions the core hadn't taken, wasn't enough on 4 vCPUs: another vCPU can take them
  before the one that handles the interrupt has run.
- **And the save's pause:** under CI's load the *saved* machine failed the same way once: its clock ran through
  the pause while the file was written, past the guest's 100 ms wait. **Taking the state now holds the clock at the
  reading it saves** (`Clock::hold`) until a vCPU runs again, so the saved machine and one restored from it go on from
  the same instant. And under load the restored machine's vCPU workers started up to hundreds of ms apart: one took
  the completions and started the clock while vCPU 0 (the sound interrupt's) hadn't run; **the workers now start
  together** (each waits on a start word until all are instantiated).
- **Result** (the dev VM, headless Chromium 153, three runs): the loaded machine is heard at 440 and 660 Hz and plays
  to its end with a normal drain; its new ring holds exactly what the guest hadn't had completed at the save (whole
  periods); one counted underrun of 20-35 ms (1,026-1,664 frames) while the vCPUs start, then none. Node, the same
  restore with 0, 150 and 400 ms before the first run on 4 vCPUs: six of six play on. Under load (six busy-looping
  processes on the VM's 8 vCPUs beside the test), three of three: the saved machine's pause a counted gap of 1-23 ms,
  the restored one's 136-192 ms while its vCPUs start, then none.

## 16. S4 findings: capture, the device (2026-10-11)

What was built: the input stream (stream 1, `VIRTIO_SND_D_INPUT`, the output's formats, rates and channels; its own
state machine; receive messages on rxq), the source beside the sink (`SndSource`): the deterministic `patternSource`
(integer triangles, 1 kHz left and 1.5 kHz right, the same in JS and the twin) and, until the page's microphone, the
realtime `clockSource` (silence at the stream's rate). The `linux-snd` init records 16 periods after it plays
(`snd_rec_seconds=N` on the page) and prints the hash, its own time and each channel's frequency; the snd steps moved
once (decision 15): 35,917,561 to **36,929,057** (with the init's diagnostics for a failed write, below), natively, in Node and in Chromium, interpreter and JIT.
devices.md "snd", testing.md "virtio-snd", images.md.

- **The oracle:** QEMU 11.1.1's `virtio-sound-device` with the same kernel and init gets the same capture requests in
  the same order (`PCM_SET_PARAMS`, `PCM_PREPARE`, `PCM_START`, `PCM_STOP`, `PCM_RELEASE` for stream 1). Its `wav`
  backend has no input (the guest's first read times out with EIO); with the `none` backend it records 16 periods of
  silence in **342 ms** of the guest's own time, and the page's clock source in 348 ms (§13's machine, Chromium 153).
- **Linux posts a capture period again before its reader has it.** The driver's messages point into ALSA's own
  buffer, and the indirect helper's "copy" (`snd_pcm_indirect_capture_transfer` calling `virtsnd_pcm_trans_copy`)
  only posts the period again, as soon as ALSA counts it. So the device writes the buffer cyclically, as hardware
  does, and a reader has to keep up. The deterministic source fills each message at the exit after it's posted, far
  ahead of real time, so **the first buffer is overwritten before the guest's first read**: the guest reads the
  pattern from frame 4096 (FNV-1a `2b1e136b`; the pattern's 96-frame cycle makes 1024 the same bytes, the counts say
  4096), and the source filled 24 messages for 16 read. That is deterministic (pinned in both runners) and harmless:
  the realtime sources go at the stream's rate. One completion per exit instead of three moves nothing.
- **Capture needs the same bound as playback:** without a buffer less a period per exit the twin's guest stalls in
  its reads (Linux counts a capture's position in completions modulo the buffer too).
- **A restore under load, again** (six to ten busy-looping processes beside the Chromium test, and CI): the loaded
  machine sometimes still failed its next write with EIO. The init now prints, when a write fails, the stream's
  status, the virtio lines of `/proc/interrupts`, and both again a second later. Two more ways to a whole buffer:
  - **The fallback's 10 ms was too short:** under load Linux's elapsed-period work ran later than that after the
    interrupt, so the period released 10 ms after the core took the others made a whole buffer. The wait is now half a
    buffer's time and 30 ms (two ticks of a 100 Hz guest and one for rounding) after the core was first seen to have
    taken the batch's first completion (`completionBound`): the guest's clock has then run past what ALSA's jiffies
    check needs (more than half the buffer's jiffies and one) to take the whole buffer for a wrap. A drain's last
    period comes about that late anyway: the snd guest's 4 s tone ends 8 ms late, aplay's 500 ms buffer not at all.
    (A whole buffer's time cost a drain a period, which broke Debian's playback check in ci-debian: 3,251 ms for
    3,125; and a buffer's time after the *last* batch broke the drain itself, whose wait for a period is 100 ms.)
  - **The restored RAM can hold a completion the guest hasn't seen:** a snapshot is taken with every completion the
    core had, so a period completed just before the save is in the used ring but not yet in ALSA's position, and only
    the messages still in flight are posted again (three, with four in Linux's count). Completing those three made a
    whole buffer. After a restore the bound now counts as if the guest had a whole buffer in flight (the backend tells
    the sink and the source the re-posted bytes at the restore's first poll): two of three complete before the guest
    posts again.
- **Not explained:** before the last change, under ten busy loops, one run in eight failed with the sound
  interrupt never taken again after the restore: CPU 0 took its timer interrupts (278 to 380 in a second), the
  device's line went high (the core took and matched the completions, the guest acknowledged twice), but the
  interrupt count stayed. With instrumentation in the core it didn't happen in 25 runs, and after the last change
  none in 26. Backlog ("A restored machine's lost interrupt").
- **The native runner** (`core/tests/common` `run_parallel`) lost a PSCI SYSTEM_OFF that a vCPU made while a
  stretch before a snapshot was ending (the first end won); a terminal exit now wins over the budget's, which the
  parallel snapshot boot hit once in CI.

## 17. S4 findings: the page's microphone (2026-10-11)

What was built: the microphone ring and the `webpc-mic` worklet (web/audio-worklet.ts), `micSource` in the device worker
(in place of S4's first `clockSource`: without a live ring it is that), `PageAudio`'s microphone (`getUserMedia` at the
guest's `capture-start`, closed at `capture-stop`), the Sound menu's Microphone and Raw microphone (frontend.md
"Sound"). Tests: tests/snd.test.ts (the source on a fake clock and a hand-filled ring), tests/audio-browser.test.ts with
Chromium's fake capture device (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`,
`--use-file-for-fake-audio-capture` with a 500 Hz WAV): testing.md "virtio-snd".

- **The guest hears it:** with Raw microphone, 3 s recorded (144,384 frames at 48 kHz) at **505 Hz** on both channels by
  the guest's zero crossings (the tone 500), in 3,033-3,038 ms of its own time; the worklet wrote 145,792 frames and
  dropped none. With the browser's processing (the default) 495 Hz. The track's settings show the processing on and off
  as chosen. Chromium resamples the microphone to a capture context at the stream's rate, and a worklet with no
  outputs is processed (it has an input).
- **The microphone opens while the guest records:** the first periods come from the clock's silence until the worklet
  runs, and the switch starts the period in progress again: 16 periods took 343-373 ms of the guest's time (341 ms of
  sound) on a page whose microphone opened at the recording's start.
- **Debian records it** (ci-debian, Debian 13's own `virtio_snd`; `snd-rec`, images/snd/rec.c, on the second disk
  since the nocloud image has no alsa-utils, decision 16's arecord in kind): 3 s at 48 kHz stereo with arecord's
  buffer, 144,000 frames in 3,020 ms of its own time, no overrun, **497 Hz** on both channels (the processed microphone).
- Headless Chromium grants the microphone without a prompt (the fake UI flag); the real prompt, the browser's
  indicator and a real microphone are the user's checks.

