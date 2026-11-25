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
[frontend.md](frontend.md) "The screen", video decoding over virgl in [graphics.md](graphics.md) "Video", the tests in
[testing.md](testing.md), the benchmarks in [benchmarking.md](benchmarking.md) and `bench/gpu/REPORT.md`.

## Decisions

These bind the graphics work; changing one is the user's call ([decisions.md](decisions.md)).

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
  tested (`?gpu=2d`, `WAARM64_PAGE_QUERY=gpu=2d scripts/ci-debian.sh`).
- **Snapshots while 3D is in use save the renderer's state as data** (objects decoded, contents read back), never a
  replay of the commands; refused only while a video decodes.
- **Tests:** 2D is byte-exact in deterministic mode (natively, in Node and in Chromium, with its own guest and kernel
  variant so no other step count moved); 3D runs in realtime mode only, tested at the protocol level in Node and on
  WebGL2 in Chromium; **dEQP's pass lists are the correctness gate** (`scripts/ci-deqp.sh`, for every change that
  touches 3D).
- **Guest pixels are CSS pixels by default**, scaled up crisply, with a HiDPI setting that sends device pixels and the
  physical size in the EDID. Live resize is the guest agent's job: it sets a wlroots compositor's outputs to the
  page's size (devices.md "The guest's agent", "The screen's size").
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
  calls (`web/virgl-host.ts`). The GPU worker runs them through the renderer (`web/virgl-renderer.ts`, its state model
  `web/virgl-objects.ts` and pixel paths `web/virgl-pixels.ts`, with the translator `web/virgl-tgsi.ts` and the format
  table `web/virgl-formats.ts`) and draws the screen. Guest RAM is
  shared memory, so the renderer reads and writes the guest's pages in place.
- Without WebGL2, or if the context or the caps can't be made (`failed`), the machine starts again as 2D. A lost
  context on a 3D machine stops it with a message (every renderer object is gone with it); a 2D machine's WebGL2
  screen draws again when its context comes back.
- **The switches:** the Machine menu's Graphics (3D or 2D, a restart applies it); on the query, `?gpu=2d`, `virgl`,
  `virgl-null` (the null renderer: streams walked and counted, nothing drawn, fences at once), `nopace` and `q<N>`
  (the flush pacing and the queue size, for measurements), `novideo`, `swvideo`, `waitattached` (the call queue's old,
  coarser wait: a context waits while it has any pending picture's plane attached; A/B), `debug` (the renderer's trace),
  `checkprograms` (every part of a draw's program key read again at each draw, a stale kept one refusing the draw) and
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
  | KDE Plasma on Wayland (KWin) | Takes the new preferred mode the display event brings, live (a user's session since G1's display events; not measured here) | Live |
  | GNOME on Wayland; Xorg | Not measured | Expected: live for GNOME, `xrandr --auto` for Xorg |

  Live resize is the guest agent's job (devices.md "The guest's agent": wlr-output-management's custom mode, what
  `swaymsg … mode --custom` asks for; RandR under X11) or a desktop's own setting.

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
  `nlplug-findfs` opens the render node at boot and never closes it). Mesa 26 reports `virgl (waarm64)` with **OpenGL
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
- **Firefox** (about:support): WebRender, accelerated, on "virgl (waarm64)", GLES 3.0 for WebGL 1 and 2; WebGL reaches
  WebRender through DMABUF (no read-backs); accelerated canvas 2D; only the parent process maps Mesa. Its gfxInfo
  blocks its native compositor (forcing it on presents no video frame) and DMABUF export; VA-API decoding needs no pref
  (graphics.md "Video"). One of its shaders fails to compile (`GL_EXT_shader_texture_lod`, which Mesa 26 has for no GLES driver): not ours. Scrolling
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
  avoids it (backlog). **"No EGL configuration available"** in a GtkGLArea (GTK draws in software) was Mesa 26.3.1's
  regression, not our caps: `338afb32f86` left `EGL_OPENGL_ES_BIT` out of every config of a build without GLES1
  (Arch's), and GDK's `eglChooseConfig` doesn't set `EGL_RENDERABLE_TYPE`, whose default is that bit (mesa/mesa#16934);
  Arch's 1:26.3.1-2 reverts it (the desktop image from 2026-11-22 on).
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
  VIRGL v1 (308 bytes) and VIRGL2 (1408 bytes), **minus what WebGL2 can't back** (conditional rendering,
  `start_instance`, timer queries, depth clamp, `textureQueryLod`, sample shading, cull distance, fbfetch, sRGB write
  control, ASTC, dual-source blending, advanced blend equations) or backs only as an extension (independent blending,
  half-z clip: below), and at WebGL2's minimum limits.
- **A page machine's caps follow its browser** (`capsFromGl`, `web/virgl-caps.ts`; never more than the renderer backs
  there): the context's limits; the format masks from the format table, a format only with its extension
  (`R16_UNORM` with `EXT_texture_norm16`, float render targets with `EXT_color_buffer_float`, each compressed family
  with its own); constant buffer 0 the uniform vectors less the 16 the generated shaders keep; up to 8 color
  attachments; the read-back formats the renderer can read here; **`texture_multisample` where `MAX_SAMPLES` is above
  1**, with the color and depth formats WebGL2 multisamples. Without that bit Mesa makes no multisampled renderbuffer at
  all, though GLES 3.0 requires 4 samples (vrend sets it only on GLES 3.1, so vtest on a GLES 3.0 host fails dEQP's
  MSAA cases). **The capability bits an extension backs** (`EXTENSION_BITS`) where the browser has it: independent
  blending (`indep_blend_enable` and `_func`, which give the guest `OES`/`EXT_draw_buffers_indexed`) with
  `OES_draw_buffers_indexed`, and `CLIP_HALFZ` (`EXT_clip_control`) with `EXT_clip_control`. The renderer then sets each
  buffer's blend, equation and color mask through its own stored layout (without the extension, the first buffer's for
  all, as Gallium's non-independent blend is), and the rasterizer's `clip_halfz` as clip control's 0-to-1 depth (an
  inverted depth range turned round as `w - z`, as `-z` is between -1 and 1). The video decoders are added by
  `withVideo` (graphics.md "Video").
- **No lower-left origin** (no `fragment_coord_conventions`, as vrend on GLES): Mesa lowers `gl_FragCoord` to
  upper-left itself, so the translator ignores the TGSI's `FS_COORD_ORIGIN` (honouring it flipped y twice).
- **`capsBacked`**: a snapshot restored in a browser that can't back the caps its guest was given keeps them for the
  guest and turns 3D off (new contexts refused, the saved 3D state not loaded) rather than refusing the machine. The
  caps are the guest's only once it read them (GET_CAPSET, `capsRead`; its kernel keeps them for the boot): a snapshot
  of a guest that never did carries none, and its restore gives the guest this browser's. A context doesn't count:
  Arch's kernel makes one at boot when a process opens the DRM device, with no caps read; nor does reading the Venus
  capset (the virgl caps aren't in it). The guest's reset (a reboot) gives it this browser's caps and 3D again: the
  restored caps were only its last boot's. A demo's desktop template is
  made before any GL client for this (remote-disks.md "Building the demos").
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
- **The status bar's numbers** (`stats`, always, once a second from `ready` on; `FromGpuWorker` in web/gpu-messages.ts):
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
polls them while any are pending (`pollQueries`): **at every task for 2 ms since the pending set last changed
(`SPIN_MS`, a message to itself), then every 4 ms**; the set, not the count: the renderer's `queryChanges` counts each
query added or settled, so a client that keeps one in flight, ending the next as the last settles, keeps the spin
(PERF loop 20) (web/virgl-host.ts `QueryPoll` `spin`; `?gpu=querypoll=` takes
`timeout`, `message`, `wait` and `ticker` for A/Bs). A fence waits only behind a pending query, so ordinary applications
don't pay, and nothing polls while none is pending. **Why:** a program that waits on `GL_QUERY_RESULT` waits for the
next look, and WebGL gives a result only a look or two after the GPU has it. On the M4 (bench/gpu/REPORT.md "PERF
loop 16"), glquery's waits were 13–14.5 ms with a 4 ms timer (16 frames/s), 7.1 ms on `Atomics.waitAsync`'s 0.25 ms
timeout (the Mac's ~1.5 ms turns), 2.4 ms with a ticker worker notifying every 0.05 ms, and **0.73 ms looking at every
task** (280 frames/s): the result is there ~0.7 ms after the query's end, and only a task-by-task look sees it then.
Its cost is the worker's thread busy while a query is pending (~0.7 ms a query, ~2 µs a look), capped at 2 ms a change
so a result that takes long (a heavy frame, a lost context's) doesn't keep a core spinning.

The host's other timers were inspected (bench/vulkan/REPORT.md "VK3 L2") and need nothing: the GPU worker's 20 ms stall
check and 4 ms snapshot wait, `Vm.wait` (on `Atomics.waitAsync`), the sound pump (`setInterval` at 5 ms, above the
clamp), the screens' frame pacing, gpu-present's 4 ms lag probes (meant to tick), web/profiler.ts. In a Chromium worker
a nested `setTimeout(f, 0)` turn is 4.4 ms on Linux and 6.0 ms on the Mac; a timer set from a message's task isn't
clamped (`bench/vulkan/fence.ts`).

The query's state is written to the guest's memory and to the buffer's CPU copy: Mesa's `get_query_result`, when its
wait finds the state not DONE, maps the buffer by transfers from the host in a loop until it reads DONE, and a copy
without the state overwrote it at each transfer (glquery's first wait spun for good, ~5,500 transfers a second).
**The wait finds it not DONE only when the guest gave up on the fence.** Mesa flushes and waits for the query
buffer's fence (`DRM_IOCTL_VIRTGPU_WAIT`), and the fence is held until the state is DONE in guest memory. But the
kernel's wait gives up after 15 s of guest time (`virtio_gpu_wait_ioctl`), and Mesa then reads the buffer anyway.
That doesn't happen in realtime unless a result takes 15 s: holding the first result 10 s gave no transfer, holding
it 16 s gave one. In deterministic time it happens easily: the guest idles while the host holds the fence, and its
clock jumps from deadline to deadline, at ~400 guest seconds per host second in glquery. So the first wait, whose fence
the host held ~40 ms (shader compiles), passed 15 s of guest time. That is where loop 16 saw it. (bench/gpu/REPORT.md
"PERF loop 18")

**A fence that never resolves stops the guest's 3D for good:** the guest's control queue fills (16 entries on the
page), every 3D client then sleeps uninterruptibly in `virtio_gpu_queue_ctrl_sgs` (hung-task reports name them), the
vCPUs idle and nothing can be killed, not even for a shutdown. Two causes have been found and closed (both queries,
below), and two console lines say where the next one stops: the device worker's `virgl: fence <n> unanswered for <s> s
(the guest's 3D waits behind it)` after 5 s (`STUCK_MS`), and `answered after` when it is; the GPU worker's `virgl:
fence <n> held <s> s for <k> occlusion queries' results`.

### The call queue

With video, a call waits while it could see a picture still being decoded (`CallQueue`, `web/virgl-host.ts`): Mesa's
`end_frame` makes no fence and virglrenderer decodes synchronously, while WebCodecs decodes asynchronously and a
software decoder may hold a picture until later ones come ("Video's findings"). A call waits only for pictures
decoded by calls before it in the guest's order (each pending picture carries its call's place). What waits: a
context's submit that could touch a pending plane (`VirglRenderer.submitTouches`: what each sub-context it draws in
has bound, what its commands bind or name, what the objects it makes refer to; one with a command it doesn't know, if
the context has a pending plane attached), a call naming a pending plane, and whatever an earlier waiting call must
precede: the same context or resource; fences, reads, saves, the screen and anything that ends a resource's life wait
for every earlier waiting call; and **another context's call that could see what a waiting one draws** (a submit of a
context sharing an attached resource with it, a transfer of one of its resources). The rest runs ahead. **A submit
that only decodes (`decodeOnly`) and an attach pass even their own context's waiting calls** (not its transfers,
detaches or end, which a decode may need), so the decoder gets the later pictures it may be waiting for: Chromium's
GPU process decodes and draws on one context, with every surface attached ("Video's findings"). A picture decoded
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
Programs come from the translator, made at the first draw that needs a (shader pair, draw state) and kept with the
shaders until either shader object is destroyed (`forgetShader`; a new object of the same text is another shader, so
before this the cache only grew: every Qt Quick or Firefox process of a desktop session left its programs behind).
**A draw finds its program without building its key:** each state object's contribution to the key (a *part*: the
vertex elements' types, the rasterizer's flags, the alpha test, the folded blend factors, a view's sampler type and
swizzle, a color buffer's type) is made once and given a small id, equal parts sharing one; the draw writes the ids
of what is bound into a signature, finds the signature's *draw state* by its hash, and the shaders' program by the
state's id. The key is made from the signature's parts alone (`keyOf`), once a state, so nothing the key reads can be
missing from the signature, and no command has to say that it changed the key. A view's and a surface's part read
their resource (its format and target, by number), so they are kept with the resource they were read with. (The key
was an object built and a JSON string made of it at every draw. A state counter on the sub-context, the first design,
lost: sway's trace rebuilt the key at 128 of 147 draws and a Steam session's at 64,516 of 65,028, since programs change
textures, framebuffers and shaders between most draws; by signature the Steam session's draws have 49 states.) A sampler the
program has with no view or texture gets nothing on any target of its unit and no sampler object, and a uniform block
with no buffer (or one too short) nothing at its binding: another context's would be read.
Protocol meanings are vrend's where they differ from Gallium's: query types are virgl's numbers (`VIRGL_QUERY_*`), a
transfer's stride of 0 is its level's own pitch, a draw's indices start at the index buffer's offset alone (Mesa folds
the draw's start into it), and Mesa never sets stream output's append mask (a set of targets seen before continues).

### Resources and formats

- **Buffers** keep a CPU copy (`shadow`) beside the GL buffer: WebGL2 forbids a buffer that is both an element array
  and anything else, and Mesa's upload buffer is both, so the element buffer is made from the copy when an indexed draw
  needs it (whole the first time, then the range written since). A zero-stride vertex buffer (a constant attribute) is read from the copy, and base-vertex draws rebase
  their indices there (no base vertex in WebGL2). Staging buffers are only the guest's pages.
- **Textures** by target (1D and rectangles as 2D, 1D arrays as 2D arrays, cubes, 3D, 2D arrays); multisampled and
  stencil-only resources are renderbuffers. A texture of a format WebGL can't render to (RGB9_E5, the SNORMs) keeps
  its uploaded texels on the CPU for copies from it; a compressed one its blocks (for snapshots).
- **No BGRA and no texture swizzle in WebGL2**: a format is stored as its bytes are (`B8G8R8X8` is an RGBA8 texture
  holding B, G, R, X) and swizzled in the generated shaders, on sampling (the format's swizzle composed with the
  sampler view's) and on writing (the render target's stored order, the clear and blend colors and the color mask go
  through it). Uploads and read-backs are then the guest's bytes as they are (no CPU pass), and the screen draws a
  scanout through its format's swizzle, from level 0 through a sampler of its own (the texture's own filters and
  levels are what the guest's last view of it left).
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
  refuses). GLES 3.0's framebuffer blit ignores the write masks (§4.3.3: only the scissor and pixel ownership tests
  apply); every blit and resource copy still sets them all on, with the scissor off, so no implementation's reading
  of that leaves a draw's masks on a copy.
- **Clears** are Gallium's: `CLEAR` ignores the scissor and the write masks, `CLEAR_SURFACE` clears its rectangle of
  one surface, and both turn the rasterizer's discard off (GLES clears nothing under it: a draw's, or a capture-only
  one's, left it on for the next clear).

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
- WebGL2 has one color mask: components the first target doesn't store stay on (another target may store them);
- WebGL2 blends into a 32-bit float target (R32F, RG32F, RGBA32F) only with `EXT_float_blend`, refusing the draw
  without it; the renderer enables it, and where the browser lacks it such a target is drawn unblended (with one blend
  state for all buffers, every buffer of that draw). The caps can't keep blending away: virgl's Mesa ignores
  `PIPE_BIND_BLENDABLE` (so its guest has `EXT_float_blend` wherever 32-bit floats render), and taking the formats
  out of the render mask would take `EXT_color_buffer_float` with them (vrend has no case for it);
- WebGL2 has no BGRA vertex attribute: desktop GL's `GL_BGRA` arrays (`EXT_vertex_array_bgra`'s colors, the
  2_10_10_10 ones; `B8G8R8A8_UNORM` and `B10G10R10A2_*`) are fetched as their RGBA twin and read as `.zyxw` in the
  vertex shader (`ProgramKey.bgra`), as vrend does on GLES. Mesa's virgl takes every plain vertex format as supported
  (its caps' bitmask is checked only for R11G11B10), so the caps can't keep a format away: an unknown one is drawn
  black. Luanti's GL 2.1 driver colors everything this way (its menu and world were black but the sky).

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
- registers hold bits: temporaries, flat varyings and the logical colors are `uvec4`s, read through
  `uintBitsToFloat` by float instructions; constant buffer 0 is a `uvec4` uniform array, the others uniform blocks;
  immediates are literals, as bits where a float literal would be a denormal or not finite. **No integer passes
  through a float** (found on ANGLE over D3D11, NVIDIA and WARP alike): its HLSL compiler knows the bits an integer
  operation leaves and folds a float made of them to 0 when that is a denormal, so with float registers
  `floatBitsToUint(uintBitsToFloat(x & 255u))` was 0 and Firefox's WebRender, which unpacks its instance data so
  (`cs_clip_rectangle`, `cs_blur`), drew its toolbar dark red and its text not at all;
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

On with 3D (`?gpu=novideo` off); the design, its findings and its measurements are below ("Video's design" …).
- **The caps' `video_caps`** list the decoders the browser's `VideoDecoder` takes (H.264 Constrained Baseline, Main
  and High, VP9 profile 0, AV1 Main 8-bit; `probeVideo` in `web/virgl-video.ts`, in the GPU worker before it answers,
  which also notes which are in hardware), so the guest's Mesa offers VA-API decoding. The guest needs our `waarm64-va`
  (NV12 surfaces only, "Video's design"), in the desktop image. `capsBacked` wants every decoder
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
  stripe), then the repeated edge (a smear). A picture smaller than its plane also fills a texture of its own
  size (copied from the plane on the GPU, `copyTexSubImage2D`), and draws sampling the plane sample that; an upload
  into the plane or a draw into it drops it. Firefox shows the
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
  pending pictures, once the frames the decoder output before it are copied out and written (`webCodecsDecoder` holds
  the error for the copies still out; told at once, it lost up to all of them where copies lag the decoder); a new decoder starts at the next key picture. A seek sends a key picture to the same codec; a size
  change makes a new codec ("Video's findings").
- **Out of the decoder:** a frame is copied once, into one array a picture, in the shape of the planes it goes into
  (`copyPicture`, `PictureShape`): the decoder asks the context for the pending picture's planes (their sizes, two or
  three), and `VideoFrame.copyTo` takes a layout whose offsets and strides are theirs, so I420 into three planes and
  NV12 into two need nothing more; the other two (a software decoder's I420 into NV12's two planes, a hardware
  decoder's NV12 into three) cross over in place through a scratch plane the decoder keeps. The picture's last column
  and row are then repeated out to the planes' sizes in place, and the renderer uploads the arrays as they are (and
  hands them to Venus's import). A frame nothing waits for (given up, its buffer gone) isn't copied. A decoder not told
  the shape (a test's fake) gives the picture's own size, interleaved, which `writePicture` widens and parts as before.
- **AV1** (`web/video-av1.ts` `Av1Stream`, "Video's findings"): a sequence header and each frame header written from
  the desc, a tile group of the tiles; the decoder's reference slots are this side's (Mesa sends no
  refresh_frame_flags): a frame goes to a slot holding nothing the guest's reference map has, or waits for the next
  frame's map (`nudge`d out after 30 ms of calls waiting: `CallQueue`'s `nudgeMs`, and before a destroyed codec's
  flush), and one sent stored nowhere is decoded again if a later frame references it; a hidden frame the guest shows
  later is written shown, and frames with no output go in the next temporal unit. Film grain reaches the shown surface
  through waarm64-va 2 (Mesa sends the film grain target too late).
- `renderer.videoStats` (decoded, dropped, errors; each picture's END_FRAME to written and its write, in ms) and the
  queue's `ahead` and `maxWaitMs` go out in render-stats (`bench/gpu/guest-session.ts` sums them over a phase). Mesa's
  wire numbers its profiles by its own `enum pipe_video_profile` (26.2's in `PROFILE`), which isn't stable across
  releases. A capture includes DECODE_BITSTREAM's buffers. A video decoding is the one state a snapshot refuses (below).

### Video's design

Decided 2026-10-14 (the user); the track ended 2026-10-15 with H.264, VP9 and AV1.
- **VA-API over virgl:** the guest's own Mesa (`virtio_gpu_drv_video.so`) is a VA-API driver that sends decode commands
  over the virgl protocol we already render (`VIRGL_CCMD_CREATE_VIDEO_CODEC` … `END_FRAME`); Firefox's VA-API path,
  mpv, GStreamer's `va` plugins and FFmpeg use it unmodified. The pictures never touch guest RAM: Firefox exports the
  surface as a dmabuf and WebRender samples it as virgl textures (the R8 and GR88 planes, imported zero-copy).
- **One piece of guest software of ours, `waarm64-va`** (`waarm64_drv_video.so`, `LIBVA_DRIVER_NAME=waarm64`, ~60 lines on
  libva's stable ABI; images.md): it loads Mesa's driver and drops I420 and YV12 from `vaQuerySurfaceAttributes`.
  Mesa's virgl offers them besides NV12 (real drivers offer NV12 alone for decoding), FFmpeg's
  `vaapi_decode_find_best_format` then picks I420 for 4:2:0, and Firefox's VA-API path takes NV12, YV12, P010 and P016
  only ("Unsupported VA-API surface format"), so it fell back to software. Version 2 routes AV1 film grain around a
  Mesa omission; 3 says an exported object's size is what its planes span (Mesa's says its dma-buf's, a page for a
  decoder's host-only resources, and libplacebo refuses an image larger than its object: vk/README.md "Imports"). The user: keep it until Mesa
  is fixed (backlog.md "Upstream reports").
- **The host decodes with WebCodecs in the GPU worker** and writes each picture into the guest's video buffer (Mesa's
  `vl_video_buffer`: ordinary virgl textures), as virglrenderer does with host VA-API (`vrend_video.c`: decode, then
  copy into the plane resources). The copy out of each `VideoFrame` (`copyTo`, exact) stays: a GPU-only conversion in a
  shader was kept in reserve in case the copy cost too much, and isn't worth its price: the copy costs 0.25 to 1.4 ms
  a picture at 1080p ("Video's measurements", "A picture's copy"), and the browser hands a frame to the GPU only as
  converted RGB (`texImage2D` or `importExternalTexture` of a `VideoFrame`; no plane of it), so the planes would be
  converted back and no longer exact.
- **Stateless in, stateful out.** VA-API is stateless (the guest parses the stream and sends a picture's parameters
  and its slice data); `VideoDecoder` takes the stream, so the host rebuilds what the guest parsed away: H.264's SPS and
  PPS (the slices arrive whole, with their headers), AV1's sequence and frame headers (the tiles arrive alone); VP9
  arrives as whole frames, the uncompressed header included.
- **The output order is the guest's.** The guest's FFmpeg reorders pictures itself and waits on a surface after
  sending the pictures that follow it in decode order; a decoder that holds pictures for its own reordering longer than
  the guest expects deadlocks it (the guest waits on a fence the host can't resolve without later input). Hence the
  SPS's reorder depth 0 for hardware decoders, the learned depth and the drain for software ones, and the call queue's
  per-picture waits (above).
- **Codecs:** H.264 (Constrained Baseline, Main, High; 8-bit 4:2:0, progressive), VP9 profile 0, AV1 Main 8-bit, each
  where `VideoDecoder.isConfigSupported` says yes, in hardware or not. 10-bit (VP9 profile 2, AV1 10-bit) isn't offered:
  the video buffers are NV12. **HEVC was dropped** (the user, 2026-10-15): Chromium on Linux has no HEVC decoder of its
  own (only a platform's, in hardware), so the user's host would never offer it, and VA's parameters lose the SPS's
  short-term reference picture sets (backlog.md "HEVC on the host"). HEVC files play, decoded in the guest.
- **Correctness is bit-exact:** a decoded picture's planes equal FFmpeg's software decode of the same stream byte for
  byte, where the browser's decoder is FFmpeg's or the hardware's (OpenH264 isn't: below).

### Why not V4L2

The first candidate was a stateful V4L2 decoder over virtio-media (Google's V4L2-over-virtio, device ID 48), on the
premise that Firefox's V4L2-M2M path (since 116, for the Raspberry Pi) would use it unmodified. It wouldn't
(2026-10-14):
- **Firefox's V4L2 path takes only DRM PRIME frames** (`FFmpegVideoDecoder.cpp`'s `ChooseV4L2PixelFormat`), and
  upstream FFmpeg's `*_v4l2m2m` decoders never offer them (software frames only). It works on the Pi because the Pi's
  FFmpeg fork adds DRM PRIME output through `VIDIOC_EXPBUF`, which virtio-media's driver doesn't implement, and the
  dmabuf it would export isn't a virtio-gpu resource, so virgl's EGL couldn't import it anyway. Firefox would have
  needed a patched build of ours at every release.
- **virtio-media's driver isn't upstream** (v7 of "media: add virtio-media driver", 2026-08-13, unmerged in 7.2.10),
  and v7 has MMAP buffers only, which need the device's shared memory region 0: our virtio-mmio transport has none (it
  would be a carve-out at the top of RAM, as the framebuffer is).
- It would have served mpv (`--hwdec=v4l2m2m-copy`), the ffmpeg CLI and GStreamer's `v4l2*dec` unmodified. VA-API over
  virgl keeps Firefox and Mesa stock, needs no transport change and keeps the pictures on the host's GPU; its cost is
  the host's stateless-to-stateful step.

### Video's findings

Worth not re-discovering:
- **Mesa's H.264 desc lacks fields:** the SPS's `level_idc` and `max_num_ref_frames` are 0 (the picture's
  `num_ref_frames` and the level Mesa estimates for the size stand in), and VA has no PPS
  `num_ref_idx_l0/l1_default_active_minus1` (Mesa writes 0), so every P slice without
  `num_ref_idx_active_override_flag` misparsed: they're learned from the pictures whose slices don't override, the PPS
  sent again if they change.
- **No fence covers a decode:** Mesa's virgl `end_frame` makes none, so `vaSyncSurface` returns at once
  (virglrenderer decodes synchronously, so everything after END_FRAME sees the picture). WebCodecs is asynchronous:
  hence the call queue.
- **What virgl's descs carry isn't what Mesa's pipe descs have**: check `virgl_video.c`'s fill for every field read,
  and Mesa's VA frontend for what it fills when. AV1: no `refresh_frame_flags` (written 1), no `lr_unit_size`, the film
  grain target set after the desc is sent (backlog.md "Upstream reports").
- **The browsers' H.264 decoders differ.** Chromium's own (VideoToolbox, D3D11, VA-API) honors the SPS's
  `max_num_reorder_frames` 0: each picture out before the next chunk goes in. FFmpeg in software (Chrome's
  `prefer-software`) drops every picture that comes after one it has output in display order when told 0, guesses a
  depth when told none (dropping one picture while it learns), and holds 3 pictures beyond the depth the SPS says (its
  frame threads). **The dev VM's Chromium (openSUSE's) decodes H.264 with OpenH264**: it ignores the reorder field
  (holding up to 6 later chunks), drops nothing, and is ±1-9 off in luma on B-pictures against FFmpeg: judge H.264
  exactness on the Mac. VP9 is exact everywhere, every frame out in decode order.
- **What doesn't work for a decoder that holds pictures:** flushing it loses everything to the next IDR (WebCodecs
  wants a key chunk after `flush()`; hence the drain decodes the IDR period again); rewriting the POCs so output order
  is decode order isn't exact (implicit weighted bi-prediction, which x264 uses, weighs by POC distance); a depth seen
  from the guest's waits can't go below Chrome's 3, and mpv's first-picture wait reads as depth 0. **Filler pictures**
  (2026-11-02: a non-reference P picture of skipped macroblocks, CAVLC, a PPS of its own, sent while a call waits for a
  held picture that no later picture can come before) pushed held pictures out exactly, but once the queue's waits were
  per picture and per submit the guest's Chromium never waited for a held one; dropped, with their hazards
  (consecutive identical fillers read as one picture's second slice, fillers to a decoder still decoding a drain's
  history push nothing, OpenH264 under Chromium's FFmpeg failed when chunks followed a filler before its `dequeue`).
- **The queue's two H.264 stalls in the guest's Chromium** (2026-11-02, a slideshow on a software decoder): its GPU
  process decodes and draws on one context, so a draw waiting for a held picture held back the decodes the decoder
  waited for (now decode-only submits and attaches pass their own context's waiting draws); and it has every surface
  attached, so each draw waited for the newest pictures, ones it didn't show yet (now `submitTouches`). Every submit of
  Mesa's virgl selects its sub-context before anything that depends on one (the first command past its queued
  transfers is SET_SUB_CTX, or CREATE_SUB_CTX at a context's start), so decodes run ahead safely. Holding only the
  context that shows a picture (2026-10-14) was too fine: sway composited a client's window before the client's held
  draws into it.
- **Firefox's H.264 path makes a new codec at every seek** (its VP9 path keeps it) and lets go of the old surfaces,
  detaching them, while the compositor's and content process's contexts still hold them: the write once needed the
  decoding context's attachment and the compositor sampled the old planes. Hence "where a picture goes" (above).
- **A WebM/MP4 seek lands on a key picture; an MPEG-TS seek doesn't** (no index): the guest's FFmpeg conceals the
  missing references, the browser's decoders refuse (backlog.md "H.264 that jumps to a picture that isn't an IDR").
  Use TS only for straight decodes.
- **AV1's reference slots:** a frame's decoding depends only on what the slots hold, so the host keeps its own. With
  eight distinct pictures in the guest's map (libaom's streams, mostly) none is free; decoding again whenever none was
  (the first version) decoded 55 of 65 libaom frames twice, the wait for the next frame's map none. The guest's FFmpeg
  reading each picture back waits 30 ms a frame for the nudge. Apple's hardware decoder fails a temporal unit without a
  shown frame, hence hidden frames in the next unit. With film grain FFmpeg decodes into a reference surface and shows
  another (`current_display_picture`); waarm64-va 2 has such a frame decoded into its display surface and names display
  surfaces in the reference map, and the host's decoder applies the grain (dav1d's and VideoToolbox's equal FFmpeg's).
- **The fixture replay can't find a stall:** it feeds every picture without waiting, as no guest does; a decoder that
  holds pictures shows only with the guest on the page (`bench/video/v1.ts`).
- **mpv waits to show its first picture before decoding more**: a drain at its start is normal. mpv on Vulkan takes the
  same surfaces as dma-bufs imported into Venus (vk/README.md "Imports"); mpv's default VO, gpu-next, needs GL 3
  (virgl gives mpv GLES 2): its GL runs are `--vo=gpu`.
- **Firefox:** none of its Linux blocklist entries for hardware decoding matches virgl, and no pref is needed (its
  probe, `toolkit/xre/gfxtest/vaapitest.cpp`, failed only on caps without video); `DMABUF_SURFACE_EXPORT` stays
  "Blocklisted by gfxInfo", not needed. Its logs: `MOZ_LOG=PlatformDecoderModule:5,FFmpegVideo:5,Dmabuf:5` (filter out
  `Tranche`, `Feedback` and `format 0x` lines). `media.rdd-process.enabled=false` never plays and
  `gfx.webrender.compositor.force-enabled=true` presents nothing (on virgl, sway). Measure it from 30 s after its
  launch (`WARM_S=30`) and count drops over a phase, not from its start: its start-up work runs that long.
- Harness details: `sway-mac.sh` defaults to `VIRGL_GPU=virgl-null` (pass `virgl`, `virgl,novideo` or `virgl,swvideo`)
  and takes `-` as the mode for scripts without one; sway's `exec` splits at commas and runs through `sh -c` (a
  `MOZ_LOG` list goes through a script, a URL takes no `&`); a background FFmpeg on the serial shell needs `-nostdin`;
  the serial `run` truncates long output (grep in the guest); with `?gpu=novideo` Firefox decodes in software, so its
  frame counts can't judge the host's decoding; the PC sampler slows the guest (Firefox's drops doubled), so drop
  counts come from unsampled runs.

### Video's measurements

JSON under `bench/video/results/` (`v2/`, `v3/`, `v3c/`, `v3d/`, `chromium-h264/`); the Mac is Chrome for Testing 153
on the M4, the dev VM its Chromium 153; Sintel's trailer at 854×480 and 24 fps unless said.
- **The guest's side:** FFmpeg through VA-API on the null decoder took 1.6 s of CPU for 120 frames of H.264 against
  8.9 s decoding in the guest, 1.1 s for VP9 against 23.5 s; with the real decoders on the Mac 2.0 and 1.8 s, every
  frame equal to the guest's software decode.
- **Firefox, decoded on the host** (4 vCPUs, 20 s a clip from 5 s after its start; `v2/`): Sintel's VP9 dropped 69 of
  531 frames against 454 of 528 decoded in the guest, H.264 55 of 530 (in the guest 44 of 445, playing slow); the
  640×360 sync clips drop as many either way. END_FRAME to written 2.9-3.2 ms (9 at most), the GPU worker's longest
  wait 5-9 ms. A/V sync median -10 to -13 ms (p10 -42, p90 +9), against -85 ms decoded in the guest. Those drops were
  Firefox's start: from 30 s after it (`v3c/`) **0-5 frames of ~500 dropped in 20 s**, the guest 32-41% busy; mpv 0
  dropped at 19-20%. Firefox's steady CPU is its multi-process pipeline's per-frame IPC (the parent 500-630 ms a second,
  content 310-400, RDD ~110-140, the audio process ~70-85; 13.7 k syscalls a second against mpv's 5 k), no one thread
  or call dominating, and no pref changes it.
- **H.264 in software** (FFmpeg on the Mac, `?gpu=swvideo`; `v3/`): Firefox drops as from hardware, END_FRAME to
  written 130-210 ms (the decoder's holding), which Firefox and mpv decode far enough ahead not to notice; mpv drops 0
  of 527. In the guest's Chromium (`chromium-h264/`), before the queue's per-submit waits: 6-7 presents a second, calls
  waiting 220-300 ms; after: 24 video frames, 60 animation frames and 24 presents a second, fences under 1 ms, on
  OpenH264 and FFmpeg alike; the guest's FFmpeg reading each frame back 120 frames in 2.1 s (23 s before).
- **Seeking** (`v3d/`, `bench/video/seek.ts`): FFmpeg exact through jumps and a flush (VP9 353 of 353, H.264 355 of
  355, AV1 345 of 345); Firefox shows the right frame at every paused seek and plays on after each; a seek takes
  0.5-3.8 s paused (the decode from the key picture before it), against 0.2-15 s with the guest decoding. Size changes
  (`res-vp9.webm`, `res-h264.ts`) 288 of 288 frames equal. A damaged chunk is a WebCodecs `EncodingError` in every
  decoder (none conceals it). A machine refuses Save snapshot while a player decodes, and saves once it exits.
- **AV1** exact against the guest's software decode (libaom, SVT-AV1, film grain 240 of 240; the tools clip 72 of 72:
  segmentation, 2x2 tiles, 128x128 superblocks, quantizer matrices, rotzoom global motion, delta q and lf, loop
  restoration) on dav1d and VideoToolbox.
- **A picture's copy** (`copy/`, `bench/video/copy.ts`, 2026-11-24; Chrome for Testing 158 on the M4, the dev VM's
  Chromium 155; 1080p frames into 1920×1088 planes, 9 alternated rounds of 120 pictures, no round of one arm within
  the other's): the path before (the frame copied whole, its rows copied into arrays of the picture's size, each
  widened to its plane, the chroma parted for three planes) allocated 8.9 MiB a picture for two planes and 9.9 for
  three; the shaped copy 3.0. On the Mac, VideoToolbox's NV12 frames: 1.65 → 1.05 ms a picture into two planes, 2.30 →
  1.44 into three (most of what's left is the frame's readback); software frames (I420) 1.38 → 0.55 and 1.94 → 0.25.
  In the dev VM (software only) 2.27 → 0.81 and 2.88 → 0.49. The same bytes either way, in every case. The crossover
  two bytes a step (a `Uint16Array` over the chroma) rather than one took the VM's I420 into two planes from 1.06 to
  0.82 ms and NV12 into three from 1.19 to 0.90.
- **A picture's uploads** (`upload/`, `bench/video/upload.ts`, 2026-11-24; the same browsers; 1080p, NV12's two
  planes, 9 rounds of 120 pictures, the arms in turn, no round of one within another's but the Mac's two copies): a
  1080p picture is smaller than its planes (1920×1088), so it also fills its picture textures. The planes' uploads
  alone are 0.70 ms a picture on the Mac (Metal) and 0.47 in the dev VM (SwiftShader), a texel's read-back after each
  picture included; uploading the picture's rows again, as it was, 1.13 and 0.62; copying them from the plane on the
  GPU 0.91 and 0.54 (`copyTexSubImage2D`, the path now; `blitFramebuffer` the same on the Mac and 1.89 in the VM).
  The same texels every way.
- **Not done, per picture:** a pool for the picture's array (3 MiB at 1080p, allocated a picture) is bounded by the
  whole copy of a software frame, 0.25 ms with the allocation in it, and needs the array's lifetime
  (web/venus-import.ts keeps the last picture of each imported plane); worth a look only if a trace of playback shows
  the GPU worker collecting garbage. A hardware frame kept on the GPU would save its read-back (most of the Mac's
  ~1 ms) but not exactly ("Video's design").
- The tools: `bench/video/copy.ts` (a picture's copy, before and after; `copy-mac.sh` on the Mac's hardware decoders),
  `upload.ts` (a picture's uploads; `TOOL=upload copy-mac.sh` on the Mac's GPU),
  `bench/video/v0.ts` (`vainfo`, FFmpeg and Firefox on the page, `CAPTURE=1`), `v1.ts` (the guest's FFmpeg
  through VA-API against its software decode, framemd5; `SNAPSHOT=1`), `seek.ts`, `replay.ts` (a capture's pictures
  through `VideoDecoder`; `hw|sw`, `REORDER`), `pictures.ts`, `fixture.ts` (the Chromium tests' fixtures),
  `media-disk.sh` (the clips as a second disk; images/arch/media.sh makes them); `bench/audio/avsync.ts` (`MEDIA=disk`,
  `mpv:<file>` phases, `VARIANTS` of Firefox prefs, `MPV_ARGS`); `bench/gpu/chromium-video.ts`.

## Snapshots with 3D in use

**State as data, contents read back**, not the commands since each context was made (that grows without bound:
Firefox makes 10–25 resources a second, where the state is bounded by what the guest holds).
- **Objects** are decoded data in the renderer already. `VirglRenderer.save` writes each sub-context's objects as a
  list and its bound state as places in it (a value bound but no longer named by a handle is kept unnamed); `load`
  makes the values again, shaders re-parsed with new serials (programs come back at the draws that need them), GL
  objects made on demand as always. Queries ended are settled first (the GPU worker polls them before it answers the
  save), their results already in the guest's memory; an occlusion query begun and not ended is begun again (what it
  counted before the snapshot is lost).
- **Contents**, a level at a time, every layer: a buffer's CPU copy; a color texture through the read-back path (the
  formats the guest isn't offered read-back of through `snapshotReader`: A4B4G4R4 as RGBA8, R11G11B10_FLOAT as
  floats, the 16-bit normalized ones as shorts); a format WebGL can't render to, its kept texels; a compressed one, its kept blocks; a multisampled color
  renderbuffer, resolved (a load draws it into every sample; a 32-bit float's denormals may come back 0: D3D11 flushes
  them in the draw and the resolve, as GLES allows, and keeps 16-bit ones). Depth and stencil can't be read with `readPixels`: each
  layer is blitted to a 2D texture of its format (resolving samples), its depths drawn as float bits into R32UI, its
  stencil a bit a pass; a load draws them back with `drawZs`. A 16-bit depth is written a quarter step up
  (SwiftShader truncates the float). Lost, and logged (`SavedResource.lost`): multisampled integer color.
- **Carried:** the GPU worker answers `save` with the state, transferring the contents' buffers; the device adds its
  3D tables (devices.md "Snapshots"); the snapshot file carries the Uint8Arrays as BLOB frames (format version 2,
  platform.md "The snapshot file"); a restore hands the state to the new GPU worker (`load`) before it shows the scanout.
- **Refused** only while a context has video codecs or buffers (WebCodecs keeps its reference pictures, so a decode
  can't go on from a snapshot): "close the video player first". The page asks first, before it touches the machine
  (`Gpu.refusal`, the GPU worker's `refusal` call: `snapshotRefusal` alone, nothing read back; frontend.md "Snapshots").
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
Two extensions WebGL2 has can't reach the guest through virgl: multiview (`OVR_multiview2`: the guest's Mesa sets no
`multiview` cap for virgl, and virgl's protocol has no views) and `EXT_debug_marker` (Mesa 26.2 has none; virgl's
`STRING_MARKER` serves `KHR_debug`'s messages).
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

A second 3D path beside virgl, per machine (the Home page's Vulkan switch, `?gpu=vulkan`): the guest's Mesa
**Venus** driver (Debian's and Arch's, unmodified) serializes Vulkan, and a renderer of ours in wasm translates it onto
the browser's **WebGPU**, on the real GPU. Its frames reach the screen through the virgl renderer. Built in VK0 to VK3
(2026-10-25 to 10-29; bench/vulkan/REPORT.md has each phase and loop, "VK3: the summary" the state at VK3's end); the
bar it must meet and the decisions that bind it are [plans/graphics.md](plans/graphics.md), with VK4's tasks. Where the
parts are described in detail: the renderer's code in [vk/README.md](../vk/README.md), the device, the window and the
host's side in [devices.md](devices.md) "Venus" and "The host-visible window", the tests in [testing.md](testing.md)
"dEQP", the loose ends in [backlog.md](backlog.md) ("Platform and devices": the Vulkan entries).

**Programs it runs** beyond the tests' (each found by a track that ran it end to end): vkcube, vkmark, vkQuake, mpv on
Vulkan with VA-API, GTK4, ANGLE's ES3 and Dawn in the guest's Chromium, vkd3d's tests; and Godot 4.7.2 (GD, 2026-11-03
to 11-04): its editor, Forward+ and Mobile scenes, SDFGI, and its Global Illumination demo at 60 frames/s on NVIDIA,
under Wayland and X11 (X11's windows through Mesa's prime blit, vk/README.md "Presentation"). What GD left is in
backlog.md "Godot on Venus, GD's leftovers"; bench/vulkan/godot.ts and godot-disk.sh run it.

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
  (WebGPU tracks hazards); three queue families (graphics; compute; transfer), a queue each, all the one WebGPU queue; fences complete on `onSubmittedWorkDone`. vk/README.md "The driver".
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
| **Direct** | Draws (indexed, instanced, indirect), base vertex, compute, occlusion queries, copies, blits (as draws), mipmaps, BC/ETC2/ASTC where the adapter has them, MSAA at 4 samples, depth bias, stencil, depth clip off, mutable descriptors (VK4 T34: bind groups are made of the shader's declarations; a layout that could pass a stage's bindings isn't supported) | Core WebGPU, or `depth-clip-control` |
| **The adapter's features** | Clip distances, dual-source blending, `shaderFloat16` and 16-bit storage, subgroups (anchored where the page's check finds them wrong without, Chromium's Metal path; held where it finds them wrong both ways), first instance in indirect draws, timestamp queries, 16-bit normalized formats and read-write storage images | `clip-distances`, `dual-source-blending`, `shader-f16`, `subgroups`, `indirect-first-instance`, `timestamp-query`, `texture-formats-tier1/2` |
| **Shader rewrites** (no extra passes) | Combined image-samplers (split); specialization constants (frozen per pipeline); matrix and array varyings (split into vectors); input attachments (read as textures); texel buffers (storage buffers of the view's words, the format decoded in WGSL; past WebGPU's storage buffers, a stage's read-only words of one memory through one binding, a variant keyed by who shares it); dynamically indexed descriptor arrays (a tree of ifs); sample-rate shading; more than 12 uniform buffers a stage (read as read-only storage); draw parameters (words of the push buffer); YCbCr conversions (8-bit multi-planar formats, planes as textures); sampler state WebGPU's samplers lack (borders, mirror-once, LOD bias, unnormalized coordinates, min/max reductions, non-seamless cubes, depth views filtered without a comparison, gathers of cubes bound as their faces: a variant keyed by the bound sampler, from fetches where it filters); alpha to coverage at one sample (fragments under half alpha discarded), and where WebGPU's can't be (no colour target at location 0, a `sample_mask` output, alpha to one: the stage's own mask); alpha to one; depth biases WebGPU's integer one can't give (other representations, fractions, exact ones, D24's: the fragment's depth moved); `gl_Layer` from the vertex stage (a layered pass drawn a layer at a time, other layers' primitives clipped); 8- and 64-bit integers (bytes and pairs of words) and 16-bit inputs and outputs (widened to 32 bits) | At translation, in WGSL |
| **Compute before or after the pass** | The last vertex provoking (a draw's indices rotated); transform feedback (the vertex stage run as compute, after the pass; its queries counted by the captures); a draw by a byte count's arguments from its counter (VK4 T45); an indirect draw's parameters copied from its arguments; a draw-indirect-count's records gated by its count; a vertex stage that writes storage (VK4 T33: run as compute in a cut of the pass before its draw, a pass-through vertex stage drawing its outputs) | A compute pass, its outputs left on the GPU |
| **Copies and draws of the worker's** | Depth and stencil copies WebGPU refuses (draws and compute passes); copies between size-compatible formats (bytes through a temporary buffer); multisampled copies, and resolves WebGPU refuses: integer formats, parts of an image, 3D images, depth and stencil of every mode (draws); copies and blits within one buffer or subresource (through temporaries); clears as draws; attachment-less passes | |
| **Passes and bytes of the driver's** (VK4 T7) | Multiview (a pass per view); atomics on R32 images (the image's words in a buffer, copied to and from its texture); inline uniform blocks (a uniform buffer of the set's); device addresses (address memory placed at its first buffer's bind in an address buffer of regions, a GPUBuffer and binding each, a pointer's high word its region and its low word a byte of it; VK4 T41); the depth bounds test, logic ops and advanced blends (VK4 T32: the attachment copied before each such draw, in a cut of the pass, the stage testing or blending against the copy) | |
| **Not offered** | Sparse resources; 64-bit floats and 64-bit atomics in shaders; pipeline statistics queries; sample counts other than 1 and 4; full bindless (until WebGPU's binding arrays); geometry and tessellation (compute pre-passes, as libpoly does, when a program asks: VK4) | |

What each row still misses is in backlog.md "The Vulkan driver's gaps", "ANGLE's row's gaps", "YCbCr's gaps"; what
WebGPU itself stops is "Permanent limitations" below.

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

### Permanent limitations

What WebGPU doesn't allow at an acceptable cost, so not on the backlog: each line says what, why WebGPU stops it,
and what the device does instead. What is only expensive (geometry and tessellation as compute pre-passes, polygon
modes, several viewports, formats WebGPU can't multisample, update after bind) stays in backlog.md as an L task. The
census's no-task reasons (VK4-KICKOFF.md, "The census's tasks") are the first lines.

- **Sparse binding and residency**: WebGPU has no tiled or partly resident resources. Not advertised.
- **Protected memory**: no protected allocations or queues in WebGPU. Not advertised.
- **Ray tracing (pipelines, ray queries, acceleration structures)**: WebGPU has no ray tracing, and a BVH walk in
  compute would be a renderer of its own. Not advertised (and so mutable descriptors of acceleration structures).
- **Cooperative matrices**: WGSL has no matrix-unit operations, and loops of plain ALU work give none of the speed they
  exist for. Not advertised.
- **Tile images and fragment density maps or shading rates**: WebGPU exposes neither tile memory nor variable-rate
  shading. Not advertised.
- **Descriptor buffers**: descriptors as bytes in memory, where WebGPU's bind groups are opaque objects. Not advertised.
- **Pipeline statistics queries**: WebGPU counts no invocations or primitives, and counting them in the shaders needs
  writable storage in the vertex stage, which it lacks. `pipelineStatisticsQuery` isn't advertised.
- **`occlusionQueryPrecise`**: WebGPU's occlusion query promises nonzero, not a count, and a count of its own in the
  fragment stage would come before the depth test (WGSL has no early fragment tests). Counts are the adapter's.
- **Calibrated timestamps** (`VK_KHR_calibrated_timestamps`): WebGPU can't give the GPU's time now, synchronously. Not
  advertised. Timestamps are the GPU's where the adapter has `timestamp-query` (Chromium may quantize them: Dawn's
  `timestamp_quantization`, off only under `--enable-unsafe-webgpu`), else the CPU's at replay.
- **64-bit floats and 64-bit atomics in shaders** (`shaderFloat64`, `shaderBufferInt64Atomics` and the like): WGSL has
  neither; soft floats would cost every operation tens of instructions, and two 32-bit words can't be swapped as one.
  Not advertised (64-bit integers are pairs of words: VK4 T29).
- **Sample counts other than 1 and 4**: WebGPU multisamples at 4 only. Not advertised (every sample-count limit and
  format query is 1|4; vkd3d's 8-sample tests don't run).
- **More than 8 colour attachments** (Vulkan's 16): WebGPU's pass takes 8, and a pass replayed for the rest would run
  each draw's side effects (storage, atomics) twice. `maxColorAttachments` is the adapter's.
- **Depths past [0, 1]** (`VK_EXT_depth_range_unrestricted`; a float depth kept past the viewport's range with depth
  clipping off): WebGPU's viewport depths, and the fragment depth, are clamped to [0, 1] and the viewport's range.
  Not advertised; with clipping off the clamp to the viewport's range stays.
- **Stencil export** (a shader-written stencil reference): WGSL has no stencil output. Not advertised, so neither are
  stencil read-write feedback loops (300 of `attachment_feedback_loop_layout`).
- **Early fragment tests** (`early_fragment_tests`): WGSL has no attribute for them; whether depth tests run early is the
  adapter's. The execution mode is ignored (`fragment_operations.early_fragment` cases that count on it, such as
  `samplemask_early_fragment_tests_depth_samples_4`, stay out of the list).
- **One draw's front and back primitives in order with per-face stencil state**: WebGPU's stencil reference and masks
  are one for both faces, so such a draw is split by face (VK3 L6a), and where its front and back primitives overlap
  their order is lost.
- **Coherent advanced blends, logic ops and the depth bounds test within one draw**: WebGPU has no framebuffer fetch or
  raster-order guarantee, so they read a copy of the attachment made before each draw (VK4 T32) and overlapping
  primitives of one draw see what was there before it. `advancedBlendCoherentOperations` isn't advertised.
- **Images sharing their memory's bytes** (`memory.binding.aliasing.*.image_*`, maintenance6's aliasing, YCbCr's
  `plane_view.memory_alias`, images on external memory): a WebGPU texture is storage of its own, which no buffer or
  other texture can alias, and copies at every use would cost every image. Each image is a texture of its own; images
  on external memory aren't offered (`api.external.memory.*.image.*`).
- **Storage the fragment stage writes and the vertex stage reads in one draw**: WebGPU's vertex stage has no writable
  storage, and a buffer bound writable for the fragment stage can't be bound read-only for the vertex stage in the
  same usage scope. Refused at the pipeline's creation, saying why (a vertex stage that writes storage itself runs as
  compute before its draw: VK4 T33).
- **Subgroups beyond WGSL's**: WGSL has them in compute and fragment stages only, has no subgroup-scoped barrier, and
  gives a size the shader can ask for only through `subgroup-size-control` (experimental in Chromium). Subgroups are
  advertised in those stages only, of one invocation where the adapter's size varies (Intel's, AMD's), and a
  subgroup barrier is dropped.
- **Infinities and NaNs as values** (16-bit ones through `shader-f16`, a comparison with a NaN, log of 0): WGSL lets a
  backend assume none, so results differ by adapter (6 of 233 sampled `spirv_assembly.*.float16` cases on the Mac,
  vkd3d's `test_shader_instructions` `ne` and `log`). Nothing is changed.
- **The viewport's bounds and subpixel precision**: WebGPU's viewport range is ±2×`maxTextureDimension2D` and it states
  no subpixel bits, so `viewportBoundsRange` follows it and `viewportSubPixelBits` is 0 (vkd3d warns, at no cost to a
  feature level).
- **A pipeline cache the driver keeps**: WebGPU has no pipeline cache object, so a compile is kept only where the
  browser's own cache keeps it (Metal's and NVIDIA's across restarts, SwiftShader's not). The WGSL is kept in the page's
  storage (vk/README.md "The shader cache").
- **Bindless descriptor heaps** (vkd3d-proton's: huge unbounded mutable arrays updated after bind): WebGPU has no
  binding arrays yet, and a tree of ifs over thousands of descriptors in every access isn't a cost to pay. Not
  advertised past the per-stage limits (descriptor indexing's arrays are the translator's `if` trees).

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
  vfat)` (images/arch/build.sh sets it in `/etc/mkinitcpio.conf.d/waarm64.conf`).
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
the page's Debian tests on 3D (`WAARM64_PAGE_QUERY=gpu=2d scripts/ci-debian.sh` for the 2D path).

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
The census of 2026-11-09 (bench/gpu/REPORT.md "dEQP-GLES's census") ran both lists again: the same counts, no case
failing, every "not supported" WebGL2's limit, the run's configuration or a cap we didn't take from WebGL2's
extensions; independent blending and clip control from them since (REPORT.md "virgl's caps from WebGL2's extensions")
pass 85 more. **`scripts/ci-deqp.sh`** runs the pass lists in `tests/deqp/`, every case that passes (17,035 and
44,476): a seeded sample by default, `--full` the whole lists (docs/testing.md). Groups that caught regressions
a thin sample missed: GLES3's `lifetime`, `occlusion_query` and `texstorage2d/3d.format` (a query destroyed while
pending hung the guest; the drawn depth upload's `UNPACK_ALIGNMENT`); a sample takes an eighth of each.

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
the case dEQP stopped at, `stoppedAt`). A whole list runs as `ci-deqp.sh --full`, or in slices (`CASES` files of
the mustpass list's contiguous blocks, `JOBS=4 JOBS_BLOCK=16 PASSED=1 DETAIL=400`, two machines at once: the census's
fourteen slices took ~80 min on the dev VM); `DETAIL_NOTSUPPORTED=1` over the "not supported" cases gives dEQP's
reasons. A validation run, so other work may run beside it.

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
