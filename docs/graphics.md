# Graphics

How a guest gets a display and hardware-accelerated 3D in the page **with its own unmodified drivers**: virtio-gpu for
the display (2D), and OpenGL ES through Mesa's **virgl** driver, rendered on the host by **our own virgl renderer on
WebGL2**. Done (milestone M8's graphics track, G0 to G5, 2026-10-01 to 2026-10-19, and fixes since); the decisions that
bind it are below ("Decisions"), the loose ends in [backlog.md](backlog.md) ("Platform and devices"). Vulkan is a
second path beside it, per machine: Venus's commands translated onto the browser's WebGPU by a renderer of ours in wasm
(VK0 to VK3, 2026-10-25 to 10-29: "Vulkan through Venus" below; the renderer's code in
[vk/README.md](../vk/README.md); the bar, the decisions and VK4 in [plans/graphics.md](plans/graphics.md)), whose
frames reach the screen through the virgl renderer. Where the parts are described in detail: the device in
[devices.md](devices.md) "virtio-gpu" and "virgl", the page's screen, the Graphics choice and the guest's cursor in
[frontend.md](frontend.md) "The screen", video decoding over virgl in [plans/video.md](plans/video.md), the tests in
[testing.md](testing.md), the benchmarks in [benchmarking.md](benchmarking.md) and `bench/gpu/REPORT.md`.

## Decisions

These bind the graphics work; changing one is the user's call (PLAN.md).

- **virtio-gpu is the display device**, 2D and 3D over the same device, with the guests' upstream drivers: no guest
  patches. `simple-framebuffer` stays for boot tests and guests without the driver.
- **No translation layer and no software rendering in the guest** (the user, 2026-10-09). The guest's CPU is the
  scarcest thing the machine has: llvmpipe takes 71 ms a compositor frame on 4 vCPUs even after the JIT's NEON work,
  and Zink (GL on Vulkan) would be another layer of Mesa under emulation. The guest runs a thin driver that
  serializes; the work happens on the host.
- **3D is OpenGL ES through Mesa's virgl driver, rendered by our own virgl renderer on WebGL2.** virglrenderer (MIT)
  is the reference (ported from with attribution where it helps, THIRD_PARTY.json); the guest gets what virglrenderer
  gives on a GLES 3.0 host, GLES 3.0 and desktop GL 2.1.
- **WebGL2 is the baseline.** A WebGPU backend for the same protocol (GLES 3.1: compute, storage buffers) is a backlog
  item, not built. A page without WebGL2 offers 2D only.
- **The caps follow the browser**: never more than the renderer backs there (a snapshot restored where its caps can't
  be backed runs with 3D off).
- **virgl's resources are guest-backed**: no `HOSTMEM` window, blob resources or coherent-memory tracking. (Vulkan
  through Venus needs all three, and a machine with Vulkan has them since VK1: [devices.md](devices.md) "Venus" and
  "The host-visible window", [vk/README.md](../vk/README.md), "Vulkan through Venus" below.)
- **3D is the page's default where WebGL2 is**, with the Machine menu's Graphics choice; the 2D path stays and stays
  tested (`?gpu=2d`, `WEBPC_PAGE_QUERY=gpu=2d scripts/ci-debian.sh`).
- **Snapshots while 3D is in use save the renderer's state as data** (objects decoded, contents read back), never a
  replay of the commands; refused only while a video decodes.
- **Tests:** 2D is byte-exact in deterministic mode (natively, in Node and in Chromium, with its own guest and kernel
  variant so no other step count moved); 3D runs in realtime mode only, tested at the protocol level in Node and on
  WebGL2 in Chromium; **dEQP's pass lists are the correctness gate** (`scripts/ci-deqp.sh`, for every change that
  touches 3D).
- **Guest pixels are CSS pixels by default**, scaled up crisply, with a HiDPI setting that sends device pixels and the
  physical size in the EDID. Live resize is a guest agent's job, starting from the stock agents
  ([plans/agent.md](plans/agent.md)).
- **Real-GPU numbers come from headless Chromium on the Mac host** (the bench pages and `bench/gpu/sway-mac.sh`);
  nothing else on that host, and the x86_64 desktop stays off limits.
- Chromium only, as everywhere in the project. Out of scope: multiple scanouts, ACPI.

**Why virgl and not Venus:** the first draft (2026-09-27) chose Venus on WebGPU for Vulkan and Zink over Venus for GL,
one protocol for both, and rejected virgl because it means translating TGSI and emulating desktop GL on a GLES-level
API. G1 and the JIT rounds showed that the guest's CPU decides everything (and Zink is a translation layer in the
guest), WebGL2 is far more widely available than WebGPU, and virglrenderer already runs on GLES hosts, so desktop GL on
GLES is a known, bounded problem, and the guest asks only for what the caps advertise. G2 confirmed it: a sway frame on
virgl costs the guest ~1/12 of llvmpipe's.

**Not taken: a GLES passthrough library in the guest** (our own `libEGL`/`libGLESv2` forwarding GLES calls, as the
Android emulator's do for gfxstream): the closest mapping onto WebGL2, GLSL ES untouched. The guests aren't ours to
modify (users bring unmodified images), it would have to integrate where Mesa already does (GBM and dma-bufs, EGL on
Wayland and X11, GLX for Xwayland, glvnd), and G2 showed Mesa's frontend is cheap: the guest's remaining cost is the
kernel's submit path, which a library would go through too. gfxstream's own GLES guest side targets Android, and Mesa's
gfxstream driver is Vulkan only.

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
  (the flush pacing and the queue size, for measurements), `novideo`, `swvideo`, `waitattached` (the call queue's old,
  coarser wait: a context waits while it has any pending picture's plane attached; A/B), `debug` (the renderer's trace) and
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
- **GTK4** tries Vulkan first (Mesa's virtio ICD, without Venus) and takes GSK's GL renderer on GLES 3.0. On a machine
  with Vulkan it stays on GL too: GTK takes Vulkan only where the device offers a dma-buf modifier other than LINEAR,
  and Venus's has LINEAR alone (VK3 L7.3; without YCbCr conversions, which the device has by default since then, GTK
  4.24 aborted instead). Forced (`GSK_RENDERER=vulkan`) GSK's Vulkan renderer draws right but misses GTK4's bar
  (bench/vulkan/REPORT.md "VK3 L7.3"; vk/README.md "The driver"). **Its graphics
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
- **The status bar's numbers** (`stats`, always, once a second from `ready` on; `FromGpuWorker` in web/gpu-worker.ts):
  the WebGL renderer and vendor (read once) and whether it is a CPU rasterizer, totals since the worker started of
  presents (`Screen.presented`), submits, commands, draws and errors, and video's: the codecs offered and which in
  hardware, the guest's codecs now (`VideoContext.streams`: profile, size, hardware or not, open, pictures written)
  and the decoded, dropped and error totals. Only what is counted anyway, read by the timer: nothing per frame or
  per call, no GL query. A 2D machine's presenter (web/gpu-present.ts `canvasPresenter`, in the device worker) sends
  its own over the display port: `screen-stats` once a second from the first scanout on (its draws so far, WebGL2 or
  a 2D context, the renderer). Neither is state a snapshot holds.

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
software decoder may hold a picture until later ones come (plans/video.md §5, §7, §12). A call waits only for pictures
decoded by calls before it in the guest's order (each pending picture carries its call's place). What waits: a
context's submit that could touch a pending plane (`VirglRenderer.submitTouches`: what each sub-context it draws in
has bound, what its commands bind or name, what the objects it makes refer to; one with a command it doesn't know, if
the context has a pending plane attached), a call naming a pending plane, and whatever an earlier waiting call must
precede: the same context or resource; fences, reads, saves, the screen and anything that ends a resource's life wait
for every earlier waiting call; and **another context's call that could see what a waiting one draws** (a submit of a
context sharing an attached resource with it, a transfer of one of its resources). The rest runs ahead. **A submit
that only decodes (`decodeOnly`) and an attach pass even their own context's waiting calls** (not its transfers,
detaches or end, which a decode may need), so the decoder gets the later pictures it may be waiting for: Chromium's
GPU process decodes and draws on one context, with every surface attached (plans/video.md §12). A picture decoded
ahead of a waiting call that could see its planes is written after that call has run (`CallQueue.sees`). Past
`nudgeMs` (30 ms) with nothing out, frames held for the next one are sent (AV1's); past 200 ms the decoders are
drained; past 1 s the pending pictures are given up (the guest sees the old planes rather than hanging). A picture
pending for 3 s is given up whatever else comes out (`giveUpOld`): one a decoder never outputs while later ones do
would otherwise hold every fence behind it for as long as decoding went on (the idle give-up never comes). A Vulkan
program's image on its way into virgl's texture (the readback way, web/venus-share.ts) is held back as a pending plane
is: the compositor's submit that may sample it waits for its bytes. Venus's calls that make things (a context, a blob,
its map, a resource attached to a Venus context, a submit) never wait: Venus's ring is polled past the queue and may
import an attached resource at once ([vk/README.md](../vk/README.md) "Imports"); those that end things (a context
destroyed, a detach, a blob's unmap and unref) wait as an unref does.

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
- **Another renderer's blobs** (`ExternalResource`): a Vulkan program's WSI image is a blob of Venus's renderer, which
  the guest's compositor imports as a dma-buf and types with `PIPE_RESOURCE_SET_TYPE` (format, size, strides). That
  makes a 2D texture of the format, attached to the context, whose texels web/venus-share.ts copies from the image's
  WebGPU texture before a submit that may sample it ([vk/README.md](../vk/README.md) "Presentation"); colour formats
  only. The texture goes with the blob's unref.
- **Resources another renderer imports** (VK2 L6): the reverse, a virgl resource the guest imports into Vulkan as a
  dma-buf (mpv on Vulkan maps VA-API's surfaces), stays the virgl renderer's; each video picture written into a plane
  is also handed to web/venus-import.ts (`onPlane`), which writes it into the Venus textures imported from it, and a
  resource with no picture yet is read back once (`readResource`) ([vk/README.md](../vk/README.md) "Imports").
- **What the guest sizes is bounded** before the CPU works on it (WebGL validates only the calls it gets; fuzzing the
  stream found each of these, docs/testing.md "virgl fuzzing"): a resource past WebGL's texture limits or a buffer over
  256 MiB (its CPU copy) is made with nothing on the host, as vrend's `check_resource_valid` refuses it; an upload or
  read-back's box must lie in a level of the texture (whole blocks of a compressed format) and an upload hold the box's
  bytes; an indexed draw's indices must be of size 1, 2 or 4, aligned and in the index buffer; sampler view and state
  slots end at 32 (Gallium's `PIPE_MAX_SAMPLERS`); a blit covers at most the destination's layers.
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
  texture's size with the picture's last column and row repeated (`padPlane`, for whoever reads the plane back).
- **Draws sample the picture, not the plane** (`Res.picture`): Mesa makes the planes whole 16×16 blocks (864×480 for
  an 854×480 video, 640×368 for 640×360), and Chromium and mpv import a plane at the picture's size, which on real
  hardware crops it. virgl's import never reaches the host (Mesa's virgl sends nothing for an ordinary resource; views
  carry no size), so they sampled the whole plane and showed its padding along the right or bottom edge: zeros (a green
  stripe), then the repeated edge (a smear). A picture smaller than its plane is also written into a texture of its own
  size, and draws sampling the plane sample that; an upload into the plane or a draw into it drops it. Firefox shows the
  same picture either way. Checked with the padding painted a marker colour (`bench/results/local/edge/`): VP9 at
  854×480 in Chromium (the right edge) and at 640×360 in Chromium and mpv (the bottom) showed it, none with the fix, in
  Chromium, mpv and Firefox; H.264 at 640×360 showed none either way. The size a player asked for can't tell them apart:
  Chromium's buffers ask for 864×480, as FFmpeg's do.
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
  platform.md "The snapshot file"); a restore hands the state to the new GPU worker (`load`) before it shows the scanout.
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
Beyond GLES 3.0 (compute, GLES 3.1) would be a WebGPU backend, and desktop GL 3.0 and 3.1 extensions WebGL2 has only
as extensions (backlog.md "Platform and devices"); desktop GL past 3.1 needs geometry and tessellation, which neither
WebGL2 nor WebGPU has.

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

## Vulkan through Venus

A second 3D path beside virgl, per machine (the Machines page's Vulkan switch, `?gpu=vulkan`): the guest's Mesa
**Venus** driver (Debian's and Arch's, unmodified) serializes Vulkan, and a renderer of ours in wasm translates it onto
the browser's **WebGPU**, on the real GPU. Its frames reach the screen through the virgl renderer. Built in VK0 to VK3
(2026-10-25 to 10-29; bench/vulkan/REPORT.md has each phase and loop, "VK3: the summary" the state at VK3's end); the
bar it must meet and the decisions that bind it are [plans/graphics.md](plans/graphics.md), with VK4's tasks. Where the
parts are described in detail: the renderer's code in [vk/README.md](../vk/README.md), the device, the window and the
host's side in [devices.md](devices.md) "Venus" and "The host-visible window", the tests in [testing.md](testing.md)
"dEQP", the loose ends in [backlog.md](backlog.md) ("Platform and devices": the Vulkan entries).

### The shape

- **The device** (web/gpu.ts, web/venus.ts): virtio-gpu with `CONTEXT_INIT`, `RESOURCE_BLOB`, `HOST_VISIBLE` (a shared
  memory region: the host-visible window) and `RESOURCE_UUID`, and the Venus capset beside virgl's. The guest writes
  Venus's commands into rings in shared memory that the host polls, with no ioctl a submit.
- **The renderer** (route (b), "Not taken" below): virglrenderer's Venus decoder (`vkr`) calling **a Mesa Vulkan driver
  of ours whose hardware is WebGPU**, built on Mesa's common Vulkan runtime (render passes over dynamic rendering,
  command recording, meta operations, synchronization), `spirv_to_nir` and NIR's passes, with a NIR → WGSL backend
  modelled on KosmicKrisp's NIR → MSL. One wasm module (~12 MiB, 0.74 MiB with brotli), fetched only by a machine
  with Vulkan, instantiated in the GPU worker **on the VM's memory 1**, its own (an arena of 1,280 MiB, then the
  window), so the guest's rings, command streams and mapped memory are its own pointers; vkr runs on one thread, its waits as polls.
- **Commands** are recorded and translated at submit, so a whole render pass is seen before it is encoded (the
  render-pass rule below); pipelines become render and compute pipelines, made asynchronously on Dawn's workers (a
  submit drawing with one not ready is held) and their WGSL kept across runs in the page's storage; descriptor sets
  become bind groups made at bind time and cached by content (8 sets advertised, sets 3 and up sharing WebGPU's
  fourth group); push constants are immediates, past them a push buffer of the driver's; barriers are accepted
  (WebGPU tracks hazards); one queue family; fences complete on `onSubmittedWorkDone`. vk/README.md "The driver".
- **Memory:** device-local memory is plain GPUBuffers and textures. Host-visible memory is the window (1,280 MiB of
  memory 1 after the arena: the 1 GiB host-visible heap whole, since Linux places each mappable blob there when it's made, GD G8, at the guest PA after RAM, outside guest RAM), which guest and renderer share; its pages are write-protected in the TLB
  and marked dirty on the first write (the write-watch), and the written ranges are uploaded at each submit.
  Readbacks map a staging buffer and copy into the window before the fence is signalled. A Vulkan machine's memory 0
  holds as much RAM as any (3,071 MiB); node 1 follows the window in memory 1, at most 1,536 MiB
  ([spill-memories.md](spill-memories.md)).
- **Presentation:** Venus's WSI images are shared with the virgl renderer's screen as a copy from a WebGPU texture into
  WebGL's (bitmap, canvas or readback; the first copies of a way are checked against a readback, and a wrong way is
  dropped for the next). vk/README.md "Presentation".
- **What it advertises follows the adapter** at start (its features and limits: SwiftShader's device reports a
  quarter of the Mac's workgroup); API 1.3; a GPU (libplacebo, GTK4, Dawn and wlroots turn CPU devices away); NVIDIA
  as an unknown maker (Venus's guest WSI keys its prime blit on NVIDIA's vendor ID).

### What maps, what's emulated, what isn't offered

| Kind | Vulkan | On WebGPU |
|---|---|---|
| **Direct** | Draws (indexed, instanced, indirect), base vertex, compute, occlusion queries, copies, blits (as draws), mipmaps, BC/ETC2/ASTC where the adapter has them, MSAA at 4 samples, depth bias, stencil, depth clip off | Core WebGPU, or `depth-clip-control` |
| **The adapter's features** | Clip distances, dual-source blending, `shaderFloat16` and 16-bit storage, subgroups (held where the page's check finds them wrong: Chromium's Metal path), first instance in indirect draws, timestamp queries, 16-bit normalized formats and read-write storage images | `clip-distances`, `dual-source-blending`, `shader-f16`, `subgroups`, `indirect-first-instance`, `timestamp-query`, `texture-formats-tier1/2` |
| **Shader rewrites** (no extra passes) | Combined image-samplers (split); specialization constants (frozen per pipeline); matrix and array varyings (split into vectors); input attachments (read as textures); texel buffers (storage buffers of the view's words, the format decoded in WGSL); dynamically indexed descriptor arrays (a tree of ifs); sample-rate shading; more than 12 uniform buffers a stage (read as read-only storage); draw parameters (words of the push buffer); YCbCr conversions (8-bit multi-planar formats, planes as textures) | At translation, in WGSL |
| **Compute before or after the pass** | The last vertex provoking (a draw's indices rotated); transform feedback (the vertex stage run as compute, after the pass); an indirect draw's parameters copied from its arguments | A compute pass, its outputs left on the GPU |
| **Copies and draws of the worker's** | Depth and stencil copies WebGPU refuses (draws and compute passes); copies between size-compatible formats (bytes through a temporary buffer); multisampled copies, and resolves WebGPU refuses: integer formats, parts of an image, 3D images (draws); copies and blits within one buffer or subresource (through temporaries); clears as draws; attachment-less passes | |
| **Passes and bytes of the driver's** (VK4 T7) | Multiview (a pass per view); atomics on R32 images (the image's words in a buffer, copied to and from its texture); inline uniform blocks (a uniform buffer of the set's); device addresses (address memory in one GPUBuffer, a pointer a byte of it) | |
| **Not offered** | Sparse resources; 64-bit floats and integers in shaders; logic ops; pipeline statistics queries; sample counts other than 1 and 4; full bindless (until WebGPU's binding arrays); geometry and tessellation (compute pre-passes, as libpoly does, when a program asks: VK4); multi-draw indirect | |

What each row still misses is in backlog.md "The Vulkan driver's gaps", "ANGLE's row's gaps", "YCbCr's gaps".

**The render-pass rule** (VK0 C): WebGPU can't run compute inside a render pass, and ending one to run a pre-pass,
then reopening it, stores and reloads every attachment (a break per object made a frame 10× the hoisted one on the
M4, 2.6× on NVIDIA). So translate at submit; hoist every compute pre-pass a render pass needs before it begins
(Vulkan forbids nearly every way one draw could make input for a later draw in the same pass, so the hoist is almost
always legal); split only for a self-dependency; never break for transfers or clears (before the pass, as its load
operations, or as draws); count breaks as a budget, a handful a frame (~40 µs each at 1080p on the M4, 70–160 µs with
4× MSAA, ~8 µs on NVIDIA).

**The rows and who they brought** (VK0 A, then VK3): the direct set alone brings vkcube, vkmark, mpv and vkQuake;
indexed descriptor arrays and sample-rate shading are Dawn's row (the guest's Chromium WebGPU: not yet taken, the
guest's Mesa), the provoking vertex, 13 uniform buffers and transform feedback ANGLE's ES3 (WebGL 2 on Venus in the
guest's Chromium), draw parameters vkd3d's (a Direct3D 12 device at feature level 11_0), YCbCr GTK4's (GTK 4.24
aborts on a device with dma-buf extensions and no YCbCr; with it, it still takes GL, since Venus offers only the
LINEAR modifier). **Any change that offers GTK a modifier other than LINEAR must first show GTK4 on Vulkan meeting its
bar** (bench/vulkan/REPORT.md G), or GTK4 moves to the slower path.

### Known limits

- **Venus leans on host-driver behaviour beyond the spec** (VK0 B, in `vkr`): host-visible memory forced exportable
  and bound to resources made without external-memory info, mappings assumed coherent with no flushes reaching the
  host (hence the write-watch), GPU writes to feedback slots visible without a guest wait, `vkQueueWaitIdle` refused,
  the ring and the virtqueue waiting on each other. We are the host driver: the window makes the first three free;
  the worker does the rest.
- **vkr assumes threads**: on one thread its waits are polls; a wait the guest satisfies only later must stall and
  resume, not block (VK1 found one as a hang); its resources outlive their memories (VK1 found a use-after-free). Each
  new vkr wait or lifetime is checked against that.
- **A pipeline's first compile is the browser's** (~80 ms the first time a shader reaches Metal's compiler, ~1.5 ms
  once its disk cache has it; SwiftShader 27 ms; the translation ~0.6 ms). Made asynchronously and kept across runs,
  a program's second run on a machine translates nothing and, on Metal and NVIDIA, compiles little (vkQuake's 17
  pipelines ready in 74 ms warm); its first run pays the browser's compile (NVIDIA: 16 pipelines 0.5 s). A pipeline
  made at once compiles on Chromium's GPU process's main thread and stalls the page's WebGL too (VK3 L3).
- **The browser's timers and its look at the GPU** (VK3 L2): a worker's nested `setTimeout(0)` is clamped to ~4.5 ms
  (6 on the Mac), and Chromium notices a Dawn device's finished work on Vulkan only at a slow timer unless commands
  arrive. Venus's poller sleeps on `Atomics.waitAsync` and nudges with empty submits; the render stats carry the
  fence's breakdown (`venus`). On NVIDIA a lone pass is noticed ~2.2 ms after it ends (1.2 nudged), which keeps a light
  frame behind virgl's there.
- **WebGPU's per-call cost** caps a frame at ~5,000 Vulkan-style draws a millisecond on the M4 (VK0 E): games at
  3,000–5,000 draws fit, 30,000 don't at 60 frames a second; Chromium costs ~0.25 ms a frame where the GPU is fast.
- **WebGPU and WebGL's interop differs by platform**: each way of presenting is checked at run time with a fallback,
  and a platform the agents can't reach needs the user's run (bench/vulkan/nvidia.sh).
- **The guest's cost is its submit path, not Venus's encoding** (VK1's gate): encoding costs ≤0.55 µs a command, half
  virgl's, but Venus's driver makes ~2× virgl's execbuffers (9 a frame for GTK4's against 4), ~0.17 ms of the emulated
  kernel each: a light program pays more on Venus (+0.3 ms a frame), a heavy one gains (VK4 T14).
- **Adapters differ** (limits, features, formats, precision), and an adapter's compiler can be wrong (Chromium 153's
  Metal path hoists a ballot out of an `if`): a feature a cheap kernel can check is checked that way at Venus's start.
  dEQP-VK's pass list runs on SwiftShader in CI; on the M4 7 cases fail on Metal only, on NVIDIA one group.
- **The guest's Mesa is a party too**: it keys its WSI on the vendor ID, Mesa 26's async present drops a present after
  one that failed (the desktop image sets `VN_PERF=no_async_present`), and its opaque-fd semaphore export hands back fd
  0 (so Dawn in the guest's Chromium doesn't take Venus). The host can't fix these: what the device reports is chosen
  around them, the images carry workarounds, each goes upstream (backlog.md "Upstream reports"), and a guest image
  built before a workaround meets the bug.
- **WebGPU's binding model is narrower than Vulkan's**: the advertised per-stage limits come from one count of the
  bindings WebGPU takes, translation's own included (`wg_bindings_fit`), and a pipeline past them is refused at
  creation saying why; usage scopes are per GPUBuffer while the driver binds a `VkDeviceMemory` as one, so a pass or
  dispatch that writes storage of a memory it reads otherwise reads copies of those ranges taken at its start (VK4 T3:
  vk/README.md "Usage scopes"), and two writable bindings of one range in one scope are refused.
- **The arena**: memory 1's first 1,280 MiB (web/ram.ts `VENUS_ARENA`) caps the renderer's heap, blob storage
  included (dEQP-VK's pass list took 137 MiB: bench/vulkan/REPORT.md "The renderer's arena"); the window and node 1
  follow it in memory 1 (VK4 T19).

### What VK0 to VK3 found

- **Worth it** (VK0 S): a whole Vulkan frame translated at run time onto WebGPU costs 1.0–1.8× native Vulkan on the M4
  and 1.9–3.6× on an RTX 3070 (a fixed ~0.25 ms a frame of Chromium's), and runs 200–950× faster than the guest's
  lavapipe and 3–19× faster than virgl's GLES for the same frame.
- **The guest's cost decides** (VK1): Venus costs the guest 2–9× less a frame than virgl where there's work, ~0.3 ms
  more where there's almost none; the write-watch costs machines without a window nothing measurable.
- **A pipeline's cost is the browser's compile**, not the translation (VK2 L7; above).
- **Platform bugs hide in guest-visible identity** (VK3 L1): NVIDIA's black frames were the device's vendor ID sending
  Venus's guest WSI down Mesa's prime blit, whose buffers weren't shared, not the presentation path suspected first.
  Read a platform's render stats before theorizing (`shareRefreshes` 0 meant nothing was copied).
- **Out-of-context static reviews find what loops miss** (~80 findings over nine reviews, most of them real): the M4's
  green VA-API chroma was a window page lost between two Venus devices, found by a review after a loop of experiments
  narrowed it and missed it. A bug that hides under probes is counted in bare sessions with arms alternated.
- **Advertising decides who switches**, and advertising what isn't honoured is worse than not advertising: VK2's
  null-driver YCbCr made GTK4 draw wrong for more CPU, so it was dropped until VK3 backed it.
- More, by loop: the "Things worth not re-discovering" of VK2's and VK3's handovers (`git show
  cd03da82:VK2-HANDOVER.md`, `git show 1fce4c0a:VK3-HANDOVER.md`).

### Not taken for Vulkan

- **Route (a), our own crate in Rust** (a Venus decoder generated from `venus-protocol`, SPIR-V → WGSL through naga or
  Tint, Vulkan's objects mapped by hand): smaller and ours, but every lowering ours too. VK0 D decided for route (b):
  naga with spirv-opt translated every stage of the plainly written programs but none of GTK4's 16 and 33 of vkQuake's
  51, each failure a lowering NIR already has; `spirv_to_nir` took all 110; and WebGPU calls from wasm cost what calls
  from JS do (E), with Chromium's ~9 ms of a pipeline dwarfing a frontend's.
- **A software Vulkan driver on the host** (lavapipe or SwiftShader built for wasm, behind Venus): shaders as wasm SIMD,
  a conformant feature set, the rasterizing off the vCPUs; lost on the bar, since the programs that switch to Vulkan
  would leave virgl's GPU for a CPU rasterizer (and llvmpipe's LLVM JIT can't run in wasm). Kept as a fallback for
  pages without WebGPU only if a user asks.
- **A hybrid software driver handing parts to the GPU**: work split between CPU and GPU crosses at every dependency,
  and a browser's readbacks are asynchronous and slow (Mesa's old per-feature fallbacks were cliffs for this reason).
- **Software rasterization on the GPU** (Vulkan's pipeline in WebGPU compute): a research project; WebGPU lacks 64-bit
  atomics, and it still needs SPIR-V → WGSL. The compute pre-passes take the useful part.
- **Venus onto WebGL2**: no compute, no storage buffers. **WebGPU passthrough for guest programs** written against
  WebGPU: a guest library and a context type of our own, no upstream guest support; demos, not a graphics stack.

### Sources

Venus's requirements: [Mesa's Venus docs](https://docs.mesa3d.org/drivers/venus.html). WebGPU in Chromium:
[Chrome 144](https://developer.chrome.com/blog/new-in-webgpu-144) (Linux), [142](https://developer.chrome.com/blog/new-in-webgpu-142)
(texture-format tiers, primitive index), [149–150](https://developer.chrome.com/blog/new-in-webgpu-149-150) (immediates),
[151–152](https://developer.chrome.com/blog/new-in-webgpu-151-152), [what's next](https://developer.chrome.com/blog/next-for-webgpu)
(bindless, multi-draw indirect, 64-bit atomics, UMA mapping: proposed; multi-draw indirect is still
`chromium-experimental-multi-draw-indirect`). Geometry and tessellation in compute: [libpoly in panvk
(FOSDEM)](https://fosdem.org/schedule/event/KZUJ9X-geometry_shaders_in_panvk_with_libpoly). Vulkan on Metal in Mesa:
[KosmicKrisp (XDC 2025)](https://www.lunarg.com/wp-content/uploads/2025/10/XDC-2025-KosmicKrisp-Overview.pdf). The
[Profiles layer](https://vulkan.lunarg.com/doc/view/latest/mac/profiles_layer.html) (only lowers what a driver has).
GTK4's Vulkan use: `gdk/gdkvulkancontext.c` and `gsk/gpu/gskvulkandevice.c`. Recording and replaying Vulkan calls:
[GFXReconstruct](https://github.com/LunarG/gfxreconstruct) (MIT).

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
- `Gpu.save()` is also the tests' state read (`vm.deviceState`): it never throws; it marks `unsaveable` (why, a message of
  the `display` catalog as an error for the wire: web/msg.ts `toWire`) and `vm.snapshot` refuses with it as the cause.
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
  `gtk4-load.ts`, `snapshot-3d.ts`, `chromium-flicker.ts`, `chromium-video.ts` (a clip in the guest's Chromium: its
  presented video and animation frames each second with the host's video and fence numbers), `filter-probe.ts`; `sway-mac.sh` runs any of them on the Mac
  host's GPU (`SCRIPT=`; `HEADED=1` only when the user isn't using the Mac). `PROFILE=1` samples every vCPU's PC and
  symbolizes the guest kernel's in the guest (benchmarking.md "PC sampling").
