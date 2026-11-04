// Cross-modification seen through an ISB in a hot loop (docs/platform.md "Broadcast maintenance"): CPU 1
// runs a loop that reads `flag`, executes ISB and calls `code` through a pointer (BLR), often
// enough for the JIT to compile the loop with the call followed into its region. CPU 0 rewrites
// `code` (DC CVAU, DSB ISH, IC IVAU, DSB ISH) and only then publishes the round in `flag`. Once
// CPU 1 has read the round, its ISB must make it run the new code (the architecture's
// cross-modification sequence). Parallel SMP completed the ISB in place (`Vm::fast`) and the
// block chained on into the old code, through links its table hadn't synced with the cache's
// drops: 3-8 stale calls in 8 rounds under the parallel JIT (every run), none in round-robin or the
// interpreter (whose dispatcher catches up at every block). Without the MMU (Device memory:
// the loop's accesses are aligned).
// smp: 2
#include "lib.h"

#define PSCI_CPU_ON 0xc4000003UL
#ifndef ROUNDS
#define ROUNDS 8
#endif
// CPU 1's loop turns before each rewrite, for its loop and `code` to be compiled again after the
// last round's IC. Measured on the unfixed parallel JIT with 8 rounds: 10000 failed 8 runs of 8
// (3-8 stale calls), 5000 only 5 of 8. Round-robin can't show the bug, and JIT-stress compiles on
// almost every dispatch: 2.1M steps, ~14 s (12 rounds of 60000 took 118 s there).
#ifndef TURNS
#define TURNS 10000
#endif

// The rewritten function (`movz w0, #0; ret`), alone in its page.
static u32 code[1024] __attribute__((aligned(4096))) = {0x52800000, 0xd65f03c0};
#define MOVZ_W0(v) (0x52800000u | (u32)(v) << 5)

void secondary_start(void);
static char stacks[2][4096] __attribute__((aligned(16)));
static volatile u64 flag, ack, turns, bad, badval;

void on_exception(struct frame *f, u64 vec) {
  (void)f;
  power_off(90 + vec);
}

static long psci(u64 f, u64 a, u64 b, u64 c) {
  register u64 x0 __asm__("x0") = f, x1 __asm__("x1") = a, x2 __asm__("x2") = b, x3 __asm__("x3") = c;
  __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory");
  return (long)x0;
}

void secondary_main(void) {
  u64 (*volatile fp)(void) = (u64(*)(void))code;
  u64 (*f)(void) = fp;
  for (u64 r = 1; r <= ROUNDS; r++) {
    for (u64 n = 1;; n++) {
      u64 fl = __atomic_load_n(&flag, __ATOMIC_ACQUIRE);
      __asm__ volatile("isb" ::: "memory");
      u64 v = f();
      if ((n & 255) == 0) turns = n;
      if (fl == r) {
        if (v != r) {
          bad++;
          badval = v;
        }
        break;
      }
    }
    __atomic_store_n(&ack, r, __ATOMIC_RELEASE);
  }
  for (;;)
    __asm__ volatile("wfi");
}

int main(void) {
  check(psci(PSCI_CPU_ON, 1, (u64)secondary_start, (u64)(stacks[1] + sizeof stacks[1])) == 0, 2);
  for (u64 r = 1; r <= ROUNDS; r++) {
    while (__atomic_load_n(&ack, __ATOMIC_ACQUIRE) != r - 1)
      ;
    turns = 0;
    while (turns < TURNS)
      ;
    code[0] = MOVZ_W0(r);
    __asm__ volatile("dc cvau, %0; dsb ish; ic ivau, %0; dsb ish; isb" : : "r"(code) : "memory");
    __atomic_store_n(&flag, r, __ATOMIC_RELEASE);
  }
  while (__atomic_load_n(&ack, __ATOMIC_ACQUIRE) != ROUNDS)
    ;
  if (bad) {
    uart_puts("stale calls ");
    uart_dec(bad);
    uart_puts(", the last returning ");
    uart_dec(badval);
    uart_puts("\n");
  }
  check(!bad, 10);
  return 0;
}
