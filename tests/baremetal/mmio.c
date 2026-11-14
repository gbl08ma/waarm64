// Device accesses through the TLB's device entries (docs/cpu.md "Device pages in the TLB") and, under parallel SMP's
// JIT, completed in the helper without leaving the block (docs/jit.md "Device accesses"): fw_cfg's data register,
// whose every read moves its offset, read in a loop through 4 KiB Device pages at a VA that isn't the PA; the entry
// remapped by a TLBI; a misaligned access and a hole after the entry is cached; an SPI made pending by a store, taken
// before the next instruction, and with a writeback whose base an earlier site's failure segment also stores.
// flash
#include "lib.h"

#define RAM 0x40000000UL
#define FW_CFG 0x09020000UL
#define HOLE 0x0b000000UL // nothing there
#define ALIAS 0x100000000UL // l1[4]: four 4 KiB Device pages
#define A_FWCFG (ALIAS + 0x0000)
#define A_UART (ALIAS + 0x1000)
#define A_HOLE (ALIAS + 0x2000)
#define A_GICD (ALIAS + 0x3000)

static u64 l0[512] __attribute__((aligned(4096)));
static u64 l1[512] __attribute__((aligned(4096)));
static u64 l2[512] __attribute__((aligned(4096)));
static u64 l3[512] __attribute__((aligned(4096)));

static volatile u64 n_exc, last_esr, n_irq;

void on_exception(struct frame *f, u64 vec) {
  if (vec == VEC_EL1H_IRQ) {
    u64 iar = sysreg(ICC_IAR1_EL1);
    n_irq++;
    set_sysreg(ICC_EOIR1_EL1, iar);
    return;
  }
  n_exc++;
  last_esr = f->esr;
  f->elr += 4;
}

static u64 page(u64 pa) { return pa | 3UL | 1UL << 2 | 1UL << 10 | 3UL << 53; } // attr 1 (Device-nGnRE), AF, XN

static void select(u64 base, u32 key) { *(volatile unsigned short *)(base + 8) = (unsigned short)(key >> 8 | key << 8); }

#define DABT_ALIGN 0x96000021UL
#define DABT_EXTERNAL 0x96000010UL

int main(void) {
  l0[0] = (u64)l1 | 3;
  l1[0] = 1UL | 1UL << 2 | 1UL << 10 | 3UL << 53; // the first GiB, Device, a block
  l1[1] = RAM | 1UL | 3UL << 8 | 1UL << 10;
  l1[4] = (u64)l2 | 3;
  l2[0] = (u64)l3 | 3;
  l3[0] = page(FW_CFG);
  l3[1] = page(UART);
  l3[2] = page(HOLE);
  l3[3] = page(GICD);
  set_sysreg(mair_el1, 0x04ffUL); // attr 0 Normal write-back, attr 1 Device-nGnRE
  set_sysreg(ttbr0_el1, (u64)l0);
  set_sysreg(tcr_el1, 16UL | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  __asm__ volatile("tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1 << 2 | 1 << 12);

  // Every read moves the offset: the signature's bytes in order, then zeros, many times over (compiled code's).
  for (int k = 0; k < 20000; k++) {
    select(A_FWCFG, 0);
    check(mmio8(A_FWCFG) == 'Q', 1);
    check(mmio8(A_FWCFG) == 'E', 2);
    check(mmio8(A_FWCFG) == 'M', 3);
    check(mmio8(A_FWCFG) == 'U', 4);
    check(mmio8(A_FWCFG) == 0, 5);
    select(A_FWCFG, 1); // the ID: 1, as a little-endian word
    u32 id = mmio32(A_FWCFG);
#ifndef ORACLE
    check(id == 1, 6); // QEMU's has DMA: 3
#endif
    (void)id;
    check(mmio32(FW_CFG) == 0, 7); // the same register through the identity block: past the ID
  }

  // The page remapped to the UART's: its entry goes with the TLBI (PL011's PeriphID0 at 0xfe0 is 0x11).
  __asm__ volatile("ldr w2, [%0]" : : "r"(A_FWCFG + 0xfe0) : "x2", "memory"); // past fw_cfg's registers: nothing
  check(n_exc == 1 && last_esr == DABT_EXTERNAL, 11);
  l3[0] = page(UART);
  __asm__ volatile("dsb ishst; tlbi vae1, %0; dsb ish; isb" : : "r"(A_FWCFG >> 12) : "memory");
  check(mmio32(A_FWCFG + 0xfe0) == 0x11 && mmio32(A_UART + 0xfe0) == 0x11, 12);
  check(n_exc == 1, 13);

  // With the entries cached: a misaligned access to Device memory, and a page with nothing there, from compiled code too.
  for (int k = 0; k < 3000; k++) {
    u64 n0 = n_exc;
    __asm__ volatile("ldr w2, [%0]" : : "r"(A_UART + 0x19) : "x2", "memory");
    check(n_exc == n0 + 1 && last_esr == DABT_ALIGN, 20);
    __asm__ volatile("ldr w2, [%0]" : : "r"(A_HOLE) : "x2", "memory");
    check(n_exc == n0 + 2 && last_esr == DABT_EXTERNAL, 21);
    __asm__ volatile("str w2, [%0]" : : "r"(A_HOLE + 4) : "x2", "memory");
    check(n_exc == n0 + 3 && last_esr == (DABT_EXTERNAL | 1 << 6), 22);
  }

  // An SPI made pending by a store, with IRQs unmasked: taken before the next instruction (ours; QEMU may take it later).
  gic_init();
  u64 mpidr = sysreg(MPIDR_EL1);
  mmio32(GICD + 0x6000 + 8 * 40) = (u32)(mpidr & 0xffffff); // IROUTER40
  mmio32(GICD + 0x084) = ~0u;                                // SPIs 32-63 group 1
  mmio8(GICD + 0x420 + 8) = 0xa0;
  mmio32(GICD + 0x104) = 1 << 8; // ISENABLER1: SPI 40
  __asm__ volatile("msr daifclr, #2; isb");
  for (int k = 0; k < 20000; k++) {
    u64 seen;
    __asm__ volatile("str %w2, [%1]\nldr %0, [%3]" : "=&r"(seen) : "r"(A_GICD + 0x204), "r"(1 << 8), "r"(&n_irq) : "memory");
#ifndef ORACLE
    check(seen == (u64)k + 1, 30);
#endif
    while (n_irq != (u64)k + 1)
      ;
  }
  // The same store with a writeback, after a load from RAM while the base was already dirty in compiled code (the base
  // is then stored by the RAM load's failure segment too, which must not write the pre-store base over the post-index's
  // once the access retired in the helper and left the IRQ for the run loop: PERF loop 22).
  for (int k = 0; k < 20000; k++) {
    u64 base, seen;
    __asm__ volatile("mov x9, %2\nldr %1, [%3]\nstr %w4, [x9], #4\nmov %0, x9"
                     : "=&r"(base), "=&r"(seen)
                     : "r"(A_GICD + 0x204), "r"(&n_irq), "r"(1 << 8)
                     : "x9", "memory");
    check(base == A_GICD + 0x208, 31);
    while (n_irq != (u64)k + 20001)
      ;
  }
  __asm__ volatile("msr daifset, #2; isb");
  return 0;
}
