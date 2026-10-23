// Self-hosted debug: software step from EL0 through the step state machine's
// edges (a load-exclusive, an SVC, an UNDEFINED instruction, an IRQ taken
// before the first stepped instruction), breakpoints (address, linked and
// unlinked context ID, the PMC, KDE and PSTATE.D, the OS lock) and
// watchpoints (byte selection, load/store control, a masked range, a store
// exclusive), with the syndromes and addresses QEMU's TCG reports.
#include "lib.h"

#define MDSCR_SS 1UL
#define MDSCR_KDE (1UL << 13)
#define MDSCR_MDE (1UL << 15)
#define SPSR_SS (1UL << 21)
// ESR_EL1: EC, IL, and the debug exception status 0x22.
#define ESR_DEBUG(ec) ((u64)(ec) << 26 | 1 << 25 | 0x22)
#define STEP (ESR_DEBUG(0x32) | 1 << 24) // ISV: an instruction was stepped
#define STEP_EX (STEP | 1 << 6)          // ... and it was a load-exclusive
#define STEP_NOISV ESR_DEBUG(0x32)       // pending from an exception return
#define BP_EL0 ESR_DEBUG(0x30)
#define BP_EL1 ESR_DEBUG(0x31)
#define WP_EL0_R ESR_DEBUG(0x34)
#define WP_EL0_W (ESR_DEBUG(0x34) | 1 << 6) // WnR

// DBGBCR: BT, LBN, BAS (A64: 0xf), PMC (bit 1 EL1, bit 2 EL0), E.
#define BCR(bt, lbn, pmc) ((u64)(bt) << 20 | (u64)(lbn) << 16 | 0xf << 5 | (pmc) << 1 | 1)
// The context-aware breakpoint is the highest-numbered: ours is 1, QEMU's
// Cortex-A57's (6 of them, 2 context-aware) 5.
#ifdef ORACLE
#define CTX 5
#define ctx_bvr dbgbvr5_el1
#define ctx_bcr dbgbcr5_el1
#else
#define CTX 1
#define ctx_bvr dbgbvr1_el1
#define ctx_bcr dbgbcr1_el1
#endif
#define set_sysreg_x(r, v) set_sysreg(r, v) // expands r first
#define PMC_EL1 1
#define PMC_EL0 2
// DBGWCR: MASK, WT, LBN, BAS, LSC (1 load, 2 store), PAC, E.
#define WCR(mask, bas, lsc, pac) ((u64)(mask) << 24 | (u64)(bas) << 5 | (lsc) << 3 | (pac) << 1 | 1)

static volatile u64 log_elr[32], log_esr[32], log_far[32], n_log;
static volatile u64 n_irq, irq_spsr;

void on_exception(struct frame *f, u64 vec) {
  if (vec == VEC_EL1H_IRQ || vec == VEC_EL0_SYNC + 1) {
    u64 iar = sysreg(ICC_IAR1_EL1);
    n_irq++;
    irq_spsr = f->spsr;
    set_sysreg(ICC_EOIR1_EL1, iar);
    return;
  }
  u64 ec = f->esr >> 26;
  if (ec == 0x15 && (f->esr & 0xffff) == 1 && vec == VEC_EL0_SYNC) {
    f->elr = (u64)el0_return; // run_el0's way back
    f->spsr = 0x3c5;          // EL1h, DAIF masked
    return;
  }
  if (n_log < 32) {
    log_elr[n_log] = f->elr;
    log_esr[n_log] = f->esr;
    log_far[n_log] = f->far;
    n_log++;
  }
  switch (ec) {
  case 0x32: // software step: on to the next instruction
    f->spsr |= SPSR_SS;
    break;
  case 0x30:
  case 0x31: // breakpoint: off, and the instruction runs
    set_sysreg(dbgbcr0_el1, 0);
    set_sysreg_x(ctx_bcr, 0);
    break;
  case 0x34:
  case 0x35: // watchpoint: off, and the access runs again
    set_sysreg(dbgwcr0_el1, 0);
    set_sysreg(dbgwcr1_el1, 0);
    break;
  case 0x15: // SVC: ELR is past it
    break;
  default: // UNDEFINED: skip it
    f->elr += 4;
  }
}

// run_el0 (start.S) with the SPSR given (SS, and DAIF clear for IRQs).
u64 run_el0_spsr(u64 (*fn)(void), u64 sp, u64 spsr);
extern char tramp[], u_step[], u_short[], u_bp[], el1_bp[];
extern volatile unsigned char buf[32], buf2[32];
volatile unsigned char buf[32] __attribute__((aligned(16)));
volatile unsigned char buf2[32] __attribute__((aligned(16)));

__asm__(".text\n"
        "run_el0_spsr:\n"
        "  stp x29, x30, [sp, #-96]!\n"
        "  stp x19, x20, [sp, #16]\n"
        "  stp x21, x22, [sp, #32]\n"
        "  stp x23, x24, [sp, #48]\n"
        "  stp x25, x26, [sp, #64]\n"
        "  stp x27, x28, [sp, #80]\n"
        "  msr sp_el0, x1\n"
        "  adr x1, tramp\n"
        "  msr elr_el1, x1\n"
        "  msr spsr_el1, x2\n"
        "  eret\n"
        ".global tramp\n"
        "tramp:\n"
        "  blr x0\n"
        "  svc #1\n"
        // Stepped: every edge the trace in main expects.
        ".global u_step\n"
        "u_step:\n"
        "  mov x0, #1\n"
        "  ldxr x1, [sp]\n"
        "  clrex\n"
        "  svc #7\n"
        "  udf #0\n"
        "  add x0, x0, #1\n"
        "  ret\n"
        ".global u_short\n"
        "u_short:\n"
        "  mov x0, #5\n"
        "  ret\n"
        // Breakpoints at u_bp + 8.
        ".global u_bp\n"
        "u_bp:\n"
        "  mov x0, #0\n"
        "  add x0, x0, #1\n"
        "  add x0, x0, #2\n"
        "  add x0, x0, #4\n"
        "  ret\n"
        ".global el1_bp\n"
        "el1_bp:\n"
        "  mov x0, #9\n"
        "  ret\n");

// Watchpoints: a load of byte 11, a store to byte 10, then a word store over 8-11.
static u64 u_watch(void) {
  u64 v = buf[11];
  buf[10] = 1;
  *(volatile u32 *)&buf[8] = 0x04030201;
  return v;
}

static u64 u_range(void) { return buf2[12] + buf2[20]; }

static u64 u_excl(void) {
  u64 st, v;
  __asm__ volatile("ldxr %1, [%2]; stxr w0, %1, [%2]; mov %0, x0" : "=r"(st), "=&r"(v) : "r"(&buf[16]) : "x0", "memory");
  return st;
}

static u64 run_steps(u64 (*fn)(void)) { return run_el0_spsr(fn, (u64)user_stack_top, SPSR_SS); }
static u64 run(u64 (*fn)(void)) { return run_el0_spsr(fn, (u64)user_stack_top, 0); }
#define LOG(i, elr, esr) check(log_elr[i] == (u64)(elr) && log_esr[i] == (esr), 100 + 10 * (i))

int main(void) {
#ifndef ORACLE
  check(sysreg(ID_AA64DFR0_EL1) == 0x101006, 1); // v8.0 debug, 2 breakpoints, 2 watchpoints, 1 context
#endif
  set_sysreg(oslar_el1, 0);
  set_sysreg(mdscr_el1, 0);
  for (u64 n = 0; n < 2; n++) check(sysreg(oslsr_el1) == 0x8, 2);
  set_sysreg(dbgbvr0_el1, 0x1234);
  check(sysreg(dbgbvr0_el1) == 0x1234, 3);
  set_sysreg(dbgbvr0_el1, 0);

  // Software step from EL0, through each edge.
  set_sysreg(mdscr_el1, MDSCR_SS);
  check(run_steps((u64 (*)(void))u_step) == 2, 4);
  set_sysreg(mdscr_el1, 0);
  check(n_log == 9, 5);
  LOG(0, u_step, STEP);
  LOG(1, u_step + 4, STEP);
  LOG(2, u_step + 8, STEP_EX);
  LOG(3, u_step + 12, STEP);
  LOG(4, u_step + 16, 0x56000007); // the SVC completes the step
  LOG(5, u_step + 16, STEP_NOISV); // so it's pending at its return
  LOG(6, u_step + 16, 0x02000000); // UNDEFINED doesn't complete it
  LOG(7, u_step + 24, STEP);
  LOG(8, tramp + 4, STEP);

  // An IRQ pending at the ERET: taken first, with SPSR.SS = 1 (nothing stepped yet).
  gic_init();
  mmio32(SGI_BASE + 0x100) = 1 << 1; // GICR_ISENABLER0: SGI 1
  set_sysreg(ICC_SGI1R_EL1, 1UL << 24 | 1); // SGI 1 to this CPU, pending while DAIF masks it
  n_log = 0;
  set_sysreg(mdscr_el1, MDSCR_SS);
  check(run_steps((u64 (*)(void))u_short) == 5, 6);
  set_sysreg(mdscr_el1, 0);
  check(n_irq == 1 && (irq_spsr & SPSR_SS), 7);
  check(n_log == 3, 8);
  LOG(0, u_short, STEP);
  LOG(1, u_short + 4, STEP);
  LOG(2, tramp + 4, STEP);

  // No step with the OS lock set (AArch64.GenerateDebugExceptionsFrom; QEMU
  // 11.1's TCG steps anyway, so the oracle builds leave the OS lock out).
  set_sysreg(oslar_el1, 1);
  check(sysreg(oslsr_el1) == 0xa, 9);
#ifndef ORACLE
  n_log = 0;
  set_sysreg(mdscr_el1, MDSCR_SS);
  check(run_steps((u64 (*)(void))u_short) == 5 && n_log == 0, 10);
  set_sysreg(mdscr_el1, 0);
#endif
  set_sysreg(oslar_el1, 0);

  // An EL0 breakpoint; one for EL1 only doesn't hit EL0, nor (KDE clear) EL1.
  set_sysreg(mdscr_el1, MDSCR_MDE);
  n_log = 0;
  set_sysreg(dbgbvr0_el1, u_bp + 8);
  set_sysreg(dbgbcr0_el1, BCR(0, 0, PMC_EL0));
  check(run((u64 (*)(void))u_bp) == 7, 11);
  check(n_log == 1, 12);
  LOG(0, u_bp + 8, BP_EL0);
  set_sysreg(dbgbcr0_el1, BCR(0, 0, PMC_EL1));
  check(run((u64 (*)(void))u_bp) == 7 && n_log == 1, 13);
  set_sysreg(dbgbvr0_el1, el1_bp);
  check(((u64 (*)(void))el1_bp)() == 9 && n_log == 1, 14);
  // With KDE, an EL1 one hits once PSTATE.D is clear.
  set_sysreg(mdscr_el1, MDSCR_MDE | MDSCR_KDE);
  check(((u64 (*)(void))el1_bp)() == 9 && n_log == 1, 15);
  __asm__ volatile("msr daifclr, #8");
  check(((u64 (*)(void))el1_bp)() == 9, 16);
  __asm__ volatile("msr daifset, #8");
  check(n_log == 2, 17);
  LOG(1, el1_bp, BP_EL1);
  set_sysreg(mdscr_el1, MDSCR_MDE);

  // Linked to a context ID: it hits only while CONTEXTIDR_EL1 matches.
  n_log = 0;
  set_sysreg_x(ctx_bvr, 0x55);
  set_sysreg_x(ctx_bcr, BCR(3, 0, PMC_EL0 | PMC_EL1));
  set_sysreg(dbgbvr0_el1, u_bp + 8);
  set_sysreg(dbgbcr0_el1, BCR(1, CTX, PMC_EL0));
  set_sysreg(contextidr_el1, 0x66);
  check(run((u64 (*)(void))u_bp) == 7 && n_log == 0, 18);
  set_sysreg(contextidr_el1, 0x55);
  check(run((u64 (*)(void))u_bp) == 7 && n_log == 1, 19);
  LOG(0, u_bp + 8, BP_EL0);
#ifndef ORACLE // QEMU 11.1's TCG doesn't implement unlinked context ID breakpoints
  // An unlinked context ID breakpoint hits EL0's first instruction.
  set_sysreg_x(ctx_bcr, BCR(2, 0, PMC_EL0));
  check(run((u64 (*)(void))u_bp) == 7 && n_log == 2, 20);
  LOG(1, tramp, BP_EL0);
#else
  n_log = 2;
#endif
#ifndef ORACLE // the OS lock holds them off (as above)
  set_sysreg(dbgbvr0_el1, u_bp + 8);
  set_sysreg(dbgbcr0_el1, BCR(0, 0, PMC_EL0));
  set_sysreg(oslar_el1, 1);
  check(run((u64 (*)(void))u_bp) == 7 && n_log == 2, 21);
  set_sysreg(oslar_el1, 0);
#endif
  set_sysreg(dbgbcr0_el1, 0);
  set_sysreg(contextidr_el1, 0);

  // Watchpoints: byte 11 for stores. The load and the store to byte 10 pass;
  // the word store over it hits (FAR: the byte), then runs.
  n_log = 0;
  set_sysreg(dbgwvr0_el1, &buf[8]);
  set_sysreg(dbgwcr0_el1, WCR(0, 1 << 3, 2, PMC_EL0));
  check(run(u_watch) == 0 && n_log == 1, 22);
  check(log_elr[0] && log_esr[0] == WP_EL0_W && log_far[0] == (u64)&buf[11], 23);
  check(*(volatile u32 *)&buf[8] == 0x04030201, 24);
  // A 16-byte range (MASK 4) for loads: byte 12 hits, then byte 20 is outside it.
  set_sysreg(dbgwvr1_el1, buf2);
  set_sysreg(dbgwcr1_el1, WCR(4, 0xff, 1, PMC_EL0));
  check(run(u_range) == 0 && n_log == 2, 25);
  check(log_esr[1] == WP_EL0_R && log_far[1] == (u64)&buf2[12], 26);
  // WVR[2] set: BAS selects bytes of the word there; a store exclusive hits.
  set_sysreg(dbgwvr0_el1, &buf[20]);
  set_sysreg(dbgwcr0_el1, WCR(0, 1 << 1, 2, PMC_EL0));
  run(u_excl);
  check(n_log == 3 && log_esr[2] == WP_EL0_W && log_far[2] == (u64)&buf[21], 27);
  // A load-only watchpoint at EL1 without KDE: nothing.
  set_sysreg(dbgwvr0_el1, &buf[0]);
  set_sysreg(dbgwcr0_el1, WCR(0, 0xff, 3, PMC_EL1));
  check(buf[0] == 0 && n_log == 3, 28);
  set_sysreg(dbgwcr0_el1, 0);
  set_sysreg(mdscr_el1, 0);
  return 0;
}
