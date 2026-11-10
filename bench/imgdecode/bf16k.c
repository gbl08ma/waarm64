// FEAT_BF16 kernels, each path picked at run time from HWCAP2_BF16 as libraries do (PERF loop 11,
// bench/boot/REPORT.md "PERF loop 11: FEAT_BF16"). Data in bfloat16, as a bf16 model's weights and activations
// (XNNPACK's bf16 GEMMs, ggml's BF16 tensors, KleidiAI's and oneDNN's bf16 matmuls); single accumulators. The paths
// without BF16 are XNNPACK's "neonfma-shland" (a bfloat16 widened by a shift left or an AND, then FMLA .4s).
// - dot: a dot product, BFDOT (vbfdotq_f32) against the even and odd halves widened, two FMLA .4s.
// - dotl: the same with BFMLALB/BFMLALT (XNNPACK's "neonbf16-bfmlal") against the same v8.0 code.
// - gemm: a 4x8 tile of C += A B (K = 64), A and B packed for the path: BFMMLA on 2x4 by 4x2 blocks (KleidiAI's
//   bf16 MMLA kernels: eight a k-step of 4) against B's row and A's column widened and eight FMLA .4s by element.
// - gemmdot: the tile with BFDOT by element (XNNPACK's "neonbf16-bfdot" shape: A's pair in every lane, eight a k-step
//   of 2) against the same v8.0 tile.
// - cvt: singles to bfloat16 in memory (activations quantized for the next layer), BFCVTN/BFCVTN2 against the
//   rounding to nearest even in integer arithmetic with NaNs quieted (PyTorch's, ggml's GGML_FP32_TO_BF16 as NEON).
// - cvts: the same one value at a time, as scalar code compiles a (__bf16) cast: BFCVT against the integer rounding.
// - dotv8, gemmv8: the v8.0 dot product and tile in both arms (controls).
// BFDOT and BFMMLA round to odd and flush denormals (no EBF16), so their sums differ from the FMA paths' in the last
// places; the checks agree to a few digits.
// Prints `KERN <name> <ns per output or element> check <sum> <path>`.
// Built natively (no guest toolchain needed): gcc -O2 -o bf16k bf16k.c
#include <arm_neon.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <time.h>

#define HWCAP2_BF16_BIT (1UL << 14)
#define N 4096 // bfloat16s an array: 8 KiB, in the L1
#define K 64   // gemm's depth

typedef uint16_t bf16; // the bits, so the v8.0 paths need no BF16 types

static inline float32x4_t lo32(uint16x8_t x) { return vreinterpretq_f32_u32(vshlq_n_u32(vreinterpretq_u32_u16(x), 16)); }
static inline float32x4_t hi32(uint16x8_t x) { return vreinterpretq_f32_u32(vandq_u32(vreinterpretq_u32_u16(x), vdupq_n_u32(0xffff0000))); }

// ---- dot, dotl, dotv8 ---------------------------------------------------------
__attribute__((noinline)) static float dot_neon(const bf16 *x, const bf16 *y, int n) {
  float32x4_t s0 = vdupq_n_f32(0), s1 = vdupq_n_f32(0);
  for (int i = 0; i < n; i += 8) {
    uint16x8_t vx = vld1q_u16(x + i), vy = vld1q_u16(y + i);
    s0 = vfmaq_f32(s0, lo32(vx), lo32(vy));
    s1 = vfmaq_f32(s1, hi32(vx), hi32(vy));
  }
  return vaddvq_f32(vaddq_f32(s0, s1));
}
__attribute__((noinline, target("+bf16"))) static float dot_bf16(const bf16 *x, const bf16 *y, int n) {
  float32x4_t s0 = vdupq_n_f32(0), s1 = vdupq_n_f32(0);
  for (int i = 0; i < n; i += 16) {
    s0 = vbfdotq_f32(s0, vld1q_bf16((const bfloat16_t *)x + i), vld1q_bf16((const bfloat16_t *)y + i));
    s1 = vbfdotq_f32(s1, vld1q_bf16((const bfloat16_t *)x + i + 8), vld1q_bf16((const bfloat16_t *)y + i + 8));
  }
  return vaddvq_f32(vaddq_f32(s0, s1));
}
__attribute__((noinline, target("+bf16"))) static float dotl_bf16(const bf16 *x, const bf16 *y, int n) {
  float32x4_t s0 = vdupq_n_f32(0), s1 = vdupq_n_f32(0);
  for (int i = 0; i < n; i += 8) {
    bfloat16x8_t vx = vld1q_bf16((const bfloat16_t *)x + i), vy = vld1q_bf16((const bfloat16_t *)y + i);
    s0 = vbfmlalbq_f32(s0, vx, vy);
    s1 = vbfmlaltq_f32(s1, vx, vy);
  }
  return vaddvq_f32(vaddq_f32(s0, s1));
}

// ---- gemm, gemmdot, gemmv8: C[4][8] += A[4][K] B[K][8] --------------------------------------------------------
// v8.0: A column-major (a column of 4 a step), B row-major (a row of 8 a step).
__attribute__((noinline)) static void gemm_neon(float *c, const bf16 *a, const bf16 *b) {
  float32x4_t acc[8];
  for (int r = 0; r < 4; r++) acc[2 * r] = vld1q_f32(c + 8 * r), acc[2 * r + 1] = vld1q_f32(c + 8 * r + 4);
  for (int k = 0; k < K; k++) {
    uint16x8_t vb = vld1q_u16(b + 8 * k);
    float32x4_t blo = vreinterpretq_f32_u32(vshll_n_u16(vget_low_u16(vb), 16));
    float32x4_t bhi = vreinterpretq_f32_u32(vshll_high_n_u16(vb, 16));
    float32x4_t va = vreinterpretq_f32_u32(vshll_n_u16(vld1_u16(a + 4 * k), 16));
    acc[0] = vfmaq_laneq_f32(acc[0], blo, va, 0), acc[1] = vfmaq_laneq_f32(acc[1], bhi, va, 0);
    acc[2] = vfmaq_laneq_f32(acc[2], blo, va, 1), acc[3] = vfmaq_laneq_f32(acc[3], bhi, va, 1);
    acc[4] = vfmaq_laneq_f32(acc[4], blo, va, 2), acc[5] = vfmaq_laneq_f32(acc[5], bhi, va, 2);
    acc[6] = vfmaq_laneq_f32(acc[6], blo, va, 3), acc[7] = vfmaq_laneq_f32(acc[7], bhi, va, 3);
  }
  for (int r = 0; r < 4; r++) vst1q_f32(c + 8 * r, acc[2 * r]), vst1q_f32(c + 8 * r + 4, acc[2 * r + 1]);
}
// BFMMLA: A packed as [K/4][row pair 0..1][2 rows x 4 k], B as [K/4][column pair 0..3][2 columns x 4 k]; the
// accumulators are 2x2 blocks (rows 2p, 2p+1; columns 2q, 2q+1), unpacked into C at the end.
__attribute__((noinline, target("+bf16"))) static void gemm_mmla(float *c, const bf16 *ap, const bf16 *bp) {
  float32x4_t acc[2][4];
  for (int p = 0; p < 2; p++)
    for (int q = 0; q < 4; q++) {
      float32x2_t r0 = vld1_f32(c + 8 * (2 * p) + 2 * q), r1 = vld1_f32(c + 8 * (2 * p + 1) + 2 * q);
      acc[p][q] = vcombine_f32(r0, r1);
    }
  for (int k = 0; k < K / 4; k++) {
    bfloat16x8_t a0 = vld1q_bf16((const bfloat16_t *)ap + 16 * k), a1 = vld1q_bf16((const bfloat16_t *)ap + 16 * k + 8);
    for (int q = 0; q < 4; q++) {
      bfloat16x8_t bq = vld1q_bf16((const bfloat16_t *)bp + 32 * k + 8 * q);
      acc[0][q] = vbfmmlaq_f32(acc[0][q], a0, bq);
      acc[1][q] = vbfmmlaq_f32(acc[1][q], a1, bq);
    }
  }
  for (int p = 0; p < 2; p++)
    for (int q = 0; q < 4; q++) {
      vst1_f32(c + 8 * (2 * p) + 2 * q, vget_low_f32(acc[p][q]));
      vst1_f32(c + 8 * (2 * p + 1) + 2 * q, vget_high_f32(acc[p][q]));
    }
}
// BFDOT by element: A packed as [K/2][4 rows x 2 k], B as [K/2][8 columns x 2 k]: each k-pair, B's two vectors of
// column pairs and A's four row pairs as elements.
__attribute__((noinline, target("+bf16"))) static void gemm_bfdot(float *c, const bf16 *ap, const bf16 *bp) {
  float32x4_t acc[8];
  for (int r = 0; r < 4; r++) acc[2 * r] = vld1q_f32(c + 8 * r), acc[2 * r + 1] = vld1q_f32(c + 8 * r + 4);
  for (int k = 0; k < K / 2; k++) {
    bfloat16x8_t va = vld1q_bf16((const bfloat16_t *)ap + 8 * k);
    bfloat16x8_t b0 = vld1q_bf16((const bfloat16_t *)bp + 16 * k), b1 = vld1q_bf16((const bfloat16_t *)bp + 16 * k + 8);
    acc[0] = vbfdotq_laneq_f32(acc[0], b0, va, 0), acc[1] = vbfdotq_laneq_f32(acc[1], b1, va, 0);
    acc[2] = vbfdotq_laneq_f32(acc[2], b0, va, 1), acc[3] = vbfdotq_laneq_f32(acc[3], b1, va, 1);
    acc[4] = vbfdotq_laneq_f32(acc[4], b0, va, 2), acc[5] = vbfdotq_laneq_f32(acc[5], b1, va, 2);
    acc[6] = vbfdotq_laneq_f32(acc[6], b0, va, 3), acc[7] = vbfdotq_laneq_f32(acc[7], b1, va, 3);
  }
  for (int r = 0; r < 4; r++) vst1q_f32(c + 8 * r, acc[2 * r]), vst1q_f32(c + 8 * r + 4, acc[2 * r + 1]);
}

// ---- cvt, cvts --------------------------------------------------------------------------------------------------
__attribute__((noinline)) static void cvt_neon(bf16 *y, const float *x, int n) {
  const uint32x4_t one = vdupq_n_u32(1), bias = vdupq_n_u32(0x7fff), qnan = vdupq_n_u32(0x7fc00000);
  for (int i = 0; i < n; i += 8) {
    uint16x4_t h[2];
    for (int j = 0; j < 2; j++) {
      float32x4_t v = vld1q_f32(x + i + 4 * j);
      uint32x4_t u = vreinterpretq_u32_f32(v);
      uint32x4_t r = vaddq_u32(vaddq_u32(u, bias), vandq_u32(vshrq_n_u32(u, 16), one));
      r = vbslq_u32(vceqq_f32(v, v), r, qnan);
      h[j] = vshrn_n_u32(r, 16);
    }
    vst1q_u16(y + i, vcombine_u16(h[0], h[1]));
  }
}
__attribute__((noinline, target("+bf16"))) static void cvt_bf16(bf16 *y, const float *x, int n) {
  for (int i = 0; i < n; i += 8) {
    bfloat16x8_t h = vcvtq_low_bf16_f32(vld1q_f32(x + i));
    h = vcvtq_high_bf16_f32(h, vld1q_f32(x + i + 4));
    vst1q_bf16((bfloat16_t *)y + i, h);
  }
}
__attribute__((noinline)) static void cvts_int(bf16 *y, const float *x, int n) {
  for (int i = 0; i < n; i++) {
    uint32_t u;
    memcpy(&u, &x[i], 4);
    y[i] = (u & 0x7fffffff) > 0x7f800000 ? (uint16_t)(u >> 16 | 0x40) : (uint16_t)((u + 0x7fff + (u >> 16 & 1)) >> 16);
  }
}
__attribute__((noinline, target("+bf16"))) static void cvts_bf16(bf16 *y, const float *x, int n) {
  for (int i = 0; i < n; i++) {
    bfloat16_t h = vcvth_bf16_f32(x[i]);
    memcpy(&y[i], &h, 2);
  }
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

static unsigned s = 1;
// Magnitudes in [0.25, 2) of either sign, 8 random bits: plain normal bfloat16s.
static float rndf(void) {
  s = s * 1103515245 + 12345;
  float m = 0.25f * (1.0f + (s >> 8 & 0x7f) / 128.0f) * (float)(1 << (s >> 20 & 3));
  return (s >> 24 & 1) ? -m : m;
}
static bf16 tobf(float f) {
  uint32_t u;
  memcpy(&u, &f, 4);
  return (bf16)(u >> 16);
}
static float fromf(bf16 h) {
  uint32_t u = (uint32_t)h << 16;
  float f;
  memcpy(&f, &u, 4);
  return f;
}

int main(int argc, char **argv) {
  long turns = argc > 1 ? atol(argv[1]) : 2000;
  static bf16 x[N], y[N], a[4 * K], b[8 * K], am[4 * K], bm[8 * K], ad[4 * K], bd[8 * K], z[N];
  static float xf[N], c[32];
  for (int i = 0; i < N; i++) x[i] = tobf(rndf()), y[i] = tobf(rndf()), xf[i] = rndf() * 1.001f;
  for (int i = 0; i < 4 * K; i++) a[i] = tobf(rndf() * 0.01f);
  for (int i = 0; i < 8 * K; i++) b[i] = tobf(rndf());
  // a is A column-major: a[4k + r] = A[r][k]; b row-major: b[8k + j] = B[k][j]. The packed copies:
  for (int k = 0; k < K; k++)
    for (int r = 0; r < 4; r++) {
      am[16 * (k / 4) + 8 * (r / 2) + 4 * (r % 2) + k % 4] = a[4 * k + r];
      ad[8 * (k / 2) + 2 * r + k % 2] = a[4 * k + r];
    }
  for (int k = 0; k < K; k++)
    for (int j = 0; j < 8; j++) {
      bm[32 * (k / 4) + 8 * (j / 2) + 4 * (j % 2) + k % 4] = b[8 * k + j];
      bd[16 * (k / 2) + 8 * (j / 4) + 2 * (j % 4) + k % 2] = b[8 * k + j];
    }
  int bf = (getauxval(AT_HWCAP2) & HWCAP2_BF16_BIT) != 0;
  const char *path = bf ? "bf16" : "neon";

  float acc = 0;
  double t0 = now(), t1;
  for (long t = 0; t < turns; t++) acc += (bf ? dot_bf16 : dot_neon)(x, y, N);
  t1 = now();
  printf("KERN dot %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), acc / turns, path);

  acc = 0;
  t0 = now();
  for (long t = 0; t < turns; t++) acc += (bf ? dotl_bf16 : dot_neon)(x, y, N);
  t1 = now();
  printf("KERN dotl %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), acc / turns, path);

  acc = 0;
  t0 = now();
  for (long t = 0; t < turns; t++) acc += dot_neon(x, y, N);
  t1 = now();
  printf("KERN dotv8 %.3f check %.6g neon\n", (t1 - t0) / ((double)turns * N), acc / turns);

  // A tile's 4 x 8 x K multiply-adds a call; C restarted every 16 calls.
  long calls = turns * 8;
  const struct { const char *name; void (*f)(float *, const bf16 *, const bf16 *); const bf16 *a, *b; const char *path; } tiles[] = {
    {"gemm", bf ? gemm_mmla : gemm_neon, bf ? am : a, bf ? bm : b, path},
    {"gemmdot", bf ? gemm_bfdot : gemm_neon, bf ? ad : a, bf ? bd : b, path},
    {"gemmv8", gemm_neon, a, b, "neon"},
  };
  for (int g = 0; g < 3; g++) {
    t0 = now();
    for (long t = 0; t < calls; t++) {
      if (t % 16 == 0)
        for (int i = 0; i < 32; i++) c[i] = 1.0f;
      tiles[g].f(c, tiles[g].a, tiles[g].b);
    }
    t1 = now();
    double sum = 0;
    for (int i = 0; i < 32; i++) sum += c[i];
    printf("KERN %s %.3f check %.6g %s\n", tiles[g].name, (t1 - t0) / ((double)calls * 32 * K), sum, tiles[g].path);
  }

  t0 = now();
  for (long t = 0; t < turns; t++) (bf ? cvt_bf16 : cvt_neon)(z, xf, N);
  t1 = now();
  double sum = 0;
  for (int i = 0; i < N; i++) sum += fromf(z[i]);
  printf("KERN cvt %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), sum, path);

  t0 = now();
  for (long t = 0; t < turns / 4; t++) (bf ? cvts_bf16 : cvts_int)(z, xf, N);
  t1 = now();
  sum = 0;
  for (int i = 0; i < N; i++) sum += fromf(z[i]);
  printf("KERN cvts %.3f check %.6g %s\n", (t1 - t0) / ((double)(turns / 4) * N), sum, path);
  return 0;
}
