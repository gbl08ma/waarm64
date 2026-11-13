// The init of the USB test kernel for real devices (docs/usb.md "The usbhost guest"; images/build.sh
// linux-usbhost): the guest end of the guest-level tests through WebUSB and WebHID (scripts/ci-usb.sh).
// `usb_mode=` on the kernel's command line picks what it does:
//
//   testusb   images/usb/init.c's run (usb_devices=N, usb_args=…): testusb against Gadget Zeros, here
//             the dev VM's dummy_hcd gadget through the WebUSB passthrough
//   acm       the guest's cdc_acm on the ACM gadget: open /dev/ttyACM0, write, read the host's echo back,
//             close; usb_rounds= times (default 3). Each close cancels cdc_acm's reads, so the next open's
//             reads get what the cancelled ones' transfers brought (the passthrough's carry-over)
//   hid       usbhid on a WebHID device: print the report descriptor the guest got, read usb_inputs=
//             input reports from /dev/hidraw0, write the output report usb_out=<hex>, set the feature
//             report usb_setf=<hex>, get feature report usb_getf=<id>:<length>
//
// It prints what it saw ("acm: round 1: 300 bytes echoed", "hid: rdesc <hex>", "hid: input <hex>", …)
// and "waarm64: usb test ok" when every step worked; then it powers off. The tests check the lines.
#define main usb_test_main
#include "../usb/init.c"
#undef main

#include <linux/hidraw.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <termios.h>

static const char *env(const char *name, const char *dflt) {
    const char *v = getenv(name);
    return v ? v : dflt;
}

// Waits up to `ms` of the guest's time for `path` to exist.
static int appears(const char *path, int ms) {
    for (int t = 0; t <= ms; t += 20) {
        if (access(path, F_OK) == 0)
            return 1;
        nap(20);
    }
    return 0;
}

static void hex(const char *what, const unsigned char *b, int n) {
    printf("%s ", what);
    for (int i = 0; i < n; i++)
        printf("%02x", b[i]);
    printf("\n");
}

static int unhex(const char *s, unsigned char *out, int max) {
    int n = 0;
    while (s[0] && s[1] && n < max) {
        unsigned v;
        if (sscanf(s, "%2x", &v) != 1)
            break;
        out[n++] = v;
        s += 2;
    }
    return n;
}

// Reads `n` bytes from `fd` within `ms`, or fewer.
static int read_all(int fd, unsigned char *b, int n, int ms) {
    int got = 0;
    struct pollfd p = {fd, POLLIN, 0};
    while (got < n) {
        int r = poll(&p, 1, ms);
        if (r <= 0)
            break;
        ssize_t k = read(fd, b + got, n - got);
        if (k <= 0)
            break;
        got += k;
    }
    return got;
}

static int acm(void) {
    if (!appears("/dev/ttyACM0", 30000))
        die("no /dev/ttyACM0");
    int rounds = atoi(env("usb_rounds", "3"));
    for (int r = 1; r <= rounds; r++) {
        int fd = open("/dev/ttyACM0", O_RDWR | O_NOCTTY);
        if (fd < 0)
            die("open /dev/ttyACM0");
        struct termios t;
        tcgetattr(fd, &t);
        cfmakeraw(&t);
        cfsetspeed(&t, B115200);
        tcsetattr(fd, TCSANOW, &t);
        // More than one packet (64 bytes at full speed, 512 at high), different every round.
        unsigned char out[300], in[300];
        for (int i = 0; i < (int)sizeof out; i++)
            out[i] = (unsigned char)(r * 37 + i * 7);
        if (write(fd, out, sizeof out) != (ssize_t)sizeof out)
            die("write /dev/ttyACM0");
        int got = read_all(fd, in, sizeof in, 10000);
        int same = got == (int)sizeof in && !memcmp(in, out, sizeof in);
        printf("acm: round %d: %d of %d bytes echoed%s\n", r, got, (int)sizeof out, same ? "" : ", differ");
        close(fd);
        if (!same)
            die("the echo");
    }
    return 0;
}

static int hid(void) {
    if (!appears("/dev/hidraw0", 30000))
        die("no /dev/hidraw0");
    // The report descriptor the guest got (usbhid's copy, as hid-core parsed it).
    unsigned char rd[4096];
    int fd = open("/dev/hidraw0", O_RDWR);
    if (fd < 0)
        die("open /dev/hidraw0");
    int size = 0;
    if (ioctl(fd, HIDIOCGRDESCSIZE, &size) < 0)
        die("HIDIOCGRDESCSIZE");
    struct hidraw_report_descriptor *d = malloc(sizeof *d);
    d->size = size;
    if (ioctl(fd, HIDIOCGRDESC, d) < 0)
        die("HIDIOCGRDESC");
    hex("hid: rdesc", d->value, d->size);
    printf("hid: ready\n");
    int inputs = atoi(env("usb_inputs", "3"));
    for (int i = 0; i < inputs; i++) {
        struct pollfd p = {fd, POLLIN, 0};
        if (poll(&p, 1, 20000) <= 0)
            die("no input report");
        ssize_t k = read(fd, rd, sizeof rd);
        if (k <= 0)
            die("read /dev/hidraw0");
        hex("hid: input", rd, k);
    }
    const char *o = getenv("usb_out");
    if (o) {
        int n = unhex(o, rd, sizeof rd);
        ssize_t k = write(fd, rd, n);
        printf("hid: output %zd of %d bytes\n", k, n);
        if (k != n)
            die("the output report");
    }
    const char *sf = getenv("usb_setf");
    if (sf) {
        int n = unhex(sf, rd, sizeof rd);
        int k = ioctl(fd, HIDIOCSFEATURE(n), rd);
        printf("hid: set feature %d of %d bytes\n", k, n);
        if (k != n)
            die("the feature report");
    }
    const char *gf = getenv("usb_getf");
    if (gf) {
        int id = 0, n = 0;
        sscanf(gf, "%d:%d", &id, &n);
        memset(rd, 0, sizeof rd);
        rd[0] = id;
        int k = ioctl(fd, HIDIOCGFEATURE(n), rd);
        if (k <= 0)
            die("HIDIOCGFEATURE");
        hex("hid: feature", rd, k);
    }
    close(fd);
    return 0;
}

int main(void) {
    const char *mode = env("usb_mode", "testusb");
    if (!strcmp(mode, "testusb"))
        return usb_test_main();
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    setvbuf(stdout, 0, _IOLBF, 0);
    if (!strcmp(mode, "acm"))
        acm();
    else if (!strcmp(mode, "hid"))
        hid();
    else
        die("unknown usb_mode");
    printf("waarm64: usb test ok\n");
    reboot(RB_POWER_OFF);
    return 0;
}
