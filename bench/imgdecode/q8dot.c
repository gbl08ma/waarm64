// An int8 vector dot product as ML runtimes write it (ggml's q8 kernels, MLAS's GEMM on the same idea): the path is
// picked at run time from the hwcap, SDOT with it, SMULL and SADALP without it. Prints `Q8DOT <path> <ns per 16 bytes>`.
// Built natively (no guest toolchain needed): gcc -O2 -o q8dot q8dot.c
#include <arm_neon.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/auxv.h>
#include <time.h>

#define HWCAP_ASIMDDP_BIT (1UL << 20)
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

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

int main(int argc, char **argv) {
  static int8_t a[N], b[N];
  unsigned s = 1;
  for (int i = 0; i < N; i++) {
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
  return 0;
}
