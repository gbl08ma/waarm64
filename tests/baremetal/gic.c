// M3 step 4: the GICv2 distributor and CPU interface. Register shapes, SGIs,
// pending/active state, priorities and preemption, split EOI, and an SPI
// oracle: needs GICv2 (HVF has none)
// taken through the IRQ vector.
#include "lib.h"

static volatile u64 n_irq, last_iar;

void on_exception(struct frame *f, u64 vec) {
  if (vec != VEC_EL1H_IRQ) power_off(100 + vec);
  u32 iar = mmio32(GICC + 0x0c);
  n_irq++;
  last_iar = iar;
  mmio32(GICC + 0x10) = iar;
  (void)f;
}

#define IAR() (mmio32(GICC + 0x0c) & 0x3ff)
#define EOI(i) (mmio32(GICC + 0x10) = (i))
#define SGI_SELF(i) (mmio32(GICD + 0xf00) = 2 << 24 | (i))
#define ACTIVE0() mmio32(GICD + 0x300)
#define IRQ_PENDING() (sysreg(ISR_EL1) & 0x80)

int main(void) {
  u32 typer = mmio32(GICD + 0x004);
  check(32 * ((typer & 0x1f) + 1) >= 64, 1);
  check(((typer >> 5) & 7) == 0, 2); // one CPU
  check(((mmio32(GICD + 0xfe8) >> 4) & 0xf) == 2, 3); // ICPIDR2.ArchRev: GICv2

  // Priorities are byte-accessible; at least 4 bits are implemented, from the top.
  mmio8(GICD + 0x420) = 0xff; // SPI 32
  unsigned char pbits = mmio8(GICD + 0x420);
  check((pbits & 0xf0) == 0xf0 && (u32)(pbits | (pbits - 1)) == 0xff, 10);
  check((mmio32(GICD + 0x420) & 0xff) == pbits, 11);
  // Targets: RAZ/WI on a uniprocessor GIC.
  mmio8(GICD + 0x820) = 0xff;
  check(mmio32(GICD + 0x800) == 0 && mmio8(GICD + 0x820) == 0, 12);
  // ICFGR: SGIs are edge-triggered and read-only.
  mmio32(GICD + 0xc00) = 0;
  check(mmio32(GICD + 0xc00) == 0xaaaaaaaa, 15);

  // Distributor and CPU interface on; SGIs 0-15 enabled; priorities by SGI:
  // 2 at 0x40, 3 at 0x80, 4 at 0xc0.
  mmio32(GICD + 0x000) = 1;
  mmio32(GICD + 0x100) = 0xffff;
  mmio32(GICD + 0x400) = 0x80400000;
  mmio32(GICD + 0x404) = 0xc0;
  mmio32(GICC + 0x008) = 2; // BPR: group priority is bits 7:3
  mmio32(GICC + 0x004) = 0xf0;
  mmio32(GICC + 0x000) = 1;

  check(IAR() == 1023 && !IRQ_PENDING(), 20); // nothing pending: spurious
  // An SGI to self, polled through IAR/EOIR with IRQs masked.
  SGI_SELF(3);
  check(IRQ_PENDING(), 21);
  check(mmio32(GICC + 0x018) == 3, 22); // HPPIR
  check(IAR() == 3 && (ACTIVE0() & 1 << 3), 23);
  check(mmio32(GICC + 0x014) == 0x80, 24); // RPR
  check(!IRQ_PENDING(), 25);
  EOI(3);
  check(!(ACTIVE0() & 1 << 3) && mmio32(GICC + 0x014) == 0xff, 26);

  // Preemption: with SGI 3 (0x80) active, SGI 2 (0x40) is signaled and SGI 4 (0xc0) isn't.
  SGI_SELF(3);
  check(IAR() == 3, 30);
  SGI_SELF(4);
  SGI_SELF(2);
  check(mmio32(GICC + 0x018) == 2, 31);
  check(IAR() == 2, 32);
  check(IAR() == 1023, 33); // 4 doesn't preempt 0x40, nor 0x80 after EOI 2
  EOI(2);
  check(IAR() == 1023, 34);
  EOI(3);
  check(IAR() == 4, 35);
  EOI(4);

  // PMR: an interrupt needs a strictly higher priority (lower value).
  mmio32(GICC + 0x004) = 0x80;
  SGI_SELF(3);
  check(!IRQ_PENDING() && IAR() == 1023, 40);
  mmio32(GICC + 0x004) = 0xf0;
  check(IAR() == 3, 41);
  EOI(3);

  // Split EOI (GICC_CTLR.EOImode): EOIR drops priority, GICC_DIR deactivates.
  mmio32(GICC + 0x000) = 1 | 1 << 9;
  SGI_SELF(3);
  check(IAR() == 3, 50);
  EOI(3);
  check((ACTIVE0() & 1 << 3) && mmio32(GICC + 0x014) == 0xff, 51);
  SGI_SELF(3);
  check(IAR() == 1023, 52); // still active: not signaled again
  mmio32(GICC + 0x1000) = 3;
  check(IAR() == 3, 53);
  EOI(3);
  mmio32(GICC + 0x1000) = 3;
  mmio32(GICC + 0x000) = 1;

  // An SPI made pending by software, taken through the IRQ vector; ICPENDR
  // withdraws one before it's taken.
  mmio8(GICD + 0x420 + 8) = 0xa0; // SPI 40
  mmio32(GICD + 0x104) = 1 << 8;
  mmio32(GICD + 0x204) = 1 << 8; // ISPENDR
  check(mmio32(GICD + 0x204) & 1 << 8, 60);
  mmio32(GICD + 0x284) = 1 << 8; // ICPENDR
  check(!(mmio32(GICD + 0x204) & 1 << 8) && !IRQ_PENDING(), 61);
  mmio32(GICD + 0x204) = 1 << 8;
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 1 && (last_iar & 0x3ff) == 40, 62);
  // Disabled at the distributor: nothing is forwarded.
  mmio32(GICD + 0x000) = 0;
  SGI_SELF(5);
  check(!IRQ_PENDING() && IAR() == 1023, 63);
  mmio32(GICD + 0x000) = 1;
  __asm__ volatile("msr daifclr, #2; isb; msr daifset, #2" ::: "memory");
  check(n_irq == 2 && (last_iar & 0x3ff) == 5, 64);
  return 0;
}
