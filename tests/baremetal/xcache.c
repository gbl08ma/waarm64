// PERF loop 28: a page of code remapped under a call through a pointer (BLR, which the JIT finds by its VA in
// its transfer cache, docs/jit.md "Linking"), between three callees that return 1, 2 and 3, each remap followed
// by a TLBI of one kind. CPU 0 first calls it itself: the page nG (ASID 1) with VMALLE1, VAE1, VALE1, VAAE1 and
// ASIDE1; then global, through an ASIDE1 that leaves a global entry and a VAE1 that drops it; then after an
// IC IALLU, which drops compiled code (and the transfer cache's entries) but not the TLB's. Then CPU 1 calls it in
// a loop while CPU 0 remaps it with each IS form (CPU 1 waiting meanwhile): once CPU 0's DSB is done and CPU 1 has
// seen the new phase, every call must reach the new callee.
// smp: 2
#include "lib.h"

#define NCPU 2
#define CALLS 300
#define PSCI_CPU_ON 0xc4000003UL

#define TABLE 3UL
#define PAGE 3UL
#define AF (1UL << 10)
#define SH_INNER (3UL << 8)
#define RO (3UL << 6) // AP[2:1] = 11: read-only at EL1 and EL0, executable at EL1
#define NG (1UL << 11)
#define ASID 1UL
#define VA 0x80000000UL // through l1[2], l2[0], l3[0]
#define VA2 (VA + 0x1000) // l3[1]: callee 0, nG

typedef u64 table[512] __attribute__((aligned(4096)));
static table l0, l1, l2, l3, ram2, ram3;
// mov x0, #1 (#2, #3); ret
static u32 callee[3][1024] __attribute__((aligned(4096))) = {
    {0xd2800020, 0xd65f03c0}, {0xd2800040, 0xd65f03c0}, {0xd2800060, 0xd65f03c0}};

void secondary_start(void);
static char stacks[NCPU][4096] __attribute__((aligned(16)));
// CPU 1's: the phase CPU 0 published (and the value it wants then; with PARK set CPU 1 waits, and says so in
// `parked`), the calls it made in each, the first wrong one.
#define PARK 16UL
#define STOP 15UL
static volatile u64 phase, want, parked, done[16], bad;

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  power_off(90 + vec);
}

static long psci(u64 f, u64 a, u64 b, u64 c) {
  register u64 x0 __asm__("x0") = f, x1 __asm__("x1") = a, x2 __asm__("x2") = b, x3 __asm__("x3") = c;
  __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory");
  return (long)x0;
}

// RAM's first 2 MiB (image, tables, stacks) identity-mapped by pages (global; no block, whose entries a flush by VA
// in its half would drop all of, transfer cache's included), the test page at VA; ASID 1.
static void mmu_on(void) {
  set_sysreg(mair_el1, 0xff);
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l0 | ASID << 48);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12);
}

// The page at VA maps callee `i` (nG unless `global`), stored for the walker; the caller's TLBI follows.
static void map(u64 i, int global) {
  l3[0] = (u64)callee[i] | PAGE | AF | SH_INNER | RO | (global ? 0 : NG);
  __asm__ volatile("dsb ishst" ::: "memory");
}

#define TLBI(op, arg) __asm__ volatile("tlbi " op ", %0; dsb ish; isb" : : "r"((u64)(arg)) : "memory")
#define TLBI0(op) __asm__ volatile("tlbi " op "; dsb ish; isb" ::: "memory")

// `n` calls to `va`, summed.
static u64 __attribute__((noinline)) calls_at(u64 va, u64 n) {
  u64 (*volatile f)(void) = (u64(*)(void))va;
  u64 (*g)(void) = f, s = 0;
  for (u64 i = 0; i < n; i++)
    s += g();
  return s;
}

static u64 calls(u64 n) { return calls_at(VA, n); }

// The counter's ticks in 2 ms: long enough for the compile worker (parallel SMP) to have the loop compiled.
static u64 warm_ticks(void) { return sysreg(CNTFRQ_EL0) / 500; }

// CPU 0's remaps, by step: the page's callee, and the TLBI after it.
static void remap(u64 step) {
  switch (step) {
  case 1: map(1, 0); TLBI("vae1", ASID << 48 | VA >> 12); break;
  case 2: map(0, 0); TLBI("vale1", ASID << 48 | VA >> 12); break;
  case 3: map(2, 0); TLBI("vaae1", VA >> 12); break;
  case 4: map(1, 0); TLBI("aside1", ASID << 48); break;
  case 5: map(0, 0); TLBI0("vmalle1"); break;
  // Global: an ASIDE1 keeps its entry (after an nG page ran at EL1, whose entry it drops), a VAE1 drops it.
  case 6: map(2, 1); TLBI0("vmalle1"); break;
  case 7: check(calls_at(VA2, 1) == 1, 129); TLBI("aside1", ASID << 48); break;
  case 8: map(1, 1); TLBI("vae1", VA >> 12); break;
  // Compiled code dropped, the TLB's entry kept (the call finds the page through it again), then a VAE1.
  case 9: __asm__ volatile("ic iallu; dsb ish; isb" ::: "memory"); break;
  case 10: map(0, 1); TLBI("vae1", VA >> 12); break;
  }
}

// Calls in one loop, which remaps at step `step` once it ran CALLS times and for 2 ms (or 64 times CALLS), then
// runs CALLS more: each must return `old` before and `new_` after. The call right after the TLBI is the compiled
// loop's (a call at a function's entry would come from the interpreter until that's hot).
static void run(u64 step, u64 old, u64 new_) {
  u64 (*volatile f)(void) = (u64(*)(void))VA;
  u64 (*g)(void) = f;
  u64 t0 = sysreg(CNTVCT_EL0), t = warm_ticks(), k = 0;
  for (u64 i = 0; !k || i < k + CALLS; i++) {
    check(g() == (k ? new_ : old), 130 + 2 * step + !!k);
    if (!k && i >= CALLS && (sysreg(CNTVCT_EL0) - t0 >= t || i >= 64 * CALLS)) {
      remap(step);
      k = i;
    }
  }
}

void secondary_main(void) {
  mmu_on();
  u64 p = 0;
  for (;;) {
    u64 q = __atomic_load_n(&phase, __ATOMIC_ACQUIRE);
    if (q == STOP)
      break;
    if (q & PARK) {
      __atomic_store_n(&parked, q, __ATOMIC_RELEASE);
      continue;
    }
    if (q != p) {
      __asm__ volatile("isb" ::: "memory");
      p = q;
    }
    u64 w = want, v = calls(1);
    if (v != w && !bad)
      bad = p << 8 | v << 4 | w;
    __atomic_store_n(&done[p], done[p] + 1, __ATOMIC_RELEASE);
  }
  for (;;)
    __asm__ volatile("wfi");
}

#define WAIT(cond, code) do { u64 n_ = 0; while (!(cond)) if (++n_ > 200000000UL) power_off(code); } while (0)

// Phase `k` on CPU 1: parked, the page remapped to callee `i` (global or not) and flushed by `tlbi`, then
// CALLS calls that must all reach it.
#define PHASE(k, i, global, tlbi) do { \
    __atomic_store_n(&phase, PARK | (k), __ATOMIC_RELEASE); \
    WAIT(__atomic_load_n(&parked, __ATOMIC_ACQUIRE) == (PARK | (k)), 30 + (k)); \
    map(i, global); \
    tlbi; \
    want = (i) + 1; \
    __atomic_store_n(&phase, k, __ATOMIC_RELEASE); \
    u64 t0_ = sysreg(CNTVCT_EL0); \
    WAIT(__atomic_load_n(&done[k], __ATOMIC_ACQUIRE) >= CALLS && \
             (sysreg(CNTVCT_EL0) - t0_ >= warm_ticks() || done[k] >= 64 * CALLS), 40 + (k)); \
    check(!bad, 60 + (k)); \
  } while (0)

int main(void) {
  l0[0] = (u64)l1 | TABLE;
  l1[1] = (u64)ram2 | TABLE;
  ram2[0] = (u64)ram3 | TABLE;
  for (u64 i = 0; i < 512; i++)
    ram3[i] = (0x40000000UL + (i << 12)) | PAGE | AF | SH_INNER;
  l1[2] = (u64)l2 | TABLE;
  l2[0] = (u64)l3 | TABLE;
  l3[1] = (u64)callee[0] | PAGE | AF | SH_INNER | RO | NG;
  map(0, 0);
  mmu_on();
  __asm__ volatile("ic iallu; dsb ish; isb" ::: "memory");
  run(1, 1, 2);
  run(2, 2, 1);
  run(3, 1, 3);
  run(4, 3, 2);
  run(5, 2, 1);
  run(6, 1, 3);
  run(7, 3, 3);
  run(8, 3, 2);
  run(9, 2, 2);
  run(10, 2, 1);
  map(0, 0);
  TLBI0("vmalle1");

  // CPU 1 calls it; CPU 0 remaps it with each IS form.
  want = 1;
  check(psci(PSCI_CPU_ON, 1, (u64)secondary_start, (u64)(stacks[1] + sizeof stacks[1])) == 0, 20);
  WAIT(__atomic_load_n(&done[0], __ATOMIC_ACQUIRE) >= CALLS, 21);
  check(!bad, 22);
  PHASE(1, 1, 0, TLBI("vae1is", ASID << 48 | VA >> 12));
  PHASE(2, 2, 0, TLBI("vale1is", ASID << 48 | VA >> 12));
  PHASE(3, 0, 0, TLBI("vaae1is", VA >> 12));
  PHASE(4, 1, 0, TLBI("vaale1is", VA >> 12));
  PHASE(5, 2, 0, TLBI("aside1is", ASID << 48));
  PHASE(6, 0, 0, TLBI0("vmalle1is"));
  PHASE(7, 1, 1, TLBI0("vmalle1is"));
  PHASE(8, 1, 1, TLBI("aside1is", ASID << 48)); // the same global entry, kept
  PHASE(9, 2, 1, TLBI("vaae1is", VA >> 12));
  __atomic_store_n(&phase, STOP, __ATOMIC_RELEASE);
  return 0;
}
