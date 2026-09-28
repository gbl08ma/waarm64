// M7 loop 4: broadcast maintenance on 4 vCPUs sharing one set of translation
// tables (MMU on everywhere, so memory is Normal). CPU 0 runs the rounds in
// phases that CPUs 1-3 acknowledge.
// - TLBI, one round per ...IS flavor: each secondary reads through TEST_VA
//   (its TLB now holds the translation), CPU 0 remaps TEST_VA to the next page
//   and runs the TLBI + DSB ISH, and each secondary must read the new page.
// - IC IVAU, then IC IALLUIS: each secondary calls a function in a code page
//   often enough for the JIT to compile it (its batch goes out after 1M
//   dispatched steps: docs/jit.md "Compile policy"), CPU 0 rewrites it (DC CVAU, DSB
//   ISH, IC, DSB ISH), and each secondary must run the new code after an ISB
//   that follows its seeing the rewrite (the architecture's cross-modification
//   sequence: an ISB before it promises nothing, and parallel SMP runs the old
//   code then, M7 loop 5).
// smp: 4
#include "lib.h"

#define NCPU 4
#define PSCI_CPU_ON 0xc4000003UL

#define TABLE 3UL
#define BLOCK 1UL
#define AF (1UL << 10)
#define SH_INNER (3UL << 8)
#define NG (1UL << 11)
#define PAGE (3UL | AF | SH_INNER) // MAIR attr 0: Normal write-back
#define TEST_VA 0x80000000UL
#define ASID 5UL

typedef u64 table[512] __attribute__((aligned(4096)));
static table l0, l1, l2_test, l3_test;
#define NTLBI 6
static u64 pages[NTLBI + 1][512] __attribute__((aligned(4096)));
// The rewritten function (`movz w0, #1; ret`), alone in its page.
static u32 code[1024] __attribute__((aligned(4096))) = {0x52800020, 0xd65f03c0};
#define MOVZ_W0(v) (0x52800000u | (u32)(v) << 5)

void secondary_start(void);
static char stacks[NCPU][4096] __attribute__((aligned(16)));
static volatile u64 go, ack[NCPU];

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  power_off(90 + vec);
}

static long psci(u64 f, u64 a, u64 b, u64 c) {
  register u64 x0 __asm__("x0") = f, x1 __asm__("x1") = a, x2 __asm__("x2") = b, x3 __asm__("x3") = c;
  __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory");
  return (long)x0;
}

static u64 me(void) { return sysreg(MPIDR_EL1) & 0xff; }

static void isb(void) { __asm__ volatile("isb" ::: "memory"); }

// Every CPU: the same tables, TTBR0 with ASID 5 (TEST_VA's mapping is nG),
// TTBR1 walks off.
static void mmu_on(void) {
  set_sysreg(mair_el1, 0xff);
  // T0SZ = 16, inner/outer write-back inner-shareable walks, 4K granule, EPD1, 40-bit IPS.
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l0 | ASID << 48);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12); // M, C, I
}

#define WAIT(cond, code) do { u64 n_ = 0; while (!(cond)) if (++n_ > 100000000UL) power_off(code); } while (0)

// CPU 0 opens the next phase and waits until every secondary has done it.
static u64 phase;
static void next_phase(void) {
  __atomic_store_n(&go, ++phase, __ATOMIC_RELEASE);
  for (u64 c = 1; c < NCPU; c++) WAIT(__atomic_load_n(&ack[c], __ATOMIC_ACQUIRE) == phase, 50);
}

static u64 read_test(void) { return *(volatile u64 *)TEST_VA; }

static void remap(u64 r) {
  l3_test[0] = (u64)pages[r] | PAGE | NG;
  u64 va = TEST_VA >> 12, asid_va = ASID << 48 | va;
  __asm__ volatile("dsb ishst" ::: "memory");
  switch (r) {
  case 1: __asm__ volatile("tlbi vae1is, %0" : : "r"(asid_va) : "memory"); break;
  case 2: __asm__ volatile("tlbi vale1is, %0" : : "r"(asid_va) : "memory"); break;
  case 3: __asm__ volatile("tlbi vaae1is, %0" : : "r"(va) : "memory"); break;
  case 4: __asm__ volatile("tlbi vaale1is, %0" : : "r"(va) : "memory"); break;
  case 5: __asm__ volatile("tlbi aside1is, %0" : : "r"(ASID << 48) : "memory"); break;
  case 6: __asm__ volatile("tlbi vmalle1is" ::: "memory"); break;
  }
  __asm__ volatile("dsb ish; isb" ::: "memory");
}

// The one IC IVAU in this test (tests/boot-node.test.ts plants its removal).
static void rewrite(u64 v, int all) {
  code[0] = MOVZ_W0(v);
  __asm__ volatile("dc cvau, %0; dsb ish" : : "r"(code) : "memory");
  if (all)
    __asm__ volatile("ic ialluis" ::: "memory");
  else
    __asm__ volatile("ic ivau, %0" : : "r"(code) : "memory");
  __asm__ volatile("dsb ish; isb" ::: "memory");
}

void secondary_main(void) {
  mmu_on();
  u64 c = me(), p = 0;
  u64 (*f)(void) = (u64(*)(void))code;
  // Waits for phase ++p, checks `cond` (failing with `code`), acknowledges.
#define PHASE(cond, code) do { \
    p++; \
    WAIT(__atomic_load_n(&go, __ATOMIC_ACQUIRE) == p, 60); \
    check(cond, code); \
    __atomic_store_n(&ack[c], p, __ATOMIC_RELEASE); \
  } while (0)
  for (u64 r = 1; r <= NTLBI; r++) {
    PHASE(read_test() == 1000 + r - 1, 100 + 10 * r + c); // cached: the old page
    PHASE(read_test() == 1000 + r, 200 + 10 * r + c);     // after the TLBI: the new one
  }
  for (u64 k = 0; k < 2; k++) {
    u64 ok = 1;
    for (int i = 0; i < 1 << 17; i++) ok &= f() == 1 + k;
    PHASE(ok, 300 + 10 * k + c);
    PHASE((isb(), f() == 2 + k), 400 + 10 * k + c);
  }
#undef PHASE
  for (;;)
    __asm__ volatile("wfi");
}

int main(void) {
  // RAM (the image, the tables, the stacks) identity-mapped by a 1 GiB block;
  // TEST_VA through a level 3 table.
  l0[0] = (u64)l1 | TABLE;
  l1[1] = 0x40000000UL | BLOCK | AF | SH_INNER;
  l1[2] = (u64)l2_test | TABLE;
  l2_test[0] = (u64)l3_test | TABLE;
  l3_test[0] = (u64)pages[0] | PAGE | NG;
  mmu_on();
  for (u64 r = 0; r <= NTLBI; r++) pages[r][0] = 1000 + r;
  check(read_test() == 1000, 1);

  for (u64 c = 1; c < NCPU; c++)
    check(psci(PSCI_CPU_ON, c, (u64)secondary_start, (u64)(stacks[c] + sizeof stacks[c])) == 0, 2);
  for (u64 r = 1; r <= NTLBI; r++) {
    next_phase();
    remap(r);
    check(read_test() == 1000 + r, 10 + r);
    next_phase();
  }
  for (u64 k = 0; k < 2; k++) {
    next_phase();
    rewrite(2 + k, k == 1);
    next_phase();
  }
  return 0;
}
