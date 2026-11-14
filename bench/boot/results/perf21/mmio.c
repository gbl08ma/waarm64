// MMIO read micro-benchmark: N iterations of 8 LDR W of one register at ADDR,
// with the MMU on as Linux has it: 48-bit VAs (four levels), RAM a Normal 1 GiB
// block, the device page a Device-nGnRE 4 KiB page at level 3 (ioremap's).
#include "../../../../tests/baremetal/lib.h"
#define RAM 0x40000000UL
static u64 l0[512] __attribute__((aligned(4096)));
static u64 l1[512] __attribute__((aligned(4096)));
static u64 l2[512] __attribute__((aligned(4096)));
static u64 l3[512] __attribute__((aligned(4096)));
static u32 ram[8] __attribute__((aligned(64)));
void on_exception(struct frame *f, u64 vec) { (void)vec; power_off(100 + (f->esr >> 26)); }
int main(void) {
  u64 dev = ADDR & ~0x1fffffUL; // the 2 MiB around the register, 4 KiB pages
  l0[0] = (u64)l1 | 3;
  l1[0] = (u64)l2 | 3;
  l1[1] = RAM | 1UL | 3UL << 8 | 1UL << 10;
  l2[dev >> 21 & 511] = (u64)l3 | 3;
  for (int i = 0; i < 512; i++) l3[i] = (dev + (u64)i * 4096) | 3UL | 1UL << 2 | 1UL << 10 | 3UL << 53;
  set_sysreg(mair_el1, 0x04ffUL); // attr0 Normal WB, attr1 Device-nGnRE
  set_sysreg(ttbr0_el1, (u64)l0);
  set_sysreg(tcr_el1, 16UL | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  __asm__ volatile("tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1 << 2 | 1 << 12);
  u64 a = ADDR == 0x40000000UL ? (u64)ram : ADDR;
  for (u64 i = 0; i < N; i++)
    __asm__ volatile("ldr w2, [%0]\nldr w2, [%0]\nldr w2, [%0]\nldr w2, [%0]\n"
                     "ldr w2, [%0]\nldr w2, [%0]\nldr w2, [%0]\nldr w2, [%0]" : : "r"(a) : "x2", "memory");
  return 0;
}
