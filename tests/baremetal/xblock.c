// PERF loop 29: a 2 MiB block of code remapped under a call through a pointer (BLR, which the JIT finds by its VA
// in its transfer cache, docs/jit.md "Linking") to a page P of the block, then flushed the way Linux unmaps a huge
// page: one TLBI at the block's start, another page than P. Before the remap the transfer cache's entries are
// dropped while the TLB's entry for P stays (an IC IALLU, which drops compiled code; a TLBI of a data page in the
// same half; an ASIDE1 after an nG page ran), and the calls go on, so P's entry is filled again from a TLB hit. Each
// call after the TLBI must reach the new block's callee. It passes on hvf (the M4); QEMU 11.1's TCG fails it (exit
// 132: the first remap's first call runs the old block's code), as we did before PERF loop 29.
#include "lib.h"

#define CALLS 300

#define TABLE 3UL
#define PAGE 3UL
#define BLOCK 1UL
#define AF (1UL << 10)
#define SH_INNER (3UL << 8)
#define RO (3UL << 6) // AP[2:1] = 11: read-only at EL1 and EL0, executable at EL1
#define NG (1UL << 11)
#define ASID 1UL
#define VA 0x80000000UL // the block: l1[2], l2[0]
#define P 0x3000UL // the page called in it
#define VA2 0x80200000UL // l2[1], l3[0]: an nG page of code
#define BLK(i) (0x40400000UL + ((i) << 21)) // the blocks' PAs, past the image's 2 MiB

typedef u64 table[512] __attribute__((aligned(4096)));
static table l0, l1, l2, l3, ram2, ram3, data;

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  power_off(90 + vec);
}

// RAM's first 2 MiB (image, tables, stacks) identity-mapped by pages (global), the test block at VA; ASID 1.
static void mmu_on(void) {
  set_sysreg(mair_el1, 0xff);
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l0 | ASID << 48);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12);
}

// The block at VA maps block `i` (global), stored for the walker; the caller's TLBI follows.
static void map(u64 i) {
  l2[0] = BLK(i) | BLOCK | AF | SH_INNER | RO;
  __asm__ volatile("dsb ishst" ::: "memory");
}

#define TLBI(op, arg) __asm__ volatile("tlbi " op ", %0; dsb ish; isb" : : "r"((u64)(arg)) : "memory")
#define TLBI0(op) __asm__ volatile("tlbi " op "; dsb ish; isb" ::: "memory")

// The counter's ticks in 2 ms: long enough for the compile worker (parallel SMP) to have the loop compiled.
static u64 warm_ticks(void) { return sysreg(CNTFRQ_EL0) / 500; }

// What drops the transfer cache's entries and keeps the TLB's for P, by kind.
static void drop(u64 kind) {
  switch (kind) {
  case 0: __asm__ volatile("ic iallu; dsb ish; isb" ::: "memory"); break;
  case 1: data[0]++; TLBI("vaae1", (u64)data >> 12); break; // a data page in the block's half
  case 2: {
    u64 (*volatile f)(void) = (u64(*)(void))VA2;
    check(f() == 9, 129);
    TLBI("aside1", ASID << 48);
    break;
  }
  }
}

// Calls to VA + P in one loop, which returns `old` from block `old - 1`: once it ran CALLS times and for 2 ms (or
// 64 times CALLS), `drop(kind)`, then the same again, then the block remapped to block `new_ - 1` and flushed at
// VA, then CALLS more, which must return `new_`. The call right after the TLBI is the compiled loop's.
static void run(u64 step, u64 kind, u64 old, u64 new_) {
  u64 (*volatile f)(void) = (u64(*)(void))(VA + P);
  u64 (*g)(void) = f;
  u64 t0 = sysreg(CNTVCT_EL0), t = warm_ticks(), phase = 0, k = 0;
  for (u64 i = 0; phase < 2 || i < k + CALLS; i++) {
    check(g() == (phase == 2 ? new_ : old), 130 + 3 * step + phase);
    if (phase < 2 && i >= k + CALLS && (sysreg(CNTVCT_EL0) - t0 >= t || i >= k + 64 * CALLS)) {
      if (phase == 0) {
        drop(kind);
      } else {
        map(new_ - 1);
        TLBI("vaae1", VA >> 12);
      }
      phase++;
      k = i;
      t0 = sysreg(CNTVCT_EL0);
    }
  }
}

int main(void) {
  // mov x0, #1 (#2); ret at P in each block, and mov x0, #9; ret in the nG page; stored with the MMU off.
  for (u64 i = 0; i < 2; i++) {
    volatile u32 *c = (volatile u32 *)(BLK(i) + P);
    c[0] = 0xd2800020 + (u32)(i << 5);
    c[1] = 0xd65f03c0;
  }
  volatile u32 *c = (volatile u32 *)(BLK(1) + 0x1000);
  c[0] = 0xd2800120;
  c[1] = 0xd65f03c0;
  l0[0] = (u64)l1 | TABLE;
  l1[1] = (u64)ram2 | TABLE;
  ram2[0] = (u64)ram3 | TABLE;
  for (u64 i = 0; i < 512; i++)
    ram3[i] = (0x40000000UL + (i << 12)) | PAGE | AF | SH_INNER;
  l1[2] = (u64)l2 | TABLE;
  l2[1] = (u64)l3 | TABLE;
  l3[0] = (BLK(1) + 0x1000) | PAGE | AF | SH_INNER | RO | NG;
  map(0);
  mmu_on();
  __asm__ volatile("ic iallu; dsb ish; isb" ::: "memory");
  run(0, 0, 1, 2);
  run(1, 0, 2, 1);
  run(2, 1, 1, 2);
  run(3, 1, 2, 1);
  run(4, 2, 1, 2);
  run(5, 2, 2, 1);
  return 0;
}
