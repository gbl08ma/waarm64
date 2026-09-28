// M7 loop 6: 128-bit pair atomics on 4 vCPUs, against each other and against
// plain stores to the same bytes (MMU on everywhere, so memory is Normal: no
// exclusives on Device memory). One 16-byte pair {lo, hi}:
// - CPUs 0 and 1 increment hi with CASP, CPU 2 with LDXP/STXP, N times each,
//   writing lo back as they read it;
// - CPU 3 stores 1..M to lo with plain STRs and reads each back.
// A pair op must be single-copy atomic: none may lose another's increment (hi
// ends at 3N), and none may write back a lo that CPU 3 has since overwritten
// (CPU 3's read-back is never below its store, lo ends at M). Every CPU checks
// that the values it reads never go backwards (coherence).
// smp: 4
// qemu-cpu: max
#include "lib.h"

#define NCPU 4
#define N 20000UL
#define M 100000UL
#define PSCI_CPU_ON 0xc4000003UL

#define TABLE 3UL
#define BLOCK 1UL
#define AF (1UL << 10)
#define SH_INNER (3UL << 8)

typedef u64 table[512] __attribute__((aligned(4096)));
static table l0, l1;
static volatile u64 pair[2] __attribute__((aligned(16)));

void secondary_start(void);
static char stacks[NCPU][4096] __attribute__((aligned(16)));
static volatile u64 ready[NCPU], go, done[NCPU];

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

// RAM identity-mapped by a 1 GiB Normal write-back block, the same on every CPU.
static void mmu_on(void) {
  set_sysreg(mair_el1, 0xff);
  // T0SZ = 16, inner/outer write-back inner-shareable walks, 4K granule, EPD1, 40-bit IPS.
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l0);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12); // M, C, I
}

#define WAIT(cond, code) do { u64 n_ = 0; while (!(cond)) if (++n_ > 100000000UL) power_off(code); } while (0)

// What a pair CPU last read: each half must never go backwards.
struct seen { u64 lo, hi; };
static void saw(struct seen *s, u64 lo, u64 hi, u64 c) {
  check(lo >= s->lo, 10 + c);
  check(hi >= s->hi, 20 + c);
  s->lo = lo;
  s->hi = hi;
}

// CASP: hi + 1, lo as read.
static void casp_loop(u64 c) {
  struct seen s = {0, 0};
  u64 lo = 0, hi = 0;
  for (u64 n = 0; n < N;) {
    register u64 x0 __asm__("x0") = lo, x1 __asm__("x1") = hi, x2 __asm__("x2") = lo, x3 __asm__("x3") = hi + 1;
    __asm__ volatile(".arch_extension lse\n casp x0, x1, x2, x3, [%4]"
                     : "+r"(x0), "+r"(x1) : "r"(x2), "r"(x3), "r"(pair) : "memory");
    saw(&s, x0, x1, c);
    if (x0 == lo && x1 == hi) {
      n++;
      hi++;
    } else {
      lo = x0;
      hi = x1;
    }
  }
}

// LDXP/STXP: hi + 1, lo as read.
static void exclusive_loop(u64 c) {
  struct seen s = {0, 0};
  for (u64 n = 0; n < N; n++) {
    u64 lo, hi, fail;
    do {
      __asm__ volatile("ldxp %0, %1, [%2]" : "=&r"(lo), "=&r"(hi) : "r"(pair) : "memory");
      __asm__ volatile("stxp %w0, %2, %3, [%1]" : "=&r"(fail) : "r"(pair), "r"(lo), "r"(hi + 1) : "memory");
    } while (fail);
    saw(&s, lo, hi, c);
  }
}

// Plain stores to lo, each read back: nothing may overwrite it with an older value.
static void store_loop(void) {
  for (u64 k = 1; k <= M; k++) {
    pair[0] = k;
    check(pair[0] >= k, 30);
  }
}

static void run(u64 c) {
  __atomic_store_n(&ready[c], 1, __ATOMIC_RELEASE);
  WAIT(__atomic_load_n(&go, __ATOMIC_ACQUIRE), 50);
  if (c < 2)
    casp_loop(c);
  else if (c == 2)
    exclusive_loop(c);
  else
    store_loop();
  __atomic_store_n(&done[c], 1, __ATOMIC_RELEASE);
}

void secondary_main(void) {
  mmu_on();
  run(me());
  for (;;)
    __asm__ volatile("wfi");
}

int main(void) {
  l0[0] = (u64)l1 | TABLE;
  l1[1] = 0x40000000UL | BLOCK | AF | SH_INNER;
  mmu_on();
  for (u64 c = 1; c < NCPU; c++)
    check(psci(PSCI_CPU_ON, c, (u64)secondary_start, (u64)(stacks[c] + sizeof stacks[c])) == 0, 2);
  for (u64 c = 1; c < NCPU; c++) WAIT(__atomic_load_n(&ready[c], __ATOMIC_ACQUIRE), 3);
  __atomic_store_n(&go, 1, __ATOMIC_RELEASE);
  run(0);
  for (u64 c = 1; c < NCPU; c++) WAIT(__atomic_load_n(&done[c], __ATOMIC_ACQUIRE), 4);
  check(pair[1] == 3 * N, 40);
  check(pair[0] == M, 41);
  return 0;
}
