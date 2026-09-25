// Shared by the bare-metal EL1 tests (start.S is the runtime).
#pragma once
typedef unsigned long u64;
typedef unsigned int u32;

struct frame {
  u64 x[31], elr, spsr, esr, far;
};

// Vector index: 0-3 current EL with SP_EL0, 4-7 with SP_EL1, 8-11 lower EL
// (AArch64); within each, sync, IRQ, FIQ, SError.
enum { VEC_EL1T_SYNC = 0, VEC_EL1H_SYNC = 4, VEC_EL1H_IRQ = 5, VEC_EL0_SYNC = 8 };

void on_exception(struct frame *f, u64 vec);
u64 run_el0(u64 (*fn)(void), u64 sp);
_Noreturn void power_off(u64 code);
extern char user_stack_top[], el0_return[];

#define sysreg(r) ({ u64 v_; __asm__ volatile("mrs %0, " #r : "=r"(v_)); v_; })
#define set_sysreg(r, v) __asm__ volatile("msr " #r ", %0; isb" : : "r"((u64)(v)))
// Fails the test with `code` unless `c` holds. Checks of values that are ours
// rather than architectural (ID registers, reset values) go under #ifndef ORACLE,
// so the same test also runs on QEMU (oracle.sh).
#define check(c, code) do { if (!(c)) power_off(code); } while (0)

// Devices at QEMU virt's addresses.
#define GICD 0x08000000UL
#define GICC 0x08010000UL
#define UART 0x09000000UL
#define mmio32(a) (*(volatile u32 *)(a))
#define mmio8(a) (*(volatile unsigned char *)(a))

static inline void uart_putc(char c) {
  while (mmio32(UART + 0x18) & 0x20) // FR.TXFF
    ;
  mmio32(UART) = c;
}

static inline void uart_puts(const char *s) {
  while (*s) uart_putc(*s++);
}

static inline void uart_dec(u64 v) {
  char b[21], *p = b + 20;
  *p = 0;
  do *--p = '0' + v % 10; while (v /= 10);
  uart_puts(p);
}

// Prints "exit <code>" on the PL011 (for oracles without a CPU log, like
// hvf), then PSCI SYSTEM_OFF with the code in x1 (0 = pass; our convention,
// PLAN.md §4 item 6). The MMU goes off first, so the UART's PA is reachable.
_Noreturn void power_off(u64 code) {
  __asm__ volatile("mrs x9, sctlr_el1; bic x9, x9, #1; msr sctlr_el1, x9; isb" ::: "x9", "memory");
  mmio32(UART + 0x30) = 0x301; // CR: UARTEN, TXE, RXE
  uart_puts("exit ");
  uart_dec(code);
  uart_puts("\n");
  register u64 x0 __asm__("x0") = 0x84000008, x1 __asm__("x1") = code;
  __asm__ volatile("hvc #0" : : "r"(x0), "r"(x1));
  for (;;)
    ;
}
