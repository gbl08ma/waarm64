// Shared by the bare-metal EL1 tests (start.S is the runtime).
#pragma once
typedef unsigned long u64;
typedef unsigned int u32;

struct frame {
  u64 x[31], elr, spsr, esr, far;
};

// Vector index: 0-3 current EL with SP_EL0, 4-7 with SP_EL1, 8-11 lower EL
// (AArch64); within each, sync, IRQ, FIQ, SError.
enum { VEC_EL1T_SYNC = 0, VEC_EL1H_SYNC = 4, VEC_EL0_SYNC = 8 };

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
