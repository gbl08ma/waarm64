// Ad hoc: devbench.c's copy loops natively (the dev VM, M4), for the ratio.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
typedef unsigned char u8; typedef unsigned long u64;
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
static void copy_q(u8 *d, const u8 *s, u64 n) { for (u64 i = 0; i < n; i += 64) __asm__ volatile("ldp q0, q1, [%1]; ldp q2, q3, [%1, #32]; stp q0, q1, [%0]; stp q2, q3, [%0, #32]" : : "r"(d + i), "r"(s + i) : "v0", "v1", "v2", "v3", "memory"); }
static void copy_x(u8 *d, const u8 *s, u64 n) { for (u64 i = 0; i < n; i += 64) __asm__ volatile("ldp x2, x3, [%1]; ldp x4, x5, [%1, #16]; ldp x6, x7, [%1, #32]; ldp x8, x9, [%1, #48]; stp x2, x3, [%0]; stp x4, x5, [%0, #16]; stp x6, x7, [%0, #32]; stp x8, x9, [%0, #48]" : : "r"(d + i), "r"(s + i) : "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "memory"); }
static void zero_zva(u8 *d, u64 n) { for (u64 i = 0; i < n; i += 64) __asm__ volatile("dc zva, %0" : : "r"(d + i) : "memory"); }
int main(void) {
  u64 sz = 64 << 10, reps = 40000; u8 *b = aligned_alloc(4096, 16 << 20); memset(b, 1, 16 << 20);
  double t;
  for (int r = 0; r < 2; r++) {
    t = now(); for (u64 i = 0; i < reps; i++) copy_q(b + sz, b, sz); printf("copy ldp/stp q 64K: %.0f MB/s\n", reps * sz / (now() - t) / 1e6);
    t = now(); for (u64 i = 0; i < reps; i++) copy_x(b + sz, b, sz); printf("copy ldp/stp x 64K: %.0f MB/s\n", reps * sz / (now() - t) / 1e6);
    t = now(); for (u64 i = 0; i < reps; i++) zero_zva(b + sz, sz); printf("dc zva 64K: %.0f MB/s\n", reps * sz / (now() - t) / 1e6);
    t = now(); for (u64 i = 0; i < 40; i++) copy_q(b + (8 << 20), b, 8 << 20); printf("copy ldp/stp q 8M: %.0f MB/s\n", 40.0 * (8 << 20) / (now() - t) / 1e6);
    t = now(); for (u64 i = 0; i < reps; i++) { memcpy(b + sz, b, sz); __asm__ volatile("" ::: "memory"); } printf("glibc memcpy 64K: %.0f MB/s\n", reps * sz / (now() - t) / 1e6);
  }
}
