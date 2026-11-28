// ERETs that unmask IRQs and the exceptions EL0 takes, which deterministic round-robin finishes in place under the
// JIT while no IRQ can be pending (PERF loop 88: `vm::rr_fast`). EL0 runs a loop of SVCs, compiled (the ERETs
// through their helper), then one of SVCs and unaligned loads with SCTLR_EL1.A set (an alignment fault each; the
// JIT interprets everything then: `jit::key`), while the virtual timer, armed again at every IRQ a pseudo-random time
// ahead, comes due anywhere: in EL0's own work (unmasked: taken at once), or in a handler's masked spin of
// pseudo-random length, and then taken right after the ERET back to EL0. Each IRQ's ELR, vector and counter reading
// go into a hash on the console, which a deterministic run compares between the interpreter and the JIT
// (tests/boot-node.test.ts): a completion in place that let a pending IRQ wait past its ERET would move them, and
// one that miscounted a step would move every reading. Elsewhere (realtime, parallel, the oracles) only the counts.
#include "lib.h"

#define VTIMER 27
#define VEC_EL0_IRQ (VEC_EL0_SYNC + 1)
#define ROUNDS 4000

static u64 hash = 14695981039346656037UL, seed = 1;
static volatile u64 n_svc, n_align, n_irq;
static u64 buf[2];

static void mix(u64 v) { hash = (hash ^ v) * 1099511628211UL; }

static u64 rnd(void) {
  seed = seed * 6364136223846793005UL + 1442695040888963407UL;
  return seed >> 33;
}

static void spin(u64 n) { __asm__ volatile("1: subs %0, %0, #1; b.ne 1b" : "+r"(n) : : "cc"); }

void on_exception(struct frame *f, u64 vec) {
  if (vec == VEC_EL0_IRQ) {
    u64 iar = sysreg(ICC_IAR1_EL1);
    if ((iar & 0x3ff) == VTIMER) {
      n_irq++;
      mix(f->elr);
      mix(sysreg(CNTVCT_EL0));
      set_sysreg(cntv_tval_el0, 100 + rnd() % 5000);
    }
    set_sysreg(ICC_EOIR1_EL1, iar);
    return;
  }
  u64 ec = f->esr >> 26;
  if (vec == VEC_EL0_SYNC && ec == 0x15) {
    if ((f->esr & 0xffff) == 1) { // run_el0's way back
      f->elr = (u64)el0_return;
      f->spsr = 0x3c5;
      return;
    }
    n_svc++;
    spin(1 + rnd() % 3000); // SVC's ELR is past it; its SPSR: EL0t, IRQs unmasked
    return;
  }
  if (vec == VEC_EL0_SYNC && ec == 0x24 && (f->esr & 0x3f) == 0x21) { // alignment fault
    n_align++;
    f->elr += 4;
    spin(1 + rnd() % 3000);
    return;
  }
  power_off(90 + vec);
}

static u64 user_svcs(void) {
  u64 s = 3;
  for (int i = 0; i < ROUNDS; i++) {
    s = s * 2862933555777941757UL + 3037000493UL;
    spin(1 + (s >> 40) % 500);
    __asm__ volatile("svc #2" ::: "memory", "cc");
  }
  return s;
}

static u64 user_loop(void) {
  u64 s = 7, acc = 0;
  for (int i = 0; i < ROUNDS; i++) {
    s = s * 2862933555777941757UL + 3037000493UL;
    spin(1 + (s >> 40) % 500);
    if (i & 1) {
      __asm__ volatile("svc #2" ::: "memory", "cc");
    } else {
      u64 v = 0;
      __asm__ volatile("ldr %0, [%1]" : "+r"(v) : "r"((char *)buf + 1) : "memory");
      acc += v + 1;
    }
  }
  return acc;
}

int main(void) {
  mmio32(UART + 0x30) = 0x301; // CR: UARTEN, TXE, RXE
  gic_init();
  mmio32(SGI_BASE + 0x100) = 1u << VTIMER;
  set_sysreg(cntv_tval_el0, 1000);
  set_sysreg(cntv_ctl_el0, 1);
  mix(run_el0(user_svcs, (u64)user_stack_top));
  check(n_svc == ROUNDS, 5);
  n_svc = 0;
  set_sysreg(sctlr_el1, sysreg(sctlr_el1) | 2); // A: unaligned accesses fault
  u64 acc = run_el0(user_loop, (u64)user_stack_top);
  set_sysreg(sctlr_el1, sysreg(sctlr_el1) & ~2UL);
  set_sysreg(cntv_ctl_el0, 0);
  check(acc == ROUNDS / 2, 1);
  check(n_svc == ROUNDS / 2, 2);
  check(n_align == ROUNDS / 2, 3);
#ifndef HVF // the M4 runs the rounds in a fraction of a millisecond: a few IRQs
  check(n_irq > 50, 4);
#endif
  uart_puts("eret ");
  uart_dec(hash);
  uart_puts(" ");
  uart_dec(n_irq);
  uart_puts("\n");
  return 0;
}
