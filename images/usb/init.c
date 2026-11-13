// The USB test kernel's init (docs/usb.md; images/build.sh linux-usb): Linux's xhci-plat-hcd on the
// machine's xHCI, its usbtest driver bound to Gadget Zero (web/usb-gadget-zero.ts and its native twin),
// and the kernel's testusb (tools/usb/testusb.c, built beside this) against it. Its parameters come from
// the kernel's command line, which hands init the ones it doesn't know as environment variables:
//
//   usb_devices=N   the Gadget Zeros the host attaches at start (default 0: only the root hubs)
//   usb_args=…      testusb's arguments, commas for spaces (default "-a")
//   usb_unplug=1    after a clean first pass, testusb runs again and again until a device goes away
//                   (the host unplugs it at a step count), then once more after all N are back
//                   (the host plugs it in again at a later step)
//
// It prints the root hubs ("usb: hub usb1 480 Mb/s 4 ports …"), each Gadget Zero with its speed and
// driver, testusb's own lines, a summary per pass ("usb: pass 1: 26 lines, 0 failed"), and
// "waarm64: usb test ok" when every pass that had to be clean was; then it powers off. The runners check
// that and the step count (core/tests/usb_guest.rs, tests/boot-node-suite.ts, tests/browser.test.ts).
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void die(const char *what) {
    printf("waarm64: usb test failed: %s\n", what);
    fflush(stdout);
    reboot(RB_POWER_OFF);
    exit(1);
}

static void nap(int ms) {
    struct timespec t = {ms / 1000, (ms % 1000) * 1000000L};
    nanosleep(&t, 0);
}

// A sysfs attribute's first line, or "" if there is none.
static const char *attr(const char *dir, const char *name) {
    static char buf[256];
    char path[512];
    snprintf(path, sizeof path, "/sys/bus/usb/devices/%s/%s", dir, name);
    buf[0] = 0;
    FILE *f = fopen(path, "r");
    if (!f)
        return buf;
    if (!fgets(buf, sizeof buf, f))
        buf[0] = 0;
    fclose(f);
    buf[strcspn(buf, "\n")] = 0;
    return buf;
}

static int by_name(const struct dirent **a, const struct dirent **b) {
    return strcmp((*a)->d_name, (*b)->d_name);
}

// The Gadget Zeros in sysfs (0525:a4a0), by name; prints each when `show`.
static int gadgets(int show) {
    struct dirent **e;
    int n = scandir("/sys/bus/usb/devices", &e, 0, by_name), found = 0;
    for (int i = 0; i < n; i++) {
        const char *d = e[i]->d_name;
        if (d[0] != '.' && !strchr(d, ':') && strncmp(d, "usb", 3) != 0 &&
            !strcmp(attr(d, "idVendor"), "0525") && !strcmp(attr(d, "idProduct"), "a4a0")) {
            found++;
            if (show) {
                char speed[32], conf[32], product[64], intf[300], link[300], drv[300] = "none";
                snprintf(speed, sizeof speed, "%s", attr(d, "speed"));
                snprintf(conf, sizeof conf, "%s", attr(d, "bConfigurationValue"));
                snprintf(product, sizeof product, "%s", attr(d, "product"));
                snprintf(intf, sizeof intf, "/sys/bus/usb/devices/%s:%s.0/driver", d, conf);
                ssize_t k = readlink(intf, link, sizeof link - 1);
                if (k > 0) {
                    link[k] = 0;
                    snprintf(drv, sizeof drv, "%s", strrchr(link, '/') ? strrchr(link, '/') + 1 : link);
                }
                printf("usb: gadget %s: %s, %s Mb/s, configuration %s, interface driver %s\n", d, product, speed, conf, drv);
            }
        }
        free(e[i]);
    }
    if (n > 0)
        free(e);
    return found;
}

// Waits up to `ms` of the guest's time for exactly `n` Gadget Zeros with usbtest bound.
static int wait_for(int n, int ms) {
    for (int t = 0; t <= ms; t += 10) {
        if (gadgets(0) == n) {
            nap(50); // usbtest's probe and the device nodes follow the device's
            return 1;
        }
        nap(10);
    }
    return 0;
}

// Runs testusb, its output passed through; the lines it printed and those that failed ("test N --> errno").
static void testusb(const char *args, int *lines, int *failed) {
    int p[2];
    if (pipe(p) < 0)
        die("pipe");
    pid_t pid = fork();
    if (pid == 0) {
        dup2(p[1], 1);
        dup2(p[1], 2);
        close(p[0]);
        close(p[1]);
        char cmd[512];
        snprintf(cmd, sizeof cmd, "/testusb,%s", args);
        char *argv[32];
        int argc = 0;
        for (char *tok = strtok(cmd, ","); tok && argc < 31; tok = strtok(0, ","))
            argv[argc++] = tok;
        argv[argc] = 0;
        execv(argv[0], argv);
        _exit(127);
    }
    close(p[1]);
    FILE *f = fdopen(p[0], "r");
    char line[512];
    *lines = *failed = 0;
    while (fgets(line, sizeof line, f)) {
        fputs(line, stdout);
        fflush(stdout);
        (*lines)++;
        if (strstr(line, " --> "))
            (*failed)++;
    }
    fclose(f);
    int status;
    waitpid(pid, &status, 0);
    if (!WIFEXITED(status) || WEXITSTATUS(status) == 127)
        die("testusb didn't run");
}

int main(void) {
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    setvbuf(stdout, 0, _IOLBF, 0);
    int want = getenv("usb_devices") ? atoi(getenv("usb_devices")) : 0;
    const char *args = getenv("usb_args") ? getenv("usb_args") : "-a";
    int unplug = getenv("usb_unplug") && atoi(getenv("usb_unplug"));

    // The root hubs: one per protocol (USB 2, USB 3), four ports each.
    nap(100);
    int hubs = 0;
    for (int i = 1; i <= 2; i++) {
        char d[8];
        snprintf(d, sizeof d, "usb%d", i);
        if (!attr(d, "speed")[0])
            continue;
        hubs++;
        char speed[32], ports[16], version[16];
        snprintf(speed, sizeof speed, "%s", attr(d, "speed"));
        snprintf(ports, sizeof ports, "%s", attr(d, "maxchild"));
        snprintf(version, sizeof version, "%s", attr(d, "version"));
        printf("usb: hub %s %s Mb/s %s ports, USB%s, %s\n", d, speed, ports, version, attr(d, "product"));
    }
    if (hubs != 2)
        die("not two root hubs");
    if (want == 0) {
        nap(200);
        if (gadgets(1) != 0)
            die("a device on an empty bus");
        printf("waarm64: usb test ok\n");
        reboot(RB_POWER_OFF);
        return 0;
    }
    if (!wait_for(want, 20000))
        die("the gadgets didn't enumerate");
    gadgets(1);

    int lines, failed;
    testusb(args, &lines, &failed);
    printf("usb: pass 1: %d lines, %d failed\n", lines, failed);
    if (failed || lines == 0)
        die("testusb's first pass");
    if (unplug) {
        int pass = 2;
        for (;; pass++) {
            if (pass > 40)
                die("no device went away");
            testusb(args, &lines, &failed);
            int now = gadgets(0);
            printf("usb: pass %d: %d lines, %d failed, %d of %d gadgets left\n", pass, lines, failed, now, want);
            if (now < want)
                break;
        }
        printf("usb: unplugged during pass %d\n", pass);
        if (!wait_for(want, 60000))
            die("the gadget didn't come back");
        printf("usb: plugged in again\n");
        gadgets(1);
        testusb(args, &lines, &failed);
        printf("usb: pass %d: %d lines, %d failed\n", pass + 1, lines, failed);
        if (failed || lines == 0)
            die("testusb's pass after the replug");
    }
    printf("waarm64: usb test ok\n");
    reboot(RB_POWER_OFF);
    return 0;
}
