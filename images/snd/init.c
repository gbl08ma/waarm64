// The snd test kernel's init (audio S1; images/build.sh linux-snd): plays a known waveform on the
// virtio-snd's playback stream through ALSA's ioctls (no alsa-lib), prints what it saw and what it
// wrote, powers off. The host's sink hashes what it was given; the runners compare that with the
// checksum printed here (core/tests/snd_guest.rs, tests/boot-node-suite.ts, tests/browser.test.ts).
//
//   1. the card and the PCM: their names, and what the device offers (HW_REFINE on "any");
//   2. hw params S16_LE, 48 kHz, stereo, periods of 1024 frames, 4 of them; sw params that start
//      at a full buffer and never stop on an underrun (the deterministic sink plays a message as
//      soon as it's posted, so the buffer runs dry after every write);
//   3. 48 periods of frames (or, with `snd_seconds=N` on the kernel's command line, which init gets as an
//      environment variable, N seconds' worth: the page's realtime runs) of a 440 Hz sine on the left and
//      a 660 Hz one on the right (a whole number of periods: the driver sends whole periods only), written a period at a time, then a drain of
//      what's still queued (a drop if nothing is);
//   4. "snd: wrote <frames> frames fnv1a <hash>": FNV-1a (32-bit) of the bytes written;
//   5. the capture PCM (audio S4) with the same parameters: 16 periods read (or `snd_rec_seconds=N`' worth), then
//      "snd: recorded <frames> frames fnv1a <hash> in <ms> ms, <hz> Hz left, <hz> Hz right": the hash of what it
//      read, its own time for it, and each channel's frequency by its rising zero crossings (the deterministic
//      source's 1 and 1.5 kHz triangles; 0 for silence).
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <sound/asound.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <time.h>
#include <unistd.h>

#define RATE 48000
#define CHANNELS 2
#define PERIOD 1024
#define PERIODS 4

static void die(const char *what) {
    printf("webpc: snd test failed: %s\n", what);
    fflush(stdout);
    reboot(RB_POWER_OFF);
    exit(1);
}

static void io(int fd, unsigned long req, void *arg, const char *what) {
    if (ioctl(fd, req, arg) < 0) {
        char m[96];
        snprintf(m, sizeof m, "%s: %m", what);
        die(m);
    }
}

static struct snd_mask *mask(struct snd_pcm_hw_params *p, int n) {
    return &p->masks[n - SNDRV_PCM_HW_PARAM_FIRST_MASK];
}

static struct snd_interval *interval(struct snd_pcm_hw_params *p, int n) {
    return &p->intervals[n - SNDRV_PCM_HW_PARAM_FIRST_INTERVAL];
}

// Everything allowed: what alsa-lib's snd_pcm_hw_params_any starts from.
static void any(struct snd_pcm_hw_params *p) {
    memset(p, 0, sizeof *p);
    for (int n = SNDRV_PCM_HW_PARAM_FIRST_MASK; n <= SNDRV_PCM_HW_PARAM_LAST_MASK; n++)
        memset(mask(p, n), 0xff, sizeof(struct snd_mask));
    for (int n = SNDRV_PCM_HW_PARAM_FIRST_INTERVAL; n <= SNDRV_PCM_HW_PARAM_LAST_INTERVAL; n++)
        interval(p, n)->max = ~0u;
    p->rmask = ~0u;
    p->info = ~0u;
}

static void set_mask(struct snd_pcm_hw_params *p, int n, unsigned bit) {
    struct snd_mask *m = mask(p, n);
    memset(m, 0, sizeof *m);
    m->bits[bit >> 5] = 1u << (bit & 31);
}

static void set_interval(struct snd_pcm_hw_params *p, int n, unsigned v) {
    struct snd_interval *i = interval(p, n);
    i->min = i->max = v;
    i->openmin = i->openmax = 0;
    i->integer = 1;
}

static uint32_t fnv(uint32_t h, const uint8_t *b, size_t n) {
    for (size_t k = 0; k < n; k++) h = (h ^ b[k]) * 0x01000193u;
    return h;
}

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

// The virtio lines of /proc/interrupts (a failure's diagnostic).
static void irqs(void) {
    mount("proc", "/proc", "proc", 0, 0);
    FILE *f = fopen("/proc/interrupts", "r");
    char line[256];
    while (f && fgets(line, sizeof line, f))
        if (strstr(line, "virtio3") || strstr(line, "timer") || strstr(line, "IPI0") || strstr(line, "IPI1")) printf("snd: irq %s", line);
    if (f) fclose(f);
}

// hw params S16_LE, RATE, CHANNELS, PERIOD x PERIODS on `fd`; prints them with `what`.
static void hw(int fd, const char *what) {
    struct snd_pcm_hw_params p;
    any(&p);
    set_mask(&p, SNDRV_PCM_HW_PARAM_ACCESS, SNDRV_PCM_ACCESS_RW_INTERLEAVED);
    set_mask(&p, SNDRV_PCM_HW_PARAM_FORMAT, SNDRV_PCM_FORMAT_S16_LE);
    set_mask(&p, SNDRV_PCM_HW_PARAM_SUBFORMAT, SNDRV_PCM_SUBFORMAT_STD);
    set_interval(&p, SNDRV_PCM_HW_PARAM_CHANNELS, CHANNELS);
    set_interval(&p, SNDRV_PCM_HW_PARAM_RATE, RATE);
    set_interval(&p, SNDRV_PCM_HW_PARAM_PERIOD_SIZE, PERIOD);
    set_interval(&p, SNDRV_PCM_HW_PARAM_PERIODS, PERIODS);
    io(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &p, "hw params");
    printf("snd: %s %u Hz, %u channels, period %u frames, buffer %u frames\n", what,
           interval(&p, SNDRV_PCM_HW_PARAM_RATE)->min, interval(&p, SNDRV_PCM_HW_PARAM_CHANNELS)->min,
           interval(&p, SNDRV_PCM_HW_PARAM_PERIOD_SIZE)->min, interval(&p, SNDRV_PCM_HW_PARAM_BUFFER_SIZE)->min);
}

// Records `periods` periods from the capture PCM and prints what it got (5. above).
static void record(int periods) {
    int fd = open("/dev/snd/pcmC0D0c", O_RDWR);
    if (fd < 0) die("no /dev/snd/pcmC0D0c");
    hw(fd, "capture hw params");
    struct snd_pcm_sw_params sw = {
        .tstamp_mode = SNDRV_PCM_TSTAMP_NONE,
        .period_step = 1,
        .avail_min = PERIOD,
        .start_threshold = (snd_pcm_uframes_t)-1 >> 1, // started by the START ioctl below
        .stop_threshold = (snd_pcm_uframes_t)-1 >> 1, // never: an overrun just loses frames
        .proto = SNDRV_PCM_VERSION,
    };
    io(fd, SNDRV_PCM_IOCTL_SW_PARAMS, &sw, "capture sw params");
    io(fd, SNDRV_PCM_IOCTL_PREPARE, 0, "capture prepare");
    io(fd, SNDRV_PCM_IOCTL_START, 0, "capture start");
    static int16_t buf[PERIOD * CHANNELS];
    uint32_t h = 0x811c9dc5u;
    long rising[CHANNELS] = { 0 };
    int16_t last[CHANNELS] = { 0 };
    double t0 = now_ms();
    for (int k = 0; k < periods; k++) {
        struct snd_xferi x = { .buf = buf, .frames = PERIOD };
        io(fd, SNDRV_PCM_IOCTL_READI_FRAMES, &x, "read");
        if (x.result != PERIOD) die("short read");
        h = fnv(h, (const uint8_t *)buf, sizeof buf);
        for (int f = 0; f < PERIOD; f++)
            for (int c = 0; c < CHANNELS; c++) {
                int16_t v = buf[f * CHANNELS + c];
                if ((k > 0 || f > 0) && last[c] < 0 && v >= 0) rising[c]++;
                last[c] = v;
            }
    }
    double ms = now_ms() - t0;
    io(fd, SNDRV_PCM_IOCTL_DROP, 0, "capture drop");
    close(fd);
    long frames = (long)periods * PERIOD;
    printf("snd: recorded %ld frames fnv1a %08x in %.0f ms, %ld Hz left, %ld Hz right\n", frames, h, ms,
           rising[0] * RATE / frames, rising[1] * RATE / frames);
}

int main(void) {
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    setvbuf(stdout, 0, _IOLBF, 0);

    int ctl = open("/dev/snd/controlC0", O_RDWR);
    if (ctl < 0) die("no /dev/snd/controlC0");
    struct snd_ctl_card_info card = { 0 };
    io(ctl, SNDRV_CTL_IOCTL_CARD_INFO, &card, "card info");
    printf("snd: card %s, driver %s\n", card.name, card.driver);
    close(ctl);

    int fd = open("/dev/snd/pcmC0D0p", O_RDWR);
    if (fd < 0) die("no /dev/snd/pcmC0D0p");
    struct snd_pcm_info info = { 0 };
    io(fd, SNDRV_PCM_IOCTL_INFO, &info, "pcm info");
    printf("snd: pcm %s, %u subdevice\n", info.name, info.subdevices_count);

    struct snd_pcm_hw_params p;
    any(&p);
    io(fd, SNDRV_PCM_IOCTL_HW_REFINE, &p, "hw refine");
    struct snd_interval *r = interval(&p, SNDRV_PCM_HW_PARAM_RATE), *c = interval(&p, SNDRV_PCM_HW_PARAM_CHANNELS),
        *pb = interval(&p, SNDRV_PCM_HW_PARAM_PERIOD_BYTES), *bb = interval(&p, SNDRV_PCM_HW_PARAM_BUFFER_BYTES),
        *pp = interval(&p, SNDRV_PCM_HW_PARAM_PERIODS);
    printf("snd: offers formats %#x, rates %u-%u, channels %u-%u, periods %u-%u of %u-%u bytes, buffer %u-%u bytes\n",
           mask(&p, SNDRV_PCM_HW_PARAM_FORMAT)->bits[0], r->min, r->max, c->min, c->max, pp->min, pp->max, pb->min, pb->max,
           bb->min, bb->max);

    hw(fd, "hw params");

    struct snd_pcm_sw_params sw = {
        .tstamp_mode = SNDRV_PCM_TSTAMP_NONE,
        .period_step = 1,
        .avail_min = PERIOD,
        .start_threshold = PERIOD * PERIODS,
        .stop_threshold = (snd_pcm_uframes_t)-1 >> 1, // never: an underrun just waits for the next write
        .proto = SNDRV_PCM_VERSION,
    };
    io(fd, SNDRV_PCM_IOCTL_SW_PARAMS, &sw, "sw params");
    io(fd, SNDRV_PCM_IOCTL_PREPARE, 0, "prepare");

    const char *seconds = getenv("snd_seconds");
    int frames = seconds ? (int)(atof(seconds) * RATE / PERIOD + 0.5) * PERIOD : 48 * PERIOD;
    if (frames <= 0) die("snd_seconds");
    static int16_t buf[PERIOD * CHANNELS];
    uint32_t h = 0x811c9dc5u;
    double t0 = now_ms();
    for (int f = 0; f < frames; f += PERIOD) {
        for (int k = 0; k < PERIOD; k++) {
            double t = (double)(f + k) / RATE;
            buf[2 * k] = (int16_t)lrint(12000 * sin(2 * M_PI * 440 * t));
            buf[2 * k + 1] = (int16_t)lrint(12000 * sin(2 * M_PI * 660 * t));
        }
        struct snd_xferi x = { .buf = buf, .frames = PERIOD };
        double tw = now_ms();
        if (ioctl(fd, SNDRV_PCM_IOCTL_WRITEI_FRAMES, &x) < 0) {
            // What ALSA saw: how long the write waited, and the stream's positions.
            int err = errno;
            struct snd_pcm_status st = { 0 };
            ioctl(fd, SNDRV_PCM_IOCTL_STATUS, &st);
            printf("snd: write %d failed after %.0f ms (%s): state %d, hw_ptr %lu, appl_ptr %lu, avail %lu, delay %ld, frame %d\n", f / PERIOD,
                   now_ms() - tw, strerror(err), (int)st.state, (unsigned long)st.hw_ptr, (unsigned long)st.appl_ptr, (unsigned long)st.avail,
                   (long)st.delay, f);
            // And a second later: are the completions only late, or lost? And the device's interrupts meanwhile.
            irqs();
            usleep(1000000);
            irqs();
            memset(&st, 0, sizeof st);
            ioctl(fd, SNDRV_PCM_IOCTL_STATUS, &st);
            printf("snd: a second later: state %d, hw_ptr %lu, avail %lu\n", (int)st.state, (unsigned long)st.hw_ptr, (unsigned long)st.avail);
            die("write: I/O error");
        }
        if (x.result != PERIOD) die("short write");
        h = fnv(h, (const uint8_t *)buf, sizeof buf);
    }
    // Drain what's still queued. ALSA's drain waits for a period to elapse and never looks at the position
    // first, so on a stream that is already empty (the deterministic sink plays a message the moment it's
    // posted) it would wait out its timeout and fail: then there's nothing to drain, and a drop ends it.
    struct snd_pcm_status st = { 0 };
    io(fd, SNDRV_PCM_IOCTL_STATUS, &st, "status");
    long queued = PERIOD * PERIODS - (long)st.avail;
    int ended = ioctl(fd, queued > 0 ? SNDRV_PCM_IOCTL_DRAIN : SNDRV_PCM_IOCTL_DROP);
    int err = errno;
    double ms = now_ms() - t0;
    printf("snd: %ld frames queued at the end, %s %s after %.0f ms\n", queued, queued > 0 ? "drain" : "drop", ended < 0 ? strerror(err) : "ok", ms);
    close(fd);
    printf("snd: wrote %d frames fnv1a %08x\n", frames, h);
    if (ended < 0) die("drain");

    const char *rec = getenv("snd_rec_seconds");
    int periods = rec ? (int)(atof(rec) * RATE / PERIOD + 0.5) : 16;
    if (periods <= 0) die("snd_rec_seconds");
    record(periods);
    printf("webpc: snd test ok\n");
    reboot(RB_POWER_OFF);
    return 0;
}
