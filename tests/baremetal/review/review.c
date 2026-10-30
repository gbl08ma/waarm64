// The static review of the interpreter (review/interp): each candidate as an
// observation, printed rather than checked, so that the same binary can be
// compared line by line on webpc, QEMU TCG and the M4 under hvf (run.sh).
#include "../lib.h"

#define RAM 0x40000000UL
#define UNMAPPED 0xc0000000UL // L1 entry 3: no translation
#define HOLE 0x0b000000UL     // Device-mapped, nothing there

static u64 l1[512] __attribute__((aligned(4096)));
static u64 ram[64] __attribute__((aligned(4096)));
static u32 stub[4] __attribute__((aligned(64)));

static volatile u64 n_exc, last_esr, last_far, tcr_saved;

void on_exception(struct frame *f, u64 vec) {
  (void)vec;
  n_exc++;
  last_esr = f->esr;
  last_far = f->far;
  f->elr += 4;
}

static void putx(u64 v) {
  uart_puts("0x");
  for (int k = 60; k >= 0; k -= 4) uart_putc("0123456789abcdef"[v >> k & 15]);
}

static void show(const char *name, u64 v) {
  uart_puts(name);
  uart_puts(" ");
  putx(v);
  uart_puts("\n");
}

// `body` run once: how many exceptions it took, and the last one's ESR.
#define observe(name, body, ...)                                             \
  do {                                                                       \
    u64 n0 = n_exc;                                                          \
    last_esr = 0;                                                            \
    __asm__ volatile(body __VA_ARGS__);                                      \
    uart_puts(name);                                                         \
    uart_puts(" exceptions ");                                               \
    uart_dec(n_exc - n0);                                                    \
    uart_puts(" esr ");                                                      \
    putx(last_esr);                                                          \
    uart_puts("\n");                                                         \
  } while (0)

#define CLOB ::: "x0", "x1", "x2", "x3", "memory"
#define ADDR(a) "mov x1, %0\n" a

__attribute__((noinline)) static u64 tagged_br(void) {
  u64 pc;
  __asm__ volatile(
      "adr x1, 1f\n movz x2, #0x5a00, lsl #48\n orr x1, x1, x2\n br x1\n"
      "1: adr %0, .\n" : "=r"(pc) : : "x1", "x2");
  return pc;
}

__attribute__((noinline)) static u64 tagged_eret(void) {
  u64 pc;
  __asm__ volatile(
      "adr x1, 1f\n movz x2, #0x5a00, lsl #48\n orr x1, x1, x2\n"
      "msr elr_el1, x1\n mov x1, #0x3c5\n msr spsr_el1, x1\n eret\n"
      "1: adr %0, .\n" : "=r"(pc) : : "x1", "x2");
  return pc;
}

// The stub's return value after patching its first word to return `v`, with
// `ic` (IC IALLU with Rt 31, or with Rt 0).
static u64 call_stub(void) { return ((u64 (*)(void))stub)(); }

static void patch(u32 v) {
  stub[0] = 0xd2800000 | v << 5; // movz x0, #v
  __asm__ volatile("dc cvau, %0; dsb ish" : : "r"(stub) : "memory");
}

static void watch(u64 addr, u64 lsc) {
  set_sysreg(dbgwvr0_el1, addr & ~7UL);
  set_sysreg(dbgwcr0_el1, 1UL | 3UL << 1 | lsc << 3 | 0xffUL << 5);
}

int main(void) {
  __asm__ volatile("msr oslar_el1, xzr; isb");

  // With the MMU off every access is Device-nGnRnE: must be aligned.
  uart_puts("-- MMU off\n");
  mmio32(UART + 0x30) = 0x301;
  observe("t6.unaligned_ldr_mmu_off", ADDR("ldr x0, [x1]"), : : "r"(RAM + 0x100001) : "x0", "x1", "memory");
  observe("t6.dc_zva_mmu_off", ADDR("dc zva, x1"), : : "r"((u64)ram) : "x1", "memory");

  // RAM: Normal write-back; the first GiB: Device-nGnRnE; identity, EL1 RW.
  l1[0] = 1UL | 1UL << 2 | 1UL << 10 | 3UL << 53;
  l1[1] = RAM | 1UL | 3UL << 8 | 1UL << 10;
  set_sysreg(mair_el1, 0xffUL);
  set_sysreg(ttbr0_el1, (u64)l1);
  tcr_saved = 25UL | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32 | 1UL << 37;
  set_sysreg(tcr_el1, tcr_saved);
  __asm__ volatile("tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1 << 2 | 1 << 12);

  uart_puts("-- T1: PC after a branch to a tagged address (TBI0 set)\n");
  show("t1.adr_after_br", tagged_br());
  show("t1.adr_after_eret", tagged_eret());

  uart_puts("-- T2: Q registers with SCTLR_EL1.A\n");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 2);
  observe("t2.ldr_d_addr4", ADDR(".inst 0xfd400020"), : : "r"((u64)ram + 4) : "x1", "memory"); // ldr d0, [x1]
  observe("t2.ldr_q_addr0", ADDR(".inst 0x3dc00020"), : : "r"((u64)ram) : "x1", "memory");     // ldr q0, [x1]
  observe("t2.ldr_q_addr8", ADDR(".inst 0x3dc00020"), : : "r"((u64)ram + 8) : "x1", "memory");
  observe("t2.str_q_addr8", ADDR(".inst 0x3d800020"), : : "r"((u64)ram + 8) : "x1", "memory"); // str q0, [x1]
  observe("t2.ldp_q_addr8", ADDR(".inst 0xad400420"), : : "r"((u64)ram + 8) : "x1", "memory"); // ldp q0, q1, [x1]
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) & ~2UL);

  uart_puts("-- T3: acquire and release on Device memory\n");
  u64 v = 0;
  mmio32(UART + 0x24) = 0x10;
  __asm__ volatile("ldar %w0, [%1]" : "+r"(v) : "r"(UART + 0x24) : "memory");
  show("t3.ldar_ibrd", v);
  uart_dec(n_exc);
  uart_puts(" exceptions so far\n");
  u64 n1 = n_exc;
  v = 0x20;
  __asm__ volatile("stlr %w0, [%1]" : : "r"(v), "r"(UART + 0x24) : "memory");
  show("t3.stlr_then_ibrd", mmio32(UART + 0x24));
  show("t3.exceptions", n_exc - n1);
  mmio32(UART + 0x24) = 0x10;

  uart_puts("-- T4: cache maintenance on Device memory\n");
  observe("t4.dc_cvac_uart", ADDR("dc cvac, x1"), : : "r"(UART) : "x1", "memory");
  observe("t4.dc_civac_uart", ADDR("dc civac, x1"), : : "r"(UART) : "x1", "memory");
  observe("t4.dc_ivac_uart", ADDR("dc ivac, x1"), : : "r"(UART) : "x1", "memory");
  observe("t4.ic_ivau_uart", ADDR("ic ivau, x1"), : : "r"(UART) : "x1", "memory");
  observe("t4.dc_cvac_hole", ADDR("dc cvac, x1"), : : "r"(HOLE) : "x1", "memory");
  observe("t4.ic_ivau_hole", ADDR("ic ivau, x1"), : : "r"(HOLE) : "x1", "memory");

  uart_puts("-- T5: DC ZVA on Device memory\n");
  observe("t5.dc_zva_hole", ADDR("dc zva, x1"), : : "r"(HOLE) : "x1", "memory");

  uart_puts("-- T7: watchpoints and atomics\n");
  set_sysreg(mdscr_el1, 1UL << 15 | 1UL << 13);
  __asm__ volatile("msr daifclr, #8; isb");
  ram[8] = 0;
  watch((u64)&ram[8], 1); // load
  observe("t7.ldadd_load_watch", ADDR("mov x2, #1\n .inst 0xf8220020"), : : "r"((u64)&ram[8]) : "x0", "x1", "x2", "memory");
  observe("t7.str_load_watch", ADDR("str xzr, [x1]"), : : "r"((u64)&ram[8]) : "x1", "memory");
  observe("t7.cas_fail_load_watch", ADDR("mov x2, #7\n mov x0, #7\n .inst 0xc8a07c22"), : : "r"((u64)&ram[8]) : "x0", "x1", "x2", "memory");
  watch((u64)&ram[8], 2); // store
  observe("t7.ldadd_store_watch", ADDR("mov x2, #1\n .inst 0xf8220020"), : : "r"((u64)&ram[8]) : "x0", "x1", "x2", "memory");
  observe("t7.ldr_store_watch", ADDR("ldr x0, [x1]"), : : "r"((u64)&ram[8]) : "x0", "x1", "memory");

  uart_puts("-- T8: a watchpoint on an address with no translation\n");
  watch(UNMAPPED, 3);
  observe("t8.ldr_unmapped_watched", ADDR("ldr x0, [x1]"), : : "r"(UNMAPPED) : "x0", "x1", "memory");
  set_sysreg(dbgwcr0_el1, 0);
  __asm__ volatile("msr daifset, #8; isb");
  set_sysreg(mdscr_el1, 0);

  uart_puts("-- T9: IC IALLU with Rt != 31\n");
  stub[0] = 0xd2800000 | 1 << 5; // movz x0, #1
  stub[1] = 0xd65f03c0;          // ret
  __asm__ volatile("dc cvau, %0; dsb ish; ic ivau, %0; dsb ish; isb" : : "r"(stub) : "memory");
  show("t9.before", call_stub());
  show("t9.before", call_stub());
  patch(2);
  __asm__ volatile(".inst 0xd5087500; dsb ish; isb" ::: "memory"); // ic iallu with Rt 0
  show("t9.after_ic_iallu_rt0", call_stub());
  patch(3);
  __asm__ volatile("ic iallu; dsb ish; isb" ::: "memory");
  show("t9.after_ic_iallu", call_stub());

  uart_puts("-- T13: reserved AdvSIMD encodings with FPEN 0\n");
  set_sysreg(cpacr_el1, 0);
  observe("t13.add_1d_reserved", ".inst 0x0ee28420", ::: "memory");
  observe("t13.add_2d_valid", ".inst 0x4ee28420", ::: "memory");
  set_sysreg(cpacr_el1, 3UL << 20);
  return 0;
}
