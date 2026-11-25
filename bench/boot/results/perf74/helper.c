// PERF loop 74's helper micro-benchmark: N iterations of 8 LDSMAX W on a RAM
// word (an instruction with no inline form: each one a call of the generic
// helper, `jit_exec_mmu`), with the MMU on as PERF loop 21's MMIO benchmark has
// it. ADDR stays RAM's (0x40000000): its page tables are kept as they were.
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
    __asm__ volatile("ldsmax w3, w2, [%0]\nldsmax w3, w2, [%0]\nldsmax w3, w2, [%0]\nldsmax w3, w2, [%0]\n"
                     "ldsmax w3, w2, [%0]\nldsmax w3, w2, [%0]\nldsmax w3, w2, [%0]\nldsmax w3, w2, [%0]"
                     : : "r"(a) : "x2", "x3", "memory");
  return 0;
}
