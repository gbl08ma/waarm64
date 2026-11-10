// FEAT_FCMA kernels, each path picked at run time from the hwcap as libraries do (PERF loop 7, bench/boot/REPORT.md
// "PERF loop 7: FEAT_FCMA"). Complex numbers interleaved (real, imaginary), as std::complex, C99 complex and FFT
// libraries store them:
// - cmac32 / cmac64: y[i] += a[i] * b[i], vector by vector (a filter's taps, an FFT's twiddles): FCMLA #0 and #90 with
//   HWCAP_FCMA; without it the v8.0 form compilers and Eigen's NEON path write: TRN1/TRN2 for a's real and imaginary
//   parts twice, REV64 of b, a sign flip, two FMLAs.
// - cgain32: y[i] += x[i] * g, g one complex number (a gain, a mixer's oscillator step): FCMLA by element; without it
//   REV64 of x and two FMLAs by the hoisted constants (g's real part, (-im, im)).
// - fft4: a radix-4 butterfly on four streams, its ±i·t from FCADD #90 and #270; without it REV64, a sign flip and
//   FADD/FSUB.
// Prints `KERN <name> <ns per complex output> check <sum> <path>`.
// Built natively (no guest toolchain needed): gcc -O2 -o fcmak fcmak.c
#include <arm_neon.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/auxv.h>
#include <time.h>

#define HWCAP_FCMA_BIT (1UL << 14)
#define N 2048 // complex numbers per array: 16 KiB of singles, in the L1 or L2

static const uint32x4_t NEG_RE = {0x80000000u, 0, 0x80000000u, 0};

__attribute__((noinline)) static void cmac32_neon(float *y, const float *a, const float *b, int n) {
  for (int i = 0; i < 2 * n; i += 4) {
    float32x4_t va = vld1q_f32(a + i), vb = vld1q_f32(b + i), acc = vld1q_f32(y + i);
    float32x4_t re = vtrn1q_f32(va, va), im = vtrn2q_f32(va, va);
    acc = vfmaq_f32(acc, re, vb);
    im = vreinterpretq_f32_u32(veorq_u32(vreinterpretq_u32_f32(im), NEG_RE));
    acc = vfmaq_f32(acc, im, vrev64q_f32(vb));
    vst1q_f32(y + i, acc);
  }
}
__attribute__((noinline, target("+fcma"))) static void cmac32_fcma(float *y, const float *a, const float *b, int n) {
  for (int i = 0; i < 2 * n; i += 4) {
    float32x4_t va = vld1q_f32(a + i), vb = vld1q_f32(b + i), acc = vld1q_f32(y + i);
    acc = vcmlaq_f32(acc, va, vb);
    acc = vcmlaq_rot90_f32(acc, va, vb);
    vst1q_f32(y + i, acc);
  }
}

static const uint64x2_t NEG_RE64 = {0x8000000000000000ull, 0};
__attribute__((noinline)) static void cmac64_neon(double *y, const double *a, const double *b, int n) {
  for (int i = 0; i < 2 * n; i += 2) {
    float64x2_t va = vld1q_f64(a + i), vb = vld1q_f64(b + i), acc = vld1q_f64(y + i);
    float64x2_t re = vdupq_laneq_f64(va, 0), im = vdupq_laneq_f64(va, 1);
    acc = vfmaq_f64(acc, re, vb);
    im = vreinterpretq_f64_u64(veorq_u64(vreinterpretq_u64_f64(im), NEG_RE64));
    acc = vfmaq_f64(acc, im, vextq_f64(vb, vb, 1));
    vst1q_f64(y + i, acc);
  }
}
__attribute__((noinline, target("+fcma"))) static void cmac64_fcma(double *y, const double *a, const double *b, int n) {
  for (int i = 0; i < 2 * n; i += 2) {
    float64x2_t va = vld1q_f64(a + i), vb = vld1q_f64(b + i), acc = vld1q_f64(y + i);
    acc = vcmlaq_f64(acc, va, vb);
    acc = vcmlaq_rot90_f64(acc, va, vb);
    vst1q_f64(y + i, acc);
  }
}

// x · g = (xr·gr - xi·gi, xr·gi + xi·gr) = x·gr + rev64(x)·(-gi, gi).
__attribute__((noinline)) static void cgain32_neon(float *y, const float *x, const float *g, int n) {
  float32x4_t gr = vdupq_n_f32(g[0]), gi = {-g[1], g[1], -g[1], g[1]};
  for (int i = 0; i < 2 * n; i += 4) {
    float32x4_t vx = vld1q_f32(x + i), acc = vld1q_f32(y + i);
    acc = vfmaq_f32(acc, vx, gr);
    acc = vfmaq_f32(acc, vrev64q_f32(vx), gi);
    vst1q_f32(y + i, acc);
  }
}
__attribute__((noinline, target("+fcma"))) static void cgain32_fcma(float *y, const float *x, const float *g, int n) {
  float32x4_t vg = {g[0], g[1], g[0], g[1]};
  for (int i = 0; i < 2 * n; i += 4) {
    float32x4_t vx = vld1q_f32(x + i), acc = vld1q_f32(y + i);
    acc = vcmlaq_laneq_f32(acc, vx, vg, 0);
    acc = vcmlaq_rot90_laneq_f32(acc, vx, vg, 0);
    vst1q_f32(y + i, acc);
  }
}

// y0 = (a + c) + (b + d), y2 = (a + c) - (b + d), y1 = (a - c) - i(b - d), y3 = (a - c) + i(b - d).
__attribute__((noinline)) static void fft4_neon(float *const *y, float *const *x, int n) {
  for (int i = 0; i < 2 * n; i += 4) {
    float32x4_t a = vld1q_f32(x[0] + i), b = vld1q_f32(x[1] + i), c = vld1q_f32(x[2] + i), d = vld1q_f32(x[3] + i);
    float32x4_t t0 = vaddq_f32(a, c), t1 = vsubq_f32(a, c), t2 = vaddq_f32(b, d), t3 = vsubq_f32(b, d);
    // i·t3 = (-t3.im, t3.re)
    float32x4_t it3 = vreinterpretq_f32_u32(veorq_u32(vreinterpretq_u32_f32(vrev64q_f32(t3)), NEG_RE));
    vst1q_f32(y[0] + i, vaddq_f32(t0, t2));
    vst1q_f32(y[1] + i, vsubq_f32(t1, it3));
    vst1q_f32(y[2] + i, vsubq_f32(t0, t2));
    vst1q_f32(y[3] + i, vaddq_f32(t1, it3));
  }
}
__attribute__((noinline, target("+fcma"))) static void fft4_fcma(float *const *y, float *const *x, int n) {
  for (int i = 0; i < 2 * n; i += 4) {
    float32x4_t a = vld1q_f32(x[0] + i), b = vld1q_f32(x[1] + i), c = vld1q_f32(x[2] + i), d = vld1q_f32(x[3] + i);
    float32x4_t t0 = vaddq_f32(a, c), t1 = vsubq_f32(a, c), t2 = vaddq_f32(b, d), t3 = vsubq_f32(b, d);
    vst1q_f32(y[0] + i, vaddq_f32(t0, t2));
    vst1q_f32(y[1] + i, vcaddq_rot270_f32(t1, t3));
    vst1q_f32(y[2] + i, vsubq_f32(t0, t2));
    vst1q_f32(y[3] + i, vcaddq_rot90_f32(t1, t3));
  }
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

static unsigned s = 1;
// Values in [-1, 1) with short significands' neighbours: plain normals, as signals are.
static float rnd(void) { return (int)((s = s * 1103515245 + 12345) >> 8 & 0xffff) / 32768.0f - 1.0f; }

int main(int argc, char **argv) {
  long turns = argc > 1 ? atol(argv[1]) : 2000;
  static float a[2 * N], b[2 * N], y[2 * N], xs[4][2 * N], ys[4][2 * N];
  static double a64[2 * N], b64[2 * N], y64[2 * N];
  for (int i = 0; i < 2 * N; i++) {
    a[i] = rnd(), b[i] = rnd() * 0.001f;
    a64[i] = a[i], b64[i] = b[i];
    for (int k = 0; k < 4; k++) xs[k][i] = rnd();
  }
  int fcma = (getauxval(AT_HWCAP) & HWCAP_FCMA_BIT) != 0;
  const char *path = fcma ? "fcma" : "neon";

  // The accumulators grow by at most ~2e-3 a turn: no overflow, every lane a normal.
  for (int i = 0; i < 2 * N; i++) y[i] = 1.0f;
  double t0 = now();
  for (long t = 0; t < turns; t++) (fcma ? cmac32_fcma : cmac32_neon)(y, a, b, N);
  double t1 = now();
  double sum = 0;
  for (int i = 0; i < 2 * N; i++) sum += y[i];
  printf("KERN cmac32 %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), sum, path);

  for (int i = 0; i < 2 * N; i++) y64[i] = 1.0;
  t0 = now();
  for (long t = 0; t < turns; t++) (fcma ? cmac64_fcma : cmac64_neon)(y64, a64, b64, N);
  t1 = now();
  sum = 0;
  for (int i = 0; i < 2 * N; i++) sum += y64[i];
  printf("KERN cmac64 %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), sum, path);

  const float g[2] = {0.0007f, -0.0003f};
  for (int i = 0; i < 2 * N; i++) y[i] = 1.0f;
  t0 = now();
  for (long t = 0; t < turns; t++) (fcma ? cgain32_fcma : cgain32_neon)(y, a, g, N);
  t1 = now();
  sum = 0;
  for (int i = 0; i < 2 * N; i++) sum += y[i];
  printf("KERN cgain32 %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), sum, path);

  float *const xp[4] = {xs[0], xs[1], xs[2], xs[3]}, *const yp[4] = {ys[0], ys[1], ys[2], ys[3]};
  t0 = now();
  for (long t = 0; t < turns / 2; t++) (fcma ? fft4_fcma : fft4_neon)(yp, xp, N);
  t1 = now();
  sum = 0;
  for (int k = 0; k < 4; k++)
    for (int i = 0; i < 2 * N; i++) sum += ys[k][i] * (k + 1);
  printf("KERN fft4 %.3f check %.6g %s\n", (t1 - t0) / ((double)(turns / 2) * 4 * N), sum, path);
  return 0;
}
