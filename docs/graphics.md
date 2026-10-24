# Graphics

How a guest gets a display and hardware-accelerated 3D in the page **with its own unmodified drivers**: virtio-gpu for
the display (2D), and OpenGL ES through Mesa's **virgl** driver, rendered on the host by **our own virgl renderer on
WebGL2**. Done (milestone M8's graphics track, G0 to G5, 2026-10-01 to 2026-10-19, and fixes since); the decisions that
bind it, and what is still open, are in [plans/graphics.md](plans/graphics.md), the loose ends in
[backlog.md](backlog.md) ("Platform and devices"). Where the parts are described in detail: the device in
[devices.md](devices.md) "virtio-gpu" and "virgl", the page's screen, the Graphics choice and the guest's cursor in
[frontend.md](frontend.md) "The screen", video decoding over virgl in [plans/video.md](plans/video.md), the tests in
[testing.md](testing.md), the benchmarks in [benchmarking.md](benchmarking.md) and `bench/gpu/REPORT.md`.

## How it fits together

- **The device** (`web/gpu.ts`) is a virtio backend in the device worker like the others: it checks every command,
  keeps the resource and context tables and holds replies (devices.md). It never draws by itself: where pixels go is
  `GpuHooks` (2D) or a `VirglHost` (3D).
- **A 2D machine:** the page's canvas goes machine worker → device worker, and `web/gpu-present.ts` draws each flush's
  damage on it: WebGL2 where the browser has it on a GPU (the guest's bytes uploaded as they are and swizzled in the
  draw, `web/virgl-screen.ts` without a renderer), a 2D context over the device's RGBA copy elsewhere (SwiftShader
  draws every present on the CPU). `?gpu=gl2d`, `?gpu=canvas2d` choose.
- **A 3D machine** (the default wherever the browser has WebGL2): the page starts a top-level **GPU worker**
  (`web/gpu-worker.ts`, so it has animation frames) and hands it the canvas. It makes the WebGL2 context, probes the
  browser's video decoders, builds the caps from that context (below) and says `ready`; the machine then starts with
  those caps and a port to it. The device worker keeps the virtqueues and forwards its 3D work (contexts, resources,
  backings, attachments, transfers, submits) and **every scanout, 2D ones too** (the firmware, the console) as ordered
  calls (`web/virgl-host.ts`). The GPU worker runs them through the renderer (`web/virgl-renderer.ts`, with the
  translator `web/virgl-tgsi.ts` and the format table `web/virgl-formats.ts`) and draws the screen. Guest RAM is
  shared memory, so the renderer reads and writes the guest's pages in place.
- Without WebGL2, or if the context or the caps can't be made (`failed`), the machine starts again as 2D. A lost
  context on a 3D machine stops it with a message (every renderer object is gone with it); a 2D machine's WebGL2
  screen draws again when its context comes back.
- **The switches:** the Machine menu's Graphics (3D or 2D, a restart applies it); on the query, `?gpu=2d`, `virgl`,
  `virgl-null` (the null renderer: streams walked and counted, nothing drawn, fences at once), `nopace` and `q<N>`
  (the flush pacing and the queue size, for measurements), `novideo`, `swvideo`, `debug` (the renderer's trace) and
  `capture` (devices.md "Captures"), comma-separated; `?displaystats` turns on the display's counters (commands by
  type, fences' round trip and each hop, replies held) and the renderer's; `?display=simple` gives a gpu machine the
  simple framebuffer instead.

## The 2D display

The device's commands, formats, EDID and pacing are devices.md's "virtio-gpu"; this is what the guests do with it and
why the device is as it is.

### What the guests do

- **Linux needs `CONFIG_DRM_VIRTIO_GPU_KMS=y`**: without it the driver binds, says "KMS disabled" and offers no
  connector. It also needs a modern transport (QEMU's virtio-mmio is legacy by default, and the driver then stays
  `FAILED` with no message: the oracle needs `-global virtio-mmio.force-legacy=false`; ours is modern).
- **Dumb buffers are always `B8G8R8X8` resources**, whatever the framebuffer's format, so a hardware cursor (an
  ARGB8888 framebuffer on a dumb buffer) carries its alpha in the X byte: the resource keeps the fourth byte raw for
  every format, and the screen ignores it.
- A mode set is one full transfer and flush; `DIRTYFB` with a clip transfers and flushes that rectangle only
  (`drm_atomic_helper_damage_merged`); a cursor update is a transfer of its 64×64 and an `UPDATE_CURSOR`, a legacy
  move a `MOVE_CURSOR` alone. A primary plane's update is `TRANSFER_TO_HOST_2D`, `SET_SCANOUT`, `RESOURCE_FLUSH` sent
  at once and fenced only for blob resources (we offer none), so the guest waits for no reply (a 60 Hz vblank timer
  paces it from Linux 6.19). The display event is taken by a work item: `GET_DISPLAY_INFO` and `GET_EDID`, then the
  connector's preferred mode changes (a `GETCONNECTOR` poll sees it).
- **The firmware:** EDK2's `VirtioGpuDxe` gives a GOP (a 640×480 resource set as the scanout before the kernel), and
  GRUB's `gfxterm` takes it: GRUB's menu is then on the screen only, not on the serial console. Linux has no `efifb`
  on it (the GOP is Blt-only), so the screen is dark from the kernel's start until udev loads `virtio_gpu` from the
  root filesystem (~10 s into a 21 s Debian boot), then fbcon takes `fb0`. Since 2026-10-18 the firmware's keys come
  from the built-in USB keyboard on machines with the USB controller ([usb.md](usb.md) "The keyboard").
- `edid-decode` rejects pixel clocks under 10 MHz, so the smallest EDID is 480×300 (the page's floor, 640×480, is above it).

### The console and the display size

- **fbcon's buffer is the size it was born with.** A bigger preferred mode is rejected (`drm_client_modeset_probe`:
  `VIRTUAL_X`); with no other mode in the EDID the fbdev client commits an empty mode and **the screen goes dark**
  (QEMU's EDID lists standard modes, so it never shows there). A smaller mode crops: the guest keeps its resource and
  shows a rectangle of it at the origin. Hence the device's two rules (devices.md "Display size and events"): the EDID
  lists, after the preferred mode, the size of the resource the guest last showed (kept in a snapshot) and the floor;
  a crop raises the floor to the resource's size and the event once more, so the console is whole and letterboxed. A
  fixed size takes effect for a text console at its next boot. (The fallback mode was once the size the display
  started with, which after a restore into a bigger window was the new page's, and the restored console blanked.)
- **What the guests do with a new size** (on our machine; none follows it live):

  | Guest software | On a display event | Without an agent |
  |---|---|---|
  | fbcon (Debian 13, kernel 6.12) | A bigger mode is refused (the EDID's fallback keeps the console), a smaller one crops and the display bounces it | The page's size at boot; letterboxed or scaled after |
  | sway 1.12 (wlroots), pixman or GLES | The kernel lists the new preferred mode at once, but sway keeps its mode (wlroots seems to read an output's modes only when it connects), and `swaymsg output Virtual-1 mode WxH` falls back silently. `swaymsg -- output Virtual-1 mode --custom WxH` works: a new resource, the canvas follows | The page's size when sway starts |
  | GNOME, KDE on Wayland; Xorg | Not measured | Expected: live for the first two, `xrandr --auto` for Xorg |

  Live resize is a guest agent's job ([plans/agent.md](plans/agent.md)) or a desktop's own setting.

### Console scrolling and the flush pacing

fbcon scrolling (`dmesg` on tty1) makes the guest send ~2,400 full-screen `TRANSFER_TO_HOST_2D`s a second, 4,800
requests with the flushes, while the page draws ~60 frames: Linux's fbdev emulation copies the damaged clip from its
shadow buffer and commits once per damage, with no fence on 2D. Three things keep that from hurting:

- **The device worker yields.** `Devices.serve` rang through `Atomics.waitAsync`, which returns at once when the word
  has already changed, and `poll` is all microtasks: with the guest ringing continuously the loop never reached the
  event loop, so timers and port messages (a key's release, so the guest autorepeated; the page's `size`; the draw
  timer) waited up to ~1.3 s. `serve` now yields through a `MessageChannel` after every ~2 ms of work: the device
  worker's lag (the longest a 4 ms timer was late, per second) went from 1,000–1,370 ms to 22–30 ms under the storm
  (idle 2–4 ms). With it, flush-to-draw under a continuous disk read is 22–33 ms at worst (bench/io/REPORT.md "Loop 5
  judged"), so blk stays on that thread. (A Node reproduction starved timers either way: the evidence is Chromium's.)
- **The transfer's gather works in 32-bit words** for the common formats (a full 1024×768 transfer 2.9 → 1.6 ms in Node).
- **Flush replies are paced** (devices.md "Flush replies are paced"): one per 60 Hz frame, the first after an idle
  moment at once, with a queue of 16, which is the only back-pressure a 2D guest takes. Console scrolling on Debian
  (672×762; changed canvas frames a second, and `dmesg` runs per 10 s):

  | | frames/s | `dmesg` per 10 s |
  |---|---|---|
  | simple framebuffer | 63 | 17 |
  | virtio-gpu, flushes paced, queue 16 (the page) | 55–59 | 11–12 |
  | queue 64 | 52 | 12 |
  | no pacing | 64 | 7 |

  What remains is the guest's own cost of Linux's virtio-gpu fbdev path (a shadow copy and a commit per damage), which
  a host can't remove; `?display=simple` gives a machine that wants a fast console the old screen. The tests' guests
  run unpaced with a queue of 64, so their bytes and step counts don't move.

**Tried and lost** (don't build again):
- *Lazy transfers* (note the rectangle, copy once per drawn frame): wrong by the protocol. The guest doesn't wait for
  replies, so by a deferred copy a compositor is drawing a later frame into the same buffer; it also made a `cat` to
  the console slower (9 s against ~5). A transfer copies when it arrives.
- *Copying before the reply reaches the guest* (`settle`): the same mistake one step earlier; the reply isn't what the
  guest waits for.
- *Re-reading the shown resource's backing every 30 ms* (`scanPoll`): with a guest drawing late (llvmpipe, below) it
  showed frames N−1, N−2, N in turn, and read buffers the guest was drawing into.
- *Pacing every reply*: a guest that waits for each reply (EDK2's GOP) got one command a frame. Only flushes are held,
  and commands are never delayed, only their replies.

### Guests that composite with llvmpipe

Stock sway with no 3D renders through Mesa's llvmpipe, which **is asynchronous**: wlroots ends a frame with `glFlush`,
which hands the scene to llvmpipe's rasterizer threads and returns, then page-flips, and the primary plane's update
waits for nothing. So the transfer copies a buffer the rasterizer is still filling (measured: the host's copy equals
the backing right after the flush and differs 30 ms later, at every flip), and the screen shows each buffer as it was
two flips ago plus whatever tiles were done: missing letters, tile-shaped holes. A real display hides the race by
scanning memory continuously; a virtio-gpu host wins it only if its command path is slower than the rasterizer, and
under the JIT it never is. llvmpipe is also expensive under emulation (323 ms a compositor frame on 1 vCPU, 71 ms on 4,
~12× native, after the JIT's NEON work: `bench/boot/REPORT.md` "M8: llvmpipe"):

| sway with foot, 4 vCPUs | llvmpipe (sway's default on 2D) | `WLR_RENDERER=pixman` |
|---|---|---|
| per-core load, htop running | ~54% each | 4–8% |
| frames a second, `date` in a loop | 9 | 46–55 |
| the host's copy against the backing after a flip | differs at every flip | never |

So on a 2D machine a wlroots compositor should run with `WLR_RENDERER=pixman` (on a 3D one with `gles2`: virgl).
wlroots refuses a software EGL device unless `WLR_RENDERER_ALLOW_SOFTWARE` is set, yet Arch's sway took llvmpipe
without it (not looked into). A display mode that samples the scanout's memory at its refresh and holds a flipped
buffer until it stops changing would hide the race for unmodified guests: not built (backlog).

### Numbers

`bench/gpu/REPORT.md` "G1 exit" and "A 2D machine on WebGL2": the first pixel 7.5 s after the page's load (the
firmware) instead of 18.7 s (the kernel's console), and `virtio_gpu` costs the boot nothing measurable; a transfer
~0.7 ms a megapixel on the 2D context, a flush with its draw 1.4 and 2.6 ms for a full 1080p and 1440p frame; host
memory 4 bytes a pixel per resource, capped at 64 MiB each and 256 MiB together; a key's glyph ~13 ms later on the
screen than on the simple framebuffer (backlog).

## The guest's 3D: Mesa's virgl

- **The guest driver is Mesa's virgl** (`virtio_gpu_dri.so`), in Debian's and Arch's Mesa; **Alpine's Mesa has none**
  on any architecture (its APKBUILD leaves it out: EGL says "virtio_gpu: driver missing" and falls back to llvmpipe),
  so `images/build.sh alpine-virgl` builds Mesa from source for the benchmarks (images.md). Linux 6.18 and 7.2 take the
  device as QEMU's (`features: +virgl +edid`), read both capsets at probe and **keep them for the session** (the caps
  a guest saw at boot are its Mesa's until it reboots), and make a context per DRM file (Alpine's initramfs's
  `nlplug-findfs` opens the render node at boot and never closes it). Mesa 26 reports `virgl (webpc)` with **OpenGL
  ES 3.0** (GLSL ES 3.00) **and desktop GL 2.1** (compat, GLSL 1.20; no core profile). That covers wlroots, KWin and
  GTK4's GLES paths, Firefox's WebRender and the browsers' ANGLE.
- **Texture data moves through staging buffers**: a `glTexSubImage2D` is a copy into a guest-backed
  `VIRGL_BIND_STAGING` buffer and a `COPY_TRANSFER3D` in the stream, a `glReadPixels` the same in reverse. Vertex and
  other buffer data goes as `TRANSFER3D` in the stream (the guest writes the buffer's own pages and the stream names
  the range). Every submit starts with the queued `TRANSFER3D`s and an `END_TRANSFERS` padded to 1,009 dwords (4 KB of
  each submit is padding). So glcomp and sway send no virtio `TRANSFER_TO_HOST_3D`/`FROM_HOST_3D` at all, and the
  renderer resolves a backing per command, not per transfer.
- **sway on GLES**: 2 submits a frame; its buffers are 3D resources flipped with `SET_SCANOUT` and `RESOURCE_FLUSH`;
  its cursor is drawn with GL into a 3D resource (devices.md "A 3D cursor"); dumb buffers (fbcon, a console's cursor,
  pixman) stay 2D. A scrolling foot uploads its whole window every frame (3.7 MB at 1376×762).
- **Firefox** (about:support): WebRender, accelerated, on "virgl (webpc)", GLES 3.0 for WebGL 1 and 2; WebGL reaches
  WebRender through DMABUF (no read-backs); accelerated canvas 2D; only the parent process maps Mesa. Its gfxInfo
  blocks its native compositor (forcing it on presents no video frame) and DMABUF export; VA-API decoding needs no pref
  (plans/video.md). One of its shaders fails to compile (`GL_EXT_shader_texture_lod`, which Mesa 26 has for no GLES driver): not ours. Scrolling
  Wikipedia or MDN it makes 10–25 3D resources a second, mostly small vertex buffers living ~3 s (Mesa makes a new
  resource whenever `glBufferData` changes a buffer's size or rewrites a busy one; its winsys reuses a released buffer
  for 1 s, only if idle and between the size asked and twice it): the guest's behavior, and not a cost (the whole 3D
  driver stack in the guest's kernel is 1–1.5% of the vCPUs' samples).
- **GTK4** tries Vulkan first (Mesa's virtio ICD, without Venus) and takes GSK's GL renderer on GLES 3.0. **Its graphics
  offload kills a GtkGLArea**: GTK hands the compositor the GL area's texture as a dmabuf, and Mesa's virgl backs a
  texture that isn't `PIPE_BIND_SHARED` with a 1-byte BO when the host copies transfers both ways
  (`COPY_TRANSFER_BOTH_DIRECTIONS`), so the dmabuf is smaller than stride × height and sway disconnects the client
  ("invalid buffer stride or height for plane 0"). A guest-side bug (QEMU with virgl has it too); `GDK_DISABLE=offload`
  avoids it (backlog).
- **What the guest's side costs:** Mesa's frontend is cheap and its shader compiles take milliseconds (glcomp's two,
  GLSL → NIR → TGSI, well under 10 ms). Sway's frame on virgl costs it 6.6 ms of CPU against pixman's 4.2 and
  llvmpipe's 81 (G2's null renderer, "Measurements"). Over pixman the extra is system time (~2.2 ms a frame: the
  kernel's execbuffer, fence and atomic-commit path under emulation), and profiled with the fine PC sampler it is
  spread over the kernel's generic paths (syscalls, scheduling, IRQs; Arch's kernel has preemption debugging on),
  with no virtio-gpu or DRM function in the top 60: not a cost worth chasing. What these applications wait on is the
  emulator's speed (Firefox's start: its main thread's guest CPU).

## The caps

- **The floor is `virglCaps`** (`web/virgl.ts`): virglrenderer `c8e3fc3b`'s own caps on a GLES 3.0 host
  (`virgl_test_server --use-gles` on llvmpipe with `MESA_GLES_VERSION_OVERRIDE=3.0`): GLSL level 130, `HOST_IS_GLES`,
  VIRGL v1 (308 bytes) and VIRGL2 (1408 bytes), **minus what WebGL2 can't back** (independent blending, conditional
  rendering, `start_instance`, timer queries, depth clamp, `textureQueryLod`, sample shading, cull distance, fbfetch,
  sRGB write control, ASTC, half-z clip, dual-source blending, advanced blend equations) and at WebGL2's minimum limits.
- **A page machine's caps follow its browser** (`capsFromGl`, `web/virgl-caps.ts`; never more than the renderer backs
  there): the context's limits; the format masks from the format table, a format only with its extension
  (`R16_UNORM` with `EXT_texture_norm16`, float render targets with `EXT_color_buffer_float`, each compressed family
  with its own); constant buffer 0 the uniform vectors less the 16 the generated shaders keep; up to 8 color
  attachments; the read-back formats the renderer can read here; **`texture_multisample` where `MAX_SAMPLES` is above
  1**, with the color and depth formats WebGL2 multisamples. Without that bit Mesa makes no multisampled renderbuffer at
  all, though GLES 3.0 requires 4 samples (vrend sets it only on GLES 3.1, so vtest on a GLES 3.0 host fails dEQP's
  MSAA cases). The video decoders are added by `withVideo` (plans/video.md).
- **No lower-left origin** (no `fragment_coord_conventions`, as vrend on GLES): Mesa lowers `gl_FragCoord` to
  upper-left itself, so the translator ignores the TGSI's `FS_COORD_ORIGIN` (honouring it flipped y twice).
- **`capsBacked`**: a snapshot restored in a browser that can't back the caps its guest was given keeps them for the
  guest and turns 3D off (new contexts refused, the saved 3D state not loaded) rather than refusing the machine.
- virglrenderer's own GLSL on such a host leans on `GL_EXT_clip_cull_distance` (every vertex shader) and
  `GL_EXT_blend_func_extended` (most fragment shaders), extensions at best on WebGL2: ours uses neither.

## The GPU worker

- **Calls are ordered and answer nothing.** The device worker posts them over the port (submits transfer their
  words); the GPU worker runs each through `runCall`. `fence`, `read` (a resource's bytes, the 3D cursor) and `save`
  answer once everything before them has run.
- **The screen draws once per animation frame** (`Screen.present`), however many `scanout` and `damage` calls a guest
  frame brought. A worker's canvas commits a frame at the end of every task that draws, and Chromium holds those
  commits to the display's rate with the fences behind them: drawing at each call (three a sway frame) capped sway at
  39 frames a second instead of 55. The drawing buffer isn't preserved, so every present draws the whole scanout.
- **Stats** (`?displaystats`, `render-stats` once a second): submits, draws, commands, busy and submit time, presents,
  uploads and read-backs, fences and their latency, compile time, video's counters.

### Fences

A command with the fence flag has its reply held by the device until the host's fence resolves (everything before it
has run: uploads read, read-backs written), with every reply behind it in order (devices.md). In the GPU worker a
fence is also held **until the occlusion queries ended before it have their results** (`FenceGate`): GL's results are
ready at a fence (a guest's `glFinish` sees them), WebGL's only after the task that ended the query, so the worker
polls them every 4 ms while any are pending (`pollQueries`). A fence waits only behind a pending query, so ordinary
applications don't pay.

**A fence that never resolves stops the guest's 3D for good:** the guest's control queue fills (16 entries on the
page), every 3D client then sleeps uninterruptibly in `virtio_gpu_queue_ctrl_sgs` (hung-task reports name them), the
vCPUs idle and nothing can be killed, not even for a shutdown. Two causes have been found and closed (both queries,
below), and two console lines say where the next one stops: the device worker's `virgl: fence <n> unanswered for <s> s
(the guest's 3D waits behind it)` after 5 s (`STUCK_MS`), and `answered after` when it is; the GPU worker's `virgl:
fence <n> held <s> s for <k> occlusion queries' results`.

### The call queue

With video, a call waits while it could see a picture still being decoded (`CallQueue`, `web/virgl-host.ts`): Mesa's
`end_frame` makes no fence and virglrenderer decodes synchronously, while WebCodecs decodes asynchronously and a
software decoder may hold a picture until later ones come (plans/video.md §5, §7). What waits: a call of a context
that has a pending picture's plane attached (unless the submit only decodes, `decodeOnly`, so the decoder gets the
later pictures it may be waiting for), a call naming a pending plane, and whatever an earlier waiting call must
precede: the same context or resource; fences, reads, saves, the screen and anything that ends a resource's life wait
for every earlier waiting call; and **another context's call that could see what a waiting one draws** (a submit of a
context sharing an attached resource with it, a transfer of one of its resources). The rest runs ahead. Past
`nudgeMs` (30 ms) with nothing out, frames held for the next one are sent (AV1's); past 200 ms the decoders are
drained; past 1 s the pending pictures are given up (the guest sees the old planes rather than hanging). A picture
pending for 3 s is given up whatever else comes out (`giveUpOld`): one a decoder never outputs while later ones do
would otherwise hold every fence behind it for as long as decoding went on (the idle give-up never comes).

**Why the cross-context rule:** the guest has no sync between virtio-gpu contexts. A compositor samples a client's
buffer right after the client's draws into it were sent, trusting the host to run every context's commands in the
order they came (virglrenderer does). When the queue let other contexts run ahead of a held one, sway composited
Chromium's window before Chromium's held draws into it had run, and Chromium's partial redraws turned that into
regions of the window from different frames, flickering between later and earlier ones (the user's NVIDIA desktop,
YouTube in the guest's Chromium; Firefox waits on its fences before handing sway a frame, so it never showed it).
`bench/gpu/chromium-flicker.ts` (a frame counter read through Chromium's screencast) counted 20–22 frames stepping back
in 30 s with the decoder slowed to ~50 ms a picture under the old rule, 0–1 under this one; the page's frame rate
didn't move (JSON in `bench/gpu/results/2026-10-22-chromium-flicker/`). A single one-frame step back now and then is
still seen (backlog).

## The renderer

`web/virgl-renderer.ts` decodes the stream as virglrenderer's `vrend_decode.c` does and keeps vrend's model:
contexts with sub-contexts that own the objects (shaders, blend, rasterizer and depth-stencil-alpha states, vertex
elements, sampler views and states, surfaces, queries, stream-output targets), resources attached to the contexts
that use them (a resource the guest unrefs lives until the last context lets go). **Every guest context draws on the
one WebGL2 context** (WebGL contexts share no objects, where virglrenderer gives each guest context a GL context in one
share group), so the GL state is set from the sub-context at every draw and nothing is assumed bound between draws.
Programs come from the translator, made at the first draw that needs a (shader pair, draw-state key) and kept until
either shader object is destroyed (`forgetShader`; a new object of the same text has a new serial, so before this the
cache only grew: every Qt Quick or Firefox process of a desktop session left its programs behind). A sampler the
program has with no view or texture gets nothing on any target of its unit and no sampler object, and a uniform block
with no buffer (or one too short) nothing at its binding: another context's would be read.
Protocol meanings are vrend's where they differ from Gallium's: query types are virgl's numbers (`VIRGL_QUERY_*`), a
transfer's stride of 0 is its level's own pitch, a draw's indices start at the index buffer's offset alone (Mesa folds
the draw's start into it), and Mesa never sets stream output's append mask (a set of targets seen before continues).

### Resources and formats

- **Buffers** keep a CPU copy (`shadow`) beside the GL buffer: WebGL2 forbids a buffer that is both an element array
  and anything else, and Mesa's upload buffer is both, so the element buffer is made from the copy when an indexed draw
  needs it. A zero-stride vertex buffer (a constant attribute) is read from the copy, and base-vertex draws rebase
  their indices there (no base vertex in WebGL2). Staging buffers are only the guest's pages.
- **Textures** by target (1D and rectangles as 2D, 1D arrays as 2D arrays, cubes, 3D, 2D arrays); multisampled and
  stencil-only resources are renderbuffers. A texture of a format WebGL can't render to (RGB9_E5, the SNORMs) keeps
  its uploaded texels on the CPU for copies from it; a compressed one its blocks (for snapshots).
- **No BGRA and no texture swizzle in WebGL2**: a format is stored as its bytes are (`B8G8R8X8` is an RGBA8 texture
  holding B, G, R, X) and swizzled in the generated shaders, on sampling (the format's swizzle composed with the
  sampler view's) and on writing (the render target's stored order, the clear and blend colors and the color mask go
  through it). Uploads and read-backs are then the guest's bytes as they are (no CPU pass), and the screen draws a
  scanout through its format's swizzle.
- **Alpha of formats without it:** an X format (or RGB565, R8, RG8) used as a render target gets the fragment's alpha
  in its unused component, since GL blends with the source alpha as written (writing 1 there drew Firefox's
  translucent menus with black borders); sampling an X format reads 1, and its destination alpha is 1 through
  substituted blend factors.
- **Depth:** Gallium's Z24_UNORM_S8_UINT and Z24X8_UNORM keep depth in a word's low 24 bits where GL's
  `UNSIGNED_INT_24_8` keeps it in the high 24, so their uploads are rotated. WebGL2 takes no data for
  `FLOAT_32_UNSIGNED_INT_24_8_REV`, so a Z32_FLOAT_S8X24_UINT upload is drawn (`drawZs`): the depths as an R32F texture
  written through `gl_FragDepth`, the stencil a bit a pass. Mesa uploads a depth texture's level through another
  texture and `RESOURCE_COPY_REGION`, so a copy binds a depth source at its depth attachment point (bound as a color
  attachment, the copy failed and the texture stayed empty). The drawn upload restores
  `UNPACK_ALIGNMENT` to 1 (left at 4, it skewed every later upload of rows not a multiple of 4 bytes).
- **Uploads** read the guest's pages in place where they are contiguous (`COPY_TRANSFER3D` from a staging buffer,
  `TRANSFER3D`, the virtio transfer, `RESOURCE_INLINE_WRITE`); read-backs (`readPixels`, or a buffer's copy) write
  them. RGB10_A2UI reads back as four integers packed again. Depth formats aren't read back (not advertised).
- **Coordinates:** textures store rows as the guest does (row 0 first): Gallium's upper-left origin and GL's own
  window coordinates, so nothing is flipped except the front face (`front_ccw` inverts, as vrend does), a viewport
  with a negative y scale (the shader flips `gl_Position.y`, the viewport is made positive) and the screen.
- **Blits** go through GL's framebuffer blit for the same stored layout (and between integer formats of one
  signedness, which can't be sampled as floats), a draw through both formats' swizzles otherwise; a drawn blit has
  only its destination attached (a texture still attached from the last draw and sampled is a feedback loop WebGL
  refuses).

### Where WebGL2 refuses what GLES allows

Most of the bugs dEQP found were WebGL2 silently refusing a draw that GLES allows. Each is worked around at the draw:
- front and back stencil states whose reference or masks differ: the draw goes once per face, each with its state on
  both faces and the other face culled;
- an attribute whose stride or offset isn't a multiple of its type's size, or whose stride is over 255: repacked from
  the buffer's copy into a scratch buffer of its slot;
- WebGL2 always restarts primitives at the index type's largest value: indices that hold it with restart off (GLES 2)
  are widened to the next type, and another restart index is mapped onto the largest (a scratch element buffer);
- a blend pairing constant color with constant alpha: the source RGB factor is applied in the fragment shader and
  blended with ONE (`ProgramKey.blendSrc`);
- an inverted depth range (near above far): the range goes the right way round and the vertex shader negates z
  (`u_adjz`);
- WebGL2 has one color mask: components the first target doesn't store stay on (another target may store them).

### Multisampling

Multisampled resources are renderbuffers. A multisampled source is resolved into a texture of its own format before a
blit that converts layouts (GL's resolve copies bytes: RGBA8 onto a B8G8R8A8 window swapped red and blue) or whose
rectangles differ (Mesa flips onto a window; GLES resolves only onto the same rectangle). The sample mask Mesa makes
from `glSampleCoverage` maps back onto WebGL's `sampleCoverage`. The caps bit also gives desktop GL 2.1
`ARB_texture_multisample`, and WebGL2 samples no multisampled texture, so **a multisampled texture sampled is resolved
at the draw** and fetched as a 2D texture: one value a pixel, the samples' average, whatever sample index the shader
asks for (close, not exact). Firefox's WebGL `antialias` gets real multisampling from it.

### Stream output

Transform feedback is advertised (GLES 3.0 needs it; 4 buffers). Every captured output is written interleaved, as
bits, into one scratch buffer and scattered to its target in the buffer's CPU copy, then uploaded (`SoPlan`): GLES
3.0's two layouts can't express Gallium's (several outputs a buffer, several buffers, gaps). **A shader with stream
outputs captures all of them whether targets are bound or not** (`soOutputs`), so it draws through one program, as in
GL: two programs, one per state, computed positions differently on Metal and moved lines by a pixel. GLES 3.0 captures
only unindexed point, line and triangle lists and refuses a draw that would overflow a buffer, where Gallium stops at
the end: the draw is cut to the primitives that fit. Each target remembers how far it is written (a resume continues
there). PRIMITIVES_GENERATED and PRIMITIVES_EMITTED are counted by the draws. A capture-only draw gets a 1×1
framebuffer with the rasterizer off.

### Queries

- **Occlusion queries** (counters, predicates and virgl's conservative predicate, type 11) are WebGL2's "any samples
  passed": a counter reads 0 or 1, written to the query's buffer when its result comes.
- **They are counted in spans.** WebGL has one occlusion query active at a time for the whole context, and every guest
  context and sub-context draws on it. A WebGL query (`ANY_SAMPLES_PASSED`) is begun at the first draw of a
  sub-context while it has occlusion queries active, shared by those queries, and ended when anything else may draw
  (another sub-context or context, a blit or a copy, an upload drawn, the end of a submit: the screen draws on the same
  context) or when the set of active queries changes (`countQueries`, `pauseQueries`). A query's result is "any span
  passed"; one with no draw while active is done at once (0). Spans with their results are folded in at the
  query's sub-context's next draw, and a query that already passed takes no more spans, so a query left active while
  other contexts draw keeps a few WebGL queries, not one a frame; a span no query uses any more is deleted (or kept
  for the next, read). **Why:** passing the guest's begin and end straight
  to WebGL, a query left active across a submit while another context began its own made WebGL refuse the second begin
  (INVALID_OPERATION), the second's end ended the first, and the second query never got a result: every later fence of
  every context was held for good (a KDE desktop's 3D stopped half an hour into a session, 2026-10-24; which program
  had queries open isn't known: KWin, Qt Quick and WebRender use none by default, a page's WebGL in Firefox can).
- **No query can hold fences for good:** a span WebGL answers `null` for (a lost context, a query it refused) counts
  as passed, said once on the console; a query destroyed with its result pending stops counting (a deleted WebGL
  query never has one; once it held every later fence and hung dEQP's `lifetime` cases); a query begun again before
  its result came drops that result.
- PRIMITIVES_GENERATED and PRIMITIVES_EMITTED are counted by the draws (stream output, above). Timer queries aren't
  advertised.

### Feedback loops

WebGL refuses a draw that samples a texture attached to the framebuffer it draws to ("Feedback loop formed between
Framebuffer and active Texture" on the console; the draw is skipped and a picture misses something). GL draws it:
sampling other levels or layers than the one drawn into is well defined, the same texels undefined (drivers mostly
give the texels as they were before the draw). Measured on Chromium's WebGL2 (ANGLE's validation, the same on any
GPU): it refuses when the attached level is among the levels sampled (the view's range, or its base level alone with a
minification filter that has no mip), whatever the layer of an array or 3D texture, and a depth texture sampled while
attached even with depth writes and the test off; a texture bound but not sampled by the program is no loop. So
**such a texture is sampled from a copy** (`feedbackCopies`, `copyLevels`): before the draw, the levels sampled with
every layer are blitted into a texture of the same target, format and size kept beside the resource (`Res.feedback`,
made again at each such draw), and the draw samples it: the texels as they were before the draw. The copy is made at
every draw that needs it (`stats.feedbackCopies` counts them); no write tracking skips a copy whose source hasn't
changed. The report that showed it (2026-10-24, the KDE desktop above) had them on instanced draws, most likely
Firefox's WebRender; which of its passes isn't known. `tests/virgl-browser.test.ts`: a level drawn while it is
sampled through a swizzle (its old texels come out), an array's layer drawn while another is sampled.

## The translator

`web/virgl-tgsi.ts` parses the TGSI text Mesa sends (what `tgsi_dump` writes) and generates GLSL ES 3.00 for a vertex
and fragment shader **pair** (their varyings must agree in name and interpolation, which only the pair knows),
following vrend's conventions:
- registers are float vec4s holding bits; constant buffer 0 is a `uvec4` uniform array, the others uniform blocks;
  immediates are literals, as bits where a float literal would be a denormal or not finite;
- the program key carries what a shader can't know: the attributes' integer-ness, each sampler's type and swizzle,
  each color buffer's type and stored order, alpha test, flat shading, two-sided color, points, the blend substitution;
- flat varyings travel as integers (`vf_…`): an integer's bits in a float varying are a denormal or a NaN, which GLSL
  ES lets the interface flush or canonicalize (SwiftShader keeps them; a GPU needn't);
- **what a real GPU's compiler may take liberties with is said explicitly** (found on ANGLE over Metal): a position
  computed by precise instructions (`_PRECISE`, Mesa's mark of GLSL's `invariant`, since GLES 3.0 has no `precise`)
  makes the vertex shader say `invariant gl_Position`; `FSNE`/`FSEQ` of an operand with itself (Mesa's `x != x`) is
  `isnan`/`!isnan`, since Metal's fast math folds `x != x` to false; an integer immediate whose bits aren't a normal
  float is `uintBitsToFloat(K ^ u_zero)` (`u_zero` a uniform never set), since ANGLE folds a constant expression and
  its Metal backend writes a NaN as the canonical one (-1 came back as 0x7fc00000);
- what GLES 3.0 lacks is refused with a reason, and none of it is advertised: images, buffers and atomics, `IMUL_HI`,
  cube arrays and buffer textures, 64-bit types, indirect inputs, outputs and constant-buffer selection, geometry,
  tessellation and compute stages.

## Video

On with 3D (`?gpu=novideo` off); the design and its measurements are [plans/video.md](plans/video.md).
- **The caps' `video_caps`** list the decoders the browser's `VideoDecoder` takes (H.264 Constrained Baseline, Main
  and High, VP9 profile 0, AV1 Main 8-bit; `probeVideo` in `web/virgl-video.ts`, in the GPU worker before it answers,
  which also notes which are in hardware), so the guest's Mesa offers VA-API decoding. The guest needs our `webpc-va`
  (NV12 surfaces only, plans/video.md §1; AV1 film grain, §10), in the desktop image. `capsBacked` wants every decoder
  the guest was told of.
- **The renderer keeps each context's codecs and video buffers** (CCMD 53–61: a buffer is its planes' resources, R8
  and RG8) and reads each picture's parameters and data from the guest's staging buffers. `VideoContext` makes a chunk
  of each END_FRAME (H.264 rebuilt as Annex B with our SPS and PPS by `H264Stream`, `web/video-h264.ts`; VP9 as sent)
  for one `VideoDecoder` per codec (`optimizeForLatency`; recreated at the next key picture after an error), and writes
  each frame's Y and interleaved U/V into the buffer's planes (`VirglRenderer.writePicture`), each plane filled to its
  texture's size with the picture's last column and row repeated (`padPlane`: the planes are the coded size, whole
  blocks, 864×480 for an 854×480 video, and Chromium and mpv show its width: unwritten, the padding was a green edge).
- **Waiting for pictures** is the call queue's (above). The SPS's reorder depth is 0 for a hardware decoder; in
  software (which outputs in display order) the larger of the stream's reference count and the depth learned from the
  POCs (`H264Stream` `'stream'`): FFmpeg drops a picture that comes after one it has shown, and a pending picture of a
  lesser POC than one that comes out is given up at once. If calls wait 200 ms and nothing comes out, a software H.264
  decoder is drained without loss: flushed, and a new one decodes the IDR period again from its start (kept up to 600
  pictures or 32 MiB; else the next IDR); a picture still out after 1 s is given up (logged; the guest sees the old
  planes). VP9 frames with `show_frame` 0 give no output and aren't waited for.
- **Where a picture goes:** into the planes its buffer had at END_FRAME as long as they exist, attached to the decoding
  context or not (virglrenderer writes at END_FRAME; Firefox's decoder process lets go of its surfaces at a seek while
  the compositor's context still shows them), never over a later picture in the same planes; a destroyed buffer's
  pending picture is still written, and a destroyed codec's decoder is flushed (what it holds written) before it
  closes. A decoder error (WebCodecs reports a damaged chunk; none conceals) closes the decoder and drops the codec's
  pending pictures; a new decoder starts at the next key picture. A seek sends a key picture to the same codec; a size
  change makes a new codec (plans/video.md §9).
- **AV1** (`web/video-av1.ts` `Av1Stream`, plans/video.md §10): a sequence header and each frame header written from
  the desc, a tile group of the tiles; the decoder's reference slots are this side's (Mesa sends no
  refresh_frame_flags): a frame goes to a slot holding nothing the guest's reference map has, or waits for the next
  frame's map (`nudge`d out after 30 ms of calls waiting: `CallQueue`'s `nudgeMs`, and before a destroyed codec's
  flush), and one sent stored nowhere is decoded again if a later frame references it; a hidden frame the guest shows
  later is written shown, and frames with no output go in the next temporal unit. Film grain reaches the shown surface
  through webpc-va 2 (Mesa sends the film grain target too late).
- `renderer.videoStats` (decoded, dropped, errors; each picture's END_FRAME to written and its write, in ms) and the
  queue's `ahead` and `maxWaitMs` go out in render-stats (`bench/gpu/guest-session.ts` sums them over a phase). Mesa's
  wire numbers its profiles by its own `enum pipe_video_profile` (26.2's in `PROFILE`), which isn't stable across
  releases. A capture includes DECODE_BITSTREAM's buffers. A video decoding is the one state a snapshot refuses (below).

## Snapshots with 3D in use

**State as data, contents read back**, not the commands since each context was made (that grows without bound:
Firefox makes 10–25 resources a second, where the state is bounded by what the guest holds).
- **Objects** are decoded data in the renderer already. `VirglRenderer.save` writes each sub-context's objects as a
  list and its bound state as places in it (a value bound but no longer named by a handle is kept unnamed); `load`
  makes the values again, shaders re-parsed with new serials (programs come back at the draws that need them), GL
  objects made on demand as always. Queries ended are settled first (the GPU worker polls them before it answers the
  save), their results already in the guest's memory; an occlusion query begun and not ended is begun again (what it
  counted before the snapshot is lost).
- **Contents**, a level at a time, every layer: a buffer's CPU copy; a color texture through the read-back path (two
  formats the guest isn't offered read-back of through `snapshotReader`: A4B4G4R4 as RGBA8, R11G11B10_FLOAT as
  floats); a format WebGL can't render to, its kept texels; a compressed one, its kept blocks; a multisampled color
  renderbuffer, resolved (a load draws it into every sample). Depth and stencil can't be read with `readPixels`: each
  layer is blitted to a 2D texture of its format (resolving samples), its depths drawn as float bits into R32UI, its
  stencil a bit a pass; a load draws them back with `drawZs`. A 16-bit depth is written a quarter step up
  (SwiftShader truncates the float). Lost, and logged (`SavedResource.lost`): multisampled integer color.
- **Carried:** the GPU worker answers `save` with the state, transferring the contents' buffers; the device adds its
  3D tables (devices.md "Snapshots"); the snapshot file carries the Uint8Arrays as BLOB frames (format version 2,
  plans/snapshots.md "The file"); a restore hands the state to the new GPU worker (`load`) before it shows the scanout.
- **Refused** only while a context has video codecs or buffers (WebCodecs keeps its reference pictures, so a decode
  can't go on from a snapshot): "close the video player first".
- **The size before saving:** every resource's bytes follow from its description (`snapshotBytes`), and from 64 MiB
  the page says how much the 3D state adds and asks first (frontend.md "Snapshots").
- **What it costs** (the desktop guest with sway, Firefox on 400 WebGL 2 cubes and gtk4-demo's gears, 4 vCPUs,
  2.5 GiB; `bench/gpu/snapshot-3d.ts`, `bench/gpu/results/2026-10-19-snapshot-3d*.json`): 96 resources, 8 contexts,
  119 MB of 3D state stored as 6 MB (glyph and texture atlases, mostly empty, compress ~20 to 1), read back in 0.23 s
  on SwiftShader and 0.2 s on the Mac's GPU (the copies and the transfer to the device worker, not the drawing), in a
  pause of 8.2 s and 5.2 s: the rest is guest RAM. The load brings the session back (the clients draw on, new GL
  clients start, no resource lost). No page test: the desktop guest's session takes ~10 minutes to set up and an
  800 MB file; the renderer's save and load are tested on traces, a snapshot's restore on Debian in
  `scripts/ci-debian.sh` (3D by default).

## What isn't backed

The guest gets GLES 3.0 and GL 2.1; none of this is advertised, or it is refused with a reason: conditional rendering,
user clip planes, cull distances, indirect draws, depth read-backs, indexed or strip stream output, timer
queries, images, buffer textures, `IMUL_HI`, cube arrays, multisampled textures sampled exactly (the average above).
Beyond GLES 3.0 (compute, GLES 3.1) is the WebGPU backend the plan keeps open; desktop GL past 3.1 needs geometry and
tessellation, which neither WebGL2 nor WebGPU has.

## Applications on 3D

- **3D is what makes GL applications usable.** On 2D the guest's llvmpipe takes all four vCPUs for sway alone: Firefox
  scrolls a JS page at 23 frames a second and draws WebGL 2 cubes at 2; GTK's fishbowl and shadertoy at 1.
- **On a real GPU** (the Mac host's M4, ANGLE on Metal) sway on GLES keeps 60 frames a second with the same guest CPU a
  frame as the null renderer: 3D costs it nothing measurable. Firefox scrolls real sites (Wikipedia, MDN, GitHub, BBC
  News, Hacker News) at 49–60 frames a second and draws WebGL 2 cubes at 60; its start (18–41 s) and page loads
  (5–17 s) are the guest's CPU. GTK4 draws every gtk4-demo demo right with GSK's GL renderer.
- **On SwiftShader** (the dev VM, CI) everything is slower for a reason of its own (below, "Findings"): sway 55 frames a
  second, Firefox's scrolls 4–44, WebGL 2 at ~34, GTK's GL areas ~15–31.
- **Chromium in the guest** (ANGLE on virgl) runs, YouTube included, since the call queue's cross-context rule.
- **Not measured:** KWin, Mutter, Xorg sessions (a KDE desktop has been run by a user: the query fix above came from it).

## Measurements

Kept because later work leans on them; the JSON is committed under `bench/gpu/results/` and `bench/boot/results/m8-g2/`.

**The guest's cost, on the null renderer** (Chromium 153, the dev VM; `gl_virgl_jit*` against
`gl_virgl_llvmpipe_jit*` on one Mesa build, and `bench/gpu/sway-load.ts`):

| | virgl, null renderer | llvmpipe |
|---|---|---|
| glcomp (1376×762), 1 vCPU, ms a frame / guest steps a frame | 1.68 / 0.70M | 314.7 / 476M |
| glcomp, 4 vCPUs, ms a frame | 1.30 | 69.3 |
| glcomp's warm-up (3 frames, two shaders compiled), ms | 10.0 | 4,472 |
| sway with foot scrolling, frames a second | 60 (the pacing's cap) | 27.9 |
| sway's CPU a frame, ms | 6.6 (1.7 user, 4.9 sys; pixman 4.2) | 81 |

Of glcomp's 0.7M steps on virgl about half is glcomp's own client work (its pixel loop and its copy into the staging
buffer), which a compositor doesn't do. Over sway's load with foot running `date` in a loop the machine takes ~25,700
TLB flushes and ~9,300 syscalls a second, mostly the loop's fork and exec: a load without them is the better probe of
the compositor.

**The renderer's cost** (sway and foot scrolling at 1376×762, 4 vCPUs; `bench/gpu/results/g3-sway/`): ~1 ms a frame of
the GPU worker's time on SwiftShader and 0.65 ms on the Mac, most of it uploading foot's window (200–220 MB/s). Shader
compiles: in every steady phase measured (Firefox's scrolls, WebGL, real pages; GTK's demos) the renderer compiles
nothing, and Firefox's start compiles 96 programs, ~0.2 s of a 32 s start: **no program cache across sessions or
`KHR_parallel_shader_compile` is needed**.

**Firefox's churn and the held replies** (`bench/gpu/results/firefox-churn/`): the device holds every reply behind a
fenced one (QEMU holds only the fenced reply). On the Mac's GPU a fence's round trip is 0.5–0.7 ms on average, the
unfenced replies held only behind a fenced one add 26–52 ms a second, and the guest's control queue is full for
0.2–1 ms a second; answering unfenced replies at once would win nothing on a real GPU, so it isn't done. The display's
stats count it (`fences.behindMs`, `fullMs`, `heldMax`).

## Findings

Worth not re-discovering:
- **On SwiftShader the GPU worker stalls ~33 ms after every present**: Chromium holds a worker's canvas commit until
  the GPU process has drawn the frame, which SwiftShader does on the CPU (25 stalls, 850 ms a second under Firefox's
  WebGL; none after a submit alone). Fences queue behind it (18 ms on the way in against 0.2 ms on the Mac), so
  anything that waits on fences several times a frame (Firefox's WebGL, GTK's GL areas) is capped there. Presenting
  through `transferToImageBitmap` moved the same wait into the transfer. Judge fence latency and GL frame rates on a
  real GPU (the Mac host, `bench/gpu/sway-mac.sh`), never on the dev VM.
- **A worker's canvas commits a frame at the end of every task that draws**, held to the display's rate: draw once, in
  an animation frame (the device worker, nested in the machine worker, has no `requestAnimationFrame` and draws on a
  timer: the backlog's 13 ms key-to-glyph suspect).
- **Most renderer bugs were WebGL refusing silently what GLES allows, or protocol meanings that are vrend's rather than
  Gallium's** (query numbers, stride 0, index offsets, the append mask): read `vrend_decode.c`/`vrend_renderer.c` and
  Mesa's encoder (`src/gallium/drivers/virgl/`) before assuming the Gallium meaning.
- **What a real GPU's compiler folds or relaxes, SwiftShader doesn't**: two programs where GL has one, a dropped
  invariance mark, NaN-pattern constants and `x != x` all passed on SwiftShader and failed on Metal. A difference that
  shows with the generated GLSL alone in a WebGL2 page is the browser's.
- **Apple's GPU keeps the magnifying filter up to a level of detail of 0.01–0.02** where GLES switches above 0
  (`bench/gpu/filter-probe.ts`, no emulator involved): mixed `nearest_linear`/`linear_nearest` filters differ by a few
  pixels near the switch. Metal's line rasterization and one invariant loop (`shaders.invariance.lowp.loop_2`) differ
  too. None of it is ours to fix.
- Headed and headless Chromium on the Mac give the same frame rates (no headless throttling).
- **Headless WebGPU in the dev VM** needs `--enable-unsafe-webgpu` and, to present from a worker's `OffscreenCanvas`,
  `--enable-features=Vulkan --use-angle=swiftshader --use-gl=angle`; WebGPU's `writeBuffer`/`writeTexture` and WebGL's
  `texSubImage2D` take `SharedArrayBuffer` views at the cost of plain ones (bench/gpu/REPORT.md).
- **QEMU's `virtio-gpu-gl` can't run in the dev VM** (no DRM render node; the kernel has neither `vgem` nor `vkms`):
  vtest (`virgl_test_server`) is the protocol's oracle and our own device's log the guest kernel's.
- Through virglrenderer on llvmpipe, glcomp's pixel hash equals llvmpipe's own, so reference images can come from the
  oracle natively. es2gears doesn't start under Xvfb (EGLUT wants DRI3); glmark2-es2 does.
- The guests' Arch `pacman -Syu` rebuilds the initramfs with `autodetect`: keep `MODULES=(virtio_mmio virtio_blk ext4
  vfat)` (images/arch/build.sh sets it in `/etc/mkinitcpio.conf.d/webpc.conf`).
- Firefox: a fresh profile's first minute is busy (WebExtensions, settings sync failing offline): warm up 30 s before
  measuring. The null renderer can't run Firefox's WebGL page (it never gets ready).
- `Gpu.save()` is also the tests' state read (`vm.deviceState`): it never throws; it marks `unsaveable` and
  `vm.snapshot` refuses.
- Playwright's `keyboard.insertText` sends no Enter for a `\n` (paste lines, press Enter); the tty's line is 4096
  bytes. The Mac host's shell is zsh (`status` is read-only) with no `timeout` (`perl -e 'alarm shift; exec @ARGV' N`),
  and the dev VM runs on the same Mac: never measure on both at once.

## Testing

The test layers are in [testing.md](testing.md): the 2D device and the gpu guest (byte-exact, natively, in Node and in
Chromium), virgl's device side, the renderer in Node on a recording WebGL2 and in Chromium on traces, 3D snapshots,
the page's Debian tests on 3D (`WEBPC_PAGE_QUERY=gpu=2d scripts/ci-debian.sh` for the 2D path).

**dEQP is the correctness gate** (VK-GL-CTS, Apache-2.0: built and run as a guest workload, nothing copied;
`images/deqp/build.sh`, images.md). `bench/gpu/deqp-run.ts` runs a case list on the page under the JIT: dEQP's guest
(Arch with Mesa) on a 3D machine, dEQP as its second disk, as root on EGL's surfaceless platform (no compositor).
Results on SwiftShader (`bench/gpu/results/g4-deqp/`):

| whole mustpass list | pass | fail | not supported |
|---|---|---|---|
| GLES2 (17,165) | 17,027 | 0 | 136 |
| GLES3 (44,768) | 44,398 | 0 | 358 |

Better than the oracle (`tools/virgl-oracle/deqp.sh`: the same binaries on Mesa's virpipe against vtest on llvmpipe's
GLES 3.0), which fails MSAA. The warnings left are timing (`flush_finish`) and highp `floor`'s precision on SwiftShader.
**`scripts/ci-deqp.sh`** runs the pass lists in `tests/deqp/`: the every-50th subsets (342 and 889 cases) plus GLES3's
`lifetime`, `occlusion_query` and `texstorage2d/3d.format` groups, which caught two regressions the subsets didn't
(a query destroyed while pending hung the guest; the drawn depth upload's `UNPACK_ALIGNMENT`).

**On the Mac's GPU** (ANGLE on Metal, Apple M4, through `bench/gpu/sway-mac.sh` with `SCRIPT=deqp-run.ts`;
`bench/gpu/results/g5-deqp-metal/`; dEQP runs ~2.4 times as fast as on the dev VM): GLES2 16,939 pass and 85 fail,
GLES3 44,276 pass and 129 fail, every failure the GPU's (the filter switch, one invariance loop; above). No cap we
advertise is beyond Metal: no "not supported" count moved. Other WebGL2 stacks are still to run (backlog "dEQP on more
platforms"). The pass lists stay SwiftShader's (CI's).

**The method that found the bugs:** a group with `CASES='dEQP-…group.*'` and `DETAIL=3`, then one case with
`VIRGL_GPU=virgl,debug` (the renderer's trace) or `CAPTURE=` (replayed on Chromium with every read-back compared by
`bench/gpu/virgl-pairs.ts`); compare with vrend (`target/virgl-oracle/src/src/vrend/`) and Mesa's encoder. For a
GPU's difference: the case's TGSI (log the shader text in `VirglRenderer.finishShader` behind the trace), its GLSL from
`generate()` in Node, and that GLSL alone in a WebGL2 page on the Mac with variants. A hang: the hung tasks' stacks in
the run's `serial.txt` (the harness keeps the serial log on a timeout, disables core dumps in the guest, and reports
the case dEQP stopped at, `stoppedAt`). A whole GLES3 list is ten slices (`STRIDE=10 OFFSET=$k LIMIT_S=1800` under
`timeout 2100`, ~17 min each on the dev VM, ~7 on the Mac); a validation run, so other work may run beside it.

## Tools

- **Captures and the trace:** `?gpu=…,capture` (`Gpu.onCapture`, `web/virgl-trace.ts`) records every 3D control
  command and the guest memory it reads; `web/virgl-replay.ts` runs one through the device into a host;
  `tools/virgl-capture.ts` captures glcomp on `alpine-virgl` in Node (`--llvmpipe` for the reference frame),
  `tools/virgl-trace.ts` summarizes one; the fixtures are `tests/virgl/` (glcomp, sway on Arch, dEQP cases, the TGSI
  corpus). `?gpu=virgl,debug` logs each distinct resource creation, surface, sampler view, draw, clear, blit, copy and
  upload once (with an alpha histogram for 4-byte formats), and a `life` line at each resource's unref (its age,
  uploads and bytes staged). The renderer's error log is capped per kind of error (5 each, 200 in all: 49 of one kind
  once used up a cap of 50 and hid the stream output's).
- **The oracle:** `tools/virgl-oracle/build.sh` builds virglrenderer `c8e3fc3b` in debug mode natively in the dev VM,
  with `capture.patch` (`VTEST_DUMP`: every submit, resource, transfer and capset to a file; `capture.sh` runs a
  client, `dump.ts` reads the file) and `VREND_DEBUG=shader` for the GLSL it makes; clients on
  `GALLIUM_DRIVER=virpipe`, `VIRGL_DEBUG=tgsi` prints the TGSI they send. glcomp builds natively
  (`clang -O2 images/alpine/gl/glcomp.c -lEGL -lGLESv2`).
- **Guest sessions** (`bench/gpu/guest-session.ts`; benchmarking.md "Guest sessions"): `sway-load.ts`,
  `firefox-load.ts` (synthetic pages and saved real sites, `bench/gpu/firefox-pages.sh`; `PHASES`, `GUEST_CMD`),
  `gtk4-load.ts`, `snapshot-3d.ts`, `chromium-flicker.ts`, `filter-probe.ts`; `sway-mac.sh` runs any of them on the Mac
  host's GPU (`SCRIPT=`; `HEADED=1` only when the user isn't using the Mac). `PROFILE=1` samples every vCPU's PC and
  symbolizes the guest kernel's in the guest (benchmarking.md "PC sampling").
