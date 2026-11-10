// An IRQ that became pending while IRQs were masked is taken right after the
// MSR that unmasks them (DAIFClr and MSR DAIF, Xt in turn): the virtual timer
// comes due 0.32 µs after it's armed, inside a masked spin of 4K steps that
// starts a chunk (the timer writes exit), and the unmask then takes it within
// a few instructions. In realtime round-robin the timer's line moves only at
// the run loop's top, so the unmask must end the chunk there (PERF loop 9:
// the JIT's inline unmask once let it wait for the chunk's end). Not in
// parallel SMP, where a timer is seen at a chunk boundary (`fast`, TIMER_STEPS).
// The latency is ours, not the architecture's (a timer's interrupt is only
// signalled in finite time): QEMU TCG, whose timer raises the line from its
// main loop, takes it late too, so the oracles check only that it's taken.
// round-robin
#include "lib.h"

#define VTIMER 27
#define REPS 3000
#define SPIN 2000
#define LATE 16

static volatile u64 fired;

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  if (vec == VEC_EL1H_IRQ) {
    u64 iar = sysreg(ICC_IAR1_EL1);
    if ((iar & 0x3ff) == VTIMER) {
      set_sysreg(cntv_ctl_el0, 3); // IMASK
      fired = 1;
    }
    set_sysreg(ICC_EOIR1_EL1, iar);
    return;
  }
  power_off(90 + vec);
}

int main(void) {
  gic_init();
  mmio32(SGI_BASE + 0x100) = 1u << VTIMER;
  mmio32(SGI_BASE + 0x418) = 0xa0a0a0a0; // IPRIORITYR, INTIDs 24-27
  for (int rep = 0; rep < REPS; rep++) {
    fired = 0;
    __asm__ volatile("msr daifset, #2" ::: "memory");
    set_sysreg(cntv_tval_el0, 20); // 0.32 µs at 62.5 MHz
    set_sysreg(cntv_ctl_el0, 1);
    u64 n = SPIN;
    __asm__ volatile("1: subs %0, %0, #1; b.ne 1b" : "+r"(n));
    if (rep & 1) {
      __asm__ volatile("msr daifclr, #2" ::: "memory");
    } else {
      u64 d;
      __asm__ volatile("mrs %0, daif; bic %0, %0, #0x80; msr daif, %0" : "=&r"(d) : : "memory");
    }
    u64 k = 0;
    while (!fired && k < 1000000)
      k++;
    __asm__ volatile("msr daifset, #2" ::: "memory");
    check(fired, 10);
#ifndef ORACLE
    check(k <= LATE, 11 + (rep & 1));
#endif
  }
  return 0;
}
