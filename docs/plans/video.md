# webpc video decoding plan

**Status:** done 2026-10-15 (started 2026-10-14) (the backlog's "Hardware video decoding"). The direction is the user's (§1): **VA-API
over virgl**, decoded by the browser's WebCodecs. **V0 (the gates) passed (2026-10-14, §4)**: the guest's Mesa takes
the caps, FFmpeg and Firefox decode through VA-API (Firefox once a VA driver wrapper of ours hides the surface
formats it can't take), and the host's rebuilt streams decode exactly. **V1 (the decoders) is done (2026-10-14, §5)**:
the browser decodes what the guest sends, frame for frame equal to the guest's own decode, H.264 only where the
browser has it in hardware. **V2 (Firefox measured on the page) is done (2026-10-14, §6)**: every picture decoded
within 3 ms, the GPU worker's pause under 10 ms, Sintel's VP9 shown at 87% of its frames against 14% decoded in the
guest, A/V sync within ±45 ms; what Firefox still drops is the guest's CPU, not the decode path, so nothing changes.
V3 (§3: robustness) started with **H.264 where the browser decodes it only in software** (§7): offered there now,
Firefox and mpv play it as well as from a hardware decoder. **Firefox's cost and frame pacing were measured (§8)**:
steady playback drops almost nothing, V2's cost was Firefox's start, no pref helps, and the bursts are the guest's
CPU saturated and the host stopping every vCPU at once for JIT installs (since fixed by the JIT's compile worker:
jit.md "Sharing"). **Seeking, size changes, decoder errors and snapshots were checked (§9)**: right pictures after
every seek once a held picture is written into planes the guest's decoder has let go of (Firefox's at a seek), exact
frames across size changes, a damaged chunk a decoder error that loses nothing but its codec's pictures, a machine
with a live codec refused a snapshot that saves once the player exits. **AV1 is decoded on the host (§10)**: offered
wherever `VideoDecoder` takes it (the user's Linux Chromium decodes it in software), its headers rebuilt, exact in
software and in the Mac's hardware, film grain included (webpc-va 2).
**The track is done (§11): HEVC dropped.** What exists is
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
  ABI, ~60 lines; `LIBVA_DRIVER_NAME=webpc`), a package of the desktop image as `virtio-snd-dkms` was then (since §10 it
  also routes AV1 film grain around a Mesa omission: webpc-va 2). **The user: keep
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
  Chromium's own H.264 decoder (its hardware paths) honors that; the software decoders hold pictures (§5). V1 offered
  H.264 only in hardware; **since V3 it's offered wherever the browser decodes it** (§7, the user's priority: their
  host is Chromium on Linux): a held picture stalls only the context that shows it, a software decoder is told the
  stream's depth, and a drain loses nothing.
- **Codecs:** H.264 (Constrained Baseline, Main, High; 8-bit 4:2:0, progressive) and VP9 profile 0 first: what
  YouTube and the media test clips use and what every browser decodes. Advertised where `VideoDecoder.
  isConfigSupported` says yes, in hardware or not. AV1 Main 8-bit since V3 (§10); HEVC after.
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
- **V3, robustness and breadth:** H.264 where the browser decodes it in software (first, the user's priority: §7);
  seeking and resolution changes (a new codec, a new key frame), errors (a decoder
  error ends that codec's pictures, the guest falls back), snapshots (a machine with a codec is 3D in use: refused,
  as now): §9. AV1 (§10), HEVC where the browser has them.

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
  (graphics.md §20's caveat), so `arch_counter_get_cntvct`'s 4% is an exit site, not a measured cost. Arch Linux ARM's
  kernel has `DEBUG_PREEMPT` on (`debug_smp_processor_id`, `check_preemption_disabled` ~1.5%) and walks stacks
  (`arch_stack_walk` 1.6%). Sampling slows the guest (273 drops of 558 with it): drop counts only from unsampled runs.
- **A/V sync, decoded on the host:** the H.264 sync clip median -13 ms (p10 -29, p90 +7, all within -40..+7), VP9
  median -10 ms (p10 -42, p90 +9, one outlier at -90): inside ±45 ms (ITU-R BT.1359) but for that one. Decoded in
  the guest, H.264 is median -85 ms (p10 -118, p90 +46, -137..+146): out of sync.
- **Decided:** V2 changes nothing in the decode path; the remaining drops are the emulator's speed under Firefox's
  multi-process pipeline (PLAN.md's CPU work), not the video track's. Next is V3.


## 7. V3: H.264 where the browser decodes it in software (2026-10-14)

The user's priority (their host: Chromium on Linux with an NVIDIA GPU, no hardware decoding, so VP9 was offered and
H.264 not). Tools: `bench/audio/avsync.ts` (`mpv:<file>` phases: mpv with `--hwdec=vaapi` in sway, its frames and
drops from its status line), `?gpu=swvideo` (the software decoders where there's hardware: the Mac), `v1.ts` with
`VIRGL_GPU`, `replay.ts` with `REORDER=<depth>`. JSON in `bench/video/results/v3/` (`mac-*`: Chrome for Testing 153
on the M4, its software decoders FFmpeg's; `*-devvm`, `mpv-*`: the dev VM's Chromium, OpenH264).

- **Why it stalled was the queue, not only the decoder.** `CallQueue` held every non-decode call while any picture
  was pending, and a decoder that holds pictures for reordering always has one pending: all rendering (sway's too)
  waited until the 200 ms drain, whose flush wants a key chunk, so the stream was lost to the next IDR. Now a call
  waits only if it could see a pending picture: its context has a pending picture's plane attached (the renderer
  refuses a context a resource it hasn't attached; Firefox's compositor and mpv attach the planes to show a frame,
  ~2 a frame) or it names one; decode-only submits still pass. With that alone Firefox played H.264 through OpenH264
  on the dev VM with no call ever waiting, every picture decoded, 117-176 ms from END_FRAME to written. *Too fine:*
  other contexts ran ahead of a held one they share resources with, so sway composited a client's window before the
  client's held draws into it (Chromium in the guest showed older frames; graphics.md §24). They wait too since
  2026-10-22.
- **FFmpeg (Chrome's software decoder) drops what it reorders too late.** Told no depth it guesses, dropping a
  picture while it learns (V1's replay: 1 of 130); that picture never came out, the compositor waited on it, the
  drain followed, and the trailer lost 19 pictures a second (`mac-swvideo`). So the SPS says the larger of the
  stream's reference count and the depth learned from the POCs (the desc's POC, offset 2308; the trailer's depth is
  2, as its VUI says, and the SPS changes only at an IDR, before the first B-picture shows the depth, hence the
  reference count). A software decoder outputs in display order, so a pending picture of a lesser POC than one that
  comes out was dropped by it: given up at once (a one-picture glitch, not a stall).
- **Drains lose nothing now.** mpv waits to show its first picture before it decodes more, and OpenH264 holds it:
  the drain came at every start (`mpv-devvm`: 6.7 pictures a second lost). The IDR period's pictures are kept, and a
  drain flushes the decoder (out come the held pictures, written) and has a new one decode the period again from its
  IDR (its outputs written only where still pending). mpv: 2 drains at the start, then every picture.
- **Chrome's FFmpeg holds 3 pictures beyond what the SPS says** (`replay.ts`, `REORDER=2`: lag up to 5; 5: up to 8),
  its frame threads; OpenH264 ignores the SPS (up to 6). So a player that waits for each picture after fewer later
  ones (the guest's `ffmpeg -hwaccel vaapi` reading frames back waits after 2) can't be served by the depth: it
  gets every frame right (`v1.ts` on the Mac, 120 of 120 equal) but each through a drain, 120 frames in 23 s
  (backlog.md). A depth seen from the guest's waits was tried and dropped: it can't go below Chrome's 3, and mpv's
  first-picture wait reads as depth 0.
- **On the Mac** (`?gpu=virgl,swvideo`, 20 s a clip):

| | Software decoder (FFmpeg) | Hardware (V2, `mac-video`) |
|---|---|---|
| Firefox, sync clip, H.264 at 30 | 66-97 of 663-667 dropped (10-15%), all 30 a second decoded, sync median -2 to -10 ms | 133 of 662 (20%), -13 ms |
| Firefox, Sintel, H.264 at 24 | 66-79 of 526-555 (13-15%), all decoded | 55 of 530 (10%) |
| mpv, Sintel, H.264 | 0 of 527 dropped, the guest 19% busy | (not run) |
| Firefox, VP9 (sync clip, Sintel) | 101 of 696, 76 of 532: as hardware, under 1 ms a picture | 116 of 694, 69 of 531 |

  END_FRAME to written 130-210 ms in software (the decoder's holding), against ~3 ms in hardware; Firefox and mpv
  decode far enough ahead not to notice. One Firefox run in five went wrong (the sync clip: 322 of 667 dropped, a
  drain whose cause the run didn't record); the four with the renderer's log had at most one drain, at a clip's
  start. **mpv keeps the guest at 19-27% busy where Firefox needs 54-74%** for the same clip, with no frame dropped:
  the cost left is Firefox's (the next loop).


## 8. V3: Firefox's cost and frame pacing (2026-10-15)

The user's report (decision 7 of the handover): the host's decoding isn't felt in Firefox, and its playback, scrolling
and browsing come in uneven bursts, at times losing a second or more. Tools, all dev-only (docs/benchmarking.md
"Guest sessions"): `bench/gpu/guest-session.ts` `load` now records every process (its /proc stat: threads that exited
count), every thread over 2 ms a second with schedstat's runs and run-queue wait, and with `SYSCALLS=1` the syscalls by
thread (a kprobe on `do_el0_svc`: Arch's kernel has no syscall tracepoints); `TIMELINE=1` the vCPU timeline (every
vCPU's counters and liveness every 10 ms, `web/timeline-worker.ts`); `bench/audio/avsync.ts` `VARIANTS`/`ROUNDS` (sets of
Firefox prefs alternated in one boot, a fresh prefs.js each launch), `NCPUS`, Firefox's frames and drops each second;
web/vm.ts logs an install of JIT code that took 20 ms or more (`webpc-slow install`, collected into results' `slow`);
`sway-mac.sh` samples the Mac's `vm_stat` each second. JSON in `bench/video/results/v3c/` (Sintel's H.264 trailer, the
Mac, Chrome for Testing 153, 4 vCPUs, the desktop image with webpc-va; `pages-devvm`: the dev VM's Chromium 153).

- **V2 and V3's per-thread numbers were incomplete.** `load` read the threads off the serial terminal, and those that
  scrolled away were lost (Firefox's listed threads were 6-25% of /proc/stat's busy time). Process totals were right.
- **V2/V3's cost was Firefox's start.** Their phases began 5 s after playback started; Firefox's start-up work goes on
  ~30 s more, and the drops fell in the first ~6 s of the phase (each second's count: `7,7,10,2,5,17,0,2,...,0`).
  From 30 s after the start (`ab2`): **0-5 frames of ~500 dropped in 20 s** (one run 20, 18 of them in one second), the
  guest 32-41% busy at ~200 M instructions a second (V2: 54-74%, ~430 M). mpv on the same file: 0 dropped, 19-20%.
- **Where Firefox's CPU goes** (steady, ms a second): the parent 500-630 (its main thread, WebRender's `Renderer` and
  `RenderBackend`, the `Compositor`, `WaylandProxy`, IPC, telemetry's `glean.dispatcher` spinning on `sched_yield`,
  PulseAudio's `threaded-ml`), the content process 310-400, RDD (the decoder) ~110-140, the audio utility process
  ~70-85, sway ~170; mpv 450 and sway 145. Syscalls (`sys2`, during the start): Firefox 13.7 k a second (futex 5.4 k,
  ppoll 1.7 k (1.1 k of them RDD's decoder threads, ~45 a frame), recvmsg and sendmsg 2.1 k, sched_yield 0.7 k),
  mpv 5 k. No one thread or call dominates: it's the multi-process pipeline's per-frame IPC.
- **No Firefox switch matters at steady state** (`ab2`, two rounds each): telemetry off (`notel`) 0 and 0 dropped,
  `media.utility-process.enabled=false` 3 and 5, `media.decoder.skip-to-next-key-frame.enabled=false` 2 and 4, the
  defaults 20 and 3: all within the noise. `media.rdd-process.enabled=false` never starts playing (frames stay 0);
  `gfx.webrender.compositor.force-enabled=true` (the native Wayland compositor) says it plays but presents no frame.
  Nothing becomes the image's default.
- **Scrolling** (`scroll`, `pages*`: firefox-load.ts, a wheel notch every 100 ms on real pages): ~60 frames a second;
  the slow frames (100-430 ms, mostly on Wikipedia and BBC as they load) come with the guest 50-85% busy: its own work.
- **The host stalls the vCPUs at JIT installs.** A vCPU installs compiled modules synchronously on its own thread
  (`jit_install`: `new WebAssembly.Module`, then the instance), and when one vCPU compiles a batch the others catch up
  on their next miss: **all four install the same bytes at once, and each waits the full time** (V8's process-wide
  module cache has the others wait on the one compile). On the dev VM 31 installs of ≥ 20 ms in ~8 minutes of
  Firefox starts and page loads, most four at once, 20-58 ms for modules of 1-5 KB, the longest **739 ms** (13 KB, 14
  functions); on the Mac 3 in each session, 26-513 ms. The guest's clock runs on meanwhile; another vCPU spinning on a
  lock the stalled one holds stops too (the timeline: two vCPUs crawling in lockstep at ~17 instructions a µs through
  a 270 ms stall of a third). None fell inside the measured windows of scrolling or steady playback. Why V8 takes that
  long for a few KB is unmeasured (lock or `mprotect` contention with the threads running wasm is a guess). The fix
  that holds whatever the cause is jit.md's compile worker (compiled off the vCPU threads, the `WebAssembly.Module`
  posted to them): backlog.md. **Built the same day** (jit.md "Sharing", `bench/boot/REPORT.md` "M8: the JIT's
  compile worker"): the cause was V8's GC of code and objects, not compiling; with the worker no stall reached 250 ms
  in the pages session.
- **The Mac's memory is overcommitted** (7 of 8 GiB of swap used, ~10 GiB compressed; the Lima VMs reserve 22 of its
  24 GiB): one 270 ms stall had no install in it, and the slowest installs came in seconds with 2-3× the run's p90 of
  decompressions. Latency measured on the Mac is suspect while both VMs run.
- **Decided:** nothing changes in the guest or the decode path. Firefox's steady playback is fine where the host keeps
  up; what the user feels as bursts is the guest's CPU saturated (Firefox's start, page loads) and the host's
  synchronous JIT installs stopping every vCPU at once.


## 9. V3: seeking, size changes, errors, snapshots (2026-10-15)

Tools: `bench/video/seek.ts` (the guest's FFmpeg jumping within one decoder: the concat demuxer's in and out points on
one file, the list looped once so the loop's seek flushes the decoder, framemd5 against its software decode; Firefox
seeking a paused video, the picture it shows drawn to a canvas and compared as 16×9 blocks of mean luma with FFmpeg's
software frames from 0.1 s before to 0.1 s after; Firefox seeking every 2.5 s while playing; `CAPTURE=1`),
`bench/video/v1.ts` (`SNAPSHOT=1`), the clips `res-vp9.webm` and `res-h264.ts` (images/arch/media.sh: the trailer
from 20 s in three 4 s segments at 854×480, 640×360 and 1280×720, joined as one track), `ChunkFault` in the Chromium
test. JSON in `bench/video/results/v3d/` (the dev VM's Chromium 153; the Mac's Chrome for Testing 153 on the M4).

- **A decoder error** (a chunk's bytes garbled or cut, in Chromium): every damaged chunk, VP9 or H.264 at the 11th
  picture, is a WebCodecs `EncodingError` (none of Chromium's decoders conceals it; a damaged first, key, chunk is
  refused at `decode()`). The pictures before it are written, the codec's later ones dropped until a key picture, and
  no call waits on them (the longest wait 14 ms). Real streams rarely get there, but one did: the guest's FFmpeg
  seeking in an MPEG-TS (no index) jumps to a P picture with no IDR, which its own decoder conceals and the browser's
  reject; the host then shows nothing new until the next IDR (`res-ts-jumps-*`; backlog.md).
- **Snapshots** (`snapshot-devvm`): while the guest's FFmpeg decodes through VA-API, Save snapshot is refused with
  "the machine is using 3D (virgl): close its GL programs and video players first" (the message now names players);
  once it exits (its context destroyed), the machine saves (348 MB, paused 2.4 s). Nothing changed in the rule.
- **Seeking: FFmpeg exact.** Through three jumps and a flush (`seek-*`): VP9 353 of 353 frames equal to the guest's
  software decode (dev VM); H.264 355 of 355 on the Mac in hardware and in software (the latter at V3's pace for a
  player that waits on each picture: 168 s, backlog.md). A seek sends a key picture to the same codec.
- **Seeking in Firefox, a bug found and fixed.** In hardware (the Mac, H.264) and with VP9 on the dev VM every paused
  seek showed its frame (the best match within a frame of the time at 0.0-2.5 mean luma; where neighbouring frames
  differ the next is 14 away). With H.264 in software two of seven showed a picture from before the seek (38 and 50
  away from every frame near the time; `seek-h264-swvideo-mac-before`). Firefox's decoder process tears its decoder
  down at an H.264 seek (a new codec every seek; its VP9 path keeps the codec) and lets go of the surfaces, detaching
  them from its context, while the compositor's and the content process's contexts still hold them (dmabuf imports).
  The software decoder still held the target picture, and when it came out (a drain) the write needed the decoding
  context's attachment, so it was skipped (`ctx 10: resource N isn't attached`) and the compositor sampled the old
  planes. virglrenderer writes at END_FRAME, when they're attached; now a picture is written into the planes its
  buffer had at END_FRAME as long as they exist, a destroyed codec's decoder is flushed rather than dropped, a
  destroyed buffer's pending picture still written, and a picture never written over a later one in the same planes
  (two decoders may output out of order). After it (`seek-h264-swvideo-mac`): all seven right, no warning.
- **Seek times** (from setting `currentTime` to `seeked`, the decode from the key picture before the time): VP9 on
  the dev VM 0.7-3.8 s paused, 1.0-3.0 s playing, against 0.2-15 s and 3.9-17 s with the guest decoding (`novideo`,
  most frames then dropped for seconds after each seek); H.264 on the Mac 0.5-1.5 s paused, 0.07-3.6 s playing,
  the same in software. The host's side: 1.6-3 ms from END_FRAME to written in hardware, no call waiting; the rest is
  Firefox in the guest. Playback resumes after every seek (2.3-2.5 s played in the 2.5 s after it).
- **Size changes make a new codec** (FFmpeg and Firefox, VP9 and H.264: the guest's VA context is made for one size),
  and the host a new decoder: `res-vp9.webm` 288 of 288 frames equal on the dev VM, `res-h264.ts` 288 of 288 on the
  Mac in hardware and in software (where a codec destroyed with pictures held is flushed out); Firefox on the VP9 clip
  shows the right frame at every paused seek across the sizes and plays on after each seek. VP9's change of size
  without a key frame (reference scaling: libvpx's real-time resizing) wasn't tried.
- **Decided:** the write and destroy rules above (devices.md "virgl"); nothing else changes. Next: HEVC and AV1.


## 10. V3: AV1 (2026-10-15)

AV1 before HEVC: Chromium on Linux has no software HEVC decoder, so the user's host would never be offered HEVC,
while AV1 decodes in software everywhere (dav1d) and is what YouTube serves. Clips (images/arch/media.sh): the
trailer in SVT-AV1 (`sintel-av1.webm`), 10 s in libaom (`sintel-aom.webm`: all eight references, hidden frames), 10 s
of SVT-AV1 with film grain (`sintel-grain.webm`), 3 s of libaom with more tools on (`sintel-tools.webm`: segmentation,
2x2 tiles, 128x128 superblocks, quantizer matrices, rotzoom global motion, delta q and lf, loop restoration, film
grain). JSON in `bench/video/results/v3d/` (`av1-*`, `seek-av1-*`).

- **The stream** (`web/video-av1.ts`): Mesa's `virgl_av1_picture_desc` has the sequence and frame header's fields and
  the frame's tiles (offsets and sizes into its bitstream buffers, which hold only tile data); the host writes a
  sequence header and each frame header from them, in explicit forms where the original may have leaned on state
  (frame sizes, references without short signalling, loop filter deltas, segmentation data and film grain written as
  updates, which FFmpeg's CBS fills with the effective values; global motion delta-coded against parameters this side
  keeps per slot), and a tile group of its own. Caps: AV1 Main, 8-bit (`av01.0.13M.08`; 10-bit isn't offered: the
  video buffers are NV12). Mesa's VA frontend lists `VAProfileAV1Profile0` and Firefox decodes through it.
- **Mesa doesn't send `refresh_frame_flags`** (its VA frontend writes 1), so the host keeps its own reference slots.
  AV1's decoding depends only on what the slots hold: a frame goes to a slot holding no picture the guest can still
  reference (not in its reference map), and its references are the slots holding the pictures the guest's name. With
  eight distinct pictures in the guest's map (libaom's streams, mostly) none is free; the frame then waits for the next
  frame, whose map says whether and where the guest stored it. If the guest waits on it instead, `CallQueue` nudges it
  out after 30 ms stored nowhere, and if a later frame references it, it's decoded again, hidden, into a slot freed by
  then (exact: the slots haven't changed in between). Decoding again whenever no slot was free (the first version) cost
  55 of 65 libaom frames, 14 of 64 SVT's and 56 of 77 of the tools clip decoded twice; with the wait, none, for a
  player that decodes ahead. The guest's FFmpeg reading each picture back waits 30 ms a frame for the nudge.
- **Hidden frames.** A frame the guest shows later (`show_existing_frame`, which FFmpeg answers without a decode) is
  written shown, so the decoder outputs it for its surface (an inter frame decodes the same shown or not); a hidden
  key frame shown later isn't output (not seen in these encoders' streams). A frame with no output goes in the next
  frame's temporal unit, as encoders put hidden frames: Apple's hardware decoder fails a temporal unit without a shown
  frame (libaom's from its second frame).
- **Film grain needs webpc-va 2.** With grain, FFmpeg decodes into a reference surface and shows another (VA's
  `current_display_picture`), and Mesa sends the frame (DECODE_BITSTREAM, from `vaRenderPicture`) before it sets the
  film grain target (in `vaEndPicture`), so the host never learns where the grained picture goes: 7 of 60 frames
  matched (`av1-grain-before-devvm`; virglrenderer would do the same). webpc-va 2 has such a frame decoded into its
  display surface and names display surfaces in the reference map (FFmpeg keeps a frame's display surface while the
  frame is a reference); the host's decoder applies the grain (dav1d's and VideoToolbox's equal FFmpeg's). The image
  is rebuilt with it (Mesa, FFmpeg and the kernel unchanged). Also unsent: `lr_unit_size` (virgl copies the shifts).
- **Exact.** The guest's FFmpeg against its software decode (framemd5): libaom, SVT-AV1 and film grain 240 of 240,
  the tools clip 72 of 72, on the dev VM (dav1d) and on the Mac in hardware (VideoToolbox) and software; through jumps
  and a flush (seek.ts) 345 of 345. Firefox: every paused seek shows its frame, playback resumes after each, nothing
  dropped on the host (dev VM and the Mac's hardware). Not exercised: superres (libaom through FFmpeg won't take the
  option), non-uniform tiles, translation and affine global motion, intra block copy, switch frames.
- **Decided:** AV1 is offered; webpc-va 2 is the image's. Mesa's three omissions go to backlog.md "Upstream reports".


## 11. The end: HEVC dropped (2026-10-15)

**The user, 2026-10-15:** HEVC isn't accelerated, and the track ends with H.264, VP9 and AV1. They cover what the web
serves (YouTube, the media test sites); Chromium on Linux has no HEVC decoder of its own (only a platform's, in
hardware), so the user's host would never offer it; and it's more work than AV1 was: VA's parameters lose the SPS's
short-term reference picture sets, so every slice header would be parsed through and rewritten with an explicit set
(backlog.md has what it would take). HEVC files still play, decoded in the guest. Loose ends are in backlog.md: a
player that waits on each picture where H.264 decodes in software (§7), an H.264 jump to a non-IDR picture (§9), and
Mesa's omissions under "Upstream reports".

Learned on the way (from the track's handover; for whoever works on video again):

- **The fixture replay can't find a stall:** it feeds every picture without waiting, as no guest does. A decoder that
  holds pictures shows only with the guest on the page (`v1.ts`).
- **The dev VM's Chromium decodes H.264 with OpenH264** (openSUSE's build): it ignores the SPS's reorder field and
  isn't bit-exact with FFmpeg on B-pictures. Judge H.264 exactness on the Mac.
- **The page's frame counts can't judge decoding with `?gpu=novideo`**: Firefox then decodes in software.
- **`sway-mac.sh` takes `-` as the mode** for scripts without one (`v1.ts`, `v0.ts`); it copies the media disk.
- **sway's `exec` splits at commas**: `MOZ_LOG=a:5,b:5` must go through a script (`v0.ts` writes
  `/home/arch/ff-launch.sh`).
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
- **What virgl's descs carry isn't what Mesa's pipe descs have**: check `virgl_video.c`'s fill for every field read
  (AV1's `lr_unit_size` isn't copied), and Mesa's VA frontend for what it fills when (the film grain target comes after
  the desc is sent).
- **libaom through FFmpeg takes `-aom-params` keys, not every aomenc option** (`superres-mode` isn't one).
- **The PC sampler slows the guest** (Firefox's drops doubled): drop counts from unsampled runs only; and it charges
  a chunk to the instruction after the last exit, so exit sites (`arch_counter_get_cntvct`) look hot.
