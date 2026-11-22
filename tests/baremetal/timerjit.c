// The timers' registers read and written inside compiled blocks (PERF loop 49): deterministic round-robin's JIT
// reads CTL, CVAL and TVAL from the step clock and keeps a write in the block when the timer's new state fires
// nothing before the chunk's end, which the run loop cut at the timers' deadlines. The physical timer, armed a
// few hundred ticks ahead, sets where a chunk ends; the virtual one is then armed just before it, at it and
// after it (through CVAL and TVAL, enabled before or after the compare value), and both IRQs are taken with
// the counter at each. Between, the code masks a timer that fired (IMASK, as Linux's handler does) and reads
// ISR_EL1 and ICC_IAR1_EL1 at once, which must see its line low. The readings' hash goes to the console,
// which a deterministic run compares between the interpreter and the JIT (tests/boot-node.test.ts), and a
// spin at the end makes the steps depend on it too. Elsewhere (realtime, the oracles) only the IRQs'
// sources and counts are checked (on the oracles, that each timer fired: the M4 takes a masked one again while
// its line falls).
#include "lib.h"

#define VTIMER 27
#define PTIMER 30

static volatile u64 n_v, n_p, n_other;
static u64 hash = 14695981039346656037UL;

static void mix(u64 v) { hash = (hash ^ v) * 1099511628211UL; }

void on_exception(struct frame *f, u64 vec) {
  if (vec != VEC_EL1H_IRQ) power_off(90 + vec);
  u64 iar = sysreg(ICC_IAR1_EL1), id = iar & 0x3ff;
  mix(sysreg(CNTVCT_EL0));
  mix(id);
  if (id == VTIMER) {
    // Linux's way: CTL read, IMASK written, no ISB between them and the EOI.
    u64 ctl;
    __asm__ volatile("mrs %0, cntv_ctl_el0; orr %0, %0, #2; msr cntv_ctl_el0, %0" : "=&r"(ctl));
    mix(ctl);
    n_v++;
  } else if (id == PTIMER) {
    u64 ctl;
    __asm__ volatile("mrs %0, cntp_ctl_el0; orr %0, %0, #2; msr cntp_ctl_el0, %0" : "=&r"(ctl));
    mix(ctl);
    n_p++;
  } else {
    n_other++;
  }
  if (id < 1020) set_sysreg(ICC_EOIR1_EL1, iar);
}

// Work between the timers' settings: a loop the JIT compiles whole, reading the timers now and then.
__attribute__((noinline)) static u64 work(u64 n, u64 x) {
  for (u64 j = 0; j < n; j++) {
    x = x * 6364136223846793005UL + j;
    if ((j & 63) == 0) {
      u64 a, b, c;
      __asm__ volatile("mrs %0, cntv_ctl_el0; add %3, %3, #1; mrs %1, cntv_tval_el0; mrs %2, cntp_tval_el0"
                       : "=&r"(a), "=&r"(b), "=&r"(c), "+r"(x));
      x ^= a + (u32)b * 3 + (u32)c * 5;
    }
  }
  return x;
}

int main(void) {
  mmio32(UART + 0x30) = 0x301; // CR: UARTEN, TXE, RXE
  gic_init();
  mmio32(SGI_BASE + 0x100) = 1u << VTIMER | 1u << PTIMER;
  mmio32(SGI_BASE + 0x418) = 0xa0a0a0a0; // IPRIORITYR, INTIDs 24-27
  mmio32(SGI_BASE + 0x41c) = 0xa0a0a0a0; // 28-31
  u64 x = 1, fired = 0;
  for (u64 i = 0; i < 16000; i++) {
    x = x * 6364136223846793005UL + 1442695040888963407UL;
    // The virtual timer against the physical one's deadline, where the chunk ends: before it (-50, -1), at it,
    // after it (1, 50), or already due.
    static const long ds[] = {-50, -1, 0, 1, 50, -3000};
    long d = ds[i % 6];
    u64 ahead = 100 + (x >> 40) % 300, form = i / 6 % 4;
    __asm__ volatile("msr daifset, #2");
    u64 p = sysreg(CNTPCT_EL0) + ahead;
    __asm__ volatile("msr cntp_cval_el0, %0; msr cntp_ctl_el0, %1" : : "r"(p), "r"(1UL));
    u64 v = p + d, now;
    switch (form) {
    case 0: // CVAL, then enabled
      __asm__ volatile("msr cntv_cval_el0, %0; msr cntv_ctl_el0, %1" : : "r"(v), "r"(1UL));
      break;
    case 1: // enabled (masked), CVAL, then unmasked
      __asm__ volatile("msr cntv_ctl_el0, %1; msr cntv_cval_el0, %0; msr cntv_ctl_el0, %2"
                       : : "r"(v), "r"(3UL), "r"(1UL));
      break;
    case 2: // TVAL, from the counter read just before
      now = sysreg(CNTVCT_EL0);
      __asm__ volatile("msr cntv_tval_el0, %0; msr cntv_ctl_el0, %1" : : "r"(v - now - 2), "r"(1UL));
      break;
    default: // enabled with the old CVAL first (maybe due), then CVAL, with an ISB between
      set_sysreg(cntv_ctl_el0, 1);
      set_sysreg(cntv_cval_el0, v);
      break;
    }
    mix(sysreg(CNTV_CVAL_EL0) - p);
    mix(sysreg(CNTV_CTL_EL0));
    // (No exit until the IRQs: one would end the chunk, and the next would be cut at the new deadline.)
    u64 nv = n_v, np = n_p;
    __asm__ volatile("msr daifclr, #2" ::: "memory");
    while (n_v == nv || n_p == np) x = work(x & 31, x);
    // Both fired, both masked by their handlers: one fires again, and the code masks it itself with IRQs
    // masked; ISR_EL1 and the acknowledge must find nothing.
    __asm__ volatile("msr daifset, #2");
    __asm__ volatile("msr cntv_tval_el0, %0; msr cntv_ctl_el0, %1" : : "r"(x % 64), "r"(1UL));
    while (!(sysreg(CNTV_CTL_EL0) & 4)) x = work(3, x);
    u64 ctl, isr;
    __asm__ volatile("mrs %0, cntv_ctl_el0; orr %0, %0, #2; msr cntv_ctl_el0, %0; mrs %1, isr_el1"
                     : "=&r"(ctl), "=&r"(isr));
#ifndef ORACLE
    // (Hardware lowers the line some time after the write.)
    u64 iar = sysreg(ICC_IAR1_EL1);
    check(!(isr & 0x80), 10);
    check((iar & 0x3ff) >= 1020, 11);
    mix(isr);
#endif
    mix(ctl);
    fired++;
    x = work((x >> 20) % 50, x);
    __asm__ volatile("msr daifclr, #2" ::: "memory");
  }
  set_sysreg(cntv_ctl_el0, 0);
  set_sysreg(cntp_ctl_el0, 0);
#ifndef ORACLE
  check(n_v == fired && n_p == fired && n_other == 0, 12);
#else
  // (Hardware may take a masked timer's IRQ again, or a spurious one, while its line falls.)
  check(n_v >= fired && n_p >= fired, 12);
#endif
  uart_puts("timerjit ");
  uart_dec(hash);
  uart_puts(" ");
  uart_dec(x);
  uart_puts("\n");
  // Steps that depend on the readings.
  u64 until = sysreg(CNTVCT_EL0) + (hash & 0xfff);
  while (sysreg(CNTVCT_EL0) < until)
    ;
  return 0;
}
