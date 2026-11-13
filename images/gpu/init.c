// The gpu test kernel's init (M8 graphics G1 loop 3; images/build.sh linux-gpu): drives the
// virtio-gpu through KMS ioctls (no libdrm), prints what it saw, powers off. The host reads the
// scanout and the cursor back and compares hashes (tests/gpu-guest.test.ts, core/tests/gpu_guest.rs).
//
//   1. the connector: connected, its modes and physical size come from our EDID;
//   2. a dumb buffer in the preferred mode, a gradient, SETCRTC: a full transfer and flush;
//   3. a rectangle drawn, DIRTYFB with its clip: only that is transferred; then a pixel written
//      outside it without telling anybody (the host must not see it);
//   4. a cursor (64x64 ARGB, hotspot 5,6), moved;
//   5. the host changes the display's size (a display event after the flushes above): the
//      connector's preferred mode changes, and a buffer of the new size is shown.
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>

static int fd;

static void nap(int ms) {
    struct timespec t = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&t, 0);
}

static void die(const char *what) {
    printf("waarm64: gpu test failed: %s\n", what);
    fflush(stdout);
    reboot(RB_POWER_OFF);
    exit(1);
}

static void io(unsigned long req, void *arg, const char *what) {
    if (ioctl(fd, req, arg) < 0) {
        char m[96];
        snprintf(m, sizeof m, "%s: %m", what);
        die(m);
    }
}

#define P(x) ((uint64_t)(uintptr_t)(x))

struct buf { uint32_t handle, pitch, fb; uint64_t size; uint32_t *px; int w, h; };

static struct buf dumb(int w, int h) {
    struct drm_mode_create_dumb c = { .width = w, .height = h, .bpp = 32 };
    io(DRM_IOCTL_MODE_CREATE_DUMB, &c, "create dumb");
    struct buf b = { .handle = c.handle, .pitch = c.pitch, .size = c.size, .w = w, .h = h };
    struct drm_mode_map_dumb m = { .handle = c.handle };
    io(DRM_IOCTL_MODE_MAP_DUMB, &m, "map dumb");
    b.px = mmap(0, c.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, m.offset);
    if (b.px == MAP_FAILED) die("mmap dumb");
    return b;
}

static void addfb(struct buf *b) {
    struct drm_mode_fb_cmd f = { .width = b->w, .height = b->h, .pitch = b->pitch, .bpp = 32, .depth = 24, .handle = b->handle };
    io(DRM_IOCTL_MODE_ADDFB, &f, "addfb");
    b->fb = f.fb_id;
}

static void gradient(struct buf *b) {
    for (int y = 0; y < b->h; y++) {
        uint32_t *row = b->px + (size_t)y * b->pitch / 4;
        for (int x = 0; x < b->w; x++)
            row[x] = ((x * 255 / b->w) << 16) | ((y * 255 / b->h) << 8) | ((x ^ y) & 0xff);
    }
}

static void rect(struct buf *b, int x0, int y0, int w, int h, uint32_t c) {
    for (int y = y0; y < y0 + h; y++)
        for (int x = x0; x < x0 + w; x++) b->px[(size_t)y * b->pitch / 4 + x] = c;
}

static void dirty(struct buf *b, int x1, int y1, int x2, int y2) {
    struct drm_clip_rect clip = { x1, y1, x2, y2 };
    struct drm_mode_fb_dirty_cmd d = { .fb_id = b->fb, .num_clips = 1, .clips_ptr = P(&clip) };
    io(DRM_IOCTL_MODE_DIRTYFB, &d, "dirtyfb");
}

static uint32_t crtc, conn;

static struct drm_mode_modeinfo preferred(int *count, uint32_t *mm_w, uint32_t *mm_h, int *connected) {
    struct drm_mode_get_connector c = { .connector_id = conn };
    io(DRM_IOCTL_MODE_GETCONNECTOR, &c, "getconnector");
    int n = c.count_modes;
    struct drm_mode_modeinfo *modes = calloc(n ? n : 1, sizeof *modes);
    struct drm_mode_get_connector d = { .connector_id = conn, .count_modes = n, .modes_ptr = P(modes) };
    io(DRM_IOCTL_MODE_GETCONNECTOR, &d, "getconnector (modes)");
    *count = d.count_modes;
    *mm_w = d.mm_width;
    *mm_h = d.mm_height;
    *connected = d.connection == 1;
    struct drm_mode_modeinfo m = {0};
    for (int k = 0; k < (int)d.count_modes && k < n; k++)
        if (k == 0 || (modes[k].type & DRM_MODE_TYPE_PREFERRED)) m = modes[k];
    free(modes);
    return m;
}

static void setcrtc(struct buf *b, struct drm_mode_modeinfo *m) {
    uint32_t c = conn;
    struct drm_mode_crtc s = { .set_connectors_ptr = P(&c), .count_connectors = 1, .crtc_id = crtc, .fb_id = b->fb, .mode_valid = 1, .mode = *m };
    io(DRM_IOCTL_MODE_SETCRTC, &s, "setcrtc");
}

int main(void) {
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    printf("waarm64: gpu-test\n");
    for (int i = 0; i < 500; i++) {
        fd = open("/dev/dri/card0", O_RDWR);
        if (fd >= 0) break;
        nap(10);
    }
    if (fd < 0) die("no /dev/dri/card0");

    struct drm_mode_card_res r = {0};
    io(DRM_IOCTL_MODE_GETRESOURCES, &r, "getresources");
    uint32_t crtcs[8], conns[8], encs[8], fbs[8];
    struct drm_mode_card_res r2 = { .count_crtcs = 8, .crtc_id_ptr = P(crtcs), .count_connectors = 8, .connector_id_ptr = P(conns), .count_encoders = 8, .encoder_id_ptr = P(encs), .count_fbs = 0, .fb_id_ptr = P(fbs) };
    if (r.count_crtcs > 8 || r.count_connectors > 8 || r.count_encoders > 8) die("too many objects");
    io(DRM_IOCTL_MODE_GETRESOURCES, &r2, "getresources (ids)");
    printf("gpu: %u crtc %u connector %u encoder, max %ux%u\n", r2.count_crtcs, r2.count_connectors, r2.count_encoders, r2.max_width, r2.max_height);
    if (r2.count_crtcs != 1 || r2.count_connectors != 1) die("not one crtc and one connector");
    crtc = crtcs[0];
    conn = conns[0];

    int nmodes, connected;
    uint32_t mm_w, mm_h;
    struct drm_mode_modeinfo mode = preferred(&nmodes, &mm_w, &mm_h, &connected);
    printf("gpu: connector %s, %d mode%s, preferred %ux%u@%u, %ux%u mm\n", connected ? "connected" : "disconnected", nmodes, nmodes == 1 ? "" : "s", mode.hdisplay, mode.vdisplay, mode.vrefresh, mm_w, mm_h);
    if (!connected || !nmodes) die("no mode");

    // 2. The first picture.
    struct buf a = dumb(mode.hdisplay, mode.vdisplay);
    addfb(&a);
    gradient(&a);
    setcrtc(&a, &mode);
    printf("gpu: mode set %dx%d pitch %u\n", a.w, a.h, a.pitch);

    // 3. Damage: a rectangle, with its clip; then a write nobody is told about.
    rect(&a, 100, 80, 200, 100, 0x0000ff00);
    rect(&a, 120, 100, 160, 8, 0x00ffffff);
    dirty(&a, 100, 80, 300, 180);
    a.px[(size_t)10 * a.pitch / 4 + 10] = 0x00ff00ff; // silent: the host never transfers it
    printf("gpu: damage sent\n");

    // 4. The cursor: 64x64 ARGB, a hotspot, moved.
    struct buf c = dumb(64, 64);
    for (int y = 0; y < 64; y++)
        for (int x = 0; x < 64; x++) c.px[y * c.pitch / 4 + x] = (x < 32) ? (0xff000000u | (x << 18) | (y << 2)) : (((y * 4) << 24) | 0x00ffffff);
    struct drm_mode_cursor2 cur = { .flags = DRM_MODE_CURSOR_BO, .crtc_id = crtc, .x = 11, .y = 12, .width = 64, .height = 64, .handle = c.handle, .hot_x = 5, .hot_y = 6 };
    io(DRM_IOCTL_MODE_CURSOR2, &cur, "cursor set");
    struct drm_mode_cursor mv = { .flags = DRM_MODE_CURSOR_MOVE, .crtc_id = crtc, .x = 200, .y = 150 };
    io(DRM_IOCTL_MODE_CURSOR, &mv, "cursor move");
    printf("gpu: cursor set and moved\n");

    // 5. The host changes the display: wait for the preferred mode to change.
    struct drm_mode_modeinfo next = mode;
    for (int i = 0; i < 1000; i++) {
        next = preferred(&nmodes, &mm_w, &mm_h, &connected);
        if (next.hdisplay != mode.hdisplay || next.vdisplay != mode.vdisplay) break;
        nap(10);
    }
    printf("gpu: preferred now %ux%u, %ux%u mm\n", next.hdisplay, next.vdisplay, mm_w, mm_h);
    if (next.hdisplay == mode.hdisplay && next.vdisplay == mode.vdisplay) die("no display event");
    struct buf b = dumb(next.hdisplay, next.vdisplay);
    addfb(&b);
    gradient(&b);
    rect(&b, 50, 40, 100, 60, 0x00ff0000);
    setcrtc(&b, &next);
    printf("gpu: mode set %dx%d\n", b.w, b.h);

    printf("waarm64: gpu test ok\n");
    fflush(stdout);
    reboot(RB_POWER_OFF);
    return 0;
}
