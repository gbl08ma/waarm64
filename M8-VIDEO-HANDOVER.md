# M8 video: handover after V0 (2026-10-14)

V0 (the gates) is done and committed; **V1 is next and can start from this file.** Read first:
`docs/plans/video.md` (all of it: §1 decisions, §2 why not V4L2, §3 steps, §4 V0's findings), docs/devices.md
"virgl" (its "Video" bullet), `web/virgl-video.ts`, `web/video-h264.ts`, and the tools in `bench/video/`.
docs/backlog.md "Upstream reports" has the three upstream bugs V0 found (filed at the project's end, by the user).

## Decisions (the user's; don't re-ask)

1. **VA-API over virgl, decoded by WebCodecs** (not V4L2/virtio-media: plan §2).
2. **The desktop guest (Arch Linux ARM, `images/archarm/desktop.sh`) is the target**, tailored as "our distro" where
   it helps: guest packages of ours are fine (as `virtio-snd-dkms`).
3. **`webpc-va` stays for now** (`images/archarm/webpc-va/`: Mesa's virgl VA driver with I420/YV12 decode surfaces
   hidden, `LIBVA_DRIVER_NAME=webpc`). The Mesa fix waits for the user's upstream round-up.
4. **The dev VM's Chromium gets `tools/nosme` as `LD_PRELOAD`** for anything that reads decoded frames (tests and
   tools). Not wired in yet: V1's first step.
5. Firefox needs **no pref**: with `webpc-va` and video caps it enables VA-API on its own (no blocklist entry matches
   virgl; plan §4).

## V1: the decoders on WebCodecs (the steps, in order)

0. **Wire `tools/nosme`:** build `target/nosme/libnosme.so` (`cc`, aarch64 Linux only; a helper the Chromium
   launchers call, built on demand like other `target/` artifacts) and pass `LD_PRELOAD` through Playwright's
   `launch({ env })` in the launchers that touch video (`bench/video/replay.ts`, the new Chromium tests, the page
   tests if they decode). Only where the CPU has SME without SVE (`/proc/cpuinfo` flags `sme` and no `sve`); cloud
   sessions (x86_64) and the Mac host don't need it. Document in docs/testing.md and CLAUDE.md.
1. **The replay gate (Chromium, dev VM, software decoders):** `bench/video/replay.ts` on V0's capture: every H.264
   and VP9 picture's frame out, hash-equal to FFmpeg's decode of the original (the hashes: `bench/video/pictures.ts`
   writes the streams; `podman` Alpine `ffmpeg -f framemd5` as in plan §4). The open question it answers: **does
   Chromium's H.264 decoder emit every picture at once with our VUI (`max_num_reorder_frames` 0) and
   `optimizeForLatency`, or does it hold and drop out-of-order pictures as FFmpeg's raw-stream decode did (102 of 130
   frames)?** Measure the wait per picture (chunk in to frame out). Then the same on the Mac host's hardware decoders
   (rsync and run as `bench/gpu/sway-mac.sh` does; Chrome for Testing 153, no `nosme` there). If H.264 holds pictures,
   the fallbacks to weigh: rewriting the slices' POC (type 2 makes output order decode order) or a bounded wait
   after which the picture is given up.
2. **The real decoder in `VideoContext`** (`web/virgl-video.ts`): behind an interface so Node tests use a fake.
   END_FRAME → a chunk (H.264 through `H264Stream` with the codec's level; VP9 as sent, key when `pic_fields`
   bit 2 is 0, at desc byte 332) with a sequence-number timestamp mapped to the target video buffer; one
   `VideoDecoder` per codec, configured lazily (`codecString`, `optimizeForLatency`), recreated at the next key chunk
   after an error. Output → `copyTo` (the visible rect is the coded size for our H.264; VP9's coded width can exceed
   the buffer: copy the overlap) → Y into plane 0 (R8), U/V interleaved into plane 1 (RG8; Mac gives NV12, the dev VM
   I420) through the renderer's `upload`. **VP9 frames with `show_frame` 0 (bit 3) give no output: don't wait for
   them** (they are references only; a later `show_existing_frame` isn't sent through VA by FFmpeg, revisit if a
   stream shows stale pictures).
3. **Ordering in the GPU worker** (`web/gpu-worker.ts`): Mesa's virgl `end_frame` makes no fence and
   `vaSyncSurface` returns at once, so everything after an END_FRAME must see the picture. Queue every port message
   (calls and fences, in order) while any picture is pending; drain when the planes are written. A picture that never
   comes out is given up after a bound (log it; the guest shows the old planes rather than hanging). Measure what the
   pause costs; a finer rule (hold only commands touching the planes) only if it matters.
4. **Tests:** Node (`tests/virgl-video.test.ts`: the fake decoder's planes written, the pause and drain, a hidden VP9
   frame, a decoder error and the next key chunk, the give-up bound); Chromium (a fixture made from V0's capture,
   trimmed to a few dozen pictures per codec, gzipped in `tests/virgl/` like the other traces, replayed through the
   device into the renderer, planes read back and hashed against FFmpeg's). Plant a bug (e.g. U/V swapped) and see
   it fail.
5. **The desktop image rebuilt** (`images/archarm/desktop.sh`, ~15 min: it now builds and installs `webpc-va`), then
   `?gpu=video` on by default where video caps exist (the menu's 3D machines), and Firefox on the clips
   (`bench/video/v0.ts`, PHASE_S, CLIPS): the guest's CPU and dropped frames against V0's software numbers (plan §4,
   audio.md "Measurements"), on the Mac's GPU for numbers (`bench/gpu/sway-mac.sh`'s route), A/V sync with
   `bench/audio/avsync.ts`. That is V2's measurement; V1 ends when the page shows the right pictures.

CI for V1's commits: `scripts/ci.sh`, `ci-deqp.sh` (renderer) and `ci-debian.sh` (page, GPU worker), alone, in turn.

## What exists (V0)

- **Caps** (`web/virgl-caps.ts` `withVideo`, `web/virgl.ts` field `video_caps` at dword 215, `web/virgl-video.ts`
  `probeVideo`/`encodeVideoCaps`): with `?gpu=video` the GPU worker asks `VideoDecoder.isConfigSupported` and lists
  H.264 CB/Main/High (pipe profiles 8, 9, 11) and VP9 profile 0 (24), up to 4096×2304, NV12. Mesa 26.2's profile
  numbers (`PROFILE`); they aren't stable across Mesa releases.
- **Renderer** (`web/virgl-renderer.ts` → `VideoContext`): CCMD 53-61 per context; a buffer is its plane resources
  (NV12: R8 then RG8); DECODE_BITSTREAM's desc and data read from the staging buffers' guest pages. A null decoder:
  END_FRAME counts. `renderer.videoStats`; the GPU worker's `render-stats` carry the totals (`video`).
- **H.264** (`web/video-h264.ts`): bit reader/writer, emulation prevention, Annex B split, `parseH264Desc` (Mesa's
  `virgl_h264_picture_desc`, 2624 bytes; offsets from its compiler), `buildSps` (level from the codec, refs from the
  picture's `num_ref_frames`, gaps allowed, no cropping, VUI reorder 0), `buildPps` (effective scaling lists),
  `sliceRefs` (header up to the ref-count override), `H264Stream` (parameter sets at IDRs and on change; PPS ref
  defaults learned from non-overriding slices). Tests: `tests/video-h264.test.ts`.
- **Captures** include DECODE_BITSTREAM's buffers (`web/gpu.ts` `capture`).
- **Tools** (`bench/video/`): `v0.ts` (the desktop guest with `?gpu=virgl,video`: `vainfo`, FFmpeg with and without
  VA-API, Firefox on the clips with its decoder and dmabuf log and about:support's features; `CAPTURE=1`, `SHIM=1`
  (a VA driver from the media disk), `PREFS`, `CLIPS`, `FFMPEG=0`, `FIREFOX=0`), `media-disk.sh` (the clips and an
  optional `target/video/shim/webpc_drv_video.so` as `?disk2=`), `pictures.ts` (a capture's pictures per codec; writes
  `.h264`/`.ivf`), `replay.ts` (a codec's pictures through Chromium's `VideoDecoder`, frames hashed as framemd5).
- **Local artifacts** (git-ignored): `target/archarm/desktop.qcow2` (kernel 7.2.10, libva-utils, **without
  webpc-va**: rebuild), `target/archarm/pkg/webpc-va-1-1-aarch64.pkg.tar.xz`, `target/video/media.ext4`,
  V0's capture `bench/results/local/video/v0-ffmpeg/capture.vglt` (218 MB: H.264 130 pictures, VP9 127; FFmpeg only),
  the rebuilt streams and original-file hashes in `bench/results/local/video/v0-streams/` (`h264-orig.md5`,
  `vp9-orig.md5`), the Mesa 26.2.4 sparse checkout `~/Development/src/mesa` (now with `src/gallium/frontends/va`,
  `auxiliary/vl`, `util/format`).

## Learned (don't re-discover)

- **The page's frame counts can't judge decoding until V1:** with the null decoder Firefox shows blank pictures; its
  dropped-frame counts mean nothing yet.
- **Mesa's VA frontend leaves the SPS's `level_idc` and `max_num_ref_frames` 0, and VA has no PPS ref-count
  defaults** (plan §4): already handled in `H264Stream`; a misparse there shows as FFmpeg's "reference count
  overflow".
- **FFmpeg's raw H.264 parser regroups pictures**: counting frames from an `.h264` file through `ffmpeg -i` is wrong
  (102 of 130); hashes in order were exact. Judge counts per chunk (the replay).
- **`VideoFrame.copyTo` with a `rect` or `format` option crashed the renderer** even before the SME finding was
  understood (all of it was the SIGILL); with `nosme`, retest plain `copyTo` first.
- **sway's `exec` splits at commas**: `MOZ_LOG=a:5,b:5` must go through a script (`v0.ts` writes
  `/home/alarm/ff-launch.sh`).
- **Firefox logs to read:** `MOZ_LOG=PlatformDecoderModule:5,FFmpegVideo:5,Dmabuf:5`; filter out `Tranche` /
  `Feedback` / `format 0x` lines (the dmabuf format table floods the terminal). "Unsupported VA-API surface format
  808596553" is I420.
- **The harness's serial `run` truncates long output**; grep in the guest first.
- **Never run Chromium experiments beside a measuring run or a CI lane**: one Firefox run overlapped small Chromium
  probes and its CPU numbers are only indicative.
- Booting the desktop guest on the page takes ~40 s; sway ~30 s more; Firefox's first page ~50 s on SwiftShader.
