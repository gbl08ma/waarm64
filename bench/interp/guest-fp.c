// FP/NEON guest workload for the interpreter MIPS baseline (M2). Bare metal on
// flat memory, like guest.c, with FPCR at its reset value (round to nearest).
// It loops forever over single- and double-precision code (an auto-vectorized
// matrix multiply, an n-body step with sqrt and division, Horner polynomials
// and conversions) and NEON integer intrinsics (a u8 image kernel with
// widening multiply-accumulate, saturating narrowing, TBL and CNT), and counts
// rounds at ROUNDS. Built for plain ARMv8.0 (no FP16, dot product or crypto).
// Build: bench/interp/build.sh

#include <arm_neon.h>

typedef unsigned long u64;
typedef unsigned int u32;
typedef unsigned char u8;

#define ROUNDS ((volatile u64 *)0x80000)

static float fa[16][16], fb[16][16], fc[16][16];
static double px[8], py[8], pz[8], vx[8], vy[8], vz[8], mass[8];
static u8 img[1024], out[1024];
static float fx[256];
static int ix[256];

static u32 rng = 12345;
static u32 rand32(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}
static float frand(void) { return (float)(rand32() % 20000) / 1000.0f - 10.0f; }

static void init(void) {
    for (int i = 0; i < 16; i++)
        for (int j = 0; j < 16; j++) fa[i][j] = frand(), fb[i][j] = frand();
    for (int i = 0; i < 8; i++) {
        px[i] = frand(), py[i] = frand(), pz[i] = frand();
        vx[i] = vy[i] = vz[i] = 0;
        mass[i] = 1.0 + (rand32() % 100) / 10.0;
    }
    for (int i = 0; i < 1024; i++) img[i] = (u8)rand32();
    for (int i = 0; i < 256; i++) fx[i] = frand() * 1000.0f;
}

static float matmul(void) {
    float s = 0;
    for (int i = 0; i < 16; i++) {
        for (int j = 0; j < 16; j++) fc[i][j] = 0;
        for (int k = 0; k < 16; k++)
            for (int j = 0; j < 16; j++) fc[i][j] += fa[i][k] * fb[k][j];
        s += fc[i][i];
    }
    return s;
}

static double nbody(void) {
    const double dt = 0.001;
    for (int i = 0; i < 8; i++)
        for (int j = i + 1; j < 8; j++) {
            double dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
            double d2 = dx * dx + dy * dy + dz * dz + 0.01;
            double mag = dt / (d2 * __builtin_sqrt(d2));
            vx[i] -= dx * mass[j] * mag, vy[i] -= dy * mass[j] * mag, vz[i] -= dz * mass[j] * mag;
            vx[j] += dx * mass[i] * mag, vy[j] += dy * mass[i] * mag, vz[j] += dz * mass[i] * mag;
        }
    double e = 0;
    for (int i = 0; i < 8; i++) {
        px[i] += dt * vx[i], py[i] += dt * vy[i], pz[i] += dt * vz[i];
        e += 0.5 * mass[i] * (vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
    }
    return e;
}

static double horner(void) {
    double s = 0;
    for (int i = 0; i < 64; i++) {
        double x = fx[i] * 0.001;
        s += __builtin_fma(__builtin_fma(__builtin_fma(0.25, x, -0.5), x, 1.0), x, 2.0);
    }
    return s;
}

static int convert(void) {
    int s = 0;
    for (int i = 0; i < 256; i++) ix[i] = (int)fx[i], s += ix[i];
    for (int i = 0; i < 256; i++) fx[i] = (float)ix[(i * 7) & 255] * 0.999f + 0.5f;
    return s;
}

static u32 image(void) {
    // out = sat(img * 3 / 4 + 16), then a byte shuffle and a popcount.
    const uint8x8_t k3 = vdup_n_u8(3);
    const uint8x16_t idx = {15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0};
    uint32x4_t acc = vdupq_n_u32(0);
    for (int i = 0; i < 1024; i += 16) {
        uint8x16_t p = vld1q_u8(&img[i]);
        uint16x8_t lo = vmull_u8(vget_low_u8(p), k3), hi = vmull_u8(vget_high_u8(p), k3);
        lo = vaddq_u16(vshrq_n_u16(lo, 2), vdupq_n_u16(16));
        hi = vaddq_u16(vshrq_n_u16(hi, 2), vdupq_n_u16(16));
        uint8x16_t r = vcombine_u8(vqmovn_u16(lo), vqmovn_u16(hi));
        r = vqtbl1q_u8(r, idx);
        vst1q_u8(&out[i], r);
        acc = vpadalq_u16(acc, vpaddlq_u8(vcntq_u8(r)));
    }
    for (int i = 0; i < 1024; i++) img[i] = out[i] ^ (u8)i;
    return vaddvq_u32(acc);
}

__attribute__((noreturn)) void guest_main(void) {
    init();
    u32 sink = 0;
    for (;;) {
        float m = matmul();
        double e = nbody() + horner();
        sink ^= (u32)(int)m + (u32)(long)(e * 1000.0) + (u32)convert() + image();
        *ROUNDS += 1;
        ((volatile u32 *)ROUNDS)[2] = sink;
    }
}

__asm__(".section .text.start\n"
        ".globl _start\n"
        "_start:\n"
        "  mov sp, #0x100000\n"
        "  bl guest_main\n");
