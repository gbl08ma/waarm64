// FEAT_FP16 and FEAT_FHM kernels, each path picked at run time from the hwcaps as libraries do (PERF loop 10,
// bench/boot/REPORT.md "PERF loop 10: FEAT_FP16 and FEAT_FHM"). Data in half precision, as an fp16 model's weights
// and activations (XNNPACK's f16 operators, ggml's F16 tensors, KleidiAI's f16 GEMMs):
// - axpy16: y[i] += a * x[i] on halves: FMLA .8h by element with HWCAP_ASIMDHP; without it FCVTL/FCVTL2 of x and y,
//   two FMLA .4s, FCVTN/FCVTN2 back (data stays half in memory).
// - dot16: a dot product of halves, half accumulators with ASIMDHP (ggml's F16 vec_dot on fp16 arithmetic, eight
//   lanes an FMLA); without it the halves widened (FCVTL, FCVTL2) into single accumulators.
// - gemm16: a 4x8 tile of C += A B (K = 64) by element, XNNPACK's f16 GEMM shape: half accumulators and FMLA .8h by
//   A's lanes with ASIMDHP; without it B's row and A's column widened, eight FMLA .4s by element into singles.
// - poly16: a cubic by Horner on each half (scalar _Float16 code): FMADD h with HWCAP_FPHP; without it FCVT to
//   single, FMADD s, FCVT back.
// - dotw / gemmw: the same dot product and tile with single accumulators: FMLAL/FMLAL2 (vector, by element) with
//   HWCAP_ASIMDFHM; without it the v8.0 widening of dot16's and gemm16's single paths. Both paths compute the same
//   sums in the same precision.
// Prints `KERN <name> <ns per output or element> check <sum> <path>`.
// Built natively (no guest toolchain needed): gcc -O2 -o fp16k fp16k.c
#include <arm_fp16.h>
#include <arm_neon.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/auxv.h>
#include <time.h>

#define HWCAP_FPHP_BIT (1UL << 9)
#define HWCAP_ASIMDHP_BIT (1UL << 10)
#define HWCAP_ASIMDFHM_BIT (1UL << 23)
#define N 4096 // halves an array: 8 KiB, in the L1
#define K 64   // gemm's depth

// ---- axpy16 ---------------------------------------------------------------
__attribute__((noinline)) static void axpy16_neon(float16_t *y, const float16_t *x, float a, int n) {
  for (int i = 0; i < n; i += 8) {
    float16x8_t vx = vld1q_f16(x + i), vy = vld1q_f16(y + i);
    float32x4_t lo = vfmaq_n_f32(vcvt_f32_f16(vget_low_f16(vy)), vcvt_f32_f16(vget_low_f16(vx)), a);
    float32x4_t hi = vfmaq_n_f32(vcvt_high_f32_f16(vy), vcvt_high_f32_f16(vx), a);
    vst1q_f16(y + i, vcvt_high_f16_f32(vcvt_f16_f32(lo), hi));
  }
}
__attribute__((noinline, target("+fp16"))) static void axpy16_fp16(float16_t *y, const float16_t *x, float a, int n) {
  float16x8_t va = vdupq_n_f16((float16_t)a);
  for (int i = 0; i < n; i += 8) vst1q_f16(y + i, vfmaq_laneq_f16(vld1q_f16(y + i), vld1q_f16(x + i), va, 0));
}

// ---- dot16, dotw -----------------------------------------------------------
__attribute__((noinline)) static float dot_neon(const float16_t *x, const float16_t *y, int n) {
  float32x4_t s0 = vdupq_n_f32(0), s1 = vdupq_n_f32(0);
  for (int i = 0; i < n; i += 8) {
    float16x8_t vx = vld1q_f16(x + i), vy = vld1q_f16(y + i);
    s0 = vfmaq_f32(s0, vcvt_f32_f16(vget_low_f16(vx)), vcvt_f32_f16(vget_low_f16(vy)));
    s1 = vfmaq_f32(s1, vcvt_high_f32_f16(vx), vcvt_high_f32_f16(vy));
  }
  return vaddvq_f32(vaddq_f32(s0, s1));
}
__attribute__((noinline, target("+fp16"))) static float dot16_fp16(const float16_t *x, const float16_t *y, int n) {
  float16x8_t s0 = vdupq_n_f16(0), s1 = vdupq_n_f16(0);
  for (int i = 0; i < n; i += 16) {
    s0 = vfmaq_f16(s0, vld1q_f16(x + i), vld1q_f16(y + i));
    s1 = vfmaq_f16(s1, vld1q_f16(x + i + 8), vld1q_f16(y + i + 8));
  }
  float16x8_t s = vaddq_f16(s0, s1);
  return vaddvq_f32(vaddq_f32(vcvt_f32_f16(vget_low_f16(s)), vcvt_high_f32_f16(s)));
}
__attribute__((noinline, target("+fp16fml"))) static float dotw_fhm(const float16_t *x, const float16_t *y, int n) {
  float32x4_t s0 = vdupq_n_f32(0), s1 = vdupq_n_f32(0);
  for (int i = 0; i < n; i += 8) {
    float16x8_t vx = vld1q_f16(x + i), vy = vld1q_f16(y + i);
    s0 = vfmlalq_low_f16(s0, vx, vy);
    s1 = vfmlalq_high_f16(s1, vx, vy);
  }
  return vaddvq_f32(vaddq_f32(s0, s1));
}

// ---- gemm16, gemmw: C[4][8] += A[4][K] B[K][8], A column-major (a row of 4 a step) --------------------------------
__attribute__((noinline)) static void gemm_neon(float *c, const float16_t *a, const float16_t *b) {
  float32x4_t acc[8];
  for (int r = 0; r < 4; r++) acc[2 * r] = vld1q_f32(c + 8 * r), acc[2 * r + 1] = vld1q_f32(c + 8 * r + 4);
  for (int k = 0; k < K; k++) {
    float16x8_t vb = vld1q_f16(b + 8 * k);
    float32x4_t blo = vcvt_f32_f16(vget_low_f16(vb)), bhi = vcvt_high_f32_f16(vb);
    float32x4_t va = vcvt_f32_f16(vld1_f16(a + 4 * k));
    acc[0] = vfmaq_laneq_f32(acc[0], blo, va, 0), acc[1] = vfmaq_laneq_f32(acc[1], bhi, va, 0);
    acc[2] = vfmaq_laneq_f32(acc[2], blo, va, 1), acc[3] = vfmaq_laneq_f32(acc[3], bhi, va, 1);
    acc[4] = vfmaq_laneq_f32(acc[4], blo, va, 2), acc[5] = vfmaq_laneq_f32(acc[5], bhi, va, 2);
    acc[6] = vfmaq_laneq_f32(acc[6], blo, va, 3), acc[7] = vfmaq_laneq_f32(acc[7], bhi, va, 3);
  }
  for (int r = 0; r < 4; r++) vst1q_f32(c + 8 * r, acc[2 * r]), vst1q_f32(c + 8 * r + 4, acc[2 * r + 1]);
}
__attribute__((noinline, target("+fp16"))) static void gemm16_fp16(float16_t *c, const float16_t *a, const float16_t *b) {
  float16x8_t acc[4];
  for (int r = 0; r < 4; r++) acc[r] = vld1q_f16(c + 8 * r);
  for (int k = 0; k < K; k++) {
    float16x8_t vb = vld1q_f16(b + 8 * k);
    float16x4_t va = vld1_f16(a + 4 * k);
    acc[0] = vfmaq_lane_f16(acc[0], vb, va, 0);
    acc[1] = vfmaq_lane_f16(acc[1], vb, va, 1);
    acc[2] = vfmaq_lane_f16(acc[2], vb, va, 2);
    acc[3] = vfmaq_lane_f16(acc[3], vb, va, 3);
  }
  for (int r = 0; r < 4; r++) vst1q_f16(c + 8 * r, acc[r]);
}
// The single-accumulator path of gemm16 without ASIMDHP: the tile in singles, written back as halves.
__attribute__((noinline)) static void gemm16_neon(float16_t *c, const float16_t *a, const float16_t *b) {
  float t[32];
  for (int i = 0; i < 32; i += 4) vst1q_f32(t + i, vcvt_f32_f16(vld1_f16(c + i)));
  gemm_neon(t, a, b);
  for (int i = 0; i < 32; i += 4) vst1_f16(c + i, vcvt_f16_f32(vld1q_f32(t + i)));
}
__attribute__((noinline, target("+fp16fml"))) static void gemmw_fhm(float *c, const float16_t *a, const float16_t *b) {
  float32x4_t acc[8];
  for (int r = 0; r < 4; r++) acc[2 * r] = vld1q_f32(c + 8 * r), acc[2 * r + 1] = vld1q_f32(c + 8 * r + 4);
  for (int k = 0; k < K; k++) {
    float16x8_t vb = vld1q_f16(b + 8 * k);
    float16x8_t va = vcombine_f16(vld1_f16(a + 4 * k), vld1_f16(a + 4 * k));
    acc[0] = vfmlalq_laneq_low_f16(acc[0], vb, va, 0), acc[1] = vfmlalq_laneq_high_f16(acc[1], vb, va, 0);
    acc[2] = vfmlalq_laneq_low_f16(acc[2], vb, va, 1), acc[3] = vfmlalq_laneq_high_f16(acc[3], vb, va, 1);
    acc[4] = vfmlalq_laneq_low_f16(acc[4], vb, va, 2), acc[5] = vfmlalq_laneq_high_f16(acc[5], vb, va, 2);
    acc[6] = vfmlalq_laneq_low_f16(acc[6], vb, va, 3), acc[7] = vfmlalq_laneq_high_f16(acc[7], vb, va, 3);
  }
  for (int r = 0; r < 4; r++) vst1q_f32(c + 8 * r, acc[2 * r]), vst1q_f32(c + 8 * r + 4, acc[2 * r + 1]);
}

// ---- poly16 ----------------------------------------------------------------
__attribute__((noinline)) static void poly16_neon(float16_t *y, const float16_t *x, int n) {
  for (int i = 0; i < n; i++) {
    float v = (float)x[i];
    y[i] = (float16_t)(((0.25f * v - 0.5f) * v + 0.75f) * v + 1.0f);
  }
}
// Half arithmetic as written with arm_fp16.h (GCC evaluates _Float16 expressions in single otherwise).
__attribute__((noinline, target("+fp16"))) static void poly16_fp16(float16_t *y, const float16_t *x, int n) {
  for (int i = 0; i < n; i++) {
    float16_t v = x[i];
    float16_t r = vfmah_f16((float16_t)-0.5f, (float16_t)0.25f, v);
    r = vfmah_f16((float16_t)0.75f, r, v);
    y[i] = vfmah_f16((float16_t)1.0f, r, v);
  }
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

static unsigned s = 1;
// Magnitudes in [0.25, 2) of either sign, 11 random bits: plain normal halves whose products stay normal.
static float16_t rnd(void) {
  s = s * 1103515245 + 12345;
  float m = 0.25f * (1.0f + (s >> 8 & 0x7ff) / 2048.0f) * (float)(1 << (s >> 20 & 3));
  return (float16_t)((s >> 24 & 1) ? -m : m);
}

int main(int argc, char **argv) {
  long turns = argc > 1 ? atol(argv[1]) : 2000;
  static float16_t x[N], y[N], y0[N], a[4 * K], b[8 * K], c16[32];
  static float cw[32];
  for (int i = 0; i < N; i++) x[i] = rnd(), y0[i] = rnd();
  for (int i = 0; i < 4 * K; i++) a[i] = (float16_t)((float)rnd() * 0.01f);
  for (int i = 0; i < 8 * K; i++) b[i] = rnd();
  unsigned long hw = getauxval(AT_HWCAP);
  int hp = (hw & HWCAP_ASIMDHP_BIT) != 0, fphp = (hw & HWCAP_FPHP_BIT) != 0, fhm = (hw & HWCAP_ASIMDFHM_BIT) != 0;
  const char *vpath = hp ? "fp16" : "neon", *spath = fphp ? "fp16" : "neon", *wpath = fhm ? "fhm" : "neon";

  // y stays bounded: a tiny a, refreshed every 64 turns.
  double t0 = now(), sum = 0;
  for (long t = 0; t < turns; t++) {
    if (t % 64 == 0)
      for (int i = 0; i < N; i++) y[i] = y0[i];
    (hp ? axpy16_fp16 : axpy16_neon)(y, x, 0.0078125f, N);
  }
  double t1 = now();
  for (int i = 0; i < N; i++) sum += (float)y[i];
  printf("KERN axpy16 %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), sum, vpath);

  float acc = 0;
  t0 = now();
  for (long t = 0; t < turns; t++) acc += (hp ? dot16_fp16 : dot_neon)(x, y0, N);
  t1 = now();
  printf("KERN dot16 %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), acc / turns, vpath);

  acc = 0;
  t0 = now();
  for (long t = 0; t < turns; t++) acc += (fhm ? dotw_fhm : dot_neon)(x, y0, N);
  t1 = now();
  printf("KERN dotw %.3f check %.6g %s\n", (t1 - t0) / ((double)turns * N), acc / turns, wpath);

  // A tile's 4 x 8 x K multiply-adds a call; C restarted every 16 calls (it stays well inside half's range).
  long calls = turns * 8;
  t0 = now();
  for (long t = 0; t < calls; t++) {
    if (t % 16 == 0)
      for (int i = 0; i < 32; i++) c16[i] = (float16_t)1.0f;
    (hp ? gemm16_fp16 : gemm16_neon)(c16, a, b);
  }
  t1 = now();
  sum = 0;
  for (int i = 0; i < 32; i++) sum += (float)c16[i];
  printf("KERN gemm16 %.3f check %.6g %s\n", (t1 - t0) / ((double)calls * 32 * K), sum, vpath);

  t0 = now();
  for (long t = 0; t < calls; t++) {
    if (t % 16 == 0)
      for (int i = 0; i < 32; i++) cw[i] = 1.0f;
    (fhm ? gemmw_fhm : gemm_neon)(cw, a, b);
  }
  t1 = now();
  sum = 0;
  for (int i = 0; i < 32; i++) sum += cw[i];
  printf("KERN gemmw %.3f check %.6g %s\n", (t1 - t0) / ((double)calls * 32 * K), sum, wpath);

  t0 = now();
  for (long t = 0; t < turns / 4; t++) (fphp ? poly16_fp16 : poly16_neon)(y, x, N);
  t1 = now();
  sum = 0;
  for (int i = 0; i < N; i++) sum += (float)y[i];
  printf("KERN poly16 %.3f check %.6g %s\n", (t1 - t0) / ((double)(turns / 4) * N), sum, spath);
  return 0;
}
