// snd-play (audio S3; images/build.sh linux-snd): plays a WAV file on card 0's playback PCM through ALSA's ioctls
// (no alsa-lib), as aplay would, for guests that have the driver but not alsa-utils (the page's Debian test,
// tests/page-debian.test.ts, hands it to the guest on a second disk). Static, so it runs on any arm64 Linux.
//
//   snd-play [-D /dev/snd/pcmC0D0p] file.wav
//
// The WAV: PCM S16_LE or S32_LE, or IEEE float (32-bit), 1 or 2 channels, any rate the device offers. The buffer is
// aplay's default, 500 ms in 4 periods (rounded to whole frames); the stream starts when the buffer is full and the
// last period is padded with silence (the driver sends whole periods only), then drained. It prints:
//   "snd-play: <rate> Hz, <channels> ch, <format>, period <p> frames, buffer <b> frames"
//   "snd-play: delay <frames> frames, avail <frames> at <ms> ms"   (once, half-way: ALSA's delay includes the
//                                                                   device's reported latency)
//   "snd-play: played <frames> frames (<ms> ms of sound) in <ms> ms"  (the first write to the drain's end)
// and exits 0, or "snd-play: failed: <why>" and exits 1.
#include <errno.h>
#include <fcntl.h>
#include <sound/asound.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void die(const char *what) {
    printf("snd-play: failed: %s\n", what);
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

static uint32_t le32(const uint8_t *b) { return b[0] | b[1] << 8 | b[2] << 16 | (uint32_t)b[3] << 24; }
static uint16_t le16(const uint8_t *b) { return b[0] | b[1] << 8; }

int main(int argc, char **argv) {
    const char *dev = "/dev/snd/pcmC0D0p";
    if (argc == 4 && !strcmp(argv[1], "-D")) dev = argv[2], argv += 2, argc -= 2;
    if (argc != 2) die("usage: snd-play [-D pcm-device] file.wav");
    setvbuf(stdout, 0, _IOLBF, 0);

    // The file, whole.
    int wf = open(argv[1], O_RDONLY);
    struct stat sb;
    if (wf < 0 || fstat(wf, &sb) < 0) die("can't open the file");
    uint8_t *w = malloc(sb.st_size);
    if (!w || read(wf, w, sb.st_size) != sb.st_size) die("can't read the file");
    close(wf);
    if (sb.st_size < 12 || memcmp(w, "RIFF", 4) || memcmp(w + 8, "WAVE", 4)) die("not a WAV file");
    unsigned tag = 0, channels = 0, rate = 0, bits = 0;
    const uint8_t *data = 0;
    size_t data_len = 0;
    for (size_t at = 12; at + 8 <= (size_t)sb.st_size;) {
        size_t len = le32(w + at + 4), body = at + 8;
        if (len > (size_t)sb.st_size - body) len = sb.st_size - body; // a length left at 0 or past the end: the rest
        if (!memcmp(w + at, "fmt ", 4) && len >= 16) {
            tag = le16(w + body), channels = le16(w + body + 2), rate = le32(w + body + 4), bits = le16(w + body + 14);
            if (tag == 0xfffe && len >= 26) tag = le16(w + body + 24); // WAVE_FORMAT_EXTENSIBLE: the subformat's tag
        } else if (!memcmp(w + at, "data", 4)) {
            data = w + body, data_len = len ? len : sb.st_size - body;
            break;
        }
        at = body + len + (len & 1);
    }
    unsigned format;
    const char *fname;
    if (tag == 1 && bits == 16) format = SNDRV_PCM_FORMAT_S16_LE, fname = "S16_LE";
    else if (tag == 1 && bits == 32) format = SNDRV_PCM_FORMAT_S32_LE, fname = "S32_LE";
    else if (tag == 3 && bits == 32) format = SNDRV_PCM_FORMAT_FLOAT_LE, fname = "FLOAT_LE";
    else die("unsupported sample format");
    if (!data || channels < 1 || channels > 2 || !rate) die("no data, or not 1-2 channels");
    size_t fsize = channels * bits / 8, frames = data_len / fsize;

    int fd = open(dev, O_RDWR);
    if (fd < 0) die("can't open the PCM");
    // aplay's default: a buffer of 500 ms, 4 periods.
    unsigned period = rate / 8;
    struct snd_pcm_hw_params p;
    any(&p);
    set_mask(&p, SNDRV_PCM_HW_PARAM_ACCESS, SNDRV_PCM_ACCESS_RW_INTERLEAVED);
    set_mask(&p, SNDRV_PCM_HW_PARAM_FORMAT, format);
    set_mask(&p, SNDRV_PCM_HW_PARAM_SUBFORMAT, SNDRV_PCM_SUBFORMAT_STD);
    set_interval(&p, SNDRV_PCM_HW_PARAM_CHANNELS, channels);
    set_interval(&p, SNDRV_PCM_HW_PARAM_RATE, rate);
    set_interval(&p, SNDRV_PCM_HW_PARAM_PERIOD_SIZE, period);
    set_interval(&p, SNDRV_PCM_HW_PARAM_PERIODS, 4);
    io(fd, SNDRV_PCM_IOCTL_HW_PARAMS, &p, "hw params");
    unsigned buffer = interval(&p, SNDRV_PCM_HW_PARAM_BUFFER_SIZE)->min;
    printf("snd-play: %u Hz, %u ch, %s, period %u frames, buffer %u frames\n", rate, channels, fname, period, buffer);

    struct snd_pcm_sw_params sw = {
        .tstamp_mode = SNDRV_PCM_TSTAMP_NONE,
        .period_step = 1,
        .avail_min = period,
        .start_threshold = buffer,
        .stop_threshold = buffer, // an underrun stops the stream (XRUN), as with aplay: then it's prepared again
        .proto = SNDRV_PCM_VERSION,
    };
    io(fd, SNDRV_PCM_IOCTL_SW_PARAMS, &sw, "sw params");
    io(fd, SNDRV_PCM_IOCTL_PREPARE, 0, "prepare");

    uint8_t *chunk = calloc(period, fsize);
    unsigned xruns = 0;
    int reported = 0;
    double t0 = now_ms();
    for (size_t f = 0; f < frames; f += period) {
        size_t n = frames - f < period ? frames - f : period;
        memset(chunk, 0, period * fsize); // the last period's rest: silence (0 in every format here)
        memcpy(chunk, data + f * fsize, n * fsize);
        for (size_t done = 0; done < period;) {
            struct snd_xferi x = { .buf = chunk + done * fsize, .frames = period - done };
            if (ioctl(fd, SNDRV_PCM_IOCTL_WRITEI_FRAMES, &x) < 0) {
                if (errno != EPIPE) die("write");
                xruns++;
                io(fd, SNDRV_PCM_IOCTL_PREPARE, 0, "prepare after an underrun");
                continue;
            }
            done += x.result;
        }
        if (!reported && f >= frames / 2) {
            struct snd_pcm_status st = { 0 };
            io(fd, SNDRV_PCM_IOCTL_STATUS, &st, "status");
            printf("snd-play: delay %ld frames, avail %lu at %.0f ms\n", (long)st.delay, (unsigned long)st.avail, now_ms() - t0);
            reported = 1;
        }
    }
    io(fd, SNDRV_PCM_IOCTL_DRAIN, 0, "drain");
    double ms = now_ms() - t0;
    close(fd);
    size_t played = (frames + period - 1) / period * period;
    printf("snd-play: played %zu frames (%.0f ms of sound) in %.0f ms, %u underruns\n", played, played * 1e3 / rate, ms, xruns);
    return 0;
}
