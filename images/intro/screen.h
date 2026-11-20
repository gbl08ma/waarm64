// The toys' screen (images/intro/: scope.c, ridges.c, life.c): the framebuffer (/dev/fb0, 32 bits a
// pixel, any size) behind a buffer of brightness, a byte a pixel, shown through one ramp of color:
// black, the page's orange, a warm white where traces cross. A toy adds light with `dot` and `line`
// and calls `show` once a frame, which also lets the light fade, as a phosphor does.
#include <fcntl.h>
#include <linux/fb.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

static int W, H;
static uint8_t *lum;       // brightness, W × H
static uint32_t *fb;       // the framebuffer's pixels
static int fb_stride;      // its row, in pixels
static uint32_t ramp[256]; // brightness to x8r8g8b8

static void screen_open(void) {
  struct fb_var_screeninfo var;
  struct fb_fix_screeninfo fix;
  int fd = open("/dev/fb0", O_RDWR);
  if (fd < 0 || ioctl(fd, FBIOGET_VSCREENINFO, &var) || ioctl(fd, FBIOGET_FSCREENINFO, &fix) || var.bits_per_pixel != 32)
    exit(1);
  W = var.xres, H = var.yres, fb_stride = fix.line_length / 4;
  fb = mmap(0, fix.line_length * H, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  lum = calloc(W, H);
  if (fb == MAP_FAILED || !lum) exit(1);
  // One toy has the screen at a time: the one before is told to stop (/tmp/toy holds its process).
  // (No stdio in the toys: it would be most of their bytes.)
  char note[16] = "";
  int tf = open("/tmp/toy", O_RDWR | O_CREAT, 0644);
  if (tf >= 0) {
    if (read(tf, note, sizeof note - 1) > 0 && atoi(note) > 1 && atoi(note) != getpid()) kill(atoi(note), SIGTERM);
    int me = getpid(), n = sizeof note;
    note[--n] = '\n';
    do note[--n] = '0' + me % 10; while (me /= 10);
    if (ftruncate(tf, 0) || pwrite(tf, note + n, sizeof note - n, 0) < 0) exit(1);
    close(tf);
  }
  // The ramp: an ember up to the orange (#fa6432) at 176, then toward white.
  for (int i = 0; i < 256; i++) {
    int r, g, b;
    if (i < 176) r = 250 * i / 176, g = 100 * i / 176, b = 50 * i / 176;
    else r = 250 + 5 * (i - 176) / 79, g = 100 + 140 * (i - 176) / 79, b = 50 + 170 * (i - 176) / 79;
    ramp[i] = r << 16 | g << 8 | b;
  }
}

// Adds `v` of light to a pixel.
static inline void dot(int x, int y, int v) {
  if ((unsigned)x >= (unsigned)W || (unsigned)y >= (unsigned)H) return;
  uint8_t *p = &lum[y * W + x];
  v += *p;
  *p = v > 255 ? 255 : v;
}

// Adds `v` (of 256) of light at a point between pixels, x and y in 1/256ths of one.
static inline void glow(int x, int y, int v) {
  int fx = x & 255, fy = y & 255;
  x >>= 8, y >>= 8;
  dot(x, y, v * (256 - fx) * (256 - fy) >> 16);
  dot(x + 1, y, v * fx * (256 - fy) >> 16);
  dot(x, y + 1, v * (256 - fx) * fy >> 16);
  dot(x + 1, y + 1, v * fx * fy >> 16);
}

// A line of light between two points in 1/256ths of a pixel, a `glow` every half pixel.
static inline void line(int x0, int y0, int x1, int y1, int v) {
  int dx = x1 - x0, dy = y1 - y0;
  int n = (abs(dx) > abs(dy) ? abs(dx) : abs(dy)) / 128 + 1;
  for (int i = 0; i < n; i++) glow(x0 + dx * i / n, y0 + dy * i / n, v);
}

// Shows the frame; what was lit keeps `keep`/256 of its light for the next one (0: none).
static inline void show(int keep) {
  for (int y = 0; y < H; y++) {
    uint8_t *l = &lum[y * W];
    uint32_t *p = &fb[y * fb_stride];
    for (int x = 0; x < W; x++) p[x] = ramp[l[x]], l[x] = l[x] * keep >> 8;
  }
}

// Sleeps to the next frame of `fps` a second; the count of frames so far.
static inline int frame(int fps) {
  static struct timespec next;
  static int n;
  if (!n) clock_gettime(CLOCK_MONOTONIC, &next);
  next.tv_nsec += 1000000000 / fps;
  if (next.tv_nsec >= 1000000000) next.tv_nsec -= 1000000000, next.tv_sec++;
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  // Behind by more than a frame (the tab was paused): start from now, don't run to catch up.
  if (now.tv_sec > next.tv_sec || (now.tv_sec == next.tv_sec && now.tv_nsec > next.tv_nsec)) next = now;
  else clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, 0);
  return n++;
}

// A number that differs from run to run and call to call.
static inline uint32_t dice(void) {
  static uint32_t s;
  if (!s) {
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    s = (t.tv_nsec ^ t.tv_sec ^ getpid() << 16) | 1;
  }
  s ^= s << 13, s ^= s >> 17, s ^= s << 5;
  return s;
}
