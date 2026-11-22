// The counter read in compiled code's places (PERF loop 47): at a loop's head and further into its block,
// at both ends of a chain of blocks, in a callee (a guest call, a host call under the JIT), after a forward
// edge, at EL0 with CNTKCTL_EL1's enable, and at EL0 without it (a trap each time). Deterministic time
// counts a tick a step, so every reading is the steps retired before it: the readings' hash and the
// last reading go to the console, which a deterministic run compares between the interpreter and the
// JIT (tests/boot-node.test.ts), and the spin at the end makes the steps depend on them too. Elsewhere
// (realtime, the oracles) it checks only that the counter never goes back.
#include "lib.h"

static volatile u64 n_trap;
static u64 hash = 14695981039346656037UL;

static void mix(u64 v) { hash = (hash ^ v) * 1099511628211UL; }

void on_exception(struct frame *f, u64 vec) {
  u64 ec = f->esr >> 26;
  if (ec == 0x15 && (f->esr & 0xffff) == 1 && vec == VEC_EL0_SYNC) {
    f->elr = (u64)el0_return; // run_el0's way back
    f->spsr = 0x3c5;
    return;
  }
  if (ec == 0x18) { // the EL0 MRS that CNTKCTL_EL1 traps
    n_trap++;
    f->elr += 4;
    return;
  }
  power_off(90 + vec);
}

// A callee: two readings around a few instructions.
__attribute__((noinline)) static u64 leaf(u64 x) {
  u64 a, b;
  __asm__ volatile("mrs %0, cntvct_el0; add %2, %2, #1; eor %2, %2, #3; mrs %1, cntpct_el0"
                   : "=&r"(a), "=&r"(b), "+r"(x));
  return a * 3 + b + x;
}

static u64 user_cntvct(void) { return sysreg(CNTVCT_EL0); }

int main(void) {
  mmio32(UART + 0x30) = 0x301; // CR: UARTEN, TXE, RXE
  u64 prev = 0;
  for (u64 i = 0; i < 20000; i++) {
    u64 a = sysreg(CNTVCT_EL0);
    __asm__ volatile("nop; nop; nop");
    u64 b = sysreg(CNTPCT_EL0);
    check(a >= prev && b >= a, 1);
    u64 c = leaf(i);
    if (i % 3 == 1) mix(sysreg(CNTVCT_EL0));
    mix(a);
    mix(b);
    mix(c);
    prev = b;
  }
  set_sysreg(cntkctl_el1, 2); // EL0VCTEN
  for (int i = 0; i < 2000; i++) {
    u64 t = run_el0(user_cntvct, (u64)user_stack_top);
    check(t >= prev, 2);
    mix(t);
    prev = t;
  }
  set_sysreg(cntkctl_el1, 0);
  for (int i = 0; i < 2000; i++) run_el0(user_cntvct, (u64)user_stack_top);
  check(n_trap == 2000, 3);
  uart_puts("counter ");
  uart_dec(hash);
  uart_puts(" ");
  uart_dec(sysreg(CNTVCT_EL0));
  uart_puts("\n");
  // Steps that depend on the readings.
  u64 until = sysreg(CNTVCT_EL0) + (hash & 0xfff);
  while (sysreg(CNTVCT_EL0) < until)
    ;
  return 0;
}
