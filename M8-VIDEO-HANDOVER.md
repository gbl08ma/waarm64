# M8 video: handover in V3's third loop (2026-10-15)

V0 (the gates), V1 (the decoders on WebCodecs), V2 (Firefox on the page, measured), V3's first loop (H.264 where
the browser decodes it in software), its second (Firefox's cost and frame pacing, measured) and the third's robustness
half (seeking, size changes, decoder errors, snapshots: plan §9) are done and committed; **what's left of V3 is its
breadth, HEVC and AV1.** Read first: `docs/plans/video.md` (all of it:
§1 decisions, §2 why not V4L2, §3 steps, §4 V0's findings, §5 V1's, §6 V2's, §7 V3's first loop, §8 its second, §9 the third's),
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
6. **H.264 wherever `VideoDecoder` takes it, software included** (2026-10-14, the user, whose host is Chromium on
   Linux with NVIDIA: no hardware decoding there). Done in V3's first loop (plan §7).
7. **Firefox's cost and its frame pacing** (2026-10-14, the user): the host's decoding isn't felt in Firefox on
   their PC (VP9 included, a plain `<video>` page too), while mpv with `--hwdec=vaapi` plays smoothly; and Firefox's
   playback (and scrolling, browsing generally) comes in uneven bursts, at times losing a second or more of video.
   Measured in V3's second loop (plan §8): steady playback drops almost nothing on the Mac, V2's cost was Firefox's
   start, no pref helps; the bursts are the guest's CPU saturated (Firefox's start, page loads) and the host's
   synchronous JIT installs stopping every vCPU at once. **The compile worker stays in backlog.md (JIT), with what it
   costs video in a browser; the rest of V3 comes first** (2026-10-15, the user). The user then had it built the same
   day (jit.md "Sharing", `bench/boot/REPORT.md` "M8: the JIT's compile worker"): no install stall of 250 ms or more in
   Firefox's pages session since.

By measurement: V2 (plan §6) kept **the copy out of each `VideoFrame`** (the host decodes a picture in ~3 ms, the
GPU worker never waited 10 ms in hardware; what Firefox drops is the guest's CPU). V3's first loop (plan §7) made
`CallQueue` hold only a call that could see a pending picture, a software decoder's SPS say the stream's depth, and a
drain lossless; `?gpu=swvideo` forces software decoding (`swh264` is gone).

## Next: the rest of V3, breadth (plan §3)

Done in this loop (plan §9): seeking (FFmpeg exact through jumps and a flush; Firefox's pictures right after every
seek, once a held picture is written into planes the guest's decoder process let go of), size changes (a new codec
per size, exact), decoder errors (a damaged chunk is a WebCodecs error; the codec's later pictures dropped, nothing
waits), snapshots (refused while a player decodes, saved once it exits). Left:
- **Breadth**: HEVC and AV1 where the browser decodes them (the Mac's: both in hardware; the dev VM's Chromium has no
  HEVC, AV1 in software). HEVC is H.264's shape (VPS/SPS/PPS rebuilt); AV1 needs its sequence and frame headers rebuilt
  (the hardest; plan §1). Mesa 26.2.4's source is in `~/Development/src/mesa` (`src/gallium/drivers/virgl/virgl_video.c`
  fills `virgl_hevc_picture_desc` and `virgl_av1_picture_desc`, `src/virtio/virtio-gpu/virgl_video_hw.h` their layouts).

CI for video commits: `scripts/ci.sh`, `ci-deqp.sh` (renderer) and `ci-debian.sh` (page, GPU worker), alone, in turn.

## What exists

- **Caps** (`probeVideo`): VP9 profile 0 and H.264 CB/Main/High wherever `VideoDecoder` takes them; in hardware where
  `prefer-hardware` is supported (`?gpu=swvideo`: never). Mesa 26.2's profile numbers (`PROFILE`).
- **Decoding** (`VideoContext` in `web/virgl-video.ts`): END_FRAME → a chunk (H.264 rebuilt by `H264Stream`; VP9 as
  sent, hidden frames not waited for) → one `VideoDecoder` per codec → `copyPicture` → `VirglRenderer.writePicture`
  (Y into R8, U/V interleaved into RG8). Behind `DecoderFactory`, so Node tests use a fake.
- **Ordering** (`CallQueue` in `web/virgl-host.ts`, used by the GPU worker): a call waits only if its context has a
  pending picture's plane attached (decode-only submits pass) or it names one, and what must follow it; software
  H.264 drained after 200 ms (flushed, the IDR period decoded again by a new decoder); given up after 1 s.
- **Tests:** `tests/virgl-video.test.ts` (Node), `tests/virgl-browser.test.ts` (Chromium: 40 pictures a codec from
  fixtures in `tests/virgl/video-*`, made by `bench/video/fixture.ts`).
- **Measuring Firefox** (plan §8, benchmarking.md "Guest sessions"): `load`'s processes, threads (runs, run-queue
  wait) and `SYSCALLS=1`; `TIMELINE=1` (the vCPU timeline: host stalls); avsync.ts `VARIANTS`/`ROUNDS` (Firefox prefs
  A/B in one boot), `NCPUS`, each second's drops (`perSecond`); `webpc-slow install` lines (results' `slow`); the
  Mac's `vm_stat` (`sway-mac.sh`). JSON: `bench/video/results/v3c/`.
- **Tools:** `bench/video/v1.ts` (the guest's FFmpeg, software against VA-API, framemd5; `SNAPSHOT=1`), `seek.ts`
  (seeking and the size-changing clips, plan §9; `CAPTURE=1`), `replay.ts` and
  `replay-mac.sh` (a capture's pictures through `VideoDecoder`), `v0.ts` (Firefox on the clips, its log, screenshots),
  `bench/audio/avsync.ts` with `MEDIA=disk` (Firefox on the media disk's clips: frames and drops over the phase, the
  guest's CPU, A/V sync, the renderer's video stats; `mpv:<file>` phases; `PROFILE=1` samples the guest; with
  `?gpu=...,debug` the renderer's video lines go to the results). V2's JSON: `bench/video/results/v2/`, V3's:
  `.../v3/`.
- **Local artifacts** (git-ignored): `target/archarm/desktop.qcow2` (with webpc-va; V0's image kept as
  `desktop-v0.qcow2`), `target/video/media.ext4` (the sync clip in VP8, VP9 and H.264 since V2; `res-vp9.webm` and
  `res-h264.ts`, whose size changes, since V3's third loop), V0's capture `bench/results/local/video/v0-ffmpeg/capture.vglt`,
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
- **`sway-mac.sh` defaults to `VIRGL_GPU=virgl-null`**: pass `VIRGL_GPU=virgl` (or `virgl,novideo`, `virgl,swvideo`) for
  video runs.
- **Chrome's FFmpeg holds 3 pictures beyond the SPS's depth** (frame threads), OpenH264 up to 6 whatever the SPS says:
  a player that waits for each picture gets it through a drain (plan §7, backlog.md).
- **mpv waits to show its first picture before decoding more**: a drain at its start is normal.
- **Count Firefox's drops over a phase, not from its start**: its first seconds drop more frames than it presents
  (avsync.ts's `quality`).
- **Measure Firefox from 30 s after its launch** (`WARM_S=30`): its start-up work runs that long, and a phase that
  overlaps it measures the start (V2/V3's 54-74% busy was that), not the playback.
- **`media.rdd-process.enabled=false` never plays; `gfx.webrender.compositor.force-enabled=true` presents nothing**
  (on virgl, sway).
- **The Mac's memory is overcommitted** (the Lima VMs reserve 22 of 24 GiB; 7 GiB of swap used): latency there is
  suspect while both VMs run; `sway-mac.sh` records `vm_stat` to check.
- **A background FFmpeg on the serial shell needs `-nostdin`** (else it stops on its terminal setup, before opening
  VA-API), and a page URL through sway's `exec` takes no `&` (it runs through `sh -c`) and no comma.
- **Firefox's H.264 path makes a new codec at every seek** (its VP9 path keeps it), and lets go of the old surfaces
  while the compositor still shows them: the host writes into planes, not into a context's attachments (plan §9).
- **A WebM/MP4 seek lands on a key picture; an MPEG-TS seek doesn't** (no index): use TS only for straight decodes.
- **The PC sampler slows the guest** (Firefox's drops doubled): drop counts from unsampled runs only; and it charges
  a chunk to the instruction after the last exit, so exit sites (`arch_counter_get_cntvct`) look hot.
