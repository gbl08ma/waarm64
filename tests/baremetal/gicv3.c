// M7 loop 2: the GICv3 distributor, redistributor and system-register CPU
// interface, one CPU: register shapes, SGIs through ICC_SGI1R_EL1,
// pending/active state, priorities and preemption, split EOI, an SPI and the
// virtual timer's PPI taken through the IRQ vector.
// oracle: GICv3
#include "lib.h"

#define GICR 0x080a0000UL
#define SGI_BASE (GICR + 0x10000)
#define VTIMER 27

static volatile u64 n_irq, last_iar;

void on_exception(struct frame *f, u64 vec) {
  if (vec != VEC_EL1H_IRQ) power_off(100 + vec);
  u64 iar = sysreg(ICC_IAR1_EL1);
  n_irq++;
  last_iar = iar;
  if (iar == VTIMER) set_sysreg(cntv_ctl_el0, 3); // IMASK
  set_sysreg(ICC_EOIR1_EL1, iar);
  (void)f;
}

#define IAR() (sysreg(ICC_IAR1_EL1) & 0xffffff)
#define EOI(i) set_sysreg(ICC_EOIR1_EL1, i)
// Aff3.Aff2.Aff1 = 0, target list: CPU 0 (Aff0 0).
#define SGI_SELF(i) set_sysreg(ICC_SGI1R_EL1, (u64)(i) << 24 | 1)
#define ACTIVE0() mmio32(SGI_BASE + 0x300)
#define IRQ_PENDING() (sysreg(ISR_EL1) & 0x80)
#define RWP_WAIT() while (mmio32(GICD) & 1u << 31)

int main(void) {
#ifndef HVF // Apple's hypervisor reports GIC = 0 while its ICC_* registers work
  check((sysreg(ID_AA64PFR0_EL1) >> 24 & 0xf) == 1, 1); // GIC: the system-register interface
#endif
  u32 typer = mmio32(GICD + 0x004);
  check(32 * ((typer & 0x1f) + 1) >= 64, 2);
  check(((mmio32(GICD + 0xffe8) >> 4) & 0xf) == 3, 3); // PIDR2.ArchRev
  check(((mmio32(GICR + 0xffe8) >> 4) & 0xf) == 3, 4);
  // GICR_TYPER: this CPU's affinity, processor 0, the last redistributor.
  u64 rtyper = *(volatile u64 *)(GICR + 0x8); // a 64-bit read, as Linux does (Apple's vGIC reads 0 for 32-bit halves)
  u64 mpidr = sysreg(MPIDR_EL1);
  check(rtyper >> 32 == ((mpidr >> 8 & 0xff000000) | (mpidr & 0xffffff)), 5);
  check((rtyper >> 4 & 1) == 1 && (rtyper >> 8 & 0xffff) == 0, 6);
  check(sysreg(ICC_SRE_EL1) & 1, 7);
#ifndef ORACLE
  check(mpidr == 1UL << 31, 8);
  check((sysreg(ICC_CTLR_EL1) >> 8 & 7) == 4, 9); // PRIbits: 5 bits
#endif

  // Wake the redistributor; affinity routing and group 1 on at the distributor.
  mmio32(GICR + 0x14) &= ~2u;
  while (mmio32(GICR + 0x14) & 4)
    ;
  mmio32(GICD + 0x000) = 1 << 4 | 1 << 1; // ARE, EnableGrp1
  RWP_WAIT();
  check((mmio32(GICD + 0x000) & 0x12) == 0x12, 10);

  // Priorities are byte-accessible; at least 4 bits, from the top.
  mmio8(GICD + 0x420) = 0xff; // SPI 32
  unsigned char pbits = mmio8(GICD + 0x420);
  check((pbits & 0xf0) == 0xf0 && (u32)(pbits | (pbits - 1)) == 0xff, 11);
  check((mmio32(GICD + 0x420) & 0xff) == pbits, 12);
  // SGIs are edge-triggered, read-only (GICR_ICFGR0: QEMU and we read 0b10
  // per SGI, as GICv2 prescribes; Apple's vGIC reads 0).
  mmio32(SGI_BASE + 0xc00) = 0;
#ifndef HVF
  check(mmio32(SGI_BASE + 0xc00) == 0xaaaaaaaa, 13);
#endif
  // With affinity routing, the distributor's SGI/PPI registers are RAZ/WI.
  mmio32(GICD + 0x100) = 0xffff;
  check(mmio32(GICD + 0x100) == 0, 14);

  // SGIs and PPIs group 1 and enabled; priorities by SGI: 2 at 0x40, 3 at 0x80,
  // 4 at 0xc0. The CPU interface: group priority bits 7:3, PMR 0xf0, group 1 on.
  mmio32(SGI_BASE + 0x080) = ~0u;
  mmio32(SGI_BASE + 0x100) = 0xffff;
  mmio32(SGI_BASE + 0x400) = 0x80400000;
  mmio32(SGI_BASE + 0x404) = 0xc0;
  set_sysreg(ICC_BPR1_EL1, 3);
  set_sysreg(ICC_PMR_EL1, 0xf0);
  set_sysreg(ICC_IGRPEN1_EL1, 1);
  check(sysreg(ICC_PMR_EL1) == 0xf0 && sysreg(ICC_IGRPEN1_EL1) == 1, 19);

  check(IAR() == 1023 && !IRQ_PENDING(), 20); // nothing pending: spurious
  // An SGI to self, polled through IAR/EOIR with IRQs masked.
  SGI_SELF(3);
  check(IRQ_PENDING(), 21);
  check(sysreg(ICC_HPPIR1_EL1) == 3, 22);
  check(IAR() == 3 && (ACTIVE0() & 1 << 3), 23);
  check(sysreg(ICC_RPR_EL1) == 0x80, 24);
  check(!IRQ_PENDING(), 25);
  EOI(3);
  check(!(ACTIVE0() & 1 << 3) && sysreg(ICC_RPR_EL1) == 0xff, 26);

  // Preemption: with SGI 3 (0x80) active, SGI 2 (0x40) is signaled and SGI 4 (0xc0) isn't.
  SGI_SELF(3);
  check(IAR() == 3, 30);
  SGI_SELF(4);
  SGI_SELF(2);
  check(sysreg(ICC_HPPIR1_EL1) == 2, 31);
  check(IAR() == 2, 32);
  check(IAR() == 1023, 33); // 4 doesn't preempt 0x40, nor 0x80 after EOI 2
  EOI(2);
  check(IAR() == 1023, 34);
  EOI(3);
  check(IAR() == 4, 35);
  EOI(4);

  // PMR: an interrupt needs a strictly higher priority (lower value).
  set_sysreg(ICC_PMR_EL1, 0x80);
  SGI_SELF(3);
  check(!IRQ_PENDING() && IAR() == 1023, 40);
  set_sysreg(ICC_PMR_EL1, 0xf0);
  check(IAR() == 3, 41);
  EOI(3);

  // Split EOI (ICC_CTLR_EL1.EOImode): EOIR drops priority, ICC_DIR deactivates.
  set_sysreg(ICC_CTLR_EL1, 2);
  SGI_SELF(3);
  check(IAR() == 3, 50);
  EOI(3);
  check((ACTIVE0() & 1 << 3) && sysreg(ICC_RPR_EL1) == 0xff, 51);
  SGI_SELF(3);
  check(IAR() == 1023, 52); // still active: not signaled again
  set_sysreg(ICC_DIR_EL1, 3);
  check(IAR() == 3, 53);
  EOI(3);
  set_sysreg(ICC_DIR_EL1, 3);
  set_sysreg(ICC_CTLR_EL1, 0);

  // An SPI routed to this CPU, made pending by software, taken through the IRQ
  // vector; ICPENDR withdraws one before it's taken.
  mmio32(GICD + 0x6000 + 8 * 40) = (u32)(mpidr & 0xffffff); // IROUTER40: Aff2-Aff0
  mmio32(GICD + 0x6000 + 8 * 40 + 4) = (u32)(mpidr >> 32 & 0xff);
  mmio32(GICD + 0x084) = ~0u; // SPIs 32-63 group 1
  mmio8(GICD + 0x420 + 8) = 0xa0;
  mmio32(GICD + 0x104) = 1 << 8;
  mmio32(GICD + 0x204) = 1 << 8; // ISPENDR
  check(mmio32(GICD + 0x204) & 1 << 8, 60);
  mmio32(GICD + 0x284) = 1 << 8; // ICPENDR
  check(!(mmio32(GICD + 0x204) & 1 << 8) && !IRQ_PENDING(), 61);
  mmio32(GICD + 0x204) = 1 << 8;
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 1 && last_iar == 40, 62);
  // Group 1 off at the CPU interface: nothing is signaled.
  set_sysreg(ICC_IGRPEN1_EL1, 0);
  SGI_SELF(5);
  check(!IRQ_PENDING() && IAR() == 1023, 63);
  set_sysreg(ICC_IGRPEN1_EL1, 1);
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 2 && last_iar == 5, 64);

  // The virtual timer's PPI through the redistributor, taken on unmasking.
  mmio8(SGI_BASE + 0x400 + VTIMER) = 0xa0;
  mmio32(SGI_BASE + 0x100) = 1u << VTIMER;
  set_sysreg(cntv_tval_el0, sysreg(CNTFRQ_EL0) / 1000); // 1 ms
  set_sysreg(cntv_ctl_el0, 1);
  while (!(sysreg(CNTV_CTL_EL0) & 4))
    ;
  check(sysreg(ISR_EL1) & 0x80, 70);
  check(sysreg(ICC_HPPIR1_EL1) == VTIMER, 71);
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 3 && last_iar == VTIMER, 72);
  check(!(sysreg(ISR_EL1) & 0x80), 73); // IMASK dropped the line
  return 0;
}
