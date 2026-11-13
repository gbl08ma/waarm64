// CoreMark's port layer for the waarm64 benchmark guest (M5 step 10); see
// core_portme.h. The guest runs CoreMark's main() (ITERATIONS iterations,
// set by build.sh) forever and counts completed runs at ROUNDS, as
// guest.c counts its rounds; the first run's report goes to OUT (a
// NUL-terminated string) so the host can check CoreMark's own validation.
#include "coremark.h"

#define ROUNDS ((volatile unsigned long *)0x80000)
#define OUT ((volatile char *)0x88000)
#define OUT_SIZE 0x4000

volatile ee_s32 seed1_volatile = 0x0; // the 2K performance run's seeds
volatile ee_s32 seed2_volatile = 0x0;
volatile ee_s32 seed3_volatile = 0x66;
volatile ee_s32 seed4_volatile = ITERATIONS;
volatile ee_s32 seed5_volatile = 0;

ee_u32 default_num_contexts = 1;

#ifdef WAARM64_LINUX
// The reference build (build-coremark.sh): a static Linux program on raw
// syscalls, for CoreMark natively and under qemu-aarch64 (TCG); CoreMark
// times itself (milliseconds) and picks its iterations for a valid run.
static long sys(long n, long a, long b, long c) {
    register long x8 __asm__("x8") = n, x0 __asm__("x0") = a, x1 __asm__("x1") = b, x2 __asm__("x2") = c;
    __asm__ volatile("svc #0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2) : "memory");
    return x0;
}
static CORE_TICKS t0, t1;
static CORE_TICKS ms(void) {
    long ts[2];
    sys(113, 1, (long)ts, 0); // clock_gettime(CLOCK_MONOTONIC)
    return (CORE_TICKS)(ts[0] * 1000 + ts[1] / 1000000);
}
void start_time(void) { t0 = ms(); }
void stop_time(void) { t1 = ms(); }
CORE_TICKS get_time(void) { return t1 - t0; }
secs_ret time_in_secs(CORE_TICKS ticks) { return ticks / 1000; }
#else
// No clock: time is the host's. CoreMark then reports "must execute for at
// least 10 secs", which only concerns publishing a score.
void start_time(void) {}
void stop_time(void) {}
CORE_TICKS get_time(void) { return 0; }
secs_ret time_in_secs(CORE_TICKS ticks) { return ticks; }
#endif

void portable_init(core_portable *p, int *argc, char *argv[]) {
    (void)argc;
    (void)argv;
    p->portable_id = 1;
}

void portable_fini(core_portable *p) { p->portable_id = 0; }

void *memset(void *d, int c, unsigned long n) {
    unsigned char *p = d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}

void *memcpy(void *d, const void *s, unsigned long n) {
    unsigned char *p = d;
    const unsigned char *q = s;
    while (n--) *p++ = *q++;
    return d;
}

// ee_printf: %d %u %x %s %c with an optional `l`, zero padding and width,
// into OUT during the first run only.
static unsigned out_len;
static int first = 1;

#ifdef WAARM64_LINUX
static char out[OUT_SIZE];
static void put(char c) {
    if (out_len < OUT_SIZE) out[out_len++] = c;
}
#else
static void put(char c) {
    if (first && out_len + 1 < OUT_SIZE) {
        OUT[out_len++] = c;
        OUT[out_len] = 0;
    }
}
#endif

int ee_printf(const char *fmt, ...) {
    __builtin_va_list ap;
    __builtin_va_start(ap, fmt);
    for (const char *f = fmt; *f; f++) {
        if (*f != '%') {
            put(*f);
            continue;
        }
        f++;
        char pad = ' ';
        int width = 0, lng = 0;
        if (*f == '0') pad = '0', f++;
        while (*f >= '0' && *f <= '9') width = width * 10 + (*f++ - '0');
        if (*f == 'l') lng = 1, f++;
        char buf[24];
        int n = 0;
        if (*f == 's') {
            for (const char *s = __builtin_va_arg(ap, const char *); *s; s++) put(*s);
            continue;
        }
        if (*f == 'c') {
            put((char)__builtin_va_arg(ap, int));
            continue;
        }
        unsigned long v;
        int neg = 0;
        if (*f == 'd') {
            long s = lng ? __builtin_va_arg(ap, long) : __builtin_va_arg(ap, int);
            neg = s < 0;
            v = neg ? -(unsigned long)s : (unsigned long)s;
        } else {
            v = lng ? __builtin_va_arg(ap, unsigned long) : __builtin_va_arg(ap, unsigned);
        }
        unsigned base = *f == 'x' ? 16 : 10;
        do buf[n++] = "0123456789abcdef"[v % base], v /= base;
        while (v);
        if (neg) buf[n++] = '-';
        while (n < width) put(pad), width--;
        while (n) put(buf[--n]);
    }
    __builtin_va_end(ap);
    return 0;
}

int main(void);

#ifdef WAARM64_LINUX
__attribute__((noreturn)) void _start(void) {
    (void)first;
    main();
    sys(64, 1, (long)out, out_len); // write
    sys(93, 0, 0, 0);               // exit
    __builtin_unreachable();
}
#else
__attribute__((noreturn)) void guest_main(void) {
    for (;;) {
        main();
        first = 0;
        *ROUNDS += 1;
    }
}

__asm__(".section .text.start\n"
        ".globl _start\n"
        "_start:\n"
        "  mov sp, #0x100000\n"
        "  bl guest_main\n");
#endif
