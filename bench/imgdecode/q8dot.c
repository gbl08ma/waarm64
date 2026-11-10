// An int8 vector dot product as ML runtimes write it (ggml's q8 kernels, MLAS's GEMM on the same idea): the path is
// picked at run time from the hwcap, SDOT with it, SMULL and SADALP without it. Prints `Q8DOT <path> <ns per 16 bytes>`.
// Then a 2x2 tile of them, two rows by two (ggml's q8_0 dot with FEAT_I8MM takes two rows of each at once): SMMLA on
// the rows' 64-bit halves zipped with HWCAP2_I8MM, four SDOTs without. Prints `Q8DOT q8mm <ns per 16 bytes of a row
// pair> check <sum> <path>`.
// Built natively (no guest toolchain needed): gcc -O2 -o q8dot q8dot.c
#include <arm_neon.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/auxv.h>
#include <time.h>

#define HWCAP_ASIMDDP_BIT (1UL << 20)
#define HWCAP2_I8MM_BIT (1UL << 13)
#define N 4096

__attribute__((noinline)) static int32_t dot_neon(const int8_t *a, const int8_t *b, int n) {
  int32x4_t s = vdupq_n_s32(0);
  for (int i = 0; i < n; i += 16) {
    int8x16_t x = vld1q_s8(a + i), y = vld1q_s8(b + i);
    s = vpadalq_s16(s, vmull_s8(vget_low_s8(x), vget_low_s8(y)));
    s = vpadalq_s16(s, vmull_high_s8(x, y));
  }
  return vaddvq_s32(s);
}

__attribute__((noinline, target("+dotprod"))) static int32_t dot_sdot(const int8_t *a, const int8_t *b, int n) {
  int32x4_t s = vdupq_n_s32(0);
  for (int i = 0; i < n; i += 16) s = vdotq_s32(s, vld1q_s8(a + i), vld1q_s8(b + i));
  return vaddvq_s32(s);
}

__attribute__((noinline, target("+dotprod"))) static int32_t tile_sdot(const int8_t *a, const int8_t *b, int n) {
  int32x4_t s00 = vdupq_n_s32(0), s01 = s00, s10 = s00, s11 = s00;
  for (int i = 0; i < n; i += 16) {
    int8x16_t a0 = vld1q_s8(a + i), a1 = vld1q_s8(a + N + i), b0 = vld1q_s8(b + i), b1 = vld1q_s8(b + N + i);
    s00 = vdotq_s32(s00, a0, b0);
    s01 = vdotq_s32(s01, a0, b1);
    s10 = vdotq_s32(s10, a1, b0);
    s11 = vdotq_s32(s11, a1, b1);
  }
  return vaddvq_s32(s00) + 3 * vaddvq_s32(s01) + 5 * vaddvq_s32(s10) + 7 * vaddvq_s32(s11);
}

__attribute__((noinline, target("+i8mm"))) static int32_t tile_mmla(const int8_t *a, const int8_t *b, int n) {
  int32x4_t s = vdupq_n_s32(0), u = s;
  for (int i = 0; i < n; i += 16) {
    int64x2_t a0 = vreinterpretq_s64_s8(vld1q_s8(a + i)), a1 = vreinterpretq_s64_s8(vld1q_s8(a + N + i));
    int64x2_t b0 = vreinterpretq_s64_s8(vld1q_s8(b + i)), b1 = vreinterpretq_s64_s8(vld1q_s8(b + N + i));
    s = vmmlaq_s32(s, vreinterpretq_s8_s64(vzip1q_s64(a0, a1)), vreinterpretq_s8_s64(vzip1q_s64(b0, b1)));
    u = vmmlaq_s32(u, vreinterpretq_s8_s64(vzip2q_s64(a0, a1)), vreinterpretq_s8_s64(vzip2q_s64(b0, b1)));
  }
  s = vaddq_s32(s, u);
  return vgetq_lane_s32(s, 0) + 3 * vgetq_lane_s32(s, 1) + 5 * vgetq_lane_s32(s, 2) + 7 * vgetq_lane_s32(s, 3);
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

int main(int argc, char **argv) {
  static int8_t a[2 * N], b[2 * N];
  unsigned s = 1;
  for (int i = 0; i < 2 * N; i++) {
    a[i] = (s = s * 1103515245 + 12345) >> 16;
    b[i] = (s = s * 1103515245 + 12345) >> 16;
  }
  int dotprod = (getauxval(AT_HWCAP) & HWCAP_ASIMDDP_BIT) != 0;
  long turns = argc > 1 ? atol(argv[1]) : 40000;
  int32_t sum = 0;
  double t0 = now();
  for (long t = 0; t < turns; t++) sum += dotprod ? dot_sdot(a, b, N) : dot_neon(a, b, N);
  double t1 = now();
  printf("Q8DOT %s %.3f check %d\n", dotprod ? "sdot" : "neon", (t1 - t0) / (turns * (N / 16)), sum);
  if (dotprod) {
    int i8mm = (getauxval(AT_HWCAP2) & HWCAP2_I8MM_BIT) != 0;
    sum = 0;
    t0 = now();
    for (long t = 0; t < turns; t++) {
      __asm__ volatile("" : : "r"(a), "r"(b) : "memory"); // the tile is pure: keep each turn's
      sum += i8mm ? tile_mmla(a, b, N) : tile_sdot(a, b, N);
    }
    t1 = now();
    printf("Q8DOT q8mm %.3f check %d %s\n", (t1 - t0) / (turns * (N / 16)), sum, i8mm ? "mmla" : "sdot");
  }
  return 0;
}
