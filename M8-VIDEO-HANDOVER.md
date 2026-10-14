# M8 video: handover after V2 (2026-10-14)

V0 (the gates), V1 (the decoders on WebCodecs) and V2 (Firefox on the page, measured) are done and committed; **V3 is
next and can start from this file.** Read first: `docs/plans/video.md` (all of it: §1 decisions, §2 why not V4L2, §3
steps, §4 V0's findings, §5 V1's, §6 V2's),
docs/devices.md "virgl" (its "Video" bullet), docs/testing.md "Video over virgl", `web/virgl-video.ts`,
`web/virgl-host.ts` (`CallQueue`), `web/video-h264.ts`, and the tools in `bench/video/`. docs/backlog.md "Upstream
reports" has the upstream bugs V0 found (filed at the project's end, by the user).

## Decisions (the user's; don't re-ask)

1. **VA-API over virgl, decoded by WebCodecs** (not V4L2/virtio-media: plan §2).
2. **The desktop guest (Arch Linux ARM, `images/archarm/desktop.sh`) is the target**, tailored as "our distro" where
   it helps: guest packages of ours are fine (as `virtio-snd-dkms`).
3. **`webpc-va` stays for now** (`images/archarm/webpc-va/`: Mesa's virgl VA driver with I420/YV12 decode surfaces
   hidden, `LIBVA_DRIVER_NAME=webpc`; in the desktop image since V1). The Mesa fix waits for the user's upstream
   round-up.
4. **The dev VM's Chromium gets `tools/nosme.ts` (`chromiumEnv()`) as `LD_PRELOAD`** for anything that reads decoded
   frames: wired into `bench/gpu/guest-session.ts`, `bench/video/replay.ts`, `tests/virgl-browser.test.ts`.
5. Firefox needs **no pref**: with `webpc-va` and video caps it enables VA-API on its own (plan §4).
6. **H.264 on browsers that decode it only in software comes first in V3** (2026-10-14, the user, whose host is
   Chromium on Linux: VP9 is offered there, H.264 isn't). Goal: offer H.264 wherever `VideoDecoder` takes it.

V1 settled one more by measurement (plan §5): **H.264 is offered to the guest only where the browser decodes it in
hardware** (software decoders hold B-pictures longer than the guest waits, and the guest stalls). `?gpu=swh264`
offers it anyway (for experiments); the ideas are in backlog.md. V2 settled another (plan §6): **the decode path stays
as it is** (the copy out of each `VideoFrame`, the queue holding every call while a picture is pending): the host
decodes a picture in ~3 ms and the GPU worker never waited 10 ms; what Firefox drops is the guest's CPU.

## V3: robustness and breadth (plan §3)

On the dev VM where VP9 is enough (`v1.ts`, `avsync.ts` with `MEDIA=disk`), on the Mac for H.264
(`bench/gpu/sway-mac.sh`):
0. **Software H.264 first** (decision 6; backlog.md "H.264 on a browser that decodes it only in software"). A decoder
   that holds pictures keeps one pending at all times, and `CallQueue` holds every non-decode call while any is
   pending, so all rendering stops until the 200 ms drain. Next: a finer rule (a call waits only if its context has
   a pending picture's plane attached or it names one: the renderer refuses a context a resource it hasn't attached,
   and Firefox attaches the planes to its compositor only to show the frame); the SPS's reorder depth set to the
   stream's (learned from the POCs in the desc, offset 2308; the trailer's is 2, as its VUI says, and V1's FFmpeg
   guessing held up to 5) for players that block at once (the guest's FFmpeg); measured with Firefox and `v1.ts` on
   the dev VM (OpenH264) and on the Mac with the software decoder forced.
1. **Seeking**: Firefox and the guest's FFmpeg (`-ss`) seek within the clips: what the guest sends (a new key
   picture; whether Mesa makes a new codec), no picture given up, the right picture after the seek (a screenshot, or
   framemd5 in `v1.ts`).
2. **Resolution changes**: a clip that changes size mid-stream (made in Podman with ffmpeg, onto the media disk): a
   new codec or new buffers from the guest, a decoder reconfigured.
3. **Decoder errors**: a corrupt chunk (a fault planted in a test, Node and Chromium): that codec's pictures end, a
   new decoder at the next key picture, the guest not hung (the 1 s give-up is the backstop).
4. **Snapshots**: a machine with a live codec is 3D in use, refused today (G5 proposes snapshots while 3D is in
   use: `M8-GRAPHICS-HANDOVER.md`); check that the refusal says so and that a machine whose player has exited saves.
5. **Breadth**: HEVC and AV1 where the browser decodes them (the Mac's: both in hardware). HEVC is H.264's shape
   (VPS/SPS/PPS rebuilt); AV1 needs its sequence and frame headers rebuilt (the hardest; plan §1).

CI for video commits: `scripts/ci.sh`, `ci-deqp.sh` (renderer) and `ci-debian.sh` (page, GPU worker), alone, in turn.

## What exists

- **Caps** (`probeVideo`): VP9 profile 0 wherever `VideoDecoder` takes it; H.264 CB/Main/High where it's in hardware
  (`prefer-hardware` supported). Mesa 26.2's profile numbers (`PROFILE`).
- **Decoding** (`VideoContext` in `web/virgl-video.ts`): END_FRAME → a chunk (H.264 rebuilt by `H264Stream`; VP9 as
  sent, hidden frames not waited for) → one `VideoDecoder` per codec → `copyPicture` → `VirglRenderer.writePicture`
  (Y into R8, U/V interleaved into RG8). Behind `DecoderFactory`, so Node tests use a fake.
- **Ordering** (`CallQueue` in `web/virgl-host.ts`, used by the GPU worker): calls wait while a picture is pending;
  video submits and resource setup run ahead; software H.264 drained after 200 ms idle; given up after 1 s.
- **Tests:** `tests/virgl-video.test.ts` (Node), `tests/virgl-browser.test.ts` (Chromium: 40 pictures a codec from
  fixtures in `tests/virgl/video-*`, made by `bench/video/fixture.ts`).
- **Tools:** `bench/video/v1.ts` (the guest's FFmpeg, software against VA-API, framemd5), `replay.ts` and
  `replay-mac.sh` (a capture's pictures through `VideoDecoder`), `v0.ts` (Firefox on the clips, its log, screenshots),
  `bench/audio/avsync.ts` with `MEDIA=disk` (Firefox on the media disk's clips: frames and drops over the phase, the
  guest's CPU, A/V sync, the renderer's video stats; `PROFILE=1` samples the guest). V2's JSON:
  `bench/video/results/v2/`.
- **Local artifacts** (git-ignored): `target/archarm/desktop.qcow2` (with webpc-va; V0's image kept as
  `desktop-v0.qcow2`), `target/video/media.ext4` (the sync clip in VP8, VP9 and H.264 since V2), V0's capture `bench/results/local/video/v0-ffmpeg/capture.vglt`,
  the streams and hashes in `bench/results/local/video/v0-streams/`, V1's runs in `bench/results/local/video/v1-*`
  and `bench/results/local/v1-mac*`.

## Learned (don't re-discover)

- **The fixture replay can't find a stall:** it feeds every picture without waiting, as no guest does. A decoder that
  holds pictures shows only with the guest on the page (`v1.ts`).
- **The dev VM's Chromium decodes H.264 with OpenH264** (openSUSE's build): it ignores the SPS's reorder field and
  isn't bit-exact with FFmpeg on B-pictures. Judge H.264 exactness on the Mac.
- **The page's frame counts can't judge decoding with `?gpu=novideo`**: Firefox then decodes in software.
- **`sway-mac.sh` takes `-` as the mode** for scripts without one (`v1.ts`, `v0.ts`); it copies the media disk.
- **sway's `exec` splits at commas**: `MOZ_LOG=a:5,b:5` must go through a script (`v0.ts` writes
  `/home/alarm/ff-launch.sh`).
- **Firefox logs to read:** `MOZ_LOG=PlatformDecoderModule:5,FFmpegVideo:5,Dmabuf:5`; filter out `Tranche` /
  `Feedback` / `format 0x` lines.
- **The harness's serial `run` truncates long output**; grep in the guest first.
- **Never run Chromium experiments beside a measuring run or a CI lane**, on the dev VM or the Mac (the VM runs on
  the Mac's CPUs).
- Booting the desktop guest on the page takes ~40 s on the dev VM, ~32 s on the Mac; sway ~30 s more.
- **`sway-mac.sh` defaults to `VIRGL_GPU=virgl-null`**: pass `VIRGL_GPU=virgl` (or `virgl,novideo`) for video runs.
- **Count Firefox's drops over a phase, not from its start**: its first seconds drop more frames than it presents
  (avsync.ts's `quality`).
- **The PC sampler slows the guest** (Firefox's drops doubled): drop counts from unsampled runs only; and it charges
  a chunk to the instruction after the last exit, so exit sites (`arch_counter_get_cntvct`) look hot.
