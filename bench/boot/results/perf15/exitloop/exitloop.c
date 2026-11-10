// PERF loop 15: ns per iteration of an always-exiting `mrs cntfrq_el0`, a fast-completed `isb`, a `wfe` (a yield),
// and an empty loop, timed with the counter (realtime: the host clock). Prints "<kind> <ps per iteration>".
// (PERF loop 18: `report` went through µs; ticks × 10^12 overflowed u64 past ~0.3 s, which read as a clock not counting.)
#include "lib.h"
static inline u64 cnt(void) { u64 v; __asm__ volatile("isb; mrs %0, cntvct_el0" : "=r"(v)); return v; }
static inline u64 frq(void) { u64 v; __asm__ volatile("mrs %0, cntfrq_el0" : "=r"(v)); return v; }
#define N 4000000ull
static void report(const char *k, u64 t0, u64 t1, u64 n) {
  u64 f = frq();
  u64 ps = (t1 - t0) * 1000000 / f * 1000000 / n; // picoseconds per iteration (via µs: ticks × 10^12 overflows u64 past ~0.3 s)
  uart_puts(k); uart_putc(' '); uart_dec(ps); uart_puts(" ps\n");
}
void on_exception(struct frame *f, u64 vec) { if (vec != VEC_EL1H_SYNC || f->esr >> 26 != 0x15) power_off(100 + vec); }
#ifdef ONLY
// One kind for a profile, ~ONLY_N iterations with the MMU on: 0 cntfrq, 1 isb, 2 wfe, 3 svc.
static void mmu_on(void);
int main(void) {
  mmu_on();
  u64 t0 = cnt();
  for (u64 i = 0; i < ONLY_N; i++) {
    if (ONLY == 0) { u64 v; __asm__ volatile("mrs %0, cntfrq_el0" : "=r"(v)); }
    if (ONLY == 1) __asm__ volatile("isb" ::: "memory");
    if (ONLY == 2) __asm__ volatile("wfe" ::: "memory");
    if (ONLY == 3) __asm__ volatile("svc #0" ::: "memory");
  }
  report("only", t0, cnt(), ONLY_N);
  return 0;
}
#endif
static void report(const char *k, u64 t0, u64 t1, u64 n);
static u64 l1[512] __attribute__((aligned(4096)));
// The MMU on, as a Linux guest has it: TTBR0 with 1 GiB blocks (devices, then RAM, both nG), ASID 5.
static void mmu_on(void) {
  l1[0] = 0x00000000UL | 1UL << 11 | 1UL << 10 | 0 << 2 | 1; // device, nG, AF
  l1[1] = 0x40000000UL | 1UL << 11 | 1UL << 10 | 3UL << 8 | 1 << 2 | 1; // normal, inner shareable, nG, AF
  set_sysreg(mair_el1, 0xff00);
  set_sysreg(tcr_el1, 25UL | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l1 | 5UL << 48);
  __asm__ volatile("tlbi vmalle1; dsb sy; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12);
}
#ifndef ONLY
int main(void) {
  for (int round = 0; round < 6; round++) {
    if (round == 3) { mmu_on(); uart_puts("mmu on\n"); }
    u64 t0 = cnt();
    for (u64 i = 0; i < N; i++) { u64 v; __asm__ volatile("mrs %0, cntfrq_el0" : "=r"(v)); }
    u64 t1 = cnt();
    report("cntfrq", t0, t1, N);
    t0 = cnt();
    for (u64 i = 0; i < N; i++) __asm__ volatile("isb" ::: "memory");
    t1 = cnt();
    report("isb", t0, t1, N);
    t0 = cnt();
    for (u64 i = 0; i < N; i++) __asm__ volatile("wfe" ::: "memory");
    t1 = cnt();
    report("wfe", t0, t1, N);
    t0 = cnt();
    for (u64 i = 0; i < N; i++) __asm__ volatile("svc #0" ::: "memory");
    t1 = cnt();
    report("svc", t0, t1, N);
    t0 = cnt();
    for (u64 i = 0; i < N * 16; i++) __asm__ volatile("" ::: "memory");
    t1 = cnt();
    report("empty", t0, t1, N * 16);
  }
  return 0;
}
#endif
