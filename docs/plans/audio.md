# webpc audio plan

**Status:** S0 done, 2026-10-10 (the guests: §11); no device code yet. The user's decisions are §10; the rest is
the proposal, to be settled by measurement as it's built. It feeds M8's "Audio" item (PLAN.md, M8).

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
  click or key on the machine (the browser's autoplay rule), with mute in the menu.
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
  1 s by default), so the device answers them promptly in every mode; on stop and release it waits for its messages
  to come back, so **the device returns every held buffer of a stream at `PCM_STOP`/`PCM_RELEASE`**. To check
  against the source as built (S1): what it does with zero jacks and zero channel maps, how it reports position
  between completions, its period and buffer limits.
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

- `{type: 'snd', ring?, capture?}`: one output stream (and one input stream with `capture`), no jacks, no
  channel maps at first (if Linux needs one, a stereo map), no controls. Queues of 64.
- **Control:** `PCM_INFO` answers formats, rates, channels 1–2; `SET_PARAMS` checks them and the
  buffer/period sizes (a period a whole number of frames, the buffer a whole number of periods) and keeps them;
  `PREPARE` resets the stream's ring position; `START`/`STOP` start and pause consumption; `RELEASE` returns every
  held message. Malformed or out of order: `BAD_MSG`; unsupported: `NOT_SUPP`, as the spec says.
- **Transmit:** a message's frames are converted to f32 and written into the ring when it has room; the message is
  held until the worklet's read position passes its last frame, then completed with `OK` and `latency_bytes` =
  what's queued ahead of it. A message that doesn't fit the ring yet waits (the guest's buffer is the queue).
- **Events:** an xrun when the worklet ran dry while the stream was started (the guest restarts the stream, as on
  hardware), if Linux takes them; otherwise silence fills in.
- **Snapshots:** the streams' parameters and states are the backend's `save`/`restore` JSON; the ring's content
  is dropped (a few milliseconds missing on load) and held messages are posted again by the core, as for every
  device (devices.md "Chains in flight").

## 4. The page and the worklet (`web/audio.ts`, `web/audio-worklet.ts`)

- **The ring:** a `SharedArrayBuffer` of f32 frames (interleaved stereo; ~200 ms at 48 kHz, sized by measurement)
  with a write index (the device worker's) and a read index (the worklet's), both i32 in a header, Atomics only:
  a single-producer single-consumer ring like the device rings (abi.md).
- **The worklet** copies 128 frames per render quantum out of the ring, outputs silence when it's short (and counts
  the underrun in the header), and publishes its read index. It allocates nothing in `process`.
- **Waking the device worker:** its loop waits on the doorbell with `Atomics.waitAsync`, so a second wait on the
  ring's read index (the worklet `Atomics.notify`s it every N quanta) or a timer (~5 ms) completes played messages.
  Measured in S2: the completion jitter each gives the guest, and the device worker's CPU.
- **Autoplay:** an `AudioContext` starts suspended until a user gesture. The page creates it at the device's first
  `START` and resumes it on the next click or key on the machine (which a user gives anyway); until then the stream
  plays into the ring as if consumed at the stream's rate (the guest mustn't stall), and the page shows that sound
  is waiting for a click.
- **Mute and volume** on the page (a `GainNode`, in the machine's menu, kept with the page's settings); guest-side
  controls (`VIRTIO_SND_F_CTLS`) later if wanted.
- **The tab in the background:** Chromium keeps an audible tab's timers and audio running; the realtime clock
  already runs there. To check that a hidden page doesn't throttle the device worker's wake.

## 5. Time and determinism

- **Deterministic mode** (tests, native runners) has no wall clock to pace by: the device completes a message at
  the `DEVICE` exit that posted it (a null sink that keeps a checksum of the frames, or all of them), so a guest
  plays a file as fast as it can and boots keep exact step counts. The twin in `core/tests/common` does the same.
- **Realtime mode** paces by the worklet as above. A machine without a page (Node, the bench pages) uses a timer
  sink at the stream's rate.

## 6. Tests (cheapest layer first)

- **Node, the device's bytes** (`tests/snd.test.ts`): every control request and its errors, a stream's lifecycle,
  conversion of each format, messages held until consumed and returned at stop and release, the ring's indices
  across a wrap, save and restore.
- **A guest, deterministic** (`linux-snd`: allnoconfig + the fragment + `SND`, `SND_VIRTIO`, a static init that
  opens `/dev/snd/pcmC0D0p`, sets parameters through ioctls, writes a known waveform, drains, closes): the sink's
  checksum, natively, in Node and in Chromium, in the same steps. The control sequence checked against QEMU's
  device with the same kernel (the oracle).
- **Chromium, realtime** (`tests/audio-browser.test.ts`): the worklet on a headless page plays a tone written
  into the ring and a tap (a second worklet or an `AnalyserNode`) hears its frequency; the read index advances at
  the context's rate; an underrun is counted and recovers.
- **Debian on the page** (ci-debian.sh, S3): `virtio_snd` binds, `aplay` of a file plays its length in real time
  (± a period) and the page's tap hears it.

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
- **S1, the device, deterministic:** `web/snd.ts`, its twin, the `linux-snd` guest; Node and native tests; the
  oracle comparison. Exit: the guest's tone arrives byte for byte in every runner.
- **S2, the page:** the ring, the worklet, the pacing, autoplay, mute and volume. Exit: a tone from the `linux-snd`
  guest on the page plays at the right speed with no underrun over a minute; the wake's jitter measured.
- **S3, real guests:** Debian (ALSA), then the desktop guest (PipeWire under sway, Firefox, with the module from
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
