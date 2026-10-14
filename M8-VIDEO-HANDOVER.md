# M8 video: handover after V1 (2026-10-14)

V0 (the gates) and V1 (the decoders on WebCodecs) are done and committed; **V2 is next and can start from this file.**
Read first: `docs/plans/video.md` (all of it: §1 decisions, §2 why not V4L2, §3 steps, §4 V0's findings, §5 V1's),
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

V1 settled one more by measurement (plan §5): **H.264 is offered to the guest only where the browser decodes it in
hardware** (software decoders hold B-pictures longer than the guest waits, and the guest stalls). `?gpu=swh264`
offers it anyway (for experiments); the ideas are in backlog.md.

## V2: Firefox on the page, measured (plan §3)

On the Mac's GPU (`bench/gpu/sway-mac.sh`'s route; the dev VM has VP9 only and SwiftShader), the desktop image
(`target/archarm/desktop.qcow2`, with webpc-va):
1. Firefox on the clips (`bench/video/v0.ts`, `FFMPEG=0`, PHASE_S, CLIPS; through `SCRIPT=../video/v0.ts
   bench/gpu/sway-mac.sh - <image> <name>`): the guest's CPU and the frames shown and dropped, against V0's software
   numbers (plan §4, audio.md "Measurements"). V1's first look: 136 of 481 frames dropped on H.264, 145 on VP9.
2. Where the drops come from: the GPU worker's pause (`render-stats`' `maxWaitMs`, `ahead`), the copy out of each
   `VideoFrame` and the plane uploads, Firefox's own compositing on virgl. A finer queue rule (hold only commands
   touching pending planes) only if the pause matters.
3. A/V sync with `bench/audio/avsync.ts` (`SCRIPT=../audio/avsync.ts`).
4. A decision on what V2 changes, then V3 (robustness: seeking, resolution changes, decoder errors, snapshots).

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
  `replay-mac.sh` (a capture's pictures through `VideoDecoder`), `v0.ts` (Firefox on the clips, screenshots).
- **Local artifacts** (git-ignored): `target/archarm/desktop.qcow2` (with webpc-va; V0's image kept as
  `desktop-v0.qcow2`), `target/video/media.ext4`, V0's capture `bench/results/local/video/v0-ffmpeg/capture.vglt`,
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
