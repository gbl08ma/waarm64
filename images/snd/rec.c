// snd-rec (audio S4; images/build.sh linux-snd): records from card 0's capture PCM through ALSA's ioctls (no
// alsa-lib), as arecord would, for guests that have the driver but not alsa-utils (the page's Debian test,
// tests/page-debian.test.ts, hands it to the guest on a second disk beside snd-play). Static, so it runs on any arm64
// Linux.
//
//   snd-rec [-D /dev/snd/pcmC0D0c] rate channels seconds [file.wav]
//
// S16_LE at `rate`, 1 or 2 channels, arecord's default buffer (500 ms in 4 periods); the stream is started at once and
// an overrun (EPIPE) is counted and the stream prepared and started again. It prints:
//   "snd-rec: <rate> Hz, <channels> ch, S16_LE, period <p> frames, buffer <b> frames"
//   "snd-rec: recorded <frames> frames in <ms> ms, <n> overruns, <hz> Hz left, <hz> Hz right, peak <abs>"
// (each channel's frequency by its rising zero crossings; a mono recording's right is its left), writes the WAV if
// asked, and exits 0, or "snd-rec: failed: <why>" and exits 1.
#include <errno.h>
#include <fcntl.h>
#include <sound/asound.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

static void die(const char *what) {
    printf("snd-rec: failed: %s\n", what);
    exit(1);
}

static void io(int fd, unsigned long req, void *arg, const char *what) {
    if (ioctl(fd, req, arg) < 0) {
        char m[96];
        snprintf(m, sizeof m, "%s: %s", what, strerror(errno));
        die(m);
    }
}

static struct snd_mask *mask(struct snd_pcm_hw_params *p, int n) {
    return &p->masks[n - SNDRV_PCM_HW_PARAM_FIRST_MASK];
}

static struct snd_interval *interval(struct snd_pcm_hw_params *p, int n) {
    return &p->intervals[n - SNDRV_PCM_HW_PARAM_FIRST_INTERVAL];
}

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

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static void le32(uint8_t *b, uint32_t v) { b[0] = v, b[1] = v >> 8, b[2] = v >> 16, b[3] = v >> 24; }
static void le16(uint8_t *b, uint16_t v) { b[0] = v, b[1] = v >> 8; }

int main(int argc, char **argv) {
    const char *dev = "/dev/snd/pcmC0D0c";
    if (argc >= 3 && !strcmp(argv[1], "-D")) dev = argv[2], argv += 2, argc -= 2;
    if (argc != 4 && argc != 5) die("usage: snd-rec [-D pcm-device] rate channels seconds [file.wav]");
    setvbuf(stdout, 0, _IOLBF, 0);
    unsigned rate = atoi(argv[1]), channels = atoi(argv[2]);
    double seconds = atof(argv[3]);
    if (!rate || channels < 1 || channels > 2 || seconds <= 0) die("bad rate, channels or seconds");
    size_t frames = (size_t)(seconds * rate), fsize = 2 * channels;

    int fd = open(dev, O_RDWR);
    if (fd < 0) die("can't open the PCM");
    unsigned period = rate / 8; // arecord's default: a buffer of 500 ms, 4 periods
    struct snd_pcm_hw_params p;
    any(&p);
    set_mask(&p, SNDRV_PCM_HW_PARAM_ACCESS, SNDRV_PCM_ACCESS_RW_INTERLEAVED);
    set_mask(&p, SNDRV_PCM_HW_PARAM_FORMAT, SNDRV_PCM_FORMAT_S16_LE);
    set_mask(&p, SNDRV_PCM_HW_PARAM_SUBFORMAT, SNDRV_PCM_SUBFORMAT_STD);
    set_interval(&p, SNDRV_PCM_HW_PARAM_CHANNELS, channels);
    set_interval(&p, SNDRV_PCM_HW_PARAM_RATE, rate);
    set_interval(&p, SNDRV_PCM_HW_PARAM_PERIOD_SIZE, period);
    set_interval(&p, SNDRV_PCM_HW_PARAM_PERIODS, 4);
    io(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &p, "hw params");
    unsigned buffer = interval(&p, SNDRV_PCM_HW_PARAM_BUFFER_SIZE)->min;
    printf("snd-rec: %u Hz, %u ch, S16_LE, period %u frames, buffer %u frames\n", rate, channels, period, buffer);
    struct snd_pcm_sw_params sw = {
        .tstamp_mode = SNDRV_PCM_TSTAMP_NONE,
        .period_step = 1,
        .avail_min = period,
        .start_threshold = 1,
        .stop_threshold = buffer, // an overrun stops the stream (XRUN), as with arecord: then it's prepared again
        .proto = SNDRV_PCM_VERSION,
    };
    io(fd, SNDRV_PCM_IOCTL_SW_PARAMS, &sw, "sw params");
    io(fd, SNDRV_PCM_IOCTL_PREPARE, 0, "prepare");
    io(fd, SNDRV_PCM_IOCTL_START, 0, "start");

    int16_t *pcm = malloc(frames * fsize);
    if (!pcm) die("no memory");
    unsigned xruns = 0;
    double t0 = now_ms();
    for (size_t got = 0; got < frames;) {
        size_t n = frames - got < period ? frames - got : period;
        struct snd_xferi x = { .buf = pcm + got * channels, .frames = n };
        if (ioctl(fd, SNDRV_PCM_IOCTL_READI_FRAMES, &x) < 0) {
            if (errno != EPIPE) die("read");
            xruns++;
            io(fd, SNDRV_PCM_IOCTL_PREPARE, 0, "prepare after an overrun");
            io(fd, SNDRV_PCM_IOCTL_START, 0, "start after an overrun");
            continue;
        }
        got += x.result;
    }
    double ms = now_ms() - t0;
    io(fd, SNDRV_PCM_IOCTL_DROP, 0, "drop");
    close(fd);

    long rising[2] = { 0 };
    int peak = 0;
    for (unsigned c = 0; c < channels; c++)
        for (size_t f = 1; f < frames; f++) {
            int a = pcm[(f - 1) * channels + c], b = pcm[f * channels + c];
            if (a < 0 && b >= 0) rising[c]++;
            if (abs(b) > peak) peak = abs(b);
        }
    if (channels == 1) rising[1] = rising[0];
    printf("snd-rec: recorded %zu frames in %.0f ms, %u overruns, %ld Hz left, %ld Hz right, peak %d\n", frames, ms, xruns,
           (long)(rising[0] * rate / frames), (long)(rising[1] * rate / frames), peak);

    if (argc == 5) {
        uint8_t h[44];
        memcpy(h, "RIFF", 4), le32(h + 4, 36 + frames * fsize), memcpy(h + 8, "WAVEfmt ", 8);
        le32(h + 16, 16), le16(h + 20, 1), le16(h + 22, channels), le32(h + 24, rate), le32(h + 28, rate * fsize);
        le16(h + 32, fsize), le16(h + 34, 16), memcpy(h + 36, "data", 4), le32(h + 40, frames * fsize);
        FILE *f = fopen(argv[4], "wb");
        if (!f || fwrite(h, 1, 44, f) != 44 || fwrite(pcm, fsize, frames, f) != frames || fclose(f)) die("can't write the file");
    }
    return 0;
}
