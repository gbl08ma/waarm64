// The native baseline for bench/usb/run.ts: the same transfers through usbfs's synchronous ioctls, no browser.
// It separates what Chromium's WebUSB costs from what dummy_hcd itself costs (bench/usb/REPORT.md).
//   cc -O2 -o target/usb/native bench/usb/native.c && target/usb/native /dev/bus/usb/BBB/DDD [n]
// Gadget Zero's bulk endpoints are 0x81 (IN) and 0x02 (OUT) in both configurations.
// Prints one JSON object: median and p99 per transfer (ms), and sequential bulk throughput (MB/s).
#include <errno.h>
#include <fcntl.h>
#include <linux/usbdevice_fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

static int fd;
static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}
static int cmp(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}
static void die(const char *what) {
  fprintf(stderr, "native: %s: %s\n", what, strerror(errno));
  exit(1);
}
static int ctrl(unsigned char type, unsigned char req, unsigned short value, unsigned short len, void *buf) {
  struct usbdevfs_ctrltransfer c = {.bRequestType = type, .bRequest = req, .wValue = value, .wIndex = 0, .wLength = len, .timeout = 1000, .data = buf};
  return ioctl(fd, USBDEVFS_CONTROL, &c);
}
static int bulk(unsigned ep, void *buf, unsigned len) {
  struct usbdevfs_bulktransfer b = {.ep = ep, .len = len, .timeout = 1000, .data = buf};
  return ioctl(fd, USBDEVFS_BULK, &b);
}

static unsigned char buf[1 << 20];
static int n = 200;
enum { CTRL_DESC, CTRL_VIN, CTRL_VOUT, BULK_IN, BULK_OUT, ECHO };
static const char *names[] = {"control_get_descriptor", "control_vendor_in_8", "control_vendor_out_8", "bulk_in_512", "bulk_out_512", "loopback_echo_64"};

static int once(int what) {
  switch (what) {
    case CTRL_DESC: return ctrl(0x80, 6, 0x0100, 18, buf);
    case CTRL_VIN: return ctrl(0xc0, 0x5c, 0, 8, buf);
    case CTRL_VOUT: return ctrl(0x40, 0x5b, 0, 8, buf);
    case BULK_IN: return bulk(0x81, buf, 512);
    case BULK_OUT: return bulk(0x02, buf, 512);
    case ECHO:
      if (bulk(0x02, buf, 64) != 64) return -1;
      return bulk(0x81, buf, 512);
  }
  return -1;
}

static void measure(int what, int first) {
  double *t = malloc(n * sizeof *t);
  for (int i = 0; i < 20; i++)
    if (once(what) < 0) die(names[what]);
  for (int i = 0; i < n; i++) {
    double t0 = now();
    if (once(what) < 0) die(names[what]);
    t[i] = now() - t0;
  }
  qsort(t, n, sizeof *t, cmp);
  printf("%s\"%s\": {\"median\": %.4f, \"p99\": %.4f}", first ? "" : ", ", names[what], t[n / 2], t[n * 99 / 100]);
  free(t);
}

static void setconfig(int c) {
  unsigned iface = 0;
  ioctl(fd, USBDEVFS_RELEASEINTERFACE, &iface);
  if (ioctl(fd, USBDEVFS_SETCONFIGURATION, &c) < 0) die("SETCONFIGURATION");
  if (ioctl(fd, USBDEVFS_CLAIMINTERFACE, &iface) < 0) die("CLAIMINTERFACE");
}

int main(int argc, char **argv) {
  if (argc < 2) return fprintf(stderr, "usage: native /dev/bus/usb/BBB/DDD [n]\n"), 2;
  if (argc > 2) n = atoi(argv[2]);
  fd = open(argv[1], O_RDWR);
  if (fd < 0) die(argv[1]);
  setconfig(1);
  printf("{\"latencyMs\": {");
  for (int w = CTRL_DESC; w <= BULK_OUT; w++) measure(w, w == CTRL_DESC);
  setconfig(2);
  measure(ECHO, 0);
  setconfig(1);
  printf("}, \"throughput\": [");
  unsigned sizes[] = {4096, 65536, 1 << 20};
  for (int s = 0; s < 3; s++) {
    double mb[2];
    for (int dir = 0; dir < 2; dir++) {
      double t0 = now(), bytes = 0;
      while (now() - t0 < 1500) {
        int r = bulk(dir ? 0x02 : 0x81, buf, sizes[s]);
        if (r < 0) die("bulk throughput");
        bytes += r;
      }
      mb[dir] = bytes / (now() - t0) / 1e3;
    }
    printf("%s{\"size\": %u, \"depth\": 1, \"inMBps\": %.1f, \"outMBps\": %.1f}", s ? ", " : "", sizes[s], mb[0], mb[1]);
  }
  printf("]}\n");
  return 0;
}
