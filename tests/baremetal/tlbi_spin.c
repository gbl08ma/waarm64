// A DSB after TLBI IS waits for every running vCPU to
// drain its queue, so a vCPU that stays inside one chunk (a tight spin) must
// still end it at the step budget. CPU 0 takes a lock, runs TLBI VMALLE1IS + DSB
// ISH under it and releases it, over and over; CPUs 1-3 spin without WFE in
// three ways: a plain load loop on the lock, a LDAXR/STXR acquire-release loop
// on it, and a YIELD loop on the stop flag. Every DSB must complete.
// smp: 4
#include "lib.h"

#define NCPU 4
#define ROUNDS 100
#define PSCI_CPU_ON 0xc4000003UL

#define TABLE 3UL
#define BLOCK 1UL
#define AF (1UL << 10)
#define SH_INNER (3UL << 8)

typedef u64 table[512] __attribute__((aligned(4096)));
static table l0, l1;

void secondary_start(void);
static char stacks[NCPU][4096] __attribute__((aligned(16)));
static volatile u64 lock, stop, ack[NCPU], seen[NCPU];

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

// Normal memory everywhere: RAM identity-mapped by a 1 GiB block, MMU and caches on, no ASID (TLBI IS waits for all).
static void mmu_on(void) {
  set_sysreg(mair_el1, 0xff);
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l0);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12);
}

static int try_lock(void) {
  u64 old, fail;
  __asm__ volatile("ldaxr %0, [%2]; cbnz %0, 1f; stxr %w1, %3, [%2]; b 2f; 1: mov %w1, #1; clrex; 2:"
                   : "=&r"(old), "=&r"(fail) : "r"(&lock), "r"(1UL) : "memory");
  return !fail;
}

static void unlock(void) { __atomic_store_n(&lock, 0, __ATOMIC_RELEASE); }

void secondary_main(void) {
  mmu_on();
  u64 c = me(), n = 0;
  __atomic_store_n(&ack[c], 1, __ATOMIC_RELEASE);
  switch (c) {
  case 1: // plain loads, no exclusives
    while (!stop) {
      while (lock && !stop)
        ;
      n++;
    }
    break;
  case 2: // acquire and release the lock in a LDAXR/STXR loop
    while (!stop)
      if (try_lock()) {
        n++;
        unlock();
      }
    break;
  default: // YIELD, then look at the flag
    while (!stop) {
      __asm__ volatile("yield");
      n++;
    }
  }
  seen[c] = n;
  __atomic_store_n(&ack[c], 2, __ATOMIC_RELEASE);
  for (;;)
    __asm__ volatile("wfi");
}

#define WAIT(cond, code) do { u64 n_ = 0; while (!(cond)) if (++n_ > 200000000UL) power_off(code); } while (0)

int main(void) {
  l0[0] = (u64)l1 | TABLE;
  l1[1] = 0x40000000UL | BLOCK | AF | SH_INNER;
  mmu_on();
  for (u64 c = 1; c < NCPU; c++)
    check(psci(PSCI_CPU_ON, c, (u64)secondary_start, (u64)(stacks[c] + sizeof stacks[c])) == 0, 2);
  for (u64 c = 1; c < NCPU; c++) WAIT(__atomic_load_n(&ack[c], __ATOMIC_ACQUIRE) == 1, 10 + c);
  for (u64 r = 0; r < ROUNDS; r++) {
    WAIT(try_lock(), 20);
    __asm__ volatile("dsb ishst; tlbi vmalle1is; dsb ish; isb" ::: "memory");
    unlock();
    // Room for the contender of CPU 2 to win the lock now and then.
    for (volatile int i = 0; i < 50; i++)
      ;
  }
  __atomic_store_n(&stop, 1, __ATOMIC_RELEASE);
  for (u64 c = 1; c < NCPU; c++) WAIT(__atomic_load_n(&ack[c], __ATOMIC_ACQUIRE) == 2, 30 + c);
  for (u64 c = 1; c < NCPU; c++) check(seen[c] > 0, 40 + c);
  return 0;
}
