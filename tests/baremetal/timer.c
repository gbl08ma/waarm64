// M3 step 4: the generic timer, and its interrupts through the GICv3 to the
// IRQ vector; WFI; the EL0 access controls in CNTKCTL_EL1.
#include "lib.h"

#define VTIMER 27
#define PTIMER 30

static volatile u64 n_irq, last_iar, n_trap, last_trap;

void on_exception(struct frame *f, u64 vec) {
  if (vec == VEC_EL1H_IRQ) {
    u64 iar = sysreg(ICC_IAR1_EL1);
    n_irq++;
    last_iar = iar;
    // Quiet the source (IMASK), then EOI.
    if ((iar & 0x3ff) == VTIMER) set_sysreg(cntv_ctl_el0, 3);
    if ((iar & 0x3ff) == PTIMER) set_sysreg(cntp_ctl_el0, 3);
    set_sysreg(ICC_EOIR1_EL1, iar);
    return;
  }
  u64 ec = f->esr >> 26;
  if (ec == 0x15 && (f->esr & 0xffff) == 1 && vec == VEC_EL0_SYNC) {
    f->elr = (u64)el0_return; // run_el0's way back
    f->spsr = 0x3c5;
    return;
  }
  n_trap++;
  last_trap = f->esr;
  f->elr += 4;
}

static u64 user_cntvct(void) { return sysreg(CNTVCT_EL0); }
static u64 user_cntv_ctl(void) { return sysreg(CNTV_CTL_EL0); }

// EC 0x18 for an EL0 MRS: op0 3, op1 3, CRn 14, with op2 and CRm; Rt masked out.
#define TRAP_MRS(crm, op2) (0x18UL << 26 | 1 << 25 | 3 << 20 | (op2) << 17 | 3 << 14 | 14 << 10 | (crm) << 1 | 1)
#define NO_RT(esr) ((esr) & ~(0x1fUL << 5))

int main(void) {
  u64 frq = sysreg(CNTFRQ_EL0);
  check(frq != 0, 1);
#ifndef ORACLE
  check(frq == 62500000, 2);
#endif
  // The counter moves (and CNTPCT = CNTVCT, as there's no EL2 offset).
  u64 t0 = sysreg(CNTVCT_EL0);
  for (int i = 0; i < 1000000 && sysreg(CNTVCT_EL0) == t0; i++)
    ;
  check(sysreg(CNTVCT_EL0) > t0, 3);
  check(sysreg(CNTPCT_EL0) > t0, 4);

  // GIC: both timer PPIs enabled at priority 0xa0, unmasked by PMR 0xf0.
  gic_init();
  mmio32(SGI_BASE + 0x100) = 1u << VTIMER | 1u << PTIMER;
  mmio32(SGI_BASE + 0x418) = 0xa0a0a0a0; // IPRIORITYR, INTIDs 24-27
  mmio32(SGI_BASE + 0x41c) = 0xa0a0a0a0; // 28-31

  // Virtual timer through TVAL, polled with IRQs masked: ISTATUS, a negative
  // TVAL and ISR_EL1.I once it fires; the IRQ is taken on unmasking.
  set_sysreg(cntv_tval_el0, frq / 1000); // 1 ms
  set_sysreg(cntv_ctl_el0, 1);
  check((sysreg(CNTV_CTL_EL0) & 4) == 0, 10);
  while (!(sysreg(CNTV_CTL_EL0) & 4))
    ;
  check((int)sysreg(CNTV_TVAL_EL0) <= 0, 11);
  check(sysreg(ISR_EL1) & 0x80, 12);
  check(n_irq == 0, 13);
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 1 && last_iar == VTIMER, 14);
  check(!(sysreg(ISR_EL1) & 0x80), 15); // IMASK dropped the line

  // Physical timer through CVAL; WFI wakes on the pending interrupt though
  // IRQs are masked.
  set_sysreg(cntp_cval_el0, sysreg(CNTPCT_EL0) + frq / 1000);
  set_sysreg(cntp_ctl_el0, 1);
  while (!(sysreg(CNTP_CTL_EL0) & 4))
    __asm__ volatile("wfi");
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 2 && last_iar == PTIMER, 20);

  // A disabled timer never interrupts; CVAL reads back; TVAL writes are relative.
  set_sysreg(cntv_ctl_el0, 0);
  set_sysreg(cntv_cval_el0, 0);
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 2, 30);
  set_sysreg(cntv_cval_el0, 0x123456789aUL);
  check(sysreg(CNTV_CVAL_EL0) == 0x123456789aUL, 31);
  u64 now = sysreg(CNTVCT_EL0);
  set_sysreg(cntv_tval_el0, 5000);
  u64 cval = sysreg(CNTV_CVAL_EL0);
  check(cval >= now + 5000 && cval - now - 5000 < frq / 100, 32);
  set_sysreg(cntv_tval_el0, (u64)-100);
  check(sysreg(CNTV_CVAL_EL0) < sysreg(CNTVCT_EL0), 33);

  // EL0: CNTKCTL_EL1.EL0VCTEN gates CNTVCT_EL0, EL0VTEN the CNTV_* registers.
  set_sysreg(cntkctl_el1, 0);
  check(sysreg(CNTKCTL_EL1) == 0, 40);
  run_el0(user_cntvct, (u64)user_stack_top);
  check(n_trap == 1 && NO_RT(last_trap) == TRAP_MRS(0, 2), 41);
  run_el0(user_cntv_ctl, (u64)user_stack_top);
  check(n_trap == 2 && NO_RT(last_trap) == TRAP_MRS(3, 1), 42);
  set_sysreg(cntkctl_el1, 2); // EL0VCTEN
  check(run_el0(user_cntvct, (u64)user_stack_top) >= now && n_trap == 2, 43);
  set_sysreg(cntkctl_el1, 2 | 1 << 8); // and EL0VTEN
  run_el0(user_cntv_ctl, (u64)user_stack_top);
  check(n_trap == 2, 44);
  return 0;
}
