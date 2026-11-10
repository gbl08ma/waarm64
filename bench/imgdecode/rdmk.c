// FEAT_RDM and FEAT_LRCPC2 kernels, each path picked at run time from the hwcap as libraries do (PERF loop 6,
// bench/boot/REPORT.md "PERF loop 6: FEAT_RDM and FEAT_LRCPC2").
// - A Q15 FIR filter (8 taps, by element) and a Q15 / Q31 multiply-accumulate (vector), as audio and video code write
//   them: SQRDMLAH with HWCAP_ASIMDRDM, SQRDMULH then SQADD without it.
// - Acquire loads of a field at an offset in a chain of nodes, as code built for v8.4 reads a published structure:
//   LDAPUR with HWCAP_ILRCPC, an ADD and LDAPR without it (LDAR without HWCAP_LRCPC).
// Prints `KERN <name> <ns per unit> check <sum> <path>`.
// Built natively (no guest toolchain needed): gcc -O2 -o rdmk rdmk.c
#include <arm_neon.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/auxv.h>
#include <time.h>

#define HWCAP_ASIMDRDM_BIT (1UL << 12)
#define HWCAP_LRCPC_BIT (1UL << 15)
#define HWCAP_ILRCPC_BIT (1UL << 26)
#define N 4096

// y[i] = sat(y[i] + sum_k x[i + k] * h[k]), Q15, 8 taps: one by-element multiply-accumulate per tap.
__attribute__((noinline)) static void fir_neon(int16_t *y, const int16_t *x, const int16_t *h, int n) {
  int16x8_t c = vld1q_s16(h);
  for (int i = 0; i < n; i += 8) {
    int16x8_t s = vld1q_s16(y + i);
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 0), c, 0));
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 1), c, 1));
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 2), c, 2));
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 3), c, 3));
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 4), c, 4));
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 5), c, 5));
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 6), c, 6));
    s = vqaddq_s16(s, vqrdmulhq_laneq_s16(vld1q_s16(x + i + 7), c, 7));
    vst1q_s16(y + i, s);
  }
}

__attribute__((noinline, target("+rdma"))) static void fir_rdm(int16_t *y, const int16_t *x, const int16_t *h, int n) {
  int16x8_t c = vld1q_s16(h);
  for (int i = 0; i < n; i += 8) {
    int16x8_t s = vld1q_s16(y + i);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 0), c, 0);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 1), c, 1);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 2), c, 2);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 3), c, 3);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 4), c, 4);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 5), c, 5);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 6), c, 6);
    s = vqrdmlahq_laneq_s16(s, vld1q_s16(x + i + 7), c, 7);
    vst1q_s16(y + i, s);
  }
}

// y[i] = sat(y[i] + a[i] * b[i]) (Q15) and its Q31 form, vector by vector.
__attribute__((noinline)) static void mac16_neon(int16_t *y, const int16_t *a, const int16_t *b, int n) {
  for (int i = 0; i < n; i += 8)
    vst1q_s16(y + i, vqaddq_s16(vld1q_s16(y + i), vqrdmulhq_s16(vld1q_s16(a + i), vld1q_s16(b + i))));
}
__attribute__((noinline, target("+rdma"))) static void mac16_rdm(int16_t *y, const int16_t *a, const int16_t *b, int n) {
  for (int i = 0; i < n; i += 8) vst1q_s16(y + i, vqrdmlahq_s16(vld1q_s16(y + i), vld1q_s16(a + i), vld1q_s16(b + i)));
}
__attribute__((noinline)) static void mac32_neon(int32_t *y, const int32_t *a, const int32_t *b, int n) {
  for (int i = 0; i < n; i += 4)
    vst1q_s32(y + i, vqaddq_s32(vld1q_s32(y + i), vqrdmulhq_s32(vld1q_s32(a + i), vld1q_s32(b + i))));
}
__attribute__((noinline, target("+rdma"))) static void mac32_rdm(int32_t *y, const int32_t *a, const int32_t *b, int n) {
  for (int i = 0; i < n; i += 4) vst1q_s32(y + i, vqrdmlahq_s32(vld1q_s32(y + i), vld1q_s32(a + i), vld1q_s32(b + i)));
}

// A chain of nodes: the next pointer at 0, a value at 12 and one at 16, each read with acquire.
struct node {
  struct node *next;
  uint32_t pad, a;
  uint64_t b;
};
__attribute__((noinline)) static uint64_t walk_ldar(struct node *p, long n) {
  uint64_t s = 0;
  for (long k = 0; k < n; k++) {
    uint32_t a;
    uint64_t b;
    uint32_t *pa = &p->a;
    uint64_t *pb = &p->b;
    __asm__ volatile("ldar %w0, [%2]\n\tldar %1, [%3]" : "=&r"(a), "=&r"(b) : "r"(pa), "r"(pb) : "memory");
    s += a ^ b;
    p = p->next;
  }
  return s;
}
__attribute__((noinline)) static uint64_t walk_ldapr(struct node *p, long n) {
  uint64_t s = 0;
  for (long k = 0; k < n; k++) {
    uint32_t a;
    uint64_t b;
    __asm__ volatile("add x9, %2, #12\n\tldapr %w0, [x9]\n\tadd x9, %2, #16\n\tldapr %1, [x9]"
                     : "=&r"(a), "=&r"(b) : "r"(p) : "x9", "memory");
    s += a ^ b;
    p = p->next;
  }
  return s;
}
__attribute__((noinline)) static uint64_t walk_ldapur(struct node *p, long n) {
  uint64_t s = 0;
  for (long k = 0; k < n; k++) {
    uint32_t a;
    uint64_t b;
    __asm__ volatile(".arch_extension rcpc2\n\tldapur %w0, [%2, #12]\n\tldapur %1, [%2, #16]"
                     : "=&r"(a), "=&r"(b) : "r"(p) : "memory");
    s += a ^ b;
    p = p->next;
  }
  return s;
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

int main(int argc, char **argv) {
  long turns = argc > 1 ? atol(argv[1]) : 2000;
  static int16_t x[N + 8], y[N], b16[N];
  static int32_t a32[N], b32[N], y32[N];
  unsigned s = 1;
  for (int i = 0; i < N + 8; i++) x[i] = (s = s * 1103515245 + 12345) >> 16;
  for (int i = 0; i < N; i++) {
    b16[i] = (s = s * 1103515245 + 12345) >> 16;
    a32[i] = s = s * 1103515245 + 12345;
    b32[i] = s = s * 1103515245 + 12345;
  }
  const int16_t h[8] = {-1200, 2900, -7100, 20000, 20000, -7100, 2900, -1200};
  unsigned long hw = getauxval(AT_HWCAP);
  int rdm = (hw & HWCAP_ASIMDRDM_BIT) != 0;
  const char *path = rdm ? "rdm" : "neon";

  for (int i = 0; i < N; i++) y[i] = 0;
  double t0 = now();
  for (long t = 0; t < turns; t++) (rdm ? fir_rdm : fir_neon)(y, x, h, N);
  double t1 = now();
  long sum = 0;
  for (int i = 0; i < N; i++) sum += y[i];
  printf("KERN fir16 %.3f check %ld %s\n", (t1 - t0) / (turns * (N / 8.0)), sum, path);

  for (int i = 0; i < N; i++) y[i] = 0;
  t0 = now();
  for (long t = 0; t < turns * 4; t++) (rdm ? mac16_rdm : mac16_neon)(y, x, b16, N);
  t1 = now();
  sum = 0;
  for (int i = 0; i < N; i++) sum += y[i];
  printf("KERN mac16 %.3f check %ld %s\n", (t1 - t0) / (turns * 4 * (N / 8.0)), sum, path);

  for (int i = 0; i < N; i++) y32[i] = 0;
  t0 = now();
  for (long t = 0; t < turns * 2; t++) (rdm ? mac32_rdm : mac32_neon)(y32, a32, b32, N);
  t1 = now();
  sum = 0;
  for (int i = 0; i < N; i++) sum += y32[i];
  printf("KERN mac32 %.3f check %ld %s\n", (t1 - t0) / (turns * 2 * (N / 4.0)), sum, path);

  // The chain: 4096 nodes 64 bytes apart, in a shuffled order that stays in the cache.
  static struct node nodes[N] __attribute__((aligned(64)));
  static int order[N];
  for (int i = 0; i < N; i++) order[i] = i;
  for (int i = N - 1; i > 0; i--) {
    int j = (s = s * 1103515245 + 12345) % (i + 1), t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  for (int i = 0; i < N; i++) {
    struct node *p = &nodes[order[i]];
    p->next = &nodes[order[(i + 1) % N]];
    p->a = i * 2654435761u;
    p->b = (uint64_t)i << 20 | i;
  }
  int ilrcpc = (hw & HWCAP_ILRCPC_BIT) != 0, lrcpc = (hw & HWCAP_LRCPC_BIT) != 0;
  long steps = turns * 400L;
  t0 = now();
  uint64_t w = ilrcpc ? walk_ldapur(nodes, steps) : lrcpc ? walk_ldapr(nodes, steps) : walk_ldar(nodes, steps);
  t1 = now();
  printf("KERN acquire %.3f check %lu %s\n", (t1 - t0) / steps, (unsigned long)w, ilrcpc ? "ldapur" : lrcpc ? "ldapr" : "ldar");
  return 0;
}
