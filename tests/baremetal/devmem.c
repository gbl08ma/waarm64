// Accesses at the edges of what memory is: acquire and release, cache
// maintenance and DC ZVA on Device mappings with and without a device behind
// them, Q registers under SCTLR_EL1.A, and IC IALLU with Rt != 31 on code that
// has run.
// qemu-cpu: max
#include "lib.h"

#define RAM 0x40000000UL
#define HOLE 0x0b000000UL // Device-mapped, nothing there
#define UART_IBRD (UART + 0x24)

static u64 l1[512] __attribute__((aligned(4096)));
static u64 ram[8] __attribute__((aligned(64)));
static u32 stub[4] __attribute__((aligned(64)));

static volatile u64 n_exc, last_esr;

void on_exception(struct frame *f, u64 vec) {
  (void)vec;
  n_exc++;
  last_esr = f->esr;
  f->elr += 4;
}

// `body` (an asm statement on x1, set to `addr`) takes no exception.
#define quiet(body, addr, code)                                      \
  do {                                                               \
    u64 n0 = n_exc;                                                  \
    __asm__ volatile("mov x1, %0\n" body : : "r"(addr) : "x1", "memory"); \
    check(n_exc == n0, code);                                        \
  } while (0)

// `body` takes one exception, with this ESR.
#define faults(body, addr, esr, code)                                \
  do {                                                               \
    u64 n0 = n_exc;                                                  \
    __asm__ volatile("mov x1, %0\n" body : : "r"(addr) : "x1", "memory"); \
    check(n_exc == n0 + 1 && last_esr == (esr), code);               \
  } while (0)

#define ALIGN_READ 0x96000021UL
#define ALIGN_WRITE 0x96000061UL

static u64 call_stub(void) { return ((u64 (*)(void))stub)(); }

// The stub returns `v` from now on, as far as the data side goes.
static void patch(u32 v) {
  stub[0] = 0xd2800000 | v << 5; // movz x0, #v
  __asm__ volatile("dc cvau, %0; dsb ish" : : "r"(stub) : "memory");
}

int main(void) {
  // RAM: Normal write-back; the first GiB: Device-nGnRnE; identity, EL1 RW.
  l1[0] = 1UL | 1UL << 2 | 1UL << 10 | 3UL << 53;
  l1[1] = RAM | 1UL | 3UL << 8 | 1UL << 10;
  set_sysreg(mair_el1, 0xffUL);
  set_sysreg(ttbr0_el1, (u64)l1);
  set_sysreg(tcr_el1, 25UL | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  __asm__ volatile("tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1 << 2 | 1 << 12);

  // LDAR and STLR on a device register.
  mmio32(UART + 0x30) = 0x301;
  mmio32(UART_IBRD) = 0x10;
  u64 v = 0, n0 = n_exc;
  __asm__ volatile("ldar %w0, [%1]" : "+r"(v) : "r"(UART_IBRD) : "memory");
  check(n_exc == n0 && v == 0x10, 1);
  v = 0x20;
  __asm__ volatile("stlr %w0, [%1]" : : "r"(v), "r"(UART_IBRD) : "memory");
  check(n_exc == n0 && mmio32(UART_IBRD) == 0x20, 2);
  mmio32(UART_IBRD) = 0x10;

  // Cache maintenance by VA translates, and asks nothing of what's there.
  quiet("dc cvac, x1", UART, 10);
  quiet("dc civac, x1", UART, 11);
  quiet("dc ivac, x1", UART, 12);
  quiet("dc cvau, x1", UART, 13);
  quiet("ic ivau, x1", UART, 14);
  quiet("dc cvac, x1", HOLE, 15);
  quiet("dc ivac, x1", HOLE, 16);
  quiet("ic ivau, x1", HOLE, 17);

  // DC ZVA is for Normal memory (QEMU's TCG reports an external abort).
#if !defined(ORACLE) || defined(HVF)
  faults("dc zva, x1", HOLE, ALIGN_WRITE, 20);
  faults("dc zva, x1", UART, ALIGN_WRITE, 21);
#endif
  check(mmio32(UART_IBRD) == 0x10, 22);

  // A Q register is one 16-byte element to SCTLR_EL1.A.
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 2);
  quiet(".inst 0x3dc00020", (u64)ram, 30);                     // ldr q0, [x1]
  quiet(".inst 0x3d800020", (u64)ram, 31);                     // str q0, [x1]
  quiet(".inst 0xad400420", (u64)ram, 32);                     // ldp q0, q1, [x1]
  quiet(".inst 0xfd400020", (u64)ram + 8, 33);                 // ldr d0, [x1]
  faults(".inst 0x3dc00020", (u64)ram + 8, ALIGN_READ, 34);
  faults(".inst 0x3d800020", (u64)ram + 8, ALIGN_WRITE, 35);
  faults(".inst 0xad400420", (u64)ram + 8, ALIGN_READ, 36);
  faults(".inst 0xad000420", (u64)ram + 8, ALIGN_WRITE, 37);   // stp q0, q1, [x1]
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) & ~2UL);

  // IC IALLU with Rt != 31 is IC IALLU.
  stub[1] = 0xd65f03c0; // ret
  patch(1);
  __asm__ volatile("dc cvau, %0; dsb ish; ic ivau, %0; dsb ish; isb" : : "r"(&stub[1]) : "memory");
  __asm__ volatile("ic iallu; dsb ish; isb" ::: "memory");
  for (int k = 0; k < 40; k++) check(call_stub() == 1, 40);
  patch(2);
  __asm__ volatile(".inst 0xd5087500; dsb ish; isb" ::: "memory"); // ic iallu with x0
  check(call_stub() == 2, 41);
  return 0;
}
