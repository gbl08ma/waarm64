// eret.c's in-place completions on two vCPUs (`vm::rr_fast`), with the exceptions eret.c doesn't take: instruction
// aborts and watchpoint hits. Each vCPU runs its own rounds at EL0: SVCs (compiled), then SVCs and unaligned loads
// with SCTLR_EL1.A set (alignment faults), then SVCs and calls to an address with nothing there (instruction aborts:
// the handler returns to the caller), then SVCs and loads of a watched word with MDSCR_EL1.MDE set (watchpoint hits:
// the handler skips the load; the JIT interprets EL0 then). Its virtual timer, armed again at every IRQ a
// pseudo-random time ahead, comes due anywhere, as in eret.c. In deterministic round-robin the other vCPU's quanta
// and deadlines cut the chunks, and the code cache moves between the vCPUs. Each vCPU's IRQs (ELR, counter) go into
// its own hash, printed by vCPU 0 at the end, which a deterministic run compares between the interpreter and the
// JIT (tests/boot-node.test.ts). Elsewhere (realtime, parallel, the oracles) only the counts.
// smp: 2
#include "lib.h"

#define NCPU 2
#define RD(c) (GICR + 0x20000UL * (c))
#define SGI_C(c) (RD(c) + 0x10000)
#define VTIMER 27
#define VEC_EL0_IRQ (VEC_EL0_SYNC + 1)
#define ROUNDS 1500
#define NOWHERE 0x0b000000UL // no RAM, no device: a fetch there is an external abort
#define PSCI_CPU_ON 0xc4000003UL
// DBGWCR: BAS 0xff, LSC 1 (loads), PAC 2 (EL0), E.
#define WCR_LOADS_EL0 (0xffUL << 5 | 1UL << 3 | 2UL << 1 | 1)
#define MDSCR_MDE (1UL << 15)

void secondary_start(void);

static char stacks[NCPU][4096] __attribute__((aligned(16)));
static char user_stacks[NCPU][4096] __attribute__((aligned(16)));
// Per-vCPU state, written by its own vCPU only (the MMU is off: no exclusives).
static u64 hash[NCPU], seed[NCPU];
static volatile u64 n_svc[NCPU], n_align[NCPU], n_iabt[NCPU], n_watch[NCPU], n_irq[NCPU], done[NCPU];
static u64 buf[NCPU][2];
static volatile u64 watched[NCPU][2] __attribute__((aligned(16)));

static u64 me(void) { return sysreg(MPIDR_EL1) & 0xff; }

static void mix(u64 c, u64 v) { hash[c] = (hash[c] ^ v) * 1099511628211UL; }

static u64 rnd(u64 c) {
  seed[c] = seed[c] * 6364136223846793005UL + 1442695040888963407UL;
  return seed[c] >> 33;
}

static void spin(u64 n) { __asm__ volatile("1: subs %0, %0, #1; b.ne 1b" : "+r"(n) : : "cc"); }

static long psci(u64 f, u64 a, u64 b, u64 c) {
  register u64 x0 __asm__("x0") = f, x1 __asm__("x1") = a, x2 __asm__("x2") = b, x3 __asm__("x3") = c;
  __asm__ volatile("hvc #0" : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory");
  return (long)x0;
}

void on_exception(struct frame *f, u64 vec) {
  u64 c = me();
  if (vec == VEC_EL0_IRQ) {
    u64 iar = sysreg(ICC_IAR1_EL1);
    if ((iar & 0x3ff) == VTIMER) {
      n_irq[c]++;
      mix(c, f->elr);
      mix(c, sysreg(CNTVCT_EL0));
      set_sysreg(cntv_tval_el0, 100 + rnd(c) % 5000);
    }
    set_sysreg(ICC_EOIR1_EL1, iar);
    return;
  }
  u64 ec = f->esr >> 26;
  if (vec != VEC_EL0_SYNC) power_off(90 + vec);
  if (ec == 0x15 && (f->esr & 0xffff) == 1) { // run_el0's way back
    f->elr = (u64)el0_return;
    f->spsr = 0x3c5;
    return;
  }
  if (ec == 0x15) {
    n_svc[c]++;
  } else if (ec == 0x24 && (f->esr & 0x3f) == 0x21) { // alignment fault
    n_align[c]++;
    f->elr += 4;
  } else if (ec == 0x20 && (f->esr & 0x3f) == 0x10 && f->far == NOWHERE) { // instruction abort, external
    n_iabt[c]++;
    f->elr = f->x[30]; // back to the caller
  } else if (ec == 0x34 && f->far == (u64)&watched[c][1]) { // watchpoint: skip the load
    n_watch[c]++;
    f->elr += 4;
  } else {
    power_off(80 + ec % 10);
  }
  mix(c, ec);
  spin(1 + rnd(c) % 3000); // the ERET back: EL0t, IRQs unmasked
}

// EL0's rounds, by the vCPU's phase: 0 SVCs only, 1 with unaligned loads, 2 with calls to NOWHERE, 3 with loads
// of the watched word.
static volatile u64 phase[NCPU];

static u64 user_rounds(void) {
  u64 c = sysreg(TPIDRRO_EL0), s = 3 + c, acc = 0, p = phase[c]; // MPIDR_EL1 is EL1's
  for (int i = 0; i < ROUNDS; i++) {
    s = s * 2862933555777941757UL + 3037000493UL;
    spin(1 + (s >> 40) % 500);
    if (p == 0 || i & 1) {
      __asm__ volatile("svc #2" ::: "memory", "cc");
    } else if (p == 1) {
      u64 v = 0;
      __asm__ volatile("ldr %0, [%1]" : "+r"(v) : "r"((char *)buf[c] + 1) : "memory");
      acc += v + 1;
    } else if (p == 2) {
      __asm__ volatile("blr %0" : : "r"(NOWHERE) : "x30", "memory");
      acc++;
    } else {
      u64 v = 0;
      __asm__ volatile("ldr %0, [%1]" : "+r"(v) : "r"(&watched[c][1]) : "memory");
      acc += v + 1;
    }
  }
  return acc;
}

static void rounds(u64 c) {
  hash[c] = 14695981039346656037UL;
  seed[c] = 1 + c;
  set_sysreg(tpidrro_el0, c);
  set_sysreg(cntv_tval_el0, 1000 + 300 * c);
  set_sysreg(cntv_ctl_el0, 1);
  char *sp = user_stacks[c] + sizeof user_stacks[c];
  // Phase 0: SVCs.
  check(run_el0(user_rounds, (u64)sp) == 0 && n_svc[c] == ROUNDS, 10 + c);
  // Phase 1: alignment faults.
  set_sysreg(sctlr_el1, sysreg(sctlr_el1) | 2); // A
  phase[c] = 1;
  check(run_el0(user_rounds, (u64)sp) == ROUNDS / 2 && n_align[c] == ROUNDS / 2, 20 + c);
  set_sysreg(sctlr_el1, sysreg(sctlr_el1) & ~2UL);
#ifndef ORACLE // an external abort where nothing is mapped is ours
  // Phase 2: instruction aborts.
  phase[c] = 2;
  check(run_el0(user_rounds, (u64)sp) == ROUNDS / 2 && n_iabt[c] == ROUNDS / 2, 30 + c);
#endif
  // Phase 3: watchpoint hits.
  set_sysreg(oslar_el1, 0);
  set_sysreg(dbgwvr0_el1, &watched[c][1]);
  set_sysreg(dbgwcr0_el1, WCR_LOADS_EL0);
  set_sysreg(mdscr_el1, MDSCR_MDE);
  phase[c] = 3;
  check(run_el0(user_rounds, (u64)sp) == ROUNDS / 2 && n_watch[c] == ROUNDS / 2, 40 + c);
  set_sysreg(mdscr_el1, 0);
  set_sysreg(dbgwcr0_el1, 0);
  set_sysreg(cntv_ctl_el0, 0);
#ifndef HVF // the M4 runs the rounds in a fraction of a millisecond: a few IRQs
  check(n_irq[c] > 20, 50 + c);
#endif
}

static void gic_cpu_init(u64 c) {
  mmio32(RD(c) + 0x14) &= ~2u; // GICR_WAKER.ProcessorSleep
  while (mmio32(RD(c) + 0x14) & 4)
    ;
  mmio32(SGI_C(c) + 0x080) = ~0u; // SGIs and PPIs group 1
  mmio32(SGI_C(c) + 0x100) = 1u << VTIMER;
  set_sysreg(ICC_PMR_EL1, 0xf0);
  set_sysreg(ICC_IGRPEN1_EL1, 1);
}

void secondary_main(void) {
  gic_cpu_init(1);
  rounds(1);
  done[1] = 1;
  for (;;) __asm__ volatile("wfi");
}

int main(void) {
  mmio32(UART + 0x30) = 0x301; // CR: UARTEN, TXE, RXE
  mmio32(GICD) = 1 << 4 | 1 << 1; // ARE, EnableGrp1
  while (mmio32(GICD) & 1u << 31) // RWP
    ;
  gic_cpu_init(0);
  check(psci(PSCI_CPU_ON, 1, (u64)secondary_start, (u64)(stacks[1] + sizeof stacks[1])) == 0, 2);
  rounds(0);
  while (!done[1])
    __asm__ volatile("yield");
  for (u64 c = 0; c < NCPU; c++) {
    uart_puts("eret_smp ");
    uart_dec(c);
    uart_puts(" ");
    uart_dec(hash[c]);
    uart_puts(" ");
    uart_dec(n_irq[c]);
    uart_puts("\n");
  }
  return 0;
}
