// The guest that runs the introduction page's snippets (tools/intro-capture.ts): calls each of them forever, so
// that the JIT compiles their blocks. Loaded at RAM + 0x210000 behind bench/interp/vm-start.bin, which enters it at
// EL1 with the MMU on.
unsigned sum(const unsigned char *p, unsigned long n);
struct point {
    long x, y, vx, vy;
};
void move(struct point *p);
unsigned collatz(unsigned long n);
double total(const double *v, unsigned long n);
unsigned cap(int *v, unsigned long n, int limit);

#define N 96
static unsigned char bytes[N];
static double values[N];
static struct point points[N];
static int levels[N];
// What the host reads to see the guest ran (BASE + 0x80000, as bench/interp/guest.c's ROUNDS).
#define ROUNDS ((volatile unsigned long *)0x40280000)

void run(void) {
    for (unsigned k = 0; k < N; k++) {
        bytes[k] = k * 7 + 1;
        values[k] = k * 0.5;
        points[k] = (struct point){k, -(long)k, 1, 2};
    }
    unsigned long seed = 27;
    for (;;) {
        volatile unsigned long sink;
        sink = sum(bytes, N);
        for (unsigned k = 0; k < N; k++)
            move(&points[k]);
        sink = collatz(seed);
        seed = seed % 97 + 2;
        sink = (unsigned long)total(values, N);
        for (unsigned k = 0; k < N; k++)
            levels[k] = k * 37 % 101;
        sink = cap(levels, N, 50);
        (void)sink;
        *ROUNDS += 1;
    }
}

__asm__(".section .text.start\n"
        ".globl _start\n"
        "_start:\n"
        "  ldr x0, =0x40300000\n"
        "  mov sp, x0\n"
        "  bl run\n"
        "  b .\n"
        ".ltorg\n"
        ".text\n");
