// M3 step 1 end to end: exception entry and return between EL0 and EL1,
// syndromes, traps, and the EL1 registers a kernel touches first.
#include "lib.h"

static volatile u64 n_exc, last_esr, last_far, last_vec, last_elr;

void on_exception(struct frame *f, u64 vec) {
  n_exc++;
  last_esr = f->esr;
  last_far = f->far;
  last_vec = vec;
  last_elr = f->elr;
  u64 ec = f->esr >> 26;
  if (ec == 0x15 && (f->esr & 0xffff) == 1 && vec == VEC_EL0_SYNC) {
    f->elr = (u64)el0_return; // run_el0's way back
    f->spsr = 0x3c5;          // EL1h, DAIF masked
  } else if (ec != 0x15) {
    f->elr += 4; // skip the instruction that trapped (SVC's ELR is already past it)
  }
}

// Runs `body` (an asm statement) and checks the exception it takes.
#define expect_exc(body, vec, esr, code)                                  \
  do {                                                                    \
    u64 n0 = n_exc;                                                       \
    __asm__ volatile(body ::: "memory");                                  \
    check(n_exc == n0 + 1 && last_vec == (vec) && last_esr == (esr), code); \
  } while (0)

// Unmapped on our platform and on QEMU virt (between virtio-mmio and the platform bus).
#define HOLE 0x0b000000UL

static u64 user_ok(void) { return 42; }

static u64 user_traps(void) {
  __asm__ volatile("mrs x0, sctlr_el1" ::: "x0"); // UNDEFINED at EL0
  __asm__ volatile("wfi");                        // traps (nTWI = 0)
  __asm__ volatile("svc #0x42");
  u64 v;
  __asm__ volatile("mrs %0, tpidrro_el0" : "=r"(v)); // readable at EL0
  return v;
}

static u64 user_abort(void) {
  *(volatile u64 *)(HOLE + 8) = 1;
  return 7;
}

int main(void) {
  check(sysreg(CurrentEL) == 4, 1); // EL1 (EL in bits 3:2)
  check(sysreg(SPSel) == 1, 2);
  check(sysreg(DAIF) == 0x3c0, 3); // masked at reset
#ifndef ORACLE // our values, not the oracle CPU's
  check(sysreg(ID_AA64PFR0_EL1) == 0x1100000000000011, 4);
  check(sysreg(ID_AA64ISAR0_EL1) == 0x210000, 5);
  check(sysreg(ID_AA64MMFR0_EL1) == 0x0f000022, 6);
  check(sysreg(ID_AA64ISAR1_EL1) == 0, 7);
  check((sysreg(SCTLR_EL1) & 0x30d00800) == 0x30d00800, 8);
#endif

  __asm__ volatile("msr daifclr, #0xf");
  check(sysreg(DAIF) == 0, 9);
  __asm__ volatile("msr daifset, #2");
  check(sysreg(DAIF) == 0x80, 10); // #2 is I

  // Synchronous exceptions from EL1h (vector 0x200).
  expect_exc("udf #0", VEC_EL1H_SYNC, 0x02000000, 20);
  expect_exc("brk #7", VEC_EL1H_SYNC, 0xf2000007, 21);
  expect_exc("svc #3", VEC_EL1H_SYNC, 0x56000003, 22);
  u64 n0 = n_exc;
  (void)*(volatile u64 *)HOLE; // data abort, read
  check(n_exc == n0 + 1 && last_esr == 0x96000010 && last_far == HOLE, 23);
  set_sysreg(cpacr_el1, 0); // then fmov d0, xzr traps
  expect_exc(".inst 0x9e6703e0", VEC_EL1H_SYNC, 0x1fe00000, 25);
  set_sysreg(cpacr_el1, 3 << 20);
  expect_exc("hlt #0", VEC_EL1H_SYNC, 0x02000000, 26); // no halting debug
  expect_exc("smc #0", VEC_EL1H_SYNC, 0x02000000, 27); // no EL3

  // EL1t: SP_EL0 in use, exceptions go to vector 0x000.
  set_sysreg(sp_el0, (u64)user_stack_top);
  __asm__ volatile("msr spsel, #0; udf #1; msr spsel, #1" ::: "memory");
  check(last_vec == VEC_EL1T_SYNC && last_esr == 0x02000000, 30);

  // EL0 and back.
  n0 = n_exc;
  check(run_el0(user_ok, (u64)user_stack_top) == 42, 40);
  check(n_exc == n0 + 1 && last_esr == 0x56000001, 41);
  set_sysreg(tpidrro_el0, 0x1234);
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) & ~(1UL << 16)); // nTWI = 0: EL0 WFI traps
  n0 = n_exc;
  check(run_el0(user_traps, (u64)user_stack_top) == 0x1234, 42);
  check(n_exc == n0 + 4, 43); // mrs, wfi, svc #0x42, svc #1
  n0 = n_exc;
  check(run_el0(user_abort, (u64)user_stack_top) == 7, 44);
  check(n_exc == n0 + 2 && last_far == HOLE + 8, 45); // abort, then svc #1
  return 0;
}
