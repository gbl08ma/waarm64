# webpc video decoding plan

**Status:** started 2026-10-14 (the backlog's "Hardware video decoding"). The direction is the user's (§1): **VA-API
over virgl**, decoded by the browser's WebCodecs. **V0 (the gates) passed (2026-10-14, §4)**: the guest's Mesa takes
the caps, FFmpeg and Firefox decode through VA-API (Firefox once a VA driver wrapper of ours hides the surface
formats it can't take), and the host's rebuilt streams decode exactly. **V1 (the decoders) is done (2026-10-14, §5)**:
the browser decodes what the guest sends, frame for frame equal to the guest's own decode, H.264 only where the
browser has it in hardware. **V2 (Firefox measured on the page) is done (2026-10-14, §6)**: every picture decoded
within 3 ms, the GPU worker's pause under 10 ms, Sintel's VP9 shown at 87% of its frames against 14% decoded in the
guest, A/V sync within ±45 ms; what Firefox still drops is the guest's CPU, not the decode path, so nothing changes.
Next: V3 (§3: robustness), from `M8-VIDEO-HANDOVER.md`, starting with H.264 on browsers that decode it only in
software (the user's priority). What exists is
in the topic docs ([devices.md](../devices.md) "virgl"); this page keeps the decisions, the findings worth not
re-discovering, and each loop's record.

The question: a guest's video player decodes on our emulated CPU (Firefox's VP9 decoder takes 1.7-1.8 s of the guest's
CPU a second for a 480p trailer and still shows ~10% of its frames, [audio.md](../audio.md) "Measurements"), while the
browser beside it has hardware decoders behind WebCodecs' `VideoDecoder`. How does the guest's player reach them,
with the guest's software unmodified?

## 1. Decisions (2026-10-14)

- **VA-API over virgl** (the user, after §2's finding): the guest's own Mesa (`virtio_gpu_drv_video.so`, in Arch
  Linux ARM's `mesa` 26.2.4) is a VA-API driver that sends decode commands over the virgl protocol we already render
  (`VIRGL_CCMD_CREATE_VIDEO_CODEC` … `END_FRAME`). Firefox's VA-API path (its hardware decoding on Linux), mpv,
  GStreamer's `va` plugins and FFmpeg use it.
- **One piece of guest software of ours: a VA driver wrapper** (V0's finding, §4): Mesa's virgl offers I420 and YV12
  video surfaces besides NV12 (real drivers offer NV12 alone for decoding), FFmpeg's VA-API decoder then picks I420
  for 4:2:0 codecs, and Firefox's VA-API path takes NV12, YV12, P010 and P016 only, so it falls back to software.
  `webpc_drv_video.so` loads Mesa's driver and drops I420 and YV12 from `vaQuerySurfaceAttributes` (libva's stable
  ABI, ~60 lines; `LIBVA_DRIVER_NAME=webpc`), a package of the desktop image as `virtio-snd-dkms` is. **The user: keep
  it for now**; the same change in Mesa's virgl driver would make it unnecessary, and it waits in backlog.md
  "Upstream reports" for the user's round-up.
- **The dev VM's Chromium reads video frames with SME hidden** (the user, 2026-10-14): `tools/nosme` (a
  `getauxval` shim) as `LD_PRELOAD` for the tests' and tools' Chromium on aarch64 (§4; V1 wires it in).
- **The host decodes with WebCodecs** in the GPU worker (where the virgl renderer and its WebGL2 context are), and
  writes each decoded picture into the guest's video buffer: Mesa's `vl_video_buffer`, ordinary virgl textures (NV12
  is an R8 luma plane and an RG8 chroma plane), as virglrenderer does with host VA-API (`vrend_video.c`: decode, then
  copy into the plane resources). The pictures never touch guest RAM: Firefox exports the surface as a dmabuf and
  WebRender samples it as virgl textures.
- **Stateless in, stateful out.** VA-API is stateless (the guest parses the stream and sends a picture's parameters
  and its slice data); `VideoDecoder` takes the stream. The host rebuilds what the guest parsed away: for H.264 the
  SPS and PPS from the picture parameters (the slices arrive whole, with their headers); VP9 arrives as whole frames
  (the uncompressed header included), so it needs nothing rebuilt. HEVC is H.264's shape (VPS/SPS/PPS); AV1 sends
  tiles and needs its sequence and frame headers rebuilt (the hardest; later).
- **The output order is the guest's, not the decoder's.** The guest's FFmpeg reorders pictures itself and waits on a
  surface in presentation order after sending the pictures that follow in decode order; a decoder that holds pictures
  for its own reordering longer than the guest expects would deadlock it (the guest waits on a fence the host can't
  resolve without later input). So the rebuilt SPS says `max_num_reorder_frames = 0` (VUI bitstream restriction):
  every picture comes out as soon as it's decoded, matched to its target surface by the chunk's timestamp. Only
  Chromium's own H.264 decoder (its hardware paths) honors that; the software decoders don't (§5), so **H.264 is
  offered only where the browser decodes it in hardware** (V1), and elsewhere the guest decodes it itself.
- **Codecs:** H.264 (Constrained Baseline, Main, High; 8-bit 4:2:0, progressive) and VP9 profile 0 first: what
  YouTube and the media test clips use and what every browser decodes. Advertised only where `VideoDecoder.
  isConfigSupported` says yes. HEVC and AV1 after.
- **Correctness is bit-exact:** H.264 and VP9 decoding is exactly specified, so a decoded picture's planes must equal
  FFmpeg's software decode of the same stream byte for byte (where the browser's decoder is FFmpeg's or the
  hardware's: the dev VM's Chromium decodes H.264 with OpenH264, ±1-9 luma off on B-pictures, §5). The first implementation copies the planes out of each
  `VideoFrame` (`copyTo`, exact) into the plane textures; a GPU-only path (drawing the frame and converting to the
  planes in a shader, not exact) only if the copy costs too much, measured.
- **Tests at the cheapest layer:** the bitstream rebuilding in Node (our SPS/PPS against the stream's own, parsed
  field by field); captured guest decode traffic (`Gpu.onCapture`, `web/virgl-replay.ts`) replayed in Chromium
  against FFmpeg's planes; the guest end to end on the page.

## 2. What was considered first, and why it lost (2026-10-14)

The backlog's first candidate was **a stateful V4L2 decoder over virtio-media** (Google's V4L2-over-virtio, device ID
48), on the premise that Firefox's V4L2-M2M path (since 116, for the Raspberry Pi) would use it unmodified. It
wouldn't:

- **Firefox's V4L2 path takes only DRM PRIME frames.** `FFmpegVideoDecoder.cpp`'s `ChooseV4L2PixelFormat` accepts
  only `AV_PIX_FMT_DRM_PRIME`; **upstream FFmpeg's `*_v4l2m2m` decoders never offer it** (no `get_format` call, software
  frames only; master and Arch's 9.0.2). It works on the Pi because the Pi's FFmpeg fork (ALARM's `ffmpeg-rpi` 7.1.5)
  adds DRM PRIME output, through `VIDIOC_EXPBUF`, which virtio-media's driver doesn't implement; and the dmabuf it
  would export isn't a virtio-gpu resource, so virgl's EGL couldn't import it anyway.
- Firefox's probe (`toolkit/xre/gfxtest/v4l2test.cpp`, `widget/gtk/GfxInfo.cpp`) wants an M2M device with
  `V4L2_CAP_STREAMING`, NV12 or YV12 capture and `H264`/`VP80`/`VP90`/`HEVC`/`AV01` output formats.
- **virtio-media's driver isn't upstream:** v7 of "media: add virtio-media driver" (2026-08-13, rebased on 7.2-rc1;
  `drivers/media/virtio/`, the protocol in `include/uapi/linux/virtio_media.h`) is unmerged; not in 7.2.9 or 7.2.10.
  The out-of-tree driver (github.com/chromeos/virtio-media, BSD-3-Clause OR GPL-2.0+; its device crate BSD-3-Clause)
  would have been a DKMS package like `virtio-snd-dkms`. v7 dropped USERPTR: **MMAP buffers only, which need the
  device's shared memory region 0**, which our virtio-mmio transport doesn't have (it would be a carve-out at the top
  of RAM, as the framebuffer is).
- What V4L2 would serve unmodified: mpv (`--hwdec=v4l2m2m-copy`), the ffmpeg CLI, GStreamer's `v4l2*dec`. Firefox would
  have needed a patched build of our own (its V4L2 path taking software frames) at every release.

VA-API over virgl keeps Firefox and Mesa stock, needs no transport change and keeps the pictures on the host's GPU;
its cost is the host's stateless-to-stateful step (above).

## 3. Steps

- **V0, the gates** (measurement, nothing kept that the gates reject):
  1. The host: `VideoDecoder.isConfigSupported` for H.264 and VP9 in a worker, in headless Chromium on the dev VM
     (no GPU: software decoders) and on the Mac host's GPU (hardware).
  2. The guest: the caps advertise video (`num_video_caps`, `video_caps[]`) and the renderer takes the video commands
     as a null decoder (codecs and buffers kept, decodes counted, nothing written). On the desktop guest: what
     `vainfo` lists, whether Firefox turns hardware decoding on (about:support, `MOZ_LOG=PlatformDecoderModule:5`),
     and the guest's CPU a second for the Sintel trailer with decoding off its CPU (the ceiling the real decoder
     approaches). A capture of the commands for a clip is V1's fixture.
- **V1, the decoders:** H.264's SPS/PPS rebuilt (Node tests), VP9's chunks; a replay of V0's captures through
  `VideoDecoder` into planes in Chromium, equal to FFmpeg's (the dev VM's Chromium needs SME hidden first: §4); the
  renderer writes each picture into the plane textures, and the GPU worker holds what follows a picture until it's
  written (no fence covers a decode: §4). The VA driver wrapper as a package in the desktop image. Done: §5.
- **V2, on the page:** Firefox plays the clips through it. Measured: the guest's CPU, the frames shown and dropped,
  A/V sync (`bench/audio/avsync.ts`), on the Mac's GPU; what the GPU worker's pause costs. Done: §6.
- **V3, robustness and breadth:** seeking and resolution changes (a new codec, a new key frame), errors (a decoder
  error ends that codec's pictures, the guest falls back), snapshots (a machine with a codec is 3D in use: refused,
  as now), HEVC and AV1 where the browser has them.

## 4. V0: the gates (2026-10-14)

Tools: `bench/video/v0.ts` (the desktop guest on the page with `?gpu=virgl,video`: `vainfo`, FFmpeg through VA-API,
Firefox on the clips; `CAPTURE=1` saves the virgl capture), `bench/video/media-disk.sh` (the clips on a second disk),
`bench/video/pictures.ts` (a capture's pictures, and the streams the host makes of them), `bench/video/replay.ts`
(those streams through Chromium's `VideoDecoder`, frames hashed against the original file's).

- **The browsers' decoders** (`VideoDecoder.isConfigSupported` in a worker, 1920×1080): the dev VM's Chromium 153 (no
  GPU) decodes H.264 (Constrained Baseline to High), VP9 (profiles 0 and 2), VP8 and AV1 in software, no HEVC; the
  Mac host's Chrome for Testing 153 on the M4 decodes H.264, VP9 (profile 2 too), HEVC and AV1 in hardware.
- **The guest takes the caps.** With four `video_caps` entries, `vainfo` on the desktop guest (Mesa 26.2.4, libva
  2.24.1) says "Mesa Gallium driver 26.2.4 for virgl (webpc)" and lists `VAEntrypointVLD` for H.264 Constrained
  Baseline, Main and High and VP9 Profile 0: no change in the guest.
- **FFmpeg decodes through it** (`-hwaccel vaapi`, 120 frames of the Sintel trailer, the null decoder: the guest's
  side alone, the ceiling a real decoder approaches): H.264 1.39-1.55 s and 1.6 s of CPU against 2.9-3.0 s and 8.9 s
  decoding in the guest; VP9 0.90-0.98 s and 1.1 s of CPU against 8.9-9.0 s and 23.5 s. Each picture is a
  BEGIN_FRAME, a DECODE_BITSTREAM and an END_FRAME in one submit.
- **What Mesa's desc lacks** (read from the capture): the SPS's `level_idc` and `max_num_ref_frames` are 0 (the
  picture's `num_ref_frames` and the codec's level, Mesa's estimate for the size, stand in), and VA has no PPS
  `num_ref_idx_l0/l1_default_active_minus1` at all (Mesa writes 0): a slice without `num_ref_idx_active_override_flag`
  uses them, so with 0 every P slice misparsed. They're learned from the pictures whose slices don't override (the
  picture's active counts are then the defaults), the PPS sent again if they change.
- **The rebuilt streams decode exactly:** FFmpeg's decode of the rebuilt H.264 (Annex B, our SPS/PPS) is hash-identical
  frame for frame, in order, to its decode of the original MP4, with no decoder message; VP9's 127 frames all match
  the WebM's. (FFmpeg's raw H.264 parser regroups pictures, so it gives 102 frames of 130: counts are the per-chunk
  replay's to judge.)
- **No fence covers a decode.** Mesa's virgl `end_frame` makes no fence, so the guest's `vaSyncSurface` returns at
  once: virglrenderer decodes synchronously as it runs the stream, and everything after END_FRAME sees the picture.
  WebCodecs is asynchronous, so the host must hold what follows an END_FRAME until its picture is in the planes.
- **The dev VM's Chromium can't read a decoded frame's pixels:** `VideoFrame.copyTo`, `createImageBitmap` and a
  WebGL2 upload of a frame all kill the renderer with SIGILL at `cntd`, an SVE instruction. The M4 under Lima has SME
  and SME2 but no SVE; LLVM's prologue for a locally streaming SME function compiled with SVE saves the vector length
  with `cntd`, which faults outside streaming mode on such a CPU. Chromium's libyuv picks its SME kernels from
  `getauxval(AT_HWCAP2)` (its `LIBYUV_DISABLE_*` switches aren't in this build). Decoding itself works.
- **Firefox** (157, its defaults: no pref is needed, and none of its Linux blocklist entries for hardware video
  decoding (Mesa before 21, NVIDIA, AMD off Mesa or before Mesa 24.2, r600) matches virgl; G4's "video decoding
  blocked" was its probe failing on caps without video): its probe (`toolkit/xre/gfxtest/vaapitest.cpp`: profiles, VLD, `vaCreateConfig`)
  passes and its VA-API FFmpeg decoder starts, then `CreateImageVAAPI(): failed to get VideoFrameSurface`: "Unsupported
  VA-API surface format" I420 (the capture's video buffers are `VIRGL_FORMAT_IYUV`, three planes). Mesa's VA frontend
  lists every format whose planes virgl can sample and render (`vl_video_buffer_is_format_supported`), and FFmpeg's
  `vaapi_decode_find_best_format` takes the one matching the codec's software format, yuv420p. With the wrapper
  (§1) the surfaces are NV12 and Firefox decodes both clips through VA-API: the surface exported as a dmabuf and
  imported zero-copy (`EGLImageTargetTexture2D` for the R8 and GR88 planes), no software decoder threads. Its
  `DMABUF_SURFACE_EXPORT` stays "Blocklisted by gfxInfo" (not needed for this path).


## 5. V1: the decoders on WebCodecs (2026-10-14)

What exists is in [devices.md](../devices.md) "virgl" ("Video") and [testing.md](../testing.md) ("Video over virgl").
Tools: `bench/video/replay.ts` (a capture's pictures through `VideoDecoder`; `hw|sw`, `REORDER`; on the Mac,
`replay-mac.sh`), `bench/video/fixture.ts` (the Chromium tests' fixtures), `bench/video/v1.ts` (the desktop guest's
FFmpeg decoding each clip in software and through VA-API, frames compared by framemd5; on the Mac,
`SCRIPT=../video/v1.ts bench/gpu/sway-mac.sh - <image> <name>`).

- **Reading frames on the dev VM** needs `tools/nosme.ts` (§1, §4): with it, plain `VideoFrame.copyTo` works; V0's
  crashes with `rect` or `format` were all the SIGILL.
- **The replay (130 H.264 pictures, 127 VP9, V0's capture).** VP9 is exact everywhere (the dev VM's software, the
  Mac's hardware and software): every frame out in decode order, 0.2-0.6 ms a picture. H.264 depends on the decoder:
  - Chromium's own decoder (the Mac's VideoToolbox; also its D3D11 and VA-API paths) honors the SPS's
    `max_num_reorder_frames` 0: 130/130 frames, FFmpeg's exactly, each out before the next chunk goes in.
  - FFmpeg in software (Chrome for Testing's `prefer-software`) drops every picture that comes after one it has
    output in display order when told 0 (50 of 130 out). Without a bitstream restriction it learns the depth: 129/130
    exact, but it holds up to 5 later chunks.
  - The dev VM's Chromium (openSUSE's) decodes H.264 with **OpenH264**: it ignores the reorder field (the same lag
    with and without it: up to 6 later chunks, though the stream's own depth is 3), drops nothing, and is not
    bit-exact with FFmpeg on B-pictures (±1-9 in luma), though identical on our rebuilt stream and the original.
- **A decoder that holds pictures stalls the guest** (v1.ts on the dev VM with software H.264: 2 of 128 pictures
  written). The guest's FFmpeg reads a picture after as many later ones as the original stream's depth, and blocks
  there; the host's decoder holds it longer, waiting for chunks the blocked guest won't send. Flushing the decoder
  gets the pictures out, but WebCodecs wants a key chunk after `flush()`, so everything to the next IDR is lost.
  Rewriting the POCs so output order is decode order isn't exact (implicit weighted bi-prediction, which x264 uses,
  weighs by POC distance). So **H.264 is offered only where the browser decodes it in hardware** (`probeVideo`;
  `?gpu=swh264` offers it anyway), and the guest decodes it itself elsewhere; VP9 has no reordering and is offered
  wherever it's decoded. backlog.md has the ideas for software H.264.
- **The guest end to end** (`v1.ts`, 120 frames a clip, the guest's FFmpeg 9.0.2 with `-hwaccel vaapi` against its
  software decode): on the Mac (Chrome for Testing 153, H.264 and VP9 in hardware) both clips 120/120 frames equal,
  no picture dropped, the guest's FFmpeg 0.76 s user + 1.2 s sys for H.264 (V0: 8.9 s of CPU decoding itself) and
  0.72 + 1.06 s for VP9 (V0: 23.5 s); the longest any call waited for a picture 65 ms. On the dev VM (VP9 only)
  120/120 equal, 0.93 + 1.46 s, the longest wait 7 ms; H.264 falls back to the guest's decoder ("No support for codec
  h264 profile 100").
- **Firefox on the page** (`v0.ts` with `FFMPEG=0`, the Mac, 20 s a clip): both clips decode through VA-API (its log:
  dmabuf NV12 surfaces imported, R8 and GR88 planes) and show the right pictures (the screenshots). It drops 136 of
  481 frames on H.264 and 145 on VP9, against ~90% in software (audio.md "Measurements"); V2 measures it properly.


## 6. V2: Firefox on the page, measured (2026-10-14)

Tool: `bench/audio/avsync.ts` with `MEDIA=disk` (the clips of `bench/video/media-disk.sh`, which now has the sync
clip in VP9 and in H.264 High with B-pictures and AAC besides VP8), Firefox's frames and drops counted over each
phase (V1's numbers included its start), the renderer's video stats over the phase (`guest-session.ts`: pictures
decoded, END_FRAME to written, the write, the queue's longest wait) and `PROFILE=1` (the guest's PC sampler). On the
Mac (`SCRIPT=../audio/avsync.ts VIRGL_GPU=virgl|virgl,novideo MEDIA=disk WARM_S=5 bench/gpu/sway-mac.sh virgl
<image> <name>`): Chrome for Testing 153 on the M4, macOS 26.6.2, `--mute-audio`, the desktop image with webpc-va, 4
vCPUs, 1376×762, 20 s a clip from 5 s after it starts. JSON in `bench/video/results/v2/` (`mac-video`, `mac-novideo`,
`mac-profile`).

| Clip | Decoded on the host: dropped, guest busy | Decoded in the guest (`novideo`): dropped, guest busy |
|---|---|---|
| Sync clip, VP9 640×360 at 30 | 116 of 694 (17%), 72% | 104 of 697 (15%), 63% |
| Sync clip, H.264 640×360 at 30 | 133 of 662 (20%), 73% | 154 of 643 (24%), 73% |
| Sintel, VP9 854×480 at 24 | **69 of 531 (13%)**, 58% | **454 of 528 (86%)**, 69% |
| Sintel, H.264 854×480 at 24 | 55 of 530 (10%), 54% | 44 of 445 (10%), 75%: plays slow (445 frames in the window, not 530) |

- **The host's side costs nothing that shows.** Every picture decoded, none dropped or given up; END_FRAME to the
  planes written 2.9-3.2 ms on average, 9 ms at most; the write into the planes 0.04 ms a picture; the GPU worker's
  longest wait for a picture 5-9 ms, with 2-3 calls a second run ahead of waiting ones. So **the finer queue rule
  (handover V2.2) isn't needed, and the copy out of each `VideoFrame` stays** (§1's GPU-only path isn't wanted).
- **What Firefox still drops is the guest's CPU.** With no decoding in the guest its 4 vCPUs are 54-73% busy, about
  half of it system time, spread over Firefox's media pipeline (the RDD process, the content process's
  `MediaDecoderStateMachine`, `RemVidChild`, `ImageBridgeChild`, the IPC threads, the parent's WebRender `Renderer`
  and `Compositor`); the emulator runs ~430 M guest instructions a second in every phase, decoding or not. The small
  sync clips drop as many frames whether decoded on the host or not (VP9 at 360p is cheap in software): the drops are
  the per-frame cost of Firefox's pipeline at 30 frames a second, not the decode. The profile (kernel 45% of samples,
  flat: the scheduler, preemption counts, IRQs) charges each run chunk to the instruction after the last exit
  (graphics.md §20's caveat), so `arch_counter_get_cntvct`'s 4% is an exit site, not a measured cost. Arch's kernel
  has `DEBUG_PREEMPT` on (`debug_smp_processor_id`, `check_preemption_disabled` ~1.5%) and walks stacks
  (`arch_stack_walk` 1.6%). Sampling slows the guest (273 drops of 558 with it): drop counts only from unsampled runs.
- **A/V sync, decoded on the host:** the H.264 sync clip median -13 ms (p10 -29, p90 +7, all within -40..+7), VP9
  median -10 ms (p10 -42, p90 +9, one outlier at -90): inside ±45 ms (ITU-R BT.1359) but for that one. Decoded in
  the guest, H.264 is median -85 ms (p10 -118, p90 +46, -137..+146): out of sync.
- **Decided:** V2 changes nothing in the decode path; the remaining drops are the emulator's speed under Firefox's
  multi-process pipeline (PLAN.md's CPU work), not the video track's. Next is V3.
